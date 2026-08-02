#!/usr/bin/env bash
#
# Playwright writes VP8 in a WebM container. That plays in a browser and almost
# nowhere else — not in Keynote, not in PowerPoint, not in QuickTime, which is
# exactly where a demonstration film ends up. So each recording is also converted
# to H.264 in MP4, which plays everywhere without a codec conversation.
#
# The WebM originals are kept and gitignored: they are the lossless source, and
# re-encoding from an already-encoded MP4 loses more each time.
#
#   bash scripts/convert-recordings.sh
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docs/demo/recordings"

if ! command -v ffmpeg > /dev/null; then
  echo "ffmpeg is not on PATH — the .webm recordings are still usable in a browser." >&2
  exit 1
fi

shopt -s nullglob
found=0
for src in "$DIR"/*.webm; do
  found=1
  out="${src%.webm}.mp4"
  echo "→ $(basename "$out")"
  # -crf 20 is visually lossless for screen content at this size; yuv420p and the
  # +faststart flag are what make it play in the widest range of players.
  ffmpeg -nostdin -loglevel error -y -i "$src" \
    -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
    -movflags +faststart -an "$out"
done

if [ "$found" -eq 0 ]; then
  echo "No .webm recordings in $DIR — run scripts/record-demo.ts first." >&2
  exit 1
fi

echo
# `du` rather than `ls | awk`: the repository path contains a space, which awk's
# field splitting turns into a truncated filename.
du -h "$DIR"/*.mp4 | while read -r size file; do printf "%-46s %s\n" "$(basename "$file")" "$size"; done
