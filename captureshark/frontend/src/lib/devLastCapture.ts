/**
 * Dev-only "last capture" stash.
 *
 * Backs the `/last-capture` verification sandbox. Stores the exact
 * JPEG blob the camera / gallery path just shipped, plus a small
 * meta object. Used to confirm we send the cropped region (and the
 * upscale floor for heavy zoom) without taking the developer's word
 * for it.
 *
 * Why IndexedDB (not localStorage): iOS Safari caps localStorage at
 * ~5 MB per origin, and a real iPhone gallery photo base64-encodes
 * to ~3 MB. Multiple captures (or a sloppy quota state) push us
 * over the limit and the setItem throws silently. IndexedDB stores
 * blobs natively (no base64 overhead) with multi-GB quotas.
 *
 * Tree-shaken from production via the `import.meta.env.DEV` guard
 * at the call sites — this module ships in dev only.
 */

const DB_NAME = "captureshark_dev_last_capture";
const STORE = "captures";
const KEY = "current";

export interface LastCaptureMeta {
  source: "camera" | "gallery";
  bytes: number;
  capturedAt: string;
  contentType?: string;
  outputWidth?: number;
  outputHeight?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  cropSx?: number;
  cropSy?: number;
  cropSw?: number;
  cropSh?: number;
}

export interface LastCaptureRecord {
  blob: Blob;
  meta: LastCaptureMeta;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveLastCapture(
  blob: Blob,
  meta: LastCaptureMeta,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ blob, meta }, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadLastCapture(): Promise<LastCaptureRecord | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as LastCaptureRecord) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function clearLastCapture(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
