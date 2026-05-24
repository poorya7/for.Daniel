"""
RecapShark Pipeline
YouTube URL → Audio Download → Whisper Transcription

Usage: python run.py <youtube_url>
"""

import sys
import time

from get_audio import download_audio, extract_video_id
from transcribe import transcribe


def run_pipeline(video_url: str) -> dict:
    """Run the full pipeline: download audio, then transcribe. Returns paths and metadata."""
    video_id = extract_video_id(video_url)
    print(f"{'=' * 50}")
    print(f"  RecapShark Pipeline")
    print(f"  Video: {video_id}")
    print(f"{'=' * 50}\n")

    # Step 1: Download audio
    print("[STEP 1/2] Downloading audio...")
    t0 = time.time()
    audio_path = download_audio(video_url)
    t1 = time.time()
    print(f"  Time: {t1 - t0:.1f}s\n")

    # Step 2: Transcribe
    print("[STEP 2/2] Transcribing with Whisper...")
    transcript_path = transcribe(audio_path)
    t2 = time.time()
    print(f"  Time: {t2 - t1:.1f}s\n")

    print(f"{'=' * 50}")
    print(f"  Done! Total: {t2 - t0:.1f}s")
    print(f"  Audio:      {audio_path}")
    print(f"  Transcript: {transcript_path}")
    print(f"{'=' * 50}")

    return {
        "video_id": video_id,
        "audio_path": audio_path,
        "transcript_path": transcript_path,
    }


def main():
    if len(sys.argv) < 2:
        print("Usage: python run.py <youtube_url>")
        print('Example: python run.py "https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
        sys.exit(1)

    try:
        run_pipeline(sys.argv[1])
    except Exception as e:
        print(f"\n[ERROR] {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
