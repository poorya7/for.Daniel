/**
 * Unit tests for the queue IndexedDB layer.
 *
 * Covers the schema contract (every table accepts the type-checked
 * record shape, indexed fields support the queries the drainer
 * needs) and the boot-time recovery sweep (`sweepStaleSyncing`
 * resurrects records killed mid-network-call).
 *
 * `fake-indexeddb/auto` replaces the global `indexedDB` with an
 * in-memory implementation BEFORE `db.ts` is imported, so the
 * Dexie singleton transparently runs against a fake backend. No
 * production code knows or cares.
 */

import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetForTests, queueDb, sweepStaleSyncing } from "@/lib/queue/db";
import type {
  BlobRecord,
  DraftRecord,
  QueueRecord,
} from "@/lib/queue/types";

import type { ExtractedFields } from "@/lib/api";

// Minimal extracted-fields fixture. The queue layer doesn't care
// about field shape; the drainer (sprint 2) does. We just need
// something round-trippable.
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

beforeEach(async () => {
  await _resetForTests();
});

afterEach(async () => {
  await _resetForTests();
});

describe("queueDb — captures table", () => {
  it("round-trips a record", async () => {
    const record = makeRecord();
    await queueDb.captures.add(record);
    const loaded = await queueDb.captures.get(record.id);
    expect(loaded).toEqual(record);
  });

  it("orders by created_at ascending (FIFO drain)", async () => {
    const a = makeRecord({ created_at: 1000 });
    const b = makeRecord({ created_at: 2000 });
    const c = makeRecord({ created_at: 1500 });
    await queueDb.captures.bulkAdd([b, a, c]);
    const ordered = await queueDb.captures.orderBy("created_at").toArray();
    expect(ordered.map((r) => r.id)).toEqual([a.id, c.id, b.id]);
  });

  it("filters by state", async () => {
    const pendingSave = makeRecord({ state: "pending_save" });
    const pendingExtract = makeRecord({ state: "pending_extraction" });
    const syncing = makeRecord({ state: "syncing" });
    await queueDb.captures.bulkAdd([pendingSave, pendingExtract, syncing]);

    const syncingOnly = await queueDb.captures.where("state").equals("syncing").toArray();
    expect(syncingOnly).toHaveLength(1);
    expect(syncingOnly[0]!.id).toBe(syncing.id);
  });

  it("rejects a duplicate id (uniqueness enforced)", async () => {
    const record = makeRecord();
    await queueDb.captures.add(record);
    await expect(queueDb.captures.add(record)).rejects.toThrow();
  });
});

describe("queueDb — blobs table", () => {
  it("round-trips blob metadata and stores the blob value", async () => {
    // jsdom + fake-indexeddb doesn't preserve Blob prototype fidelity
    // through structured-clone (the readback isn't a real Blob), so we
    // assert on the metadata we control. Real-browser Blob round-trip
    // is covered by device QA — see plan §11.4.
    const original = new Blob(["hello world"], { type: "text/plain" });
    const record: BlobRecord = {
      id: "blob-1",
      blob: original,
      content_type: "text/plain",
      bytes: original.size,
    };
    await queueDb.blobs.add(record);
    const loaded = await queueDb.blobs.get("blob-1");
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe("blob-1");
    expect(loaded!.bytes).toBe(original.size);
    expect(loaded!.content_type).toBe("text/plain");
    expect(loaded!.blob).toBeDefined();
  });
});

describe("queueDb — drafts table", () => {
  it("upserts the latest draft for a source via put()", async () => {
    const draft: DraftRecord = {
      id: "draft-1",
      source: "text",
      extracted: { fields: fakeFields, original_text: "Maria Lopez 555-0192" },
      edits: {},
      photo_blob_id: null,
      last_touched_at: Date.now(),
    };
    await queueDb.drafts.put(draft);
    const updated = { ...draft, last_touched_at: draft.last_touched_at + 1500 };
    await queueDb.drafts.put(updated);
    const loaded = await queueDb.drafts.get("draft-1");
    expect(loaded!.last_touched_at).toBe(updated.last_touched_at);
  });

  it("filters by last_touched_at for the 24h abandonment sweep", async () => {
    const now = Date.now();
    const fresh: DraftRecord = {
      id: "fresh",
      source: "text",
      extracted: { fields: fakeFields, original_text: "" },
      edits: {},
      photo_blob_id: null,
      last_touched_at: now,
    };
    const stale: DraftRecord = { ...fresh, id: "stale", last_touched_at: now - 25 * 60 * 60 * 1000 };
    await queueDb.drafts.bulkAdd([fresh, stale]);

    const cutoff = now - 24 * 60 * 60 * 1000;
    const expired = await queueDb.drafts.where("last_touched_at").below(cutoff).toArray();
    expect(expired.map((d) => d.id)).toEqual(["stale"]);
  });
});

describe("sweepStaleSyncing", () => {
  it("returns 0 and is a no-op when no syncing records exist", async () => {
    await queueDb.captures.add(makeRecord({ state: "pending_save" }));
    const swept = await sweepStaleSyncing();
    expect(swept).toBe(0);
  });

  it("flips syncing-without-extracted to pending_extraction", async () => {
    const record = makeRecord({
      state: "syncing",
      extracted: null,
      raw_input: { text: "raw note", audio_blob_id: null, photo_blob_id: null },
    });
    await queueDb.captures.add(record);

    const swept = await sweepStaleSyncing();
    expect(swept).toBe(1);
    const after = await queueDb.captures.get(record.id);
    expect(after!.state).toBe("pending_extraction");
  });

  it("flips syncing-with-extracted to pending_save", async () => {
    const record = makeRecord({ state: "syncing" }); // extracted populated by default
    await queueDb.captures.add(record);

    const swept = await sweepStaleSyncing();
    expect(swept).toBe(1);
    const after = await queueDb.captures.get(record.id);
    expect(after!.state).toBe("pending_save");
  });

  it("handles a mixed queue in a single transaction", async () => {
    const raw = makeRecord({ id: "a", state: "syncing", extracted: null });
    const extracted = makeRecord({ id: "b", state: "syncing" });
    const untouched = makeRecord({ id: "c", state: "pending_save" });
    await queueDb.captures.bulkAdd([raw, extracted, untouched]);

    const swept = await sweepStaleSyncing();
    expect(swept).toBe(2);
    expect((await queueDb.captures.get("a"))!.state).toBe("pending_extraction");
    expect((await queueDb.captures.get("b"))!.state).toBe("pending_save");
    expect((await queueDb.captures.get("c"))!.state).toBe("pending_save");
  });
});
