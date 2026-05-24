/**
 * Unit tests for the action helpers — `enqueueExtractedLead`,
 * `enqueueExtractedPhotoRows`, `enqueueRawPhoto`, and `discardCapture`.
 *
 * Covers plan §9.9 (discard contract), plus the Item 0 / 1a / 1b
 * enqueue paths and their atomicity guarantees.
 */

import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discardCapture,
  enqueueExtractedLead,
  enqueueExtractedPhotoRows,
  enqueueRawPhoto,
} from "@/lib/queue/actions";
import { _resetForTests, queueDb } from "@/lib/queue/db";
import type { ExtractedField, ExtractedFields, PhotoRow } from "@/lib/api";
import type {
  BlobRecord,
  QueueRecord,
  QueueState,
} from "@/lib/queue/types";

function makeField(value: string): ExtractedField {
  return { value, confidence: "high", alternatives: [] };
}

function makeFields(name: string, phone = "", email = ""): ExtractedFields {
  return {
    name: makeField(name),
    phone: makeField(phone),
    email: makeField(email),
    has_agent: makeField("no"),
    intent: makeField(""),
    timeline: makeField(""),
    financing_status: makeField(""),
    budget: makeField(""),
    area: makeField(""),
    follow_up: makeField(""),
    notes: makeField(""),
  };
}

function makePhotoRow(idempotencyKey: string, name: string): PhotoRow {
  return {
    row_index: 0,
    idempotency_key: idempotencyKey,
    fields: makeFields(name),
    row_confidence: "high",
    warnings: [],
  };
}

function makeRecord(
  id: string,
  state: QueueState,
  overrides: Partial<QueueRecord> = {},
): QueueRecord {
  return {
    id,
    created_at: 1_700_000_000_000,
    source: "text",
    state,
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    idempotency_key: id,
    sheet_target: {
      spreadsheet_id: "sheet-1",
      tab_name: "Leads",
      display_name: "Open House Leads",
    },
    raw_input: { text: "raw", audio_blob_id: null, photo_blob_id: null },
    extracted: null,
    ...overrides,
  };
}

function makeBlob(id: string): BlobRecord {
  return {
    id,
    blob: new Blob(["x"], { type: "application/octet-stream" }),
    content_type: "application/octet-stream",
    bytes: 1,
  };
}

beforeEach(async () => {
  await _resetForTests();
});

afterEach(async () => {
  await _resetForTests();
});

describe("enqueueExtractedLead", () => {
  const sheetTarget = {
    spreadsheet_id: "sheet-1",
    tab_name: "Leads",
    display_name: "Open House Leads",
  };

  it("writes a single pending_save record with the expected shape", async () => {
    await enqueueExtractedLead({
      source: "text",
      fields: makeFields("Maria"),
      originalText: "Maria called from Tustin",
      sheetTarget,
      now: () => 1_700_000_000_000,
    });

    const all = await queueDb.captures.toArray();
    expect(all).toHaveLength(1);
    expect(all[0]?.state).toBe("pending_save");
    expect(all[0]?.source).toBe("text");
    expect(all[0]?.extracted?.fields.name.value).toBe("Maria");
    expect(all[0]?.extracted?.original_text).toBe("Maria called from Tustin");
    expect(all[0]?.attempts).toBe(0);
    expect(all[0]?.raw_input).toEqual({
      text: null,
      audio_blob_id: null,
      photo_blob_id: null,
    });
  });

  it("uses the supplied idempotencyKey when provided", async () => {
    await enqueueExtractedLead({
      source: "voice",
      fields: makeFields("Bob"),
      originalText: "voice transcript",
      sheetTarget,
      idempotencyKey: "key-from-caller",
    });
    const record = await queueDb.captures.toArray();
    expect(record[0]?.idempotency_key).toBe("key-from-caller");
  });

  it("mints an idempotencyKey when none is supplied", async () => {
    await enqueueExtractedLead({
      source: "text",
      fields: makeFields("Alice"),
      originalText: "note",
      sheetTarget,
    });
    const record = await queueDb.captures.toArray();
    expect(record[0]?.idempotency_key).toBeTruthy();
    expect(record[0]?.idempotency_key.length).toBeGreaterThan(0);
  });
});

describe("enqueueExtractedPhotoRows", () => {
  const sheetTarget = {
    spreadsheet_id: "sheet-1",
    tab_name: "Leads",
    display_name: "Open House Leads",
  };

  it("creates N pending_save records with deterministic photo: IDs", async () => {
    const rows = [
      makePhotoRow("server-key-a", "Maria"),
      makePhotoRow("server-key-b", "Bob"),
      makePhotoRow("server-key-c", "Alice"),
    ];

    const count = await enqueueExtractedPhotoRows({ rows, sheetTarget });

    expect(count).toBe(3);
    const all = await queueDb.captures.toArray();
    expect(all).toHaveLength(3);
    const ids = all.map((r) => r.id).sort();
    expect(ids).toEqual([
      "photo:server-key-a",
      "photo:server-key-b",
      "photo:server-key-c",
    ]);
    for (const record of all) {
      expect(record.state).toBe("pending_save");
      expect(record.source).toBe("photo");
      expect(record.attempts).toBe(0);
    }
  });

  it("staggers created_at by row index so FIFO drain preserves reading order", async () => {
    const rows = [
      makePhotoRow("k1", "First"),
      makePhotoRow("k2", "Second"),
      makePhotoRow("k3", "Third"),
    ];

    await enqueueExtractedPhotoRows({
      rows,
      sheetTarget,
      now: () => 1_700_000_000_000,
    });

    const ordered = await queueDb.captures
      .orderBy("created_at")
      .toArray();
    expect(ordered.map((r) => r.idempotency_key)).toEqual(["k1", "k2", "k3"]);
  });

  it("is idempotent on double-tap (same idempotency keys overwrite, no duplicates)", async () => {
    const rows = [
      makePhotoRow("dup-a", "Maria"),
      makePhotoRow("dup-b", "Bob"),
    ];

    await enqueueExtractedPhotoRows({ rows, sheetTarget });
    await enqueueExtractedPhotoRows({ rows, sheetTarget });

    const all = await queueDb.captures.toArray();
    expect(all).toHaveLength(2);
  });

  it("is a no-op when given zero rows", async () => {
    const count = await enqueueExtractedPhotoRows({ rows: [], sheetTarget });
    expect(count).toBe(0);
    expect(await queueDb.captures.count()).toBe(0);
  });
});

describe("enqueueRawPhoto", () => {
  const sheetTarget = {
    spreadsheet_id: "sheet-1",
    tab_name: "Leads",
    display_name: "Open House Leads",
  };

  it("writes a pending_extraction record + photo blob in one transaction", async () => {
    const blob = new Blob(["fake-image-bytes"], { type: "image/jpeg" });

    const record = await enqueueRawPhoto({ blob, sheetTarget });

    expect(record.state).toBe("pending_extraction");
    expect(record.source).toBe("photo");
    expect(record.raw_input.photo_blob_id).toBeTruthy();
    expect(record.extracted).toBeNull();

    const allRecords = await queueDb.captures.toArray();
    expect(allRecords).toHaveLength(1);

    const allBlobs = await queueDb.blobs.toArray();
    expect(allBlobs).toHaveLength(1);
    expect(allBlobs[0]?.id).toBe(record.raw_input.photo_blob_id);
    expect(allBlobs[0]?.content_type).toBe("image/jpeg");
    expect(allBlobs[0]?.bytes).toBe(blob.size);
  });

  it("falls back to image/jpeg when blob has no type and no override", async () => {
    const blob = new Blob(["bytes"]);
    await enqueueRawPhoto({ blob, sheetTarget });
    const blobs = await queueDb.blobs.toArray();
    expect(blobs[0]?.content_type).toBe("image/jpeg");
  });

  it("honours an explicit contentType override", async () => {
    const blob = new Blob(["bytes"], { type: "image/png" });
    await enqueueRawPhoto({
      blob,
      sheetTarget,
      contentType: "image/webp",
    });
    const blobs = await queueDb.blobs.toArray();
    expect(blobs[0]?.content_type).toBe("image/webp");
  });
});

describe("discardCapture", () => {
  it("removes a pending_save record from the queue", async () => {
    await queueDb.captures.add(makeRecord("a", "pending_save"));
    await discardCapture("a");
    expect(await queueDb.captures.count()).toBe(0);
  });

  it("deletes the associated photo blob in the same transaction", async () => {
    await queueDb.blobs.add(makeBlob("blob-1"));
    await queueDb.captures.add(
      makeRecord("a", "pending_save", {
        source: "photo",
        raw_input: {
          text: null,
          audio_blob_id: null,
          photo_blob_id: "blob-1",
        },
      }),
    );
    await discardCapture("a");
    expect(await queueDb.blobs.count()).toBe(0);
  });

  it("deletes both audio and photo blobs if the record has them", async () => {
    await queueDb.blobs.bulkAdd([makeBlob("aud-1"), makeBlob("pic-1")]);
    await queueDb.captures.add(
      makeRecord("a", "failed_permanent", {
        raw_input: {
          text: null,
          audio_blob_id: "aud-1",
          photo_blob_id: "pic-1",
        },
      }),
    );
    await discardCapture("a");
    expect(await queueDb.blobs.count()).toBe(0);
  });

  it("rejects when the record is currently syncing", async () => {
    await queueDb.captures.add(makeRecord("a", "syncing"));
    await expect(discardCapture("a")).rejects.toThrow(/syncing/);
    expect(await queueDb.captures.count()).toBe(1);
  });

  it("is a no-op for an unknown id (no throw)", async () => {
    await expect(discardCapture("ghost")).resolves.toBeUndefined();
  });
});
