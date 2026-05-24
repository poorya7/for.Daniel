/**
 * Google Picker SDK integration — opens the spreadsheet-pick dialog.
 *
 * Why this is its own file:
 *
 *   * Loads the GAPI + Picker scripts on demand (they're hosted by
 *     Google, not bundled — no point shipping kilobytes of code most
 *     visitors never reach).
 *   * Wraps the callback-style SDK in a Promise so feature code
 *     (`ReviewCard`, `App`) reads top-to-bottom instead of bouncing
 *     into a callback.
 *   * Confines the `any`-typed SDK surface here. The exported
 *     `openSpreadsheetPicker` returns a strongly-typed `PickedSheet`
 *     or `null`; callers never touch the global `google.picker.*`
 *     namespace.
 *
 * What we feed the Picker:
 *
 *   * **App ID** — Google Cloud project number, derived from the
 *     OAuth client_id on the backend, surfaced via `/auth/config`.
 *   * **OAuth token** — short-lived access token from
 *     `/auth/picker-token`. Picker uses it to call Drive on behalf
 *     of the user. Never persisted on the frontend; lifetime is the
 *     dialog only.
 *   * **Origin** — `window.location.origin` (e.g. `http://localhost:5174`)
 *     so Google verifies the request matches one of the Authorized
 *     JavaScript origins on the OAuth client.
 *
 * Per spec §3 we use the *Picker API* rather than rolling our own
 * file browser — it's the official mobile-friendly path.
 */

const GAPI_SCRIPT_SRC = "https://apis.google.com/js/api.js";

/** What we hand back to callers — minimal, strongly typed. */
export interface PickedSheet {
  spreadsheet_id: string;
  display_name: string;
}

// --- SDK type declarations -------------------------------------------------
//
// Google doesn't ship a typed `@types/google.picker` package on
// DefinitelyTyped. We declare just the slice we touch here; the rest
// of the SDK stays `unknown` to the type-checker. Keeping the
// declarations local (rather than a global ambient .d.ts) keeps the
// project tree small.

interface GapiLoad {
  load: (libraries: string, opts: { callback: () => void }) => void;
}

declare const gapi: GapiLoad;

interface PickerCallbackData {
  action: string;
  docs?: ReadonlyArray<{ id?: string; name?: string }>;
}

interface PickerBuilder {
  addView: (viewId: unknown) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setAppId: (appId: string) => PickerBuilder;
  setOrigin: (origin: string) => PickerBuilder;
  setCallback: (cb: (data: PickerCallbackData) => void) => PickerBuilder;
  build: () => PickerInstance;
}

interface PickerInstance {
  setVisible: (visible: boolean) => void;
}

interface GooglePickerNamespace {
  PickerBuilder: new () => PickerBuilder;
  ViewId: { SPREADSHEETS: unknown };
  Action: { PICKED: string; CANCEL: string };
}

interface GoogleGlobal {
  picker: GooglePickerNamespace;
}

declare const google: GoogleGlobal;

// --- Implementation --------------------------------------------------------

interface OpenPickerOptions {
  accessToken: string;
  appId: string;
}

/**
 * Open the spreadsheet picker. Resolves with the user's selection,
 * or `null` if they closed the dialog without picking.
 *
 * Throws on script-load failure or missing-globals (likely network
 * down or a content-security-policy that blocks `apis.google.com`).
 * Callers surface that as a plain-English "Couldn't open the sheet
 * picker — check your connection." copy.
 */
export async function openSpreadsheetPicker(
  opts: OpenPickerOptions,
): Promise<PickedSheet | null> {
  await _loadGapiScript();
  await _loadPickerModule();

  return new Promise<PickedSheet | null>((resolve) => {
    const picker = new google.picker.PickerBuilder()
      .addView(google.picker.ViewId.SPREADSHEETS)
      .setOAuthToken(opts.accessToken)
      .setAppId(opts.appId)
      .setOrigin(window.location.origin)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          const doc = data.docs?.[0];
          if (doc?.id && doc.name) {
            resolve({ spreadsheet_id: doc.id, display_name: doc.name });
            return;
          }
          // Pick action with no usable doc shape — treat as cancel.
          resolve(null);
          return;
        }
        if (data.action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

// --- Script-loading internals ---------------------------------------------

let _gapiLoadPromise: Promise<void> | null = null;
let _pickerLoadPromise: Promise<void> | null = null;

/**
 * Inject the GAPI bootstrap `<script>` once per page, and resolve
 * after `gapi` becomes available. Memoised — repeated calls reuse
 * the first promise so we never load the script twice.
 */
function _loadGapiScript(): Promise<void> {
  if (_gapiLoadPromise) return _gapiLoadPromise;
  _gapiLoadPromise = new Promise<void>((resolve, reject) => {
    if (typeof gapi !== "undefined") {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = GAPI_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      resolve();
    };
    script.onerror = () => {
      _gapiLoadPromise = null; // allow retry after recoverable failure
      reject(new Error("Couldn't load the Google Picker. Check your connection."));
    };
    document.head.appendChild(script);
  });
  return _gapiLoadPromise;
}

/**
 * After `gapi` exists, ask it to load the `picker` module. Memoised
 * for the same reason as the GAPI load — second click on the same
 * Sign-in screen reuses the first promise.
 */
function _loadPickerModule(): Promise<void> {
  if (_pickerLoadPromise) return _pickerLoadPromise;
  _pickerLoadPromise = new Promise<void>((resolve) => {
    gapi.load("picker", { callback: () => resolve() });
  });
  return _pickerLoadPromise;
}
