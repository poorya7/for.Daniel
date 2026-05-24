/**
 * Unit tests for the HTTP → queue-state classifier.
 *
 * Pinning the table so a future "let's just bump that to permanent"
 * tweak gets caught in CI rather than producing silent UX regressions
 * (e.g. flipping 429 from transient → permanent would surface a
 * "needs attention" pill every time Sheets rate-limits us, which is
 * the wrong call for the persona).
 */

import { describe, expect, it } from "vitest";

import { classifySaveFailure, messageForCode } from "@/lib/queue/errorMapping";
import type { QueueErrorCode } from "@/lib/queue/types";

describe("classifySaveFailure", () => {
  it("status 0 → network / failed_transient (never stop retrying)", () => {
    expect(classifySaveFailure({ status: 0, code: undefined })).toEqual({
      next_state: "failed_transient",
      error_code: "network",
    });
  });

  it("401 → auth_expired / failed_auth (halts the pass)", () => {
    expect(classifySaveFailure({ status: 401, code: "session_lost" })).toEqual({
      next_state: "failed_auth",
      error_code: "auth_expired",
    });
  });

  it("403 → forbidden / failed_permanent", () => {
    expect(classifySaveFailure({ status: 403, code: "sheet_no_permission" }))
      .toEqual({
        next_state: "failed_permanent",
        error_code: "forbidden",
      });
  });

  it("404 → not_found / failed_permanent", () => {
    expect(classifySaveFailure({ status: 404, code: "sheet_not_found" })).toEqual({
      next_state: "failed_permanent",
      error_code: "not_found",
    });
  });

  it("409 → sheet_revoked / failed_permanent", () => {
    expect(classifySaveFailure({ status: 409, code: "no_sheet_connected" }))
      .toEqual({
        next_state: "failed_permanent",
        error_code: "sheet_revoked",
      });
  });

  it("429 → ai_busy / failed_transient", () => {
    expect(classifySaveFailure({ status: 429, code: "sheets_busy" })).toEqual({
      next_state: "failed_transient",
      error_code: "ai_busy",
    });
  });

  it.each([500, 502, 503, 504, 599])(
    "%i (5xx) → network / failed_transient",
    (status) => {
      expect(classifySaveFailure({ status, code: undefined })).toEqual({
        next_state: "failed_transient",
        error_code: "network",
      });
    },
  );

  it("unmapped client error → unknown / failed_transient (bounded retry)", () => {
    expect(classifySaveFailure({ status: 418, code: "tea" })).toEqual({
      next_state: "failed_transient",
      error_code: "unknown",
    });
  });
});

describe("messageForCode", () => {
  it.each<QueueErrorCode>([
    "network",
    "ai_busy",
    "auth_expired",
    "sheet_revoked",
    "forbidden",
    "not_found",
    "schema_mismatch",
    "extraction_failed",
    "unknown",
  ])("returns a non-empty plain-English message for %s", (code) => {
    const message = messageForCode(code);
    expect(message).toBeTruthy();
    // Sanity: no raw error codes, no curly braces, no template
    // sentinels leaked through.
    expect(message).not.toMatch(/\{|\}/);
  });
});
