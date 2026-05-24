/**
 * Auth store — the frontend's single source of truth for "who am I, am I
 * signed in, and can I save to a sheet right now?"
 *
 * Per tech-plan §5: one Zustand store per feature. This is the auth one.
 * Components subscribe via selector hooks; the actions encapsulate every
 * call to `/auth/*` so feature code never touches `lib/api.ts` directly
 * for auth.
 *
 * Persistence:
 *   We deliberately do *not* persist the signed-in state to localStorage.
 *   The HttpOnly session cookie is the source of truth (set by the
 *   backend, invisible to JS). We re-fetch `/auth/me` on every app load —
 *   that round-trip is the authoritative answer. Persisting a "yes I'm
 *   signed in" flag here would lie to the UI for a few hundred ms after
 *   the cookie has actually expired, which is exactly the wrong direction
 *   for a 75-year-old broker who just hit "Save" expecting it to work.
 */

import { create } from "zustand";

import {
  fetchAuthConfig,
  fetchAuthMe,
  signOut as apiSignOut,
  type ConnectedSheet,
} from "@/lib/api";

/** Coarse states the UI can branch on without a `?.` ladder. */
export type AuthStatus =
  /** Initial state, before the first `/auth/me` round-trip resolves. */
  | "unknown"
  /** Backend confirmed: no valid session cookie. */
  | "signed-out"
  /** Backend confirmed: signed in. Check `hasDriveAccess` for capability. */
  | "signed-in";

export interface AuthUser {
  email: string;
  name: string | null;
  picture_url: string | null;
}

interface AuthState {
  /** Has the backend told us anything yet? `unknown` until first refresh. */
  status: AuthStatus;
  /** Populated when `status === "signed-in"`. */
  user: AuthUser | null;
  /**
   * True iff the user granted the `drive.file` scope on Google's consent
   * screen. False = they signed in but skipped the permission checkbox;
   * the UI shows the "permission was skipped" retry card.
   */
  hasDriveAccess: boolean;
  /**
   * The Google Sheet the user picked via the Picker, or `null` if
   * they signed in but haven't run the Picker yet. The save flow
   * gates on this — null = open Picker before saving.
   */
  connectedSheet: ConnectedSheet | null;
  /**
   * Has the server been wired with OAuth credentials at all? `false` on
   * a half-configured dev backend; the UI should hide the "Sign in" CTA.
   * `null` means we haven't asked yet.
   */
  configured: boolean | null;
  /**
   * Cloud project number the Picker SDK needs for `setAppId`. Cached
   * here from `/auth/config` so the Picker helper can read it
   * synchronously when opening the dialog. `null` when the backend
   * isn't OAuth-configured.
   */
  googleAppId: string | null;

  // Actions
  /** Re-pull `/auth/me` and `/auth/config`. Safe to call any time. */
  refresh: () => Promise<void>;
  /** Hit `/auth/sign-out` and zero local state. */
  signOut: () => Promise<void>;
  /**
   * Update the connected-sheet slice locally — used right after the
   * Picker returns so the UI updates immediately, before the next
   * `/auth/me` round-trip would see it.
   */
  setConnectedSheet: (sheet: ConnectedSheet) => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  status: "unknown",
  user: null,
  hasDriveAccess: false,
  connectedSheet: null,
  configured: null,
  googleAppId: null,

  refresh: async () => {
    // Two parallel fetches: identity + capability vs config flag. They
    // don't depend on each other; running serial would just add latency
    // to the only render that ever blocks on this state.
    const [me, config] = await Promise.all([
      fetchAuthMe().catch(() => null),
      fetchAuthConfig().catch(
        () => ({ configured: false, google_app_id: null }) as const,
      ),
    ]);
    if (me === null) {
      set({
        status: "signed-out",
        user: null,
        hasDriveAccess: false,
        connectedSheet: null,
        configured: config.configured,
        googleAppId: config.google_app_id,
      });
      return;
    }
    // Dev-only QA simulator: `?fresh=1` pretends the user hasn't
    // connected a sheet yet, so the next save opens the Picker. The
    // backend connection is left untouched — flipping the flag back
    // off (or visiting any URL without it) restores the real state.
    // Stripped from prod by Vite DCE on `import.meta.env.DEV`.
    const simFresh =
      import.meta.env.DEV &&
      typeof location !== "undefined" &&
      new URLSearchParams(location.search).get("fresh") === "1";
    set({
      status: "signed-in",
      user: me.user,
      hasDriveAccess: me.has_drive_access,
      connectedSheet: simFresh ? null : me.connected_sheet,
      configured: config.configured,
      googleAppId: config.google_app_id,
    });
  },

  signOut: async () => {
    try {
      await apiSignOut();
    } catch {
      // Even if the network call fails (offline, server down), clear
      // local state — the user clicked "sign out" and expects to feel
      // signed out. Worst case the cookie outlives the local state by
      // a few minutes; the next page load resyncs.
    }
    set({
      status: "signed-out",
      user: null,
      hasDriveAccess: false,
      connectedSheet: null,
    });
  },

  setConnectedSheet: (sheet) => {
    set({ connectedSheet: sheet });
  },
}));

// --- Selector hooks (preferred over reading whole store in components) ----

/** Convenience: just the boolean. */
export const useIsSignedIn = (): boolean =>
  useAuthStore((s) => s.status === "signed-in");

/** Convenience: `null` until `/auth/me` resolves the first time. */
export const useAuthUser = (): AuthUser | null => useAuthStore((s) => s.user);

/**
 * The user is signed in *and* the backend's OAuth tokens cover the
 * Drive scope. Anything that calls a Google API guards on this — e.g.
 * the "Save to sheet" path.
 */
export const useCanSaveToSheet = (): boolean =>
  useAuthStore((s) => s.status === "signed-in" && s.hasDriveAccess);

/** Convenience: the user's picked sheet, or null if they haven't picked one yet. */
export const useConnectedSheet = (): ConnectedSheet | null =>
  useAuthStore((s) => s.connectedSheet);
