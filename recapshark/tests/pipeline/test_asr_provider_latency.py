"""
One-off empirical latency test for AsrProvider chunked karaoke.

Goal: measure real numbers for the lazy-karaoke plan's tunables (queue timeout,
retry policy, poll interval) instead of guessing.

Approach:
    1. Download audio from a known YouTube video via yt-dlp (one-time, cached)
    2. Slice with ffmpeg into 1-min, 3-min, 5-min chunks
    3. Submit each chunk to AsrProvider as multipart upload, multiple trials per size
    4. Record: init latency, poll count, total latency, failure rate, error types
    5. Output a structured summary with recommendations

Cost per trial: ~$0.01 (1-min) / $0.03 (3-min) / $0.05 (5-min) of AsrProvider spend.
Expected total run cost: ~$0.50-1.00.

Run from project root:
    ./venv/Scripts/python.exe pipeline/test_asr_provider_latency.py
"""

import asyncio
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path
import httpx

# Load .env from project root (manual parse — avoids python-dotenv dep)
def _load_env():
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

_load_env()

ASR_PROVIDER_API_KEY = os.environ.get("ASR_PROVIDER_API_KEY")
if not ASR_PROVIDER_API_KEY:
    print("ERROR: ASR_PROVIDER_API_KEY not set in .env", file=sys.stderr)
    sys.exit(1)

# Test video: standard short fixture URL (~10 min length).
VIDEO_ID = "qADTr7d6gMU"

# Trials per chunk size (in minutes)
TRIALS_PER_SIZE = {1: 5, 3: 10, 5: 5}   # 20 trials total, weighted toward 3-min (the actual chunk size)

# Output paths
WORK_DIR = Path("./tmp/asr_provider_test")
WORK_DIR.mkdir(parents=True, exist_ok=True)
AUDIO_FULL = WORK_DIR / f"{VIDEO_ID}.m4a"

ASR_PROVIDER_URL = "https://api.asr_provider.io/v2/pre-recorded"
ASR_PROVIDER_UPLOAD_URL = "https://api.asr_provider.io/v2/upload"


# ─────────────────────────────────────────────────────────────────────────────
# Setup: download + slice
# ─────────────────────────────────────────────────────────────────────────────

def download_full_audio_if_needed():
    if AUDIO_FULL.exists():
        print(f"[setup] Audio already cached at {AUDIO_FULL} ({AUDIO_FULL.stat().st_size / 1024 / 1024:.1f} MB)")
        return
    print(f"[setup] Downloading audio for {VIDEO_ID} via yt-dlp...")
    out_template = str(WORK_DIR / f"{VIDEO_ID}.%(ext)s")
    res = subprocess.run(
        [
            "yt-dlp", "-x", "--audio-format", "m4a",
            "-f", "bestaudio[ext=m4a]/bestaudio",
            "-o", out_template,
            f"https://www.youtube.com/watch?v={VIDEO_ID}",
        ],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        print(f"[setup] yt-dlp failed:\n{res.stderr}", file=sys.stderr)
        sys.exit(1)
    if not AUDIO_FULL.exists():
        print(f"[setup] Expected file not found after download: {AUDIO_FULL}", file=sys.stderr)
        print(f"[setup] yt-dlp stderr:\n{res.stderr}", file=sys.stderr)
        sys.exit(1)
    print(f"[setup] Downloaded to {AUDIO_FULL} ({AUDIO_FULL.stat().st_size / 1024 / 1024:.1f} MB)")


def slice_chunk(duration_sec):
    out_path = WORK_DIR / f"chunk_{duration_sec}s.m4a"
    if out_path.exists():
        return out_path
    print(f"[setup] Slicing {duration_sec}s chunk → {out_path.name}...")
    res = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-nostdin",
            "-i", str(AUDIO_FULL),
            "-ss", "0",
            "-t", str(duration_sec),
            "-vn", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
            str(out_path),
        ],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        print(f"[setup] ffmpeg failed:\n{res.stderr}", file=sys.stderr)
        sys.exit(1)
    return out_path


# ─────────────────────────────────────────────────────────────────────────────
# AsrProvider call: upload chunk + poll
# ─────────────────────────────────────────────────────────────────────────────

async def submit_and_poll(client: httpx.AsyncClient, chunk_path: Path) -> dict:
    """Returns dict with: init_time, poll_count, total_time, error (None on success)."""
    headers = {"x-asr_provider-key": ASR_PROVIDER_API_KEY}

    # Step 1: upload the audio file to AsrProvider's /v2/upload
    t_start = time.monotonic()
    with open(chunk_path, "rb") as f:
        files = {"audio": (chunk_path.name, f, "audio/mp4")}
        try:
            upload_res = await client.post(ASR_PROVIDER_UPLOAD_URL, headers=headers, files=files, timeout=30)
        except httpx.HTTPError as e:
            return {"error": f"upload_network: {type(e).__name__}", "detail": str(e)[:200]}

    if upload_res.status_code not in (200, 201):
        return {"error": f"upload_{upload_res.status_code}", "detail": upload_res.text[:200]}

    upload_data = upload_res.json()
    audio_url = upload_data.get("audio_url")
    if not audio_url:
        return {"error": "no_audio_url_after_upload", "detail": str(upload_data)[:200]}

    # Step 2: submit transcription job
    t_init_start = time.monotonic()
    try:
        init_res = await client.post(
            ASR_PROVIDER_URL,
            headers={**headers, "Content-Type": "application/json"},
            json={"audio_url": audio_url},
            timeout=30,
        )
    except httpx.HTTPError as e:
        return {"error": f"init_network: {type(e).__name__}", "detail": str(e)[:200]}

    init_time = time.monotonic() - t_init_start
    if init_res.status_code not in (200, 201):
        return {"error": f"init_{init_res.status_code}", "detail": init_res.text[:200]}

    init_data = init_res.json()
    result_url = init_data.get("result_url")
    if not result_url:
        return {"error": "no_result_url", "detail": str(init_data)[:200]}

    # Step 3: poll
    poll_count = 0
    poll_t_start = time.monotonic()
    while time.monotonic() - poll_t_start < 90:   # 90s safety ceiling
        await asyncio.sleep(1)
        poll_count += 1
        try:
            poll_res = await client.get(result_url, headers=headers, timeout=30)
        except httpx.HTTPError as e:
            return {"error": f"poll_network: {type(e).__name__}", "detail": str(e)[:200]}

        if poll_res.status_code != 200:
            continue   # transient; keep polling

        data = poll_res.json()
        status = data.get("status")
        if status == "done":
            total_time = time.monotonic() - t_start
            return {
                "init_time": init_time,
                "poll_count": poll_count,
                "total_time": total_time,
                "error": None,
            }
        if status == "error":
            err = data.get("error_message") or data.get("result", {}).get("error", "unknown")
            return {"error": "asr_provider_processing_error", "detail": str(err)[:200]}

    return {"error": "poll_timeout_90s", "detail": f"{poll_count} polls before timeout"}


# ─────────────────────────────────────────────────────────────────────────────
# Run trials + analyze
# ─────────────────────────────────────────────────────────────────────────────

def percentile(sorted_values, p):
    if not sorted_values:
        return None
    idx = max(0, min(len(sorted_values) - 1, int(round(p * (len(sorted_values) - 1)))))
    return sorted_values[idx]


async def run_trials(client, chunk_path, n_trials):
    results = []
    for i in range(n_trials):
        print(f"  trial {i+1}/{n_trials}: ", end="", flush=True)
        r = await submit_and_poll(client, chunk_path)
        results.append(r)
        if r.get("error"):
            print(f"FAIL [{r['error']}] {r.get('detail', '')[:80]}")
        else:
            print(f"OK total={r['total_time']:.2f}s init={r['init_time']:.2f}s polls={r['poll_count']}")
    return results


def analyze(size_min, results):
    success = [r for r in results if not r.get("error")]
    fail = [r for r in results if r.get("error")]
    n = len(results)

    print(f"\n──────── {size_min}-minute chunks ({n} trials) ────────")
    print(f"  success rate: {len(success)}/{n} ({len(success)/n*100:.0f}%)")

    if success:
        totals = sorted([r["total_time"] for r in success])
        inits = sorted([r["init_time"] for r in success])
        polls = sorted([r["poll_count"] for r in success])
        print(f"  total time (s): median={statistics.median(totals):.2f}  p95={percentile(totals, 0.95):.2f}  max={max(totals):.2f}")
        print(f"  init time  (s): median={statistics.median(inits):.2f}  max={max(inits):.2f}")
        print(f"  poll count    : median={statistics.median(polls):.0f}  max={max(polls)}")

    if fail:
        print(f"  failures: {[f['error'] for f in fail]}")
    return success, fail


async def main():
    download_full_audio_if_needed()

    # Slice once per size
    chunk_paths = {}
    for size_min in TRIALS_PER_SIZE.keys():
        chunk_paths[size_min] = slice_chunk(size_min * 60)
    print()

    all_results = {}
    async with httpx.AsyncClient() as client:
        for size_min, n_trials in TRIALS_PER_SIZE.items():
            print(f"=== Running {n_trials} trials of {size_min}-minute chunk ===")
            all_results[size_min] = await run_trials(client, chunk_paths[size_min], n_trials)
            print()

    # Aggregate analysis
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)

    all_success = []
    all_fail = []
    for size_min in TRIALS_PER_SIZE.keys():
        s, f = analyze(size_min, all_results[size_min])
        all_success.extend(s)
        all_fail.extend(f)

    # Recommendations
    print("\n" + "=" * 60)
    print("RECOMMENDATIONS (based on this run)")
    print("=" * 60)

    if all_success:
        all_totals = sorted([r["total_time"] for r in all_success])
        p95 = percentile(all_totals, 0.95)
        p99 = percentile(all_totals, 0.99)
        print(f"\nObserved p95 across all chunk sizes: {p95:.1f}s")
        print(f"Observed p99 across all chunk sizes: {p99:.1f}s")
        print(f"Observed max:                        {max(all_totals):.1f}s")

        suggested_timeout = max(int(p99 + 3), 8)
        print(f"\n→ Suggested queue timeout: {suggested_timeout}s (p99 + 3s buffer; min 8s)")

    fail_rate = len(all_fail) / (len(all_success) + len(all_fail)) if (all_success or all_fail) else 0
    print(f"\nObserved failure rate: {fail_rate*100:.1f}% ({len(all_fail)}/{len(all_success)+len(all_fail)})")
    if fail_rate < 0.05:
        print("→ Suggested retry policy: 1 retry per chunk, no exponential backoff needed.")
    elif fail_rate < 0.20:
        print("→ Suggested retry policy: 2 retries with 2s backoff. Surface failure rate in telemetry.")
    else:
        print("→ Suggested retry policy: 2 retries + investigate WHY failures are this high before launch.")

    # Total estimated cost
    total_audio_secs = sum(size_min * 60 * n for size_min, n in TRIALS_PER_SIZE.items())
    cost_usd = total_audio_secs * 0.00017
    print(f"\nAsrProvider spend on this run: ~${cost_usd:.2f} ({total_audio_secs}s of audio submitted)")


if __name__ == "__main__":
    asyncio.run(main())
