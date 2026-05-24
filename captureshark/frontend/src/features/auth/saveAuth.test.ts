import { describe, expect, it } from "vitest";

import { checkSaveAuth } from "./saveAuth";

const baseSheet = {
  spreadsheet_id: "abc",
  worksheet_title: "Sheet1",
  display_name: "My leads",
};

describe("checkSaveAuth", () => {
  it("allows when backend OAuth is not configured (dev / half-set env)", () => {
    expect(
      checkSaveAuth({
        authConfigured: false,
        authStatus: "signed-out",
        hasDriveAccess: false,
        connectedSheet: null,
      }),
    ).toEqual({ kind: "allow" });
  });

  it("allows when signed-in with drive + a picked sheet", () => {
    expect(
      checkSaveAuth({
        authConfigured: true,
        authStatus: "signed-in",
        hasDriveAccess: true,
        connectedSheet: baseSheet,
      }),
    ).toEqual({ kind: "allow" });
  });

  it("routes to needs-retry when signed-in but missing drive access", () => {
    expect(
      checkSaveAuth({
        authConfigured: true,
        authStatus: "signed-in",
        hasDriveAccess: false,
        connectedSheet: null,
      }),
    ).toEqual({ kind: "needs-retry" });
  });

  it("routes to needs-sign-in when signed-in + drive but no sheet picked", () => {
    expect(
      checkSaveAuth({
        authConfigured: true,
        authStatus: "signed-in",
        hasDriveAccess: true,
        connectedSheet: null,
      }),
    ).toEqual({ kind: "needs-sign-in" });
  });

  it("routes to needs-sign-in when signed-out", () => {
    expect(
      checkSaveAuth({
        authConfigured: true,
        authStatus: "signed-out",
        hasDriveAccess: false,
        connectedSheet: null,
      }),
    ).toEqual({ kind: "needs-sign-in" });
  });

  it("routes to needs-sign-in when status is still unknown", () => {
    expect(
      checkSaveAuth({
        authConfigured: true,
        authStatus: "unknown",
        hasDriveAccess: false,
        connectedSheet: null,
      }),
    ).toEqual({ kind: "needs-sign-in" });
  });

  it("treats authConfigured=null (still resolving) as needing sign-in for safety", () => {
    // authConfigured===false is the explicit dev-mode allow; null means we
    // haven't heard back yet, so we should NOT allow a save through.
    expect(
      checkSaveAuth({
        authConfigured: null,
        authStatus: "signed-out",
        hasDriveAccess: false,
        connectedSheet: null,
      }),
    ).toEqual({ kind: "needs-sign-in" });
  });
});
