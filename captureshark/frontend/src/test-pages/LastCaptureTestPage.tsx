/**
 * Last-capture sandbox.
 *
 * Dev-only verification page that displays the EXACT JPEG bytes the
 * camera / gallery capture path just shipped to the backend. Pulled
 * from IndexedDB (the PhotoCapture component stashes the blob there
 * in dev only — see the `import.meta.env.DEV` guard in
 * `PhotoCapture.tsx`'s capture paths, backed by `lib/devLastCapture.ts`).
 *
 * Use this to verify that:
 * - We send only the cropped region, not the full camera frame.
 * - The upscale floor (800 px short edge) is being applied to
 *   heavy-zoom captures so the backend doesn't reject them.
 *
 * Reloads on tab-focus so popping back from the main app shows the
 * latest capture without a manual refresh.
 */

import { useEffect, useState } from "react";

import {
  clearLastCapture,
  loadLastCapture,
  type LastCaptureMeta,
} from "@/lib/devLastCapture";

export function LastCaptureTestPage(): React.ReactElement {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<LastCaptureMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    loadLastCapture()
      .then((record) => {
        if (!record) {
          setObjectUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return null;
          });
          setMeta(null);
          return;
        }
        const url = URL.createObjectURL(record.blob);
        setObjectUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setMeta(record.meta);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Couldn't read storage.");
      });
  };

  useEffect(() => {
    refresh();
    const handleFocus = () => refresh();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
      setObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClear = () => {
    clearLastCapture()
      .then(() => {
        setObjectUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
        setMeta(null);
      })
      .catch(() => {
        // ignore
      });
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0f172a",
        color: "#f8fafc",
        fontFamily:
          "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      <h1 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>
        Last capture (dev-only)
      </h1>

      {error && (
        <p style={{ margin: 0, fontSize: "13px", color: "#fca5a5" }}>
          Storage error: {error}
        </p>
      )}

      {!error && !objectUrl && (
        <p
          style={{
            margin: 0,
            fontSize: "14px",
            color: "rgba(248, 250, 252, 0.7)",
          }}
        >
          No capture yet. Take a photo in the camera flow, then come back here.
        </p>
      )}

      {objectUrl && (
        <>
          <div
            style={{
              fontSize: "13px",
              lineHeight: 1.5,
              color: "rgba(248, 250, 252, 0.85)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {meta && (
              <>
                <div>
                  <strong>Source:</strong>{" "}
                  {meta.source === "gallery" ? "Gallery upload" : "Camera shutter"}
                </div>
                <div>
                  <strong>Sent to AI:</strong>{" "}
                  {meta.outputWidth && meta.outputHeight
                    ? `${meta.outputWidth} × ${meta.outputHeight} px`
                    : "(unmodified file)"}{" "}
                  ({Math.round(meta.bytes / 1024)} KB
                  {meta.contentType ? `, ${meta.contentType}` : ""})
                </div>
                {meta.sourceWidth && meta.sourceHeight && (
                  <div>
                    <strong>Camera source:</strong> {meta.sourceWidth} ×{" "}
                    {meta.sourceHeight} px
                  </div>
                )}
                {meta.cropSw !== undefined && meta.cropSh !== undefined && (
                  <div>
                    <strong>Crop region (in source):</strong> sx={meta.cropSx} sy=
                    {meta.cropSy} sw={meta.cropSw} sh={meta.cropSh}
                  </div>
                )}
                <div
                  style={{
                    marginTop: "6px",
                    color: "rgba(248, 250, 252, 0.5)",
                  }}
                >
                  Captured {meta.capturedAt}
                </div>
              </>
            )}
          </div>
          <img
            src={objectUrl}
            alt="Last captured frame sent to the AI"
            style={{
              maxWidth: "100%",
              height: "auto",
              border: "1px solid rgba(248, 250, 252, 0.18)",
              borderRadius: "8px",
              background: "#000",
            }}
          />
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              type="button"
              onClick={refresh}
              style={{
                minHeight: "40px",
                padding: "0 18px",
                borderRadius: "8px",
                border: "1px solid rgba(248, 250, 252, 0.18)",
                background: "rgba(248, 250, 252, 0.08)",
                color: "#f8fafc",
                fontFamily: "inherit",
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={handleClear}
              style={{
                minHeight: "40px",
                padding: "0 18px",
                borderRadius: "8px",
                border: "1px solid rgba(248, 250, 252, 0.18)",
                background: "rgba(248, 250, 252, 0.08)",
                color: "#f8fafc",
                fontFamily: "inherit",
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              Clear
            </button>
          </div>
        </>
      )}
    </div>
  );
}
