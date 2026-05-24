/**
 * Tests for the quota gate. Pins the three severity boundaries plan
 * §4.4 / §9.7 specifies:
 *
 *   - Below 80% AND below per-source count → ok
 *   - >= per-source count (50 t/v, 20 photo) OR >= 80% usage → soft_cap
 *   - >= 95% usage → hard_cap
 *
 * Storage estimate is stubbed via `navigator.storage.estimate`. Counts
 * come from the real Dexie-backed queue (fake-indexeddb).
 */

import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetForTests, queueDb } from "@/lib/queue/db";
import {
  HARD_CAP_QUOTA_RATIO,
  SOFT_CAP_PHOTO_COUNT,
  SOFT_CAP_QUOTA_RATIO,
  SOFT_CAP_TEXT_VOICE_COUNT,
  _resetPersistentStorageMemoForTests,
  checkQuotaForNewCapture,
  requestPersistentStorageOnce,
} from "@/lib/queue/quota";
import type { QueueRecord, QueueSource } from "@/lib/queue/types";

// ---- fixtures -------------------------------------------------------------

function makeRecord(
  overrides: Partial<QueueRecord> & { id?: string },
): QueueRecord {
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
    raw_input: { text: "x", audio_blob_id: null, photo_blob_id: null },
    extracted: null,
    ...overrides,
  };
}

async function seed(source: QueueSource, count: number): Promise<void> {
  const records: QueueRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    records.push(
      makeRecord({ id: `${source}-${String(i)}`, source, created_at: i }),
    );
  }
  await queueDb.captures.bulkAdd(records);
}

// ---- storage estimate stub ------------------------------------------------

function stubStorageEstimate(
  estimate: { usage?: number; quota?: number } | null,
): void {
  if (estimate === null) {
    // Simulate older browsers — storage manager exists but no method.
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      storage: {},
    });
    return;
  }
  vi.stubGlobal("navigator", {
    ...globalThis.navigator,
    storage: {
      estimate: async () => estimate,
      persist: async () => true,
    },
  });
}

// ---- lifecycle ------------------------------------------------------------

beforeEach(async () => {
  await _resetForTests();
  _resetPersistentStorageMemoForTests();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await _resetForTests();
});

// ---- severity tests -------------------------------------------------------

describe("checkQuotaForNewCapture", () => {
  it("returns ok when counts and quota are both well under the caps", async () => {
    stubStorageEstimate({ usage: 1_000_000, quota: 10_000_000 }); // 10%
    await seed("text", 5);
    await seed("photo", 2);

    const result = await checkQuotaForNewCapture("text");

    expect(result.severity).toBe("ok");
    expect(result.reason).toBeNull();
    expect(result.usage_ratio).toBeCloseTo(0.1, 2);
    expect(result.counts).toEqual({ text_voice: 5, photo: 2 });
  });

  it("returns soft_cap when text+voice count hits 50 (and quota is fine)", async () => {
    stubStorageEstimate({ usage: 1_000, quota: 100_000_000 });
    // 30 text + 20 voice = 50 (the combined soft cap).
    await seed("text", 30);
    await seed("voice", 20);

    const result = await checkQuotaForNewCapture("text");

    expect(result.severity).toBe("soft_cap");
    expect(result.reason).toMatch(/notes/i);
    expect(result.counts.text_voice).toBe(SOFT_CAP_TEXT_VOICE_COUNT);
  });

  it("returns soft_cap when photo count hits 20 (and quota is fine)", async () => {
    stubStorageEstimate({ usage: 1_000, quota: 100_000_000 });
    await seed("photo", SOFT_CAP_PHOTO_COUNT);

    const result = await checkQuotaForNewCapture("photo");

    expect(result.severity).toBe("soft_cap");
    expect(result.reason).toMatch(/photos/i);
    expect(result.counts.photo).toBe(SOFT_CAP_PHOTO_COUNT);
  });

  it("returns soft_cap when usage crosses 80% (counts irrelevant)", async () => {
    stubStorageEstimate({
      usage: Math.round(1_000_000 * SOFT_CAP_QUOTA_RATIO),
      quota: 1_000_000,
    });
    // Only one capture queued — count is well under any soft cap.
    await seed("text", 1);

    const result = await checkQuotaForNewCapture("text");

    expect(result.severity).toBe("soft_cap");
    expect(result.reason).toMatch(/space/i);
    expect(result.usage_ratio).toBeCloseTo(SOFT_CAP_QUOTA_RATIO, 2);
  });

  it("returns hard_cap at 95% usage even when counts are tiny", async () => {
    stubStorageEstimate({
      usage: Math.round(1_000_000 * HARD_CAP_QUOTA_RATIO),
      quota: 1_000_000,
    });
    await seed("text", 1);

    const result = await checkQuotaForNewCapture("text");

    expect(result.severity).toBe("hard_cap");
    expect(result.reason).toMatch(/Wi-Fi/);
    expect(result.usage_ratio).toBeCloseTo(HARD_CAP_QUOTA_RATIO, 2);
  });

  it("hard_cap wins over count-based soft_cap when both fire", async () => {
    stubStorageEstimate({
      usage: 990_000,
      quota: 1_000_000, // 99%
    });
    // 50 text/voice → would normally fire the count soft cap.
    await seed("text", SOFT_CAP_TEXT_VOICE_COUNT);

    const result = await checkQuotaForNewCapture("text");

    expect(result.severity).toBe("hard_cap");
  });

  it("treats unknown quota (older browser, no estimate API) as 'don't gate'", async () => {
    stubStorageEstimate(null);
    await seed("text", 5);

    const result = await checkQuotaForNewCapture("text");

    expect(result.severity).toBe("ok");
    expect(result.usage_ratio).toBeNull();
  });

  it("treats quota=0 (some WebViews) as unknown rather than dividing by zero", async () => {
    stubStorageEstimate({ usage: 0, quota: 0 });
    await seed("text", 5);

    const result = await checkQuotaForNewCapture("text");

    expect(result.severity).toBe("ok");
    expect(result.usage_ratio).toBeNull();
  });

  it("photo-source check ignores text/voice counts", async () => {
    stubStorageEstimate({ usage: 1_000, quota: 100_000_000 });
    // 50 text captures — would soft-cap a text submit, but a photo
    // submit looks at the photo count (which is 0).
    await seed("text", SOFT_CAP_TEXT_VOICE_COUNT);

    const result = await checkQuotaForNewCapture("photo");

    expect(result.severity).toBe("ok");
  });
});

// ---- persistent storage memoisation --------------------------------------

describe("requestPersistentStorageOnce", () => {
  it("returns true and calls persist() once", async () => {
    const persistSpy = vi.fn(async () => true);
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      storage: {
        estimate: async () => ({ usage: 0, quota: 1 }),
        persist: persistSpy,
      },
    });

    const first = await requestPersistentStorageOnce();
    const second = await requestPersistentStorageOnce();

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  it("returns false when the browser refuses", async () => {
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      storage: {
        estimate: async () => ({ usage: 0, quota: 1 }),
        persist: async () => false,
      },
    });

    expect(await requestPersistentStorageOnce()).toBe(false);
  });

  it("returns false when persist() throws", async () => {
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      storage: {
        estimate: async () => ({ usage: 0, quota: 1 }),
        persist: async () => {
          throw new Error("permission denied");
        },
      },
    });

    expect(await requestPersistentStorageOnce()).toBe(false);
  });

  it("returns false when the API isn't available at all", async () => {
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      storage: undefined,
    });

    expect(await requestPersistentStorageOnce()).toBe(false);
  });
});
