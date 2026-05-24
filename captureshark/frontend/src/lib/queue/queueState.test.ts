/**
 * Unit tests for the pure selector (`summarise`).
 *
 * The hooks themselves (`useLiveRecords`, `useOnlineState`,
 * `useQueueSummary`) are integration-tested at the component layer —
 * fake-indexeddb + React Testing Library would add disproportionate
 * setup for what is essentially "pass-through to Dexie's liveQuery
 * and `useSyncExternalStore`". This file covers the bit of logic
 * that's actually ours.
 */

import { describe, expect, it } from "vitest";

import { summarise } from "@/lib/queue/queueState";
import type { QueueRecord, QueueState } from "@/lib/queue/types";

function makeRecord(id: string, state: QueueState): QueueRecord {
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
  };
}

describe("summarise", () => {
  it("returns zeros on an empty queue", () => {
    expect(summarise([])).toEqual({
      total: 0,
      pending: 0,
      failed_auth: 0,
      failed_permanent: 0,
    });
  });

  it("counts the four auto-progressing states as pending", () => {
    const records: QueueRecord[] = [
      makeRecord("a", "pending_extraction"),
      makeRecord("b", "pending_save"),
      makeRecord("c", "syncing"),
      makeRecord("d", "failed_transient"),
    ];
    const summary = summarise(records);
    expect(summary.pending).toBe(4);
    expect(summary.failed_auth).toBe(0);
    expect(summary.failed_permanent).toBe(0);
    expect(summary.total).toBe(4);
  });

  it("counts failed_auth separately from pending", () => {
    const records: QueueRecord[] = [
      makeRecord("a", "pending_save"),
      makeRecord("b", "failed_auth"),
      makeRecord("c", "failed_auth"),
    ];
    const summary = summarise(records);
    expect(summary.pending).toBe(1);
    expect(summary.failed_auth).toBe(2);
    expect(summary.total).toBe(3);
  });

  it("counts failed_permanent separately from pending", () => {
    const records: QueueRecord[] = [
      makeRecord("a", "pending_save"),
      makeRecord("b", "failed_permanent"),
    ];
    const summary = summarise(records);
    expect(summary.pending).toBe(1);
    expect(summary.failed_permanent).toBe(1);
    expect(summary.failed_auth).toBe(0);
  });

  it("handles a mixed queue", () => {
    const records: QueueRecord[] = [
      makeRecord("a", "pending_save"),
      makeRecord("b", "pending_save"),
      makeRecord("c", "syncing"),
      makeRecord("d", "failed_transient"),
      makeRecord("e", "failed_auth"),
      makeRecord("f", "failed_permanent"),
    ];
    const summary = summarise(records);
    expect(summary).toEqual({
      total: 6,
      pending: 4,
      failed_auth: 1,
      failed_permanent: 1,
    });
  });
});
