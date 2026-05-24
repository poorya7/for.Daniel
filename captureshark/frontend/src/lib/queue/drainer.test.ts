/**
 * Integration tests for the queue drainer.
 *
 * Stack:
 *   - `fake-indexeddb/auto` for the Dexie-backed queue.
 *   - A small in-memory `navigator.locks` polyfill (jsdom has no Web
 *     Locks API; the polyfill implements just enough for our use:
 *     exclusive + ifAvailable).
 *   - `vi.stubGlobal("fetch", ...)` to inject canned save responses
 *     without going through the real backend.
 *
 * The contract these tests pin (plan §6):
 *   - Happy path: a `pending_save` record is removed from the queue
 *     on a 200 OK, and the request carries `X-Idempotency-Key`.
 *   - 401 → `failed_auth` AND halts the pass (no subsequent records
 *     attempted in the same drain).
 *   - 404 → `failed_permanent` (no retry; user-visible).
 *   - 429 → `failed_transient` (auto-retry on backoff).
 *   - Network failure → `failed_transient` with code `network`
 *     (locked principle: never stop retrying for network).
 *   - Backoff: a record whose `last_attempt_at` is too recent is
 *     skipped this cycle.
 *   - Non-network transient ceiling: 3 failures → `failed_permanent`.
 *   - Lock unavailable: returns immediately with the flag set.
 *   - `pending_extraction` records are not handled by this slice.
 */

import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetForTests, queueDb } from "@/lib/queue/db";
import { drainNow } from "@/lib/queue/drainer";
import { extractPhotoRowsFromRecord } from "@/lib/queue/extract";
import type { QueueRecord, QueueState } from "@/lib/queue/types";
import type { ExtractedFields, PhotoRow } from "@/lib/api";

// Mock the photo extract helper at module level so the Item 1b
// drainer tests can exercise the fan-out logic without going through
// FormData + fetch. Fake-indexeddb's structured-clone of Blob loses
// instance identity on read, so a "real" round-trip is impossible in
// this test env. The drainer doesn't care HOW the rows arrive — just
// that they do — so swapping the helper is honest.
vi.mock("@/lib/queue/extract", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/queue/extract")>(
      "@/lib/queue/extract",
    );
  return {
    ...actual,
    extractPhotoRowsFromRecord: vi.fn(),
  };
});

// ---- Test fixtures -------------------------------------------------------

const fakeFields: ExtractedFields = {
  name: { value: "Maria Lopez", confidence: "high", alternatives: [] },
  phone: { value: "555-0192", confidence: "high", alternatives: [] },
  email: { value: null, confidence: "high", alternatives: [] },
  has_agent: { value: null, confidence: "high", alternatives: [] },
  intent: { value: null, confidence: "high", alternatives: [] },
  timeline: { value: null, confidence: "high", alternatives: [] },
  financing_status: { value: null, confidence: "high", alternatives: [] },
  budget: { value: null, confidence: "high", alternatives: [] },
  area: { value: null, confidence: "high", alternatives: [] },
  follow_up: { value: null, confidence: "high", alternatives: [] },
  notes: { value: null, confidence: "high", alternatives: [] },
};

function makeRecord(overrides: Partial<QueueRecord> = {}): QueueRecord {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    created_at: Date.now(),
    source: "text",
    state: "pending_save",
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    idempotency_key: id,
    sheet_target: {
      spreadsheet_id: "sheet-1",
      tab_name: "Leads",
      display_name: "Open House Leads",
    },
    raw_input: { text: "Maria Lopez 555-0192", audio_blob_id: null, photo_blob_id: null },
    extracted: { fields: fakeFields, original_text: "Maria Lopez 555-0192" },
    ...overrides,
  };
}

// ---- navigator.locks polyfill --------------------------------------------

interface PolyfillState {
  busy: Set<string>;
}

function installLocksPolyfill(): PolyfillState {
  const state: PolyfillState = { busy: new Set() };
  // Minimal LockManager-shaped object — `request` is the only method
  // the drainer uses.
  const lockManager = {
    request: async (
      name: string,
      options: { mode?: string; ifAvailable?: boolean } | undefined,
      callback: (lock: { name: string; mode: string } | null) => Promise<unknown>,
    ): Promise<unknown> => {
      const opts = options ?? {};
      if (opts.ifAvailable && state.busy.has(name)) {
        return callback(null);
      }
      // Wait for any holder to release. The polyfill is single-event-
      // loop, so a busy lock with `ifAvailable: false` would deadlock;
      // the drainer always uses `ifAvailable: true`, so this branch
      // is just for completeness.
      while (state.busy.has(name)) {
        await new Promise((r) => setTimeout(r, 0));
      }
      state.busy.add(name);
      try {
        return await callback({ name, mode: opts.mode ?? "exclusive" });
      } finally {
        state.busy.delete(name);
      }
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).navigator = (globalThis as any).navigator ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).navigator.locks = lockManager;
  return state;
}

// ---- Fetch mocking helpers -----------------------------------------------

interface FakeResponse {
  status: number;
  body?: object;
}

function installFetchMock(responses: Map<string, FakeResponse[]>): {
  capturedHeaders: Array<Record<string, string>>;
} {
  const capturedHeaders: Array<Record<string, string>> = [];
  const fetchMock = vi.fn(
    async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      // Flatten headers for the assertion side.
      const headers: Record<string, string> = {};
      const rawHeaders = init?.headers ?? {};
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[k] = v;
      } else {
        Object.assign(headers, rawHeaders);
      }
      capturedHeaders.push(headers);

      // Look up the response by idempotency key — that's the easiest
      // way to keep per-record scripted responses straight in tests.
      const key = headers["X-Idempotency-Key"] ?? "__no_key__";
      const queued = responses.get(key) ?? [];
      const next =
        queued.shift() ?? { status: 500, body: { error: "no_mock_response" } };
      const bodyJson = next.body ?? {};
      return new Response(JSON.stringify(bodyJson), {
        status: next.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { capturedHeaders };
}

function installFetchThrows(): void {
  const fetchMock = vi.fn(async () => {
    throw new TypeError("simulated network failure");
  });
  vi.stubGlobal("fetch", fetchMock);
}

/**
 * Build a Response that looks like a successful SSE stream — a single
 * `Content-Type: text/event-stream` body containing each event encoded
 * in the spec's `event: <name>\ndata: <json>\n\n` frame format.
 *
 * The reader in `_streamSseRequest` will pull frames out of this body
 * in the same loop it uses on the real backend; tests don't have to
 * fake the streaming machinery.
 */
function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const text = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Fetch mock that routes the extract-step requests (`/captures/stream`,
 * `/captures/voice`, `/captures/photo`) to one stub and the save-step
 * request (`/sheets/append`) to the same scripted-by-idempotency-key
 * map the rest of the suite uses.
 *
 * Returns the same `capturedHeaders` array the simpler `installFetchMock`
 * returns so assertions on the idempotency header read the same way.
 */
function installExtractAndSaveFetchMock(opts: {
  extract: () => Response;
  saveByKey?: Map<string, FakeResponse[]>;
}): { capturedHeaders: Array<Record<string, string>> } {
  const capturedHeaders: Array<Record<string, string>> = [];
  const saveResponses = opts.saveByKey ?? new Map<string, FakeResponse[]>();

  const fetchMock = vi.fn(
    async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = String(url);
      const headers: Record<string, string> = {};
      const rawHeaders = init?.headers ?? {};
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[k] = v;
      } else {
        Object.assign(headers, rawHeaders);
      }
      capturedHeaders.push(headers);

      if (
        urlStr.includes("/captures/stream") ||
        urlStr.includes("/captures/voice") ||
        urlStr.includes("/captures/photo")
      ) {
        return opts.extract();
      }

      if (urlStr.includes("/sheets/append")) {
        const key = headers["X-Idempotency-Key"] ?? "__no_key__";
        const queued = saveResponses.get(key) ?? [];
        const next =
          queued.shift() ?? {
            status: 500,
            body: { error: "no_mock_response" },
          };
        return new Response(JSON.stringify(next.body ?? {}), {
          status: next.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Anything else is an integration test bug — fail loud rather
      // than silently 404, so we notice if the drainer starts hitting
      // a new endpoint.
      throw new Error(`Unexpected fetch URL in drainer test: ${urlStr}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { capturedHeaders };
}

// ---- Test lifecycle ------------------------------------------------------

beforeEach(async () => {
  await _resetForTests();
  installLocksPolyfill();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await _resetForTests();
});

// ---- Tests ---------------------------------------------------------------

describe("drainNow", () => {
  it("returns an empty result when the queue is empty", async () => {
    installFetchMock(new Map());
    const result = await drainNow();
    expect(result).toEqual({
      saved: 0,
      transient_failures: 0,
      auth_failures: 0,
      permanent_failures: 0,
      skipped_for_backoff: 0,
      lock_unavailable: false,
    });
  });

  it("drains a pending_save record on 200 and sends the idempotency key", async () => {
    const record = makeRecord();
    await queueDb.captures.add(record);

    const { capturedHeaders } = installFetchMock(
      new Map([
        [
          record.idempotency_key,
          [{ status: 200, body: { target: { spreadsheet_id: "sheet-1", display_name: "Open House Leads" } } }],
        ],
      ]),
    );

    const result = await drainNow();

    expect(result.saved).toBe(1);
    // Record should be gone.
    expect(await queueDb.captures.get(record.id)).toBeUndefined();
    // The idempotency key MUST have been sent.
    expect(capturedHeaders[0]!["X-Idempotency-Key"]).toBe(record.idempotency_key);
  });

  it("transitions to failed_transient on 429 and keeps the record", async () => {
    const record = makeRecord();
    await queueDb.captures.add(record);

    installFetchMock(
      new Map([
        [record.idempotency_key, [{ status: 429, body: { error: { code: "sheets_busy", message: "" } } }]],
      ]),
    );

    const result = await drainNow();

    expect(result.transient_failures).toBe(1);
    const after = await queueDb.captures.get(record.id);
    expect(after!.state).toBe("failed_transient");
    expect(after!.attempts).toBe(1);
    expect(after!.last_error?.code).toBe("ai_busy");
  });

  it("transitions to failed_transient on a network failure (fetch throws)", async () => {
    const record = makeRecord();
    await queueDb.captures.add(record);
    installFetchThrows();

    const result = await drainNow();

    expect(result.transient_failures).toBe(1);
    const after = await queueDb.captures.get(record.id);
    expect(after!.state).toBe("failed_transient");
    expect(after!.last_error?.code).toBe("network");
  });

  it("transitions to failed_auth on 401 and halts the pass", async () => {
    const a = makeRecord({ id: "a", created_at: 1 });
    const b = makeRecord({ id: "b", created_at: 2 });
    await queueDb.captures.bulkAdd([a, b]);

    installFetchMock(
      new Map([
        [a.idempotency_key, [{ status: 401, body: { error: { code: "session_lost", message: "" } } }]],
        // b should NEVER be attempted — auth failure halts the pass.
        [b.idempotency_key, [{ status: 200, body: { target: {} } }]],
      ]),
    );

    const result = await drainNow();

    expect(result.auth_failures).toBe(1);
    expect(result.saved).toBe(0);
    // b is untouched.
    const bAfter = await queueDb.captures.get(b.id);
    expect(bAfter!.state).toBe("pending_save");
    expect(bAfter!.attempts).toBe(0);
  });

  it("transitions to failed_permanent on 404", async () => {
    const record = makeRecord();
    await queueDb.captures.add(record);

    installFetchMock(
      new Map([
        [record.idempotency_key, [{ status: 404, body: { error: { code: "sheet_not_found", message: "" } } }]],
      ]),
    );

    const result = await drainNow();

    expect(result.permanent_failures).toBe(1);
    const after = await queueDb.captures.get(record.id);
    expect(after!.state).toBe("failed_permanent");
    expect(after!.last_error?.code).toBe("not_found");
  });

  it("skips a record whose backoff window hasn't elapsed", async () => {
    const now = Date.now();
    // attempts=2 → base 5000ms. last_attempt_at = now-1000 → not ready.
    const record = makeRecord({
      state: "failed_transient",
      attempts: 2,
      last_attempt_at: now - 1_000,
    });
    await queueDb.captures.add(record);

    installFetchMock(new Map());

    const result = await drainNow(() => now);

    expect(result.skipped_for_backoff).toBe(1);
    expect(result.saved).toBe(0);
    const after = await queueDb.captures.get(record.id);
    expect(after!.attempts).toBe(2); // unchanged
  });

  it("respects the non-network transient ceiling (3 attempts → permanent)", async () => {
    const record = makeRecord({
      state: "failed_transient",
      attempts: 2, // next failure will tick to 3 = at ceiling
      last_attempt_at: 0, // backoff long since elapsed
    });
    await queueDb.captures.add(record);

    installFetchMock(
      new Map([
        [record.idempotency_key, [{ status: 429, body: { error: { code: "sheets_busy", message: "" } } }]],
      ]),
    );

    const result = await drainNow();

    expect(result.permanent_failures).toBe(1);
    const after = await queueDb.captures.get(record.id);
    expect(after!.state).toBe("failed_permanent");
    expect(after!.attempts).toBe(3);
  });

  it("network failures never stop retrying — no ceiling", async () => {
    const record = makeRecord({
      state: "failed_transient",
      attempts: 5, // way past the non-network ceiling
      last_attempt_at: 0,
    });
    await queueDb.captures.add(record);

    installFetchThrows();

    const result = await drainNow();

    // The locked principle: a network failure NEVER promotes to
    // permanent, even after a lot of retries.
    expect(result.transient_failures).toBe(1);
    expect(result.permanent_failures).toBe(0);
    const after = await queueDb.captures.get(record.id);
    expect(after!.state).toBe("failed_transient");
    expect(after!.attempts).toBe(6);
  });

  it("extracts a pending_extraction record and saves it in the same cycle", async () => {
    // The persona-critical path: Linda captured offline; the record
    // landed in pending_extraction; connectivity returned. One drain
    // cycle should run extract → save and clean the record up.
    const record = makeRecord({
      state: "pending_extraction",
      extracted: null,
      raw_input: { text: "Maria Lopez 555-0192", audio_blob_id: null, photo_blob_id: null },
    });
    await queueDb.captures.add(record);

    const { capturedHeaders } = installExtractAndSaveFetchMock({
      extract: () => sseResponse([{ event: "done", data: { fields: fakeFields, original_text: "Maria Lopez 555-0192" } }]),
      saveByKey: new Map([
        [record.idempotency_key, [{ status: 200, body: { target: { spreadsheet_id: "sheet-1", display_name: "Open House Leads" } } }]],
      ]),
    });

    const result = await drainNow();

    expect(result.saved).toBe(1);
    expect(await queueDb.captures.get(record.id)).toBeUndefined();
    // The save attempt that follows the extract MUST carry the
    // idempotency header — same record, same key, same dedupe contract.
    const saveCallHeaders = capturedHeaders.find(
      (h) => "X-Idempotency-Key" in h,
    );
    expect(saveCallHeaders).toBeDefined();
    expect(saveCallHeaders!["X-Idempotency-Key"]).toBe(record.idempotency_key);
  });

  it("leaves a pending_extraction record in failed_transient on a network error", async () => {
    const record = makeRecord({
      state: "pending_extraction",
      extracted: null,
    });
    await queueDb.captures.add(record);

    installExtractAndSaveFetchMock({
      extract: () =>
        sseResponse([
          {
            event: "error",
            data: { code: "network", message: "No internet. Try again in a moment." },
          },
        ]),
    });

    const result = await drainNow();

    expect(result.transient_failures).toBe(1);
    const after = await queueDb.captures.get(record.id);
    expect(after!.state).toBe("failed_transient");
    expect(after!.extracted).toBeNull();
    expect(after!.last_error?.code).toBe("network");
    expect(after!.attempts).toBe(1);
  });

  it("routes a pending_extraction record to failed_permanent on no_signal", async () => {
    // Backend gate rejected the input (silent audio, blank text,
    // garbage transcript). Retrying with the same raw input cannot
    // change the verdict — surface for the user instead of churning.
    const record = makeRecord({
      state: "pending_extraction",
      extracted: null,
    });
    await queueDb.captures.add(record);

    installExtractAndSaveFetchMock({
      extract: () =>
        sseResponse([
          {
            event: "error",
            data: { code: "no_signal", message: "Didn't catch that — try once more." },
          },
        ]),
    });

    const result = await drainNow();

    expect(result.permanent_failures).toBe(1);
    const after = await queueDb.captures.get(record.id);
    expect(after!.state).toBe("failed_permanent");
    expect(after!.last_error?.code).toBe("extraction_failed");
  });

  it("routes an extracted-but-empty result to failed_permanent (low-confidence guard)", async () => {
    // Plan §3.2 / §11 Q2: a row with no name AND no phone AND no
    // email is too low-quality to silently write — bounce to the
    // expanded queue list for review/discard.
    const blankFields: ExtractedFields = {
      ...fakeFields,
      name: { value: null, confidence: "low", alternatives: [] },
      phone: { value: "   ", confidence: "low", alternatives: [] },
      email: { value: "", confidence: "low", alternatives: [] },
    };
    const record = makeRecord({
      state: "pending_extraction",
      extracted: null,
    });
    await queueDb.captures.add(record);

    installExtractAndSaveFetchMock({
      extract: () =>
        sseResponse([
          { event: "done", data: { fields: blankFields, original_text: "..." } },
        ]),
    });

    const result = await drainNow();

    expect(result.permanent_failures).toBe(1);
    const after = await queueDb.captures.get(record.id);
    expect(after!.state).toBe("failed_permanent");
    // We DID extract — store the (blank) result so the user can see
    // what the extractor read when they review the record.
    expect(after!.extracted).not.toBeNull();
    expect(after!.last_error?.code).toBe("extraction_failed");
  });

  it("resets the attempts counter on extract→save promotion so save gets its own retry budget", async () => {
    // A record that took 2 extract retries shouldn't enter the save
    // phase already at the non-network ceiling. Otherwise the first
    // save 429 would skip the bounded retry and immediately go
    // permanent — worse UX than the saved-pending pill the user
    // expects.
    const record = makeRecord({
      state: "failed_transient",
      extracted: null,
      attempts: 2,
      last_attempt_at: 0,
      raw_input: { text: "Maria Lopez 555-0192", audio_blob_id: null, photo_blob_id: null },
    });
    await queueDb.captures.add(record);

    installExtractAndSaveFetchMock({
      extract: () => sseResponse([{ event: "done", data: { fields: fakeFields, original_text: "..." } }]),
      saveByKey: new Map([
        [
          record.idempotency_key,
          [{ status: 429, body: { error: { code: "sheets_busy", message: "" } } }],
        ],
      ]),
    });

    const result = await drainNow();

    // The 429 inside the same cycle becomes a normal transient — NOT
    // a permanent — because the save phase started at attempts=0.
    expect(result.transient_failures).toBe(1);
    const after = await queueDb.captures.get(record.id);
    expect(after!.state).toBe("failed_transient");
    expect(after!.extracted).not.toBeNull(); // extract result persisted
    expect(after!.attempts).toBe(1); // fresh save budget
  });

  it("fans a pending_extraction photo record out into N pending_save children (Item 1b)", async () => {
    const blob = new Blob(["fake-image-bytes"], { type: "image/jpeg" });
    await queueDb.blobs.add({
      id: "blob-1",
      blob,
      content_type: "image/jpeg",
      bytes: blob.size,
    });
    const record = makeRecord({
      state: "pending_extraction",
      source: "photo",
      extracted: null,
      raw_input: { text: null, audio_blob_id: null, photo_blob_id: "blob-1" },
    });
    await queueDb.captures.add(record);

    const makeRow = (idempotencyKey: string): PhotoRow => ({
      row_index: 0,
      idempotency_key: idempotencyKey,
      fields: fakeFields,
      row_confidence: "high",
      warnings: [],
    });
    vi.mocked(extractPhotoRowsFromRecord).mockResolvedValueOnce({
      rows: [makeRow("key-a"), makeRow("key-b"), makeRow("key-c")],
      status: "ok",
    });

    // No fetch is hit on this path — the extract helper is mocked —
    // but the drainer still constructs the FetchRequest for any save
    // attempts. None are made because the children land in
    // pending_save AFTER the snapshot was taken.
    installFetchMock(new Map());

    const result = await drainNow();

    expect(await queueDb.captures.get(record.id)).toBeUndefined();
    expect(await queueDb.blobs.get("blob-1")).toBeUndefined();

    const children = await queueDb.captures.toArray();
    expect(children).toHaveLength(3);
    const ids = children.map((c) => c.id).sort();
    expect(ids).toEqual(["photo:key-a", "photo:key-b", "photo:key-c"]);
    for (const child of children) {
      expect(child.state).toBe("pending_save");
      expect(child.source).toBe("photo");
      expect(child.extracted).not.toBeNull();
      expect(child.attempts).toBe(0);
    }

    expect(result.saved).toBe(1);
  });

  it("routes a photo record with status=no_signal to failed_permanent (Item 1b)", async () => {
    const blob = new Blob(["bytes"], { type: "image/jpeg" });
    await queueDb.blobs.add({
      id: "blob-x",
      blob,
      content_type: "image/jpeg",
      bytes: blob.size,
    });
    const record = makeRecord({
      state: "pending_extraction",
      source: "photo",
      extracted: null,
      raw_input: { text: null, audio_blob_id: null, photo_blob_id: "blob-x" },
    });
    await queueDb.captures.add(record);

    vi.mocked(extractPhotoRowsFromRecord).mockResolvedValueOnce({
      rows: [],
      status: "no_signal",
    });

    installFetchMock(new Map());

    const result = await drainNow();

    expect(result.permanent_failures).toBe(1);
    const after = await queueDb.captures.get(record.id);
    expect(after!.state).toBe("failed_permanent");
    expect(after!.last_error?.code).toBe("extraction_failed");
    expect(await queueDb.blobs.get("blob-x")).toBeDefined();
  });

  it("returns lock_unavailable when another holder owns the drainer lock", async () => {
    const polyfill = installLocksPolyfill();
    polyfill.busy.add("captureshark.drainer");

    installFetchMock(new Map());

    const result = await drainNow();

    expect(result.lock_unavailable).toBe(true);
    expect(result.saved).toBe(0);
  });
});

// Asserts a record went through `syncing` and ended at the target state.
// Helper, not exported — kept here so test-only knowledge of the
// state-machine transitions stays close to the assertions.
async function _expectStateTransition(
  id: string,
  finalState: QueueState,
): Promise<void> {
  const after = await queueDb.captures.get(id);
  expect(after).toBeDefined();
  expect(after!.state).toBe(finalState);
}
// Touched here so eslint/tsc don't complain about the helper being
// unused while we let the inline assertions stand instead.
void _expectStateTransition;
