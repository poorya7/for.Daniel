import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStablePartialBuffer } from "./stablePartialBuffer";

describe("createStablePartialBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("paints append-only growth immediately (the common case)", () => {
    const onStable = vi.fn();
    const buf = createStablePartialBuffer({ onStable, stableMs: 200 });

    buf.push("hello");
    expect(onStable).toHaveBeenLastCalledWith("hello");

    buf.push("hello world");
    expect(onStable).toHaveBeenLastCalledWith("hello world");

    buf.push("hello world how");
    expect(onStable).toHaveBeenLastCalledWith("hello world how");

    expect(onStable).toHaveBeenCalledTimes(3);
  });

  it("holds a true revision and paints it after the settling window", () => {
    const onStable = vi.fn();
    const buf = createStablePartialBuffer({ onStable, stableMs: 200 });

    buf.push("Maria");
    expect(onStable).toHaveBeenLastCalledWith("Maria");

    // Earlier character changed (a → o) — revision, not append.
    buf.push("Mario");
    expect(onStable).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(199);
    expect(onStable).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(onStable).toHaveBeenCalledTimes(2);
    expect(onStable).toHaveBeenLastCalledWith("Mario");
  });

  it("suppresses a revision that gets replaced inside the window", () => {
    const onStable = vi.fn();
    const buf = createStablePartialBuffer({ onStable, stableMs: 200 });

    buf.push("Maria");
    buf.push("Mario");
    vi.advanceTimersByTime(100);
    buf.push("Marion"); // still a revision relative to painted "Maria"
    vi.advanceTimersByTime(199);
    expect(onStable).toHaveBeenCalledTimes(1); // still only "Maria"
    vi.advanceTimersByTime(1);
    expect(onStable).toHaveBeenLastCalledWith("Marion");
  });

  it("append-only AFTER a settled revision paints immediately", () => {
    const onStable = vi.fn();
    const buf = createStablePartialBuffer({ onStable, stableMs: 200 });

    buf.push("Maria");
    buf.push("Mario");
    vi.advanceTimersByTime(200);
    expect(onStable).toHaveBeenLastCalledWith("Mario");

    // Extend the settled revision — back to append-only territory.
    buf.push("Mario Lopez");
    expect(onStable).toHaveBeenLastCalledWith("Mario Lopez");
  });

  it("clear() resets the painted baseline so the next turn starts fresh", () => {
    const onStable = vi.fn();
    const buf = createStablePartialBuffer({ onStable, stableMs: 200 });

    buf.push("Maria five five");
    buf.clear();
    // Next turn — completely unrelated text. Should paint as append-from-empty.
    buf.push("call her tomorrow");
    expect(onStable).toHaveBeenLastCalledWith("call her tomorrow");
  });

  it("dispose() prevents any further emissions", () => {
    const onStable = vi.fn();
    const buf = createStablePartialBuffer({ onStable, stableMs: 200 });

    buf.push("Maria");
    expect(onStable).toHaveBeenCalledTimes(1);

    buf.push("Mario"); // pending revision, would otherwise fire after 200ms
    buf.dispose();
    vi.advanceTimersByTime(500);
    expect(onStable).toHaveBeenCalledTimes(1);

    buf.push("anything");
    vi.advanceTimersByTime(500);
    expect(onStable).toHaveBeenCalledTimes(1);
  });

  it("defaults to a 200ms revision window when none is supplied", () => {
    const onStable = vi.fn();
    const buf = createStablePartialBuffer({ onStable });

    buf.push("Maria");
    buf.push("Mario");
    vi.advanceTimersByTime(199);
    expect(onStable).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onStable).toHaveBeenCalledTimes(2);
  });
});
