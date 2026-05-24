/**
 * Typed HTTP client for the CaptureShark backend.
 *
 * Conventions:
 *   - All requests go to `/api/v1/*` (Vite proxies to the FastAPI host in dev,
 *     same-origin in production).
 *   - Network and HTTP failures throw `ApiError` with a user-friendly message.
 *     Callers translate that into UI state; never surface raw fetch errors.
 *   - Response shapes are declared here as TypeScript types. Once the backend
 *     stabilises we'll generate these from `/openapi.json` (see tech plan §11)
 *     so the two stay in lockstep automatically.
 */

const API_BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, options: { status: number; code?: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
  }
}

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  environment: string;
}

/** Fetches the backend health endpoint. Used by the skeleton to verify wiring. */
export async function fetchHealth(): Promise<HealthResponse> {
  return apiGet<HealthResponse>("/health");
}

// --- Captures (text extraction) -------------------------------------------

/**
 * Mirror of the backend `Confidence` enum. Plain-English labels live in the
 * UI layer, not here — this stays aligned with the wire format only.
 */
export type Confidence = "high" | "medium" | "low";

export interface ExtractedField {
  value: string | null;
  confidence: Confidence;
  alternatives: string[];
}

/** The eleven fields v1 extracts. Order matches the review-card display
 *  order (and the JSON-schema order the backend emits, so streaming
 *  partial-JSON parsing reveals fields in the same sequence). The 3-page
 *  review layout pivots off this order:
 *    page 1 (contact + binary qualification): name / phone / email / has_agent
 *    page 2 (prioritisation enums + budget):  intent / timeline / financing_status / budget
 *    page 3 (preferences + follow-up):        area / follow_up / notes
 *  `has_agent` is on page 1 because the corner agent-status ribbon reads
 *  off it AND it's the first question listing brokers ask at open houses
 *  (NAR ethics prohibit pursuing represented buyers). intent / timeline /
 *  financing_status are constrained-enum fields rendered as multi-option
 *  pickers (an extension of the binary has_agent pattern). */
export interface ExtractedFields {
  name: ExtractedField;
  phone: ExtractedField;
  email: ExtractedField;
  has_agent: ExtractedField;
  intent: ExtractedField;
  timeline: ExtractedField;
  financing_status: ExtractedField;
  budget: ExtractedField;
  area: ExtractedField;
  follow_up: ExtractedField;
  notes: ExtractedField;
}

export interface ExtractionResult {
  fields: ExtractedFields;
  /** The text the extractor saw — echoed back so we can offer the salvage path. */
  original_text: string;
}

/**
 * Submit a free-form text note for AI extraction.
 *
 * Throws `ApiError` on any network or HTTP failure; the error's `message`
 * is already plain-English copy from the backend, safe to render directly.
 */
export async function extractTextCapture(text: string): Promise<ExtractionResult> {
  return apiPostJson<ExtractionResult>("/captures", { source: "text", text });
}

// --- Streaming partial-result types --------------------------------------

/**
 * Per-field loading sentinel: `null` means "this field hasn't fully arrived
 * yet — render a skeleton." When the stream completes every field becomes a
 * real `ExtractedField`.
 */
export type FieldOrLoading = ExtractedField | null;

export type StreamingFields = {
  [K in keyof ExtractedFields]: FieldOrLoading;
};

export interface StreamingResult {
  fields: StreamingFields;
  original_text: string;
}

// --- Streaming extraction (Server-Sent Events) ---------------------------

/**
 * Two wire vocabularies share the SSE channel:
 *
 *   * Text + voice — `delta` (non-terminal) → `done` / `error` (terminal).
 *     One row out, streamed field-by-field. {@link StreamHandlers}.
 *   * Photo — `photo_warning` (non-terminal) → `photo_row`* (non-terminal,
 *     one per extracted row) → `photo_done` / `error` (terminal). N rows
 *     out, each carrying a server-generated idempotency key.
 *     {@link PhotoStreamHandlers}.
 *
 * Both share the underlying SSE reader (`_streamSseRequest`) — they only
 * differ in the per-frame dispatch. See
 * `docs/_spec/photo_capture.md` for the locked photo
 * wire contract.
 */
export interface StreamHandlers {
  /** Called for every `delta` frame — partial JSON content as it streams. */
  onDelta: (content: string) => void;
  /** Called once on success with the fully-parsed result. */
  onDone: (result: ExtractionResult) => void;
  /**
   * Called once on any error (parsing, network, or upstream). `code` is the
   * machine-readable error code from the server when available — callers
   * can branch on it (e.g. `"no_signal"` for the post-Whisper rejection
   * that should bounce voice flow back to ready) instead of regex-ing
   * the message.
   */
  onError: (message: string, code?: string) => void;
}

// --- Photo streaming (multi-row vocabulary) ------------------------------

/**
 * One row from a photo extraction, mirroring the backend's
 * `PhotoRowPayload` (see `04_REFERENCE.md`). `idempotency_key` is
 * server-generated and deterministic across retries — the offline-queue
 * drainer keys its dedupe table off this so a re-extracted photo never
 * writes the same row twice.
 */
export interface PhotoRow {
  row_index: number;
  idempotency_key: string;
  fields: ExtractedFields;
  row_confidence: Confidence;
  warnings: string[];
}

/**
 * Terminal payload for a photo stream. `status` drives the failure-vs-
 * success branching on the review surface:
 *   * `"ok"`        — all rows clean; render the summary surface.
 *   * `"partial"`   — some rows survived, some dropped server-side;
 *                     `warnings` names what. Surface a calm "we missed
 *                     one" note next to the summary.
 *   * `"no_signal"` — zero readable rows. Slice B's retake overlay
 *                     surfaces from this status (NOT `error` — `error`
 *                     is reserved for hard upstream failures).
 *
 * `total_rows` lets the caller validate against the `photo_row` events
 * it actually received (defensive check against dropped frames).
 *
 * `provider` identifies the vision adapter that answered (`"docai"`
 * today; new values when the v2 LLM fallback lands).
 */
export interface PhotoDone {
  status: "ok" | "partial" | "no_signal";
  total_rows: number;
  provider: string;
  warnings: string[];
}

/**
 * Photo-specific stream handlers. Distinct from {@link StreamHandlers}
 * because photo has its own event vocabulary and a multi-row result
 * shape — see the photo wire contract in `04_REFERENCE.md`.
 */
export interface PhotoStreamHandlers {
  /**
   * Called for every server-sent `heartbeat` SSE frame (~ every 2s
   * while the backend is waiting on a slow upstream call).
   *
   * Purpose: lets the caller distinguish "AI is just slow" from
   * "TCP dropped" without guessing. The frontend's watchdog timer
   * resets on each heartbeat — so a real connection drop is
   * detected within `3 × heartbeat_interval` instead of waiting
   * for an arbitrary blanket timeout (the old 30s watchdog used
   * to fire as a false *"No internet"* on every slow extraction).
   *
   * Optional. If the caller doesn't supply one, heartbeats are
   * silently dropped — useful for batch / scripted clients that
   * have their own connection health story.
   */
  onHeartbeat?: () => void;
  /**
   * Called for each non-terminal `photo_warning` SSE event — image-level
   * advisories like "image was crooked, results may be partial." Code is
   * always `"photo_advisory"` today; the field exists for future codes.
   *
   * Optional — most photos emit zero warnings.
   */
  onPhotoWarning?: (code: string, message: string) => void;
  /**
   * Called once per extracted row, in document reading order. The full
   * row payload arrives in one event — there are no progressive
   * field-level deltas on the photo path (Doc AI is batch upstream).
   */
  onPhotoRow: (row: PhotoRow) => void;
  /**
   * Called exactly once with the terminal `photo_done` payload. Always
   * fires on a clean extraction — including the zero-rows / no_signal
   * case. The only path that does NOT fire `onPhotoDone` is a hard
   * upstream failure, which fires `onError` instead.
   */
  onPhotoDone: (done: PhotoDone) => void;
  /**
   * Called once on any hard failure (network drop, upstream 5xx, auth,
   * preprocessor rejection). Mirrors {@link StreamHandlers.onError}.
   */
  onError: (message: string, code?: string) => void;
}

export async function streamTextCapture(
  text: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await _streamSseRequest(
    `${API_BASE}/captures/stream`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ source: "text", text }),
      credentials: "same-origin",
      signal: signal ?? null,
    },
    handlers,
    dispatchStreamFrame,
  );
}

/**
 * Voice capture that already has a transcript (from the AssemblyAI
 * streaming session). Bypasses the Whisper batch step entirely — the
 * pre-transcribed text goes straight to the extraction endpoint. The
 * Source tag on the request stays "voice" so the eventual sheet write
 * lands in the right column.
 */
export async function streamTranscribedVoiceCapture(
  text: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await _streamSseRequest(
    `${API_BASE}/captures/stream`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ source: "voice", text }),
      credentials: "same-origin",
      signal: signal ?? null,
    },
    handlers,
    dispatchStreamFrame,
  );
}

/**
 * Streaming voice capture — uploads an audio blob (multipart), waits
 * for the backend to transcribe via Whisper, then receives the same
 * `delta` / `done` / `error` SSE events the text path emits.
 *
 * Until Whisper finishes (typically 3-15s for a sub-30s recording),
 * the stream is silent — UI should keep showing an "extracting…"
 * state. Same SseFrame parser as the text path; the handlers contract
 * is identical.
 */
export async function streamVoiceCapture(
  audio: Blob,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("audio", audio, _filenameForBlob(audio));
  // Carry the explicit content-type as a separate form field too so
  // the server can fall back when `multipart/form-data` strips the
  // blob's type (Safari's MediaRecorder sometimes loses it).
  form.append("content_type", audio.type || "audio/webm");

  await _streamSseRequest(
    `${API_BASE}/captures/voice`,
    {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: form,
      credentials: "same-origin",
      signal: signal ?? null,
    },
    handlers,
    dispatchStreamFrame,
  );
}

function _filenameForBlob(audio: Blob): string {
  // Same defensive lower-case as the image variant — see comment there.
  const type = (audio.type || "").toLowerCase();
  if (type.includes("webm")) return "capture.webm";
  if (type.includes("ogg")) return "capture.ogg";
  if (type.includes("mp4") || type.includes("m4a")) return "capture.mp4";
  if (type.includes("mpeg") || type.includes("mp3")) return "capture.mp3";
  if (type.includes("wav")) return "capture.wav";
  return "capture.webm";
}

/**
 * Multi-row streaming photo capture (Slice C contract). Uploads an
 * image blob (multipart), waits for the backend to preprocess + run
 * vision extraction, then emits one {@link PhotoRow} per extracted
 * row followed by a terminal {@link PhotoDone}. See
 * `docs/_spec/photo_capture.md` for the locked wire spec.
 *
 * Until the vision model returns (~2s with Doc AI for a typical
 * sign-in sheet), the stream is silent — the UI should keep showing
 * the review card's skeleton state.
 */
export async function streamPhotoCaptureRows(
  image: Blob,
  handlers: PhotoStreamHandlers,
): Promise<void> {
  const form = new FormData();
  form.append("image", image, _filenameForImageBlob(image));
  // Same content-type passthrough pattern voice uses — multipart can
  // strip the type on some clients (canvas-derived blobs default to
  // `application/octet-stream` on some Android browsers).
  form.append("content_type", image.type || "image/jpeg");

  await _streamSseRequest(
    `${API_BASE}/captures/photo`,
    {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: form,
      credentials: "same-origin",
    },
    handlers,
    dispatchPhotoFrame,
  );
}

function _filenameForImageBlob(image: Blob): string {
  // Defensive lower-case: some IndexedDB implementations drop a Blob's
  // `type` on round-trip (notably fake-indexeddb in tests, and there
  // have been reports of mobile Safari doing the same under memory
  // pressure). The preprocessor normalises to JPEG anyway, so unknown
  // type falls through to the safe default below.
  const type = (image.type || "").toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) return "capture.jpg";
  if (type.includes("png")) return "capture.png";
  if (type.includes("heic") || type.includes("heif")) return "capture.heic";
  if (type.includes("webp")) return "capture.webp";
  return "capture.jpg";
}

/**
 * Minimum shape every streaming handler set must support — used as the
 * generic constraint on `_streamSseRequest` so its error / network /
 * dev-simfail paths can call `handlers.onError(...)` for both text/voice
 * and photo callers.
 */
interface _StreamErrorHandler {
  onError: (message: string, code?: string) => void;
}

async function _streamSseRequest<H extends _StreamErrorHandler>(
  url: string,
  init: RequestInit,
  handlers: H,
  dispatch: (frame: SseFrame, handlers: H) => void,
): Promise<void> {
  // Dev-only QA simulators. Each one fakes a specific failure mode so
  // the matching recovery path can be walked end-to-end on a real phone
  // without throttling the network / hanging the LLM / catching a real
  // outage. `startsWith` (not strict equality) is deliberate —
  // markdown-rendered chat links can leave trailing `**` on the value
  // when copied. Stripped from prod by Vite DCE on `import.meta.env.DEV`.
  const sim =
    import.meta.env.DEV && typeof location !== "undefined"
      ? (new URLSearchParams(location.search).get("simfail") ?? "")
      : "";
  if (sim.startsWith("net")) {
    handlers.onError("No internet. Try again in a moment.", "network");
    return;
  }
  if (sim.startsWith("llm")) {
    // LLM upstream silent / error mid-flow. Brief pause first so the
    // skeleton state actually paints (otherwise the bounce-back fires
    // before the review surface has even committed), then the same
    // `ai_busy` code path a real upstream-busy or watchdog-trip would
    // take — bounces back to the originating phase with the calm pill.
    await new Promise((r) => setTimeout(r, 600));
    handlers.onError(
      "Couldn't reach the assistant. Try again in a moment.",
      "ai_busy",
    );
    return;
  }
  if (sim.startsWith("slow")) {
    // 5-second delay before the real fetch runs. Lets you feel the
    // streaming-skeleton state without throttling the network.
    await new Promise((r) => setTimeout(r, 5000));
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    // `code: "network"` lets the parent route this back to the input/voice
    // phase with the user's text preserved instead of dumping them on a
    // half-loaded review card with ghost skeletons that never resolve.
    handlers.onError("No internet. Try again in a moment.", "network");
    return;
  }

  if (!response.ok || !response.body) {
    // 400 with a JSON body is the no_signal pre-stream rejection
    // (server gated before opening the SSE stream). Surface the
    // code so the caller can route to the right recovery UI.
    if (response.status === 400 && response.body) {
      try {
        const body = (await response.clone().json()) as {
          error?: { message?: string; code?: string };
        };
        const err = body.error;
        if (err?.code) {
          handlers.onError(err.message ?? "Didn't catch that.", err.code);
          return;
        }
      } catch {
        // Fall through to the generic message below.
      }
    }
    handlers.onError(`Couldn't start the stream (${String(response.status)}).`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Read until the server closes the body. `while(true)` is the cleanest
  // shape here — the alternative flag-tracking pattern just shifts the
  // termination logic around without adding clarity.
  //
  // The read loop is wrapped in try/catch so a TCP drop AFTER the
  // headers arrived (cell handoff, brief outage, server crash mid-
  // stream) lands in the same `code: "network"` bounce-back path as
  // an initial connect failure. Without this, an exception from
  // reader.read() would propagate as an unhandled rejection and the
  // UI would freeze on a partial review with stuck skeletons. One
  // single recovery path, regardless of WHERE in the request lifecycle
  // the connection died.
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line. Pull complete frames out of
      // the buffer; leave any partial trailing frame for the next iteration.
      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const frameText = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const frame = parseSseFrame(frameText);
        if (frame) {
          dispatch(frame, handlers);
        }
        separatorIndex = buffer.indexOf("\n\n");
      }
    }
  } catch {
    handlers.onError("No internet. Try again in a moment.", "network");
    return;
  }
}

interface SseFrame {
  event: string;
  data: unknown;
}

function parseSseFrame(text: string): SseFrame | null {
  let event = "";
  let dataLine = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice("event: ".length);
    else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
  }
  if (!event || !dataLine) return null;
  try {
    return { event, data: JSON.parse(dataLine) };
  } catch {
    return null;
  }
}

function dispatchStreamFrame(frame: SseFrame, handlers: StreamHandlers): void {
  if (frame.event === "delta") {
    const content = (frame.data as { content?: string }).content;
    if (typeof content === "string") handlers.onDelta(content);
    return;
  }
  if (frame.event === "done") {
    const data = frame.data as { fields: ExtractedFields; original_text: string };
    handlers.onDone({ fields: data.fields, original_text: data.original_text });
    return;
  }
  if (frame.event === "error") {
    const data = frame.data as { message?: string; code?: string };
    handlers.onError(
      data.message ?? "Something went wrong on our end.",
      data.code,
    );
  }
}

/**
 * Photo's per-source dispatcher. Same SSE reader as text/voice; only
 * the event vocabulary differs. See {@link PhotoStreamHandlers} for the
 * payload shapes.
 */
function dispatchPhotoFrame(
  frame: SseFrame,
  handlers: PhotoStreamHandlers,
): void {
  if (frame.event === "heartbeat") {
    // Server heartbeat — see `backend/src/captureshark/api/sse_heartbeat.py`.
    // No payload semantics, just a "still alive" tick. Reset any
    // watchdog the caller registered; ignore if they didn't.
    if (handlers.onHeartbeat) handlers.onHeartbeat();
    return;
  }
  if (frame.event === "photo_warning") {
    if (!handlers.onPhotoWarning) return;
    const data = frame.data as { code?: string; message?: string };
    handlers.onPhotoWarning(data.code ?? "", data.message ?? "");
    return;
  }
  if (frame.event === "photo_row") {
    const data = frame.data as {
      row_index: number;
      idempotency_key: string;
      fields: ExtractedFields;
      row_confidence: Confidence;
      warnings: string[];
    };
    handlers.onPhotoRow({
      row_index: data.row_index,
      idempotency_key: data.idempotency_key,
      fields: data.fields,
      row_confidence: data.row_confidence,
      warnings: data.warnings,
    });
    return;
  }
  if (frame.event === "photo_done") {
    const data = frame.data as {
      status: "ok" | "partial" | "no_signal";
      total_rows: number;
      provider: string;
      warnings: string[];
    };
    handlers.onPhotoDone({
      status: data.status,
      total_rows: data.total_rows,
      provider: data.provider,
      warnings: data.warnings,
    });
    return;
  }
  if (frame.event === "error") {
    const data = frame.data as { message?: string; code?: string };
    handlers.onError(
      data.message ?? "Something went wrong on our end.",
      data.code,
    );
  }
}

// --- Sheets (save to user's connected sheet) -----------------------------

/**
 * Shape of a row sent to the save endpoint. All fields optional — partial
 * captures are still worth saving (per the v1 sketch's "never drop data"
 * rule). The backend stamps `Date Captured` and the `Source` column from
 * the request itself.
 *
 * Note: callers don't supply `client_tz` — `saveRowToSheet` auto-attaches
 * the browser's IANA zone so the `Date Captured` cell lands in the user's
 * local time rather than the server's UTC.
 */
export interface SaveRowPayload {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  has_agent?: string | null;
  intent?: string | null;
  timeline?: string | null;
  financing_status?: string | null;
  budget?: string | null;
  area?: string | null;
  follow_up?: string | null;
  notes?: string | null;
  source: "text" | "voice" | "photo";
}

export interface SheetTarget {
  spreadsheet_id: string;
  display_name: string;
}

export interface SaveRowResult {
  target: SheetTarget;
}

/**
 * Append the (possibly user-edited) extracted fields to the connected sheet.
 *
 * For step 3 of the build the "connected sheet" is a hardcoded dev target
 * on the server; step 4 swaps that for the user's OAuth-picked sheet. The
 * frontend signature stays the same either way.
 *
 * Auto-attaches `client_tz` from the browser so the backend can format
 * the `Date Captured` cell in the user's local time. Falls back silently
 * if `Intl` is unavailable; the backend defaults to UTC in that case.
 *
 * `options.idempotencyKey` is the offline-queue dedupe handle: when
 * supplied, the backend's idempotency store short-circuits replays
 * (a retry of the same logical save with the same key) to the cached
 * 200 response — preventing the "row written, network dropped, client
 * retried, row written twice" duplicate. See
 * `docs/_spec/offline_queue.md §7`. Omitting it is the
 * pre-queue behaviour, unchanged.
 */
export async function saveRowToSheet(
  payload: SaveRowPayload,
  options?: { idempotencyKey?: string },
): Promise<SaveRowResult> {
  const wirePayload = { ...payload, client_tz: detectBrowserTimezone() };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options?.idempotencyKey) {
    headers["X-Idempotency-Key"] = options.idempotencyKey;
  }
  return apiFetch<SaveRowResult>("/sheets/append", {
    method: "POST",
    headers,
    body: JSON.stringify(wirePayload),
  });
}

/**
 * The browser's IANA timezone name (e.g. `"America/Los_Angeles"`), or
 * `null` if `Intl` isn't available or returns nothing usable. We prefer
 * a real null over an empty string so the backend can branch cleanly
 * on "did the client send one?".
 */
function detectBrowserTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && typeof tz === "string" ? tz : null;
  } catch {
    return null;
  }
}

// --- Feature flags --------------------------------------------------------

/**
 * Server-controlled feature switches the frontend reads at boot. Components
 * branch on these to render new capability behind a flag the operator
 * controls via `.env`. Today there's one flag; new flags slot in here as
 * features land.
 */
export interface FeatureFlags {
  live_captions_enabled: boolean;
}

export async function fetchFeatures(): Promise<FeatureFlags> {
  return apiGet<FeatureFlags>("/features");
}

/**
 * Response from `POST /captures/live-token`. Single-use AssemblyAI temp
 * token the browser passes on the streaming WS URL. `expires_at` is the
 * ISO-8601 instant after which the token will no longer open a session
 * — the caller uses it to pre-empt stale-token handshake errors when
 * recording starts more than ~60 s after the mint.
 */
export interface LiveCaptionToken {
  token: string;
  expires_at: string;
}

export async function fetchLiveCaptionToken(): Promise<LiveCaptionToken> {
  return apiPostJson<LiveCaptionToken>("/captures/live-token", {});
}

/**
 * Terminal outcome from the live-captions hook's POV.
 * - `streamed` — final transcript handed off (no fallback).
 * - `empty`    — WS ran, no usable transcript (Whisper fallback used downstream).
 * - `error`    — WS errored / never opened (Whisper fallback used downstream).
 * - `stopped`  — hard stop, no flush (sheet closed mid-session).
 */
export type LiveCaptionsTelemetryOutcome =
  | "streamed"
  | "empty"
  | "error"
  | "stopped";

/**
 * Wire shape of `/telemetry/live-captions`. Mirrors the backend schema.
 * No transcript text, no audio bytes — only structural metrics.
 */
export interface LiveCaptionsTelemetryPayload {
  session_id: string;
  provider: "assemblyai";
  outcome: LiveCaptionsTelemetryOutcome;
  total_session_ms: number;
  first_partial_ms: number | null;
  partial_count: number;
  p90_inter_partial_ms: number | null;
  max_inter_partial_ms: number | null;
  transcript_length: number;
  error_kind: string | null;
  user_agent: string | null;
}

/**
 * Best-effort POST. Returns immediately — the call is fire-and-forget
 * from the hook's POV, so we don't await. Failures are swallowed for
 * the same reason `reportClientError` swallows: losing a telemetry
 * record is preferable to slowing down a user-facing stop tap.
 */
export function reportLiveCaptionsTelemetry(
  payload: LiveCaptionsTelemetryPayload,
): void {
  void (async () => {
    try {
      await apiFetch<void>("/telemetry/live-captions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      /* swallow — telemetry must never escalate to user-visible failure */
    }
  })();
}

// --- Auth (Google sign-in, step 4) ----------------------------------------

/**
 * What `/auth/config` returns. Tells the frontend whether sign-in is
 * actually wired up server-side (Cloud Console creds + signing keys
 * present in `.env`) — lets us hide the "Sign in" CTA on a dev backend
 * that's guaranteed to 503 instead of confusing the user with a button
 * that never works.
 *
 * `google_app_id` is the Cloud project number derived from the OAuth
 * client_id — the Picker SDK needs it for `setAppId()`. Null when
 * the backend isn't OAuth-configured.
 */
export interface AuthConfig {
  configured: boolean;
  google_app_id: string | null;
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  return apiGet<AuthConfig>("/auth/config");
}

/**
 * Subset of `/auth/me` the frontend cares about. `has_drive_access` is
 * the load-bearing flag — `false` after sign-in means the user skipped
 * the consent checkbox and the Picker / save path will fail. The
 * frontend renders the retry-screen half of the sandwich UX in that
 * case.
 */
export interface AuthMe {
  user: {
    email: string;
    name: string | null;
    picture_url: string | null;
  };
  session: {
    created_at: string;
    last_seen_at: string;
  };
  has_drive_access: boolean;
  /**
   * The Google Sheet the user picked via the Picker, or `null` if
   * they signed in but haven't picked one yet. Frontend uses the
   * null case to auto-open the Picker after sign-in.
   */
  connected_sheet: ConnectedSheet | null;
}

export interface ConnectedSheet {
  spreadsheet_id: string;
  display_name: string;
  worksheet_title: string;
}

/**
 * Returns `null` when the user isn't signed in (HTTP 401), the
 * `AuthMe` payload otherwise. Any other error is thrown — those
 * really *are* exceptional (network down, server bug).
 */
export async function fetchAuthMe(): Promise<AuthMe | null> {
  try {
    return await apiGet<AuthMe>("/auth/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export async function signOut(): Promise<void> {
  await apiFetch<void>("/auth/sign-out", { method: "POST" });
}

/**
 * The canonical URL the browser navigates to in order to begin sign-in.
 * It's a *navigation*, not a fetch — `window.location.href = SIGN_IN_URL`.
 * The backend issues a 302 to Google after stashing a CSRF state cookie.
 */
export const SIGN_IN_URL = `${API_BASE}/auth/google/start`;

/**
 * Fetch a fresh Google access token for the Picker SDK. Backend
 * refreshes silently if expiry is near. The returned token is
 * single-purpose (Picker dialog) and short-lived; do not store it.
 *
 * Returns `null` when the user isn't signed in (HTTP 401), the token
 * payload otherwise. Callers branch on `null` to send the user back
 * to sign-in.
 */
export interface PickerToken {
  access_token: string;
  /** ISO-8601 UTC timestamp the token stops working. */
  expires_at: string;
}

export async function fetchPickerToken(): Promise<PickerToken | null> {
  try {
    return await apiGet<PickerToken>("/auth/picker-token");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/**
 * Persist the user's Picker selection. Backend overwrites any
 * previous pick — one connected sheet per user in v1.
 */
export interface ConnectSheetPayload {
  spreadsheet_id: string;
  display_name: string;
  worksheet_title?: string;
}

export interface ConnectSheetResult {
  connected_sheet: ConnectedSheet;
}

export async function connectSheet(
  payload: ConnectSheetPayload,
): Promise<ConnectSheetResult> {
  return apiPostJson<ConnectSheetResult>("/sheets/connect", payload);
}

// --- Sheets: column-mapping proposal (step 5) ----------------------------

/** The canonical lead-field keys the backend can map to columns.
 *  Mirrors `LeadField` in `domain/column_mapping.py` — both ends must
 *  stay in lockstep for the user-picked-sheet mapping screen to wire
 *  every field through. */
export type LeadFieldKey =
  | "name"
  | "phone"
  | "email"
  | "has_agent"
  | "intent"
  | "timeline"
  | "financing_status"
  | "budget"
  | "area"
  | "follow_up"
  | "notes";

/**
 * Auto-matched header per app field. `null` = no header in the sheet
 * matched our synonym table; the UI surfaces these as "Not mapped" so
 * the user knows we noticed.
 */
export interface ColumnMapping {
  fields: Record<LeadFieldKey, string | null>;
  /** Sheet headers we *didn't* claim. UI lists these as "untouched columns". */
  unmapped_headers: string[];
}

/**
 * Discriminated proposal shape. `kind` controls which screen the UI
 * renders:
 *   - `has_headers`     → mapping confirmation ("Yes, use these / Fix one")
 *   - `empty`           → "Want us to set up the headers for you?"
 *   - `looks_like_data` → "This sheet has data but no header row..."
 */
export type MappingProposalKind = "has_headers" | "empty" | "looks_like_data";

export interface MappingProposal {
  kind: MappingProposalKind;
  /** Raw row-1 cells from the user's sheet, in column order. */
  headers: string[];
  /** Populated only when `kind === "has_headers"`. */
  mapping: ColumnMapping | null;
}

export interface ProposedMappingResponse {
  proposal: MappingProposal;
}

/**
 * Read row 1 of the user's connected sheet and return the auto-matched
 * mapping proposal. Requires an authenticated session AND a previously
 * connected sheet (`POST /sheets/connect`); 401 / 409 surface as the
 * usual `ApiError`.
 */
export async function fetchProposedMapping(): Promise<MappingProposal> {
  const result = await apiGet<ProposedMappingResponse>("/sheets/proposed-mapping");
  return result.proposal;
}

/**
 * Persist the user's confirmed column mapping for the connected
 * sheet. Subsequent saves use this mapping to project rows onto the
 * user's actual column layout.
 *
 * `fields` keys MUST be the seven canonical lead-field keys; the
 * backend rejects malformed payloads with 400. Most common error
 * after that is 409 (no sheet connected yet — caller should send
 * the user back through the Picker).
 */
export interface SaveMappingPayload {
  fields: Record<LeadFieldKey, string | null>;
  unmapped_headers: string[];
}

export interface SaveMappingResult {
  mapping: ColumnMapping;
}

export async function saveMapping(
  payload: SaveMappingPayload,
): Promise<SaveMappingResult> {
  return apiPostJson<SaveMappingResult>("/sheets/mapping", payload);
}

// --- Internals ------------------------------------------------------------

async function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "GET" });
}

async function apiPostJson<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Headers come in three shapes per the Fetch spec; flatten them all to a
 * `Record<string, string>` so we can merge in our defaults safely.
 */
function flattenHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

/**
 * The most recent backend `X-Request-ID` we've seen, captured from the
 * response of any `apiFetch`. Surfaced via `getLastRequestId()` so the
 * React error boundary can include it in its crash report — gives
 * support a thread to pull when a broker says "it broke at 2pm."
 *
 * Module-private state (rather than a Zustand store) because nothing
 * renders off this — it's just a side-channel for diagnostics. A
 * trailing-edge cache, lossy by design.
 */
let _lastRequestId: string | null = null;

/**
 * Read the most recent backend request ID, if any. Returns `null` until
 * a backend round-trip has completed in this tab.
 */
export function getLastRequestId(): string | null {
  return _lastRequestId;
}

async function apiFetch<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...flattenHeaders(init.headers) },
      credentials: "same-origin",
    });
  } catch (cause) {
    throw new ApiError("No internet. Try again in a moment.", {
      status: 0,
      cause,
    });
  }

  // Capture the request ID before either branch — even error responses
  // carry one (the middleware sets it on the way out regardless).
  const requestId = response.headers.get("X-Request-ID");
  if (requestId) _lastRequestId = requestId;

  if (!response.ok) {
    const body = await safeJson(response);
    const message =
      typeof body?.error?.message === "string"
        ? body.error.message
        : `Request failed (${String(response.status)}).`;
    const baseOptions = { status: response.status };
    const options =
      typeof body?.error?.code === "string"
        ? { ...baseOptions, code: body.error.code }
        : baseOptions;
    throw new ApiError(message, options);
  }

  // 204 No Content is the right shape for endpoints whose only signal
  // is "it worked" (e.g. sign-out). Calling `.json()` on an empty body
  // would throw, so we short-circuit to a typed `undefined` cast.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// --- Client-error reporting (for the §7 error boundary) -------------------

/**
 * Payload the React error boundary will POST when it catches a render-
 * time crash. Mirrors `ClientErrorReport` on the backend; field names
 * match exactly so there's no rename layer between the two.
 *
 * `last_request_id` is auto-attached by `reportClientError` from
 * `getLastRequestId()` — callers don't supply it themselves.
 */
export interface ClientErrorReportPayload {
  message: string;
  component_stack?: string | null;
  build_version?: string | null;
  user_agent?: string | null;
}

/**
 * POST a frontend crash report to `/api/v1/client-errors`. Best-effort:
 * if the report itself fails to land (offline, server-down, network
 * error), we swallow — we'd rather lose the report than have the error
 * boundary's recovery surface crash trying to log a crash. The user's
 * fallback UI already rendered locally either way.
 *
 * Auto-attaches `last_request_id` from the most recent successful fetch
 * (when known) and `user_agent` from `navigator.userAgent`. Callers
 * don't have to know about either.
 */
export async function reportClientError(
  payload: ClientErrorReportPayload,
): Promise<void> {
  const wirePayload = {
    message: payload.message,
    component_stack: payload.component_stack ?? null,
    build_version: payload.build_version ?? null,
    user_agent: payload.user_agent ?? _detectUserAgent(),
    last_request_id: getLastRequestId(),
  };
  try {
    await apiFetch<void>("/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wirePayload),
    });
  } catch {
    // Reporting failed — don't escalate, the fallback UI is already up.
  }
}

function _detectUserAgent(): string | null {
  try {
    return typeof navigator !== "undefined" && navigator.userAgent
      ? navigator.userAgent.slice(0, 512)
      : null;
  } catch {
    return null;
  }
}

async function safeJson(response: Response): Promise<ApiErrorBody | null> {
  try {
    return (await response.json()) as ApiErrorBody;
  } catch {
    return null;
  }
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}
