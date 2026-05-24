/**
 * Feature-flags store — server-controlled switches the frontend reads at
 * boot and branches on.
 *
 * Per tech-plan §5: one Zustand store per feature surface. Feature flags
 * are deliberately separate from `auth.ts` — semantically distinct
 * (capability advertised to the client vs. who the user is), and keeping
 * them apart means an auth refresh after sign-in doesn't churn flag state.
 *
 * Fetched in parallel with `/auth/me` + `/auth/config` from `App.tsx` at
 * boot — adding this third request costs nothing on the wire.
 */

import { create } from "zustand";

import { fetchFeatures, type FeatureFlags } from "@/lib/api";

interface FeaturesState {
  /**
   * The latest flag values from the server. `null` until the first
   * `/features` round-trip resolves — components default to "off" while
   * `null` so a slow boot never accidentally renders gated UI.
   */
  flags: FeatureFlags | null;
  /** Re-pull `/features`. Safe to call any time. */
  refresh: () => Promise<void>;
}

const FALLBACK: FeatureFlags = {
  live_captions_enabled: false,
};

export const useFeaturesStore = create<FeaturesState>()((set) => ({
  flags: null,
  refresh: async () => {
    try {
      const flags = await fetchFeatures();
      set({ flags });
    } catch {
      // Backend unreachable at boot — fall through to "everything off"
      // rather than leaving `flags === null` forever, which would keep
      // gated UI hidden anyway. The conservative default matches what
      // gated branches assume.
      set({ flags: FALLBACK });
    }
  },
}));

/** Convenience: just the live-captions boolean, defaulting to `false`. */
export const useLiveCaptionsEnabled = (): boolean =>
  useFeaturesStore((s) => s.flags?.live_captions_enabled ?? false);
