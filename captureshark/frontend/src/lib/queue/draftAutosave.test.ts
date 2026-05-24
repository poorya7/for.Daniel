/**
 * Tests for review-draft autosave. Pins the four behaviours plan
 * §4.3 specifies:
 *
 *   1. saveDraft writes a record the consumer can read back.
 *   2. The debounced wrapper coalesces rapid edits into one write.
 *   3. restoreLatestDraft returns the freshest non-stale draft.
 *   4. sweepStaleDrafts removes anything older than 24h.
 */

import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetForTests, queueDb } from "@/lib/queue/db";
import {
  DRAFT_MAX_AGE_MS,
  clearDraft,
  createDebouncedDraftSaver,
  restoreLatestDraft,
  saveDraft,
  sweepStaleDrafts,
} from "@/lib/queue/draftAutosave";
import type { QueueExtracted, QueueSource } from "@/lib/queue/types";

// ---- fixtures -------------------------------------------------------------

function makeExtracted(): QueueExtracted {
  // Minimal valid ExtractedFields — every field present with a
  // confidence so the review surface can render. Only `name` is
  // populated; the rest are nullable.
  const blank = (value: string | null = null) => ({
    value,
    confidence: "high" as const,
    alternatives: [] as string[],
  });
  return {
    fields: {
      name: blank("Maria Lopez"),
      phone: blank(),
      email: blank(),
      has_agent: blank(),
      intent: blank(),
      timeline: blank(),
      financing_status: blank(),
      budget: blank(),
      area: blank(),
      follow_up: blank(),
      notes: blank(),
    },
    original_text: "Maria Lopez 555-0192",
  };
}

function makeDraftInput(overrides: {
  id?: string;
  source?: QueueSource;
  edits?: Record<string, never> | object;
  photo_blob_id?: string | null;
  now?: () => number;
}): Parameters<typeof saveDraft>[0] {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    source: overrides.source ?? "text",
    extracted: makeExtracted(),
    edits: (overrides.edits as Record<string, never>) ?? {},
    photo_blob_id: overrides.photo_blob_id ?? null,
    now: overrides.now ?? (() => 1_000),
  };
}

// ---- lifecycle ------------------------------------------------------------

beforeEach(async () => {
  await _resetForTests();
});

afterEach(async () => {
  await _resetForTests();
  vi.useRealTimers();
});

// ---- direct save / restore -----------------------------------------------

describe("saveDraft + restoreLatestDraft", () => {
  it("writes a draft and reads it back via restoreLatestDraft", async () => {
    const id = "draft-1";
    await saveDraft(makeDraftInput({ id, now: () => 5_000 }));

    const restored = await restoreLatestDraft(() => 6_000);
    expect(restored).not.toBeNull();
    expect(restored?.id).toBe(id);
    expect(restored?.last_touched_at).toBe(5_000);
    expect(restored?.extracted.fields.name.value).toBe("Maria Lopez");
  });

  it("returns null when no draft exists", async () => {
    const restored = await restoreLatestDraft(() => 1_000);
    expect(restored).toBeNull();
  });

  it("returns the freshest draft when multiple are present", async () => {
    await saveDraft(makeDraftInput({ id: "old", now: () => 1_000 }));
    await saveDraft(makeDraftInput({ id: "newer", now: () => 2_000 }));
    await saveDraft(makeDraftInput({ id: "newest", now: () => 3_000 }));

    const restored = await restoreLatestDraft(() => 3_500);
    expect(restored?.id).toBe("newest");
  });

  it("skips drafts older than DRAFT_MAX_AGE_MS", async () => {
    // Write a draft well past the horizon — older than 24h.
    await saveDraft(makeDraftInput({ id: "stale", now: () => 100 }));
    // Plus a fresh one inside the window.
    const recent = 100 + DRAFT_MAX_AGE_MS + 1_000;
    await saveDraft(
      makeDraftInput({ id: "fresh", now: () => recent }),
    );

    const restored = await restoreLatestDraft(() => recent + 100);
    expect(restored?.id).toBe("fresh");
  });

  it("returns null when every draft is stale", async () => {
    await saveDraft(makeDraftInput({ id: "old", now: () => 1_000 }));

    const restored = await restoreLatestDraft(
      () => 1_000 + DRAFT_MAX_AGE_MS + 1,
    );
    expect(restored).toBeNull();
  });
});

// ---- clearDraft -----------------------------------------------------------

describe("clearDraft", () => {
  it("removes the named draft, leaves others alone", async () => {
    await saveDraft(makeDraftInput({ id: "keep" }));
    await saveDraft(makeDraftInput({ id: "drop" }));

    await clearDraft("drop");

    expect(await queueDb.drafts.get("drop")).toBeUndefined();
    expect(await queueDb.drafts.get("keep")).toBeDefined();
  });

  it("is a no-op when the id doesn't exist", async () => {
    await expect(clearDraft("nope")).resolves.toBeUndefined();
  });
});

// ---- sweepStaleDrafts -----------------------------------------------------

describe("sweepStaleDrafts", () => {
  it("removes drafts older than the 24h horizon and reports the count", async () => {
    const now = 10_000_000;
    await saveDraft(
      makeDraftInput({ id: "stale-1", now: () => now - DRAFT_MAX_AGE_MS - 1 }),
    );
    await saveDraft(
      makeDraftInput({ id: "stale-2", now: () => now - DRAFT_MAX_AGE_MS - 5_000 }),
    );
    await saveDraft(makeDraftInput({ id: "fresh", now: () => now - 1_000 }));

    const swept = await sweepStaleDrafts(() => now);

    expect(swept).toBe(2);
    expect(await queueDb.drafts.get("stale-1")).toBeUndefined();
    expect(await queueDb.drafts.get("stale-2")).toBeUndefined();
    expect(await queueDb.drafts.get("fresh")).toBeDefined();
  });

  it("returns 0 and writes nothing when no drafts are stale", async () => {
    const now = 10_000_000;
    await saveDraft(makeDraftInput({ id: "fresh", now: () => now - 1_000 }));

    const swept = await sweepStaleDrafts(() => now);

    expect(swept).toBe(0);
    expect(await queueDb.drafts.get("fresh")).toBeDefined();
  });
});

// ---- debounced saver ------------------------------------------------------

describe("createDebouncedDraftSaver", () => {
  // Short debounce + real timers — fake-indexeddb resolves promises
  // on microtask boundaries that fake timers don't tick, so we use
  // real timers with a tiny window for fast tests.
  const TEST_DEBOUNCE_MS = 20;

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("coalesces rapid schedules into a single write at debounce time", async () => {
    const saver = createDebouncedDraftSaver({
      debounceMs: TEST_DEBOUNCE_MS,
    });
    const id = "draft-debounced";

    // Three rapid edits — only the last should land.
    saver.schedule(makeDraftInput({ id, now: () => 100 }));
    saver.schedule(makeDraftInput({ id, now: () => 200 }));
    saver.schedule(makeDraftInput({ id, now: () => 300 }));

    // Well past the debounce — write should be flushed.
    await wait(TEST_DEBOUNCE_MS * 3);
    const written = await queueDb.drafts.get(id);
    expect(written?.last_touched_at).toBe(300);
    expect(await queueDb.drafts.count()).toBe(1);
  });

  it("flush() writes immediately and cancels the pending timer", async () => {
    const saver = createDebouncedDraftSaver({
      debounceMs: TEST_DEBOUNCE_MS,
    });
    const id = "draft-flush";

    saver.schedule(makeDraftInput({ id, now: () => 100 }));
    // Force the write before the debounce window elapses.
    await saver.flush();

    expect(await queueDb.drafts.get(id)).toBeDefined();

    // Continuing past the original debounce shouldn't double-write.
    await wait(TEST_DEBOUNCE_MS * 3);
    expect(await queueDb.drafts.count()).toBe(1);
  });

  it("cancel() drops a pending write without flushing", async () => {
    const saver = createDebouncedDraftSaver({
      debounceMs: TEST_DEBOUNCE_MS,
    });
    const id = "draft-cancel";

    saver.schedule(makeDraftInput({ id, now: () => 100 }));
    saver.cancel();

    await wait(TEST_DEBOUNCE_MS * 3);
    expect(await queueDb.drafts.get(id)).toBeUndefined();
  });

  it("flush() with nothing pending is a no-op", async () => {
    const saver = createDebouncedDraftSaver({
      debounceMs: TEST_DEBOUNCE_MS,
    });
    await expect(saver.flush()).resolves.toBeUndefined();
    expect(await queueDb.drafts.count()).toBe(0);
  });
});
