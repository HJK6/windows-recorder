#!/usr/bin/env bash
# Headless capture smoke: runs the Electron harness under xvfb with Chromium
# fake devices, then asserts with ffprobe that the merged WebM has exactly one
# video track and one audio track. Exit non-zero on any failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ELECTRON="$ROOT/node_modules/.bin/electron"
OUTDIR="$(mktemp -d)"
OUT="$OUTDIR/hf-smoke.webm"
export HF_SMOKE_OUT="$OUT"

cleanup() { rm -rf "$OUTDIR"; }
trap cleanup EXIT

echo "smoke output -> $OUT"
xvfb-run -a -s "-screen 0 1280x720x24" \
  "$ELECTRON" "$ROOT/test/smoke/smoke-main.js" --no-sandbox

[ -f "$OUT" ] || { echo "FAIL: no output file produced"; exit 1; }
SIZE=$(stat -c%s "$OUT")
echo "output size = ${SIZE} bytes"
[ "$SIZE" -gt 1000 ] || { echo "FAIL: output suspiciously small"; exit 1; }

V=$(ffprobe -v error -select_streams v -show_entries stream=codec_type -of csv=p=0 "$OUT" | grep -c . || true)
A=$(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$OUT" | grep -c . || true)
echo "video streams = $V, audio streams = $A"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" || echo "?")
echo "duration = ${DUR}s"

if [ "$V" -eq 1 ] && [ "$A" -eq 1 ]; then
  echo "SMOKE PASS: merged WebM has exactly 1 video + 1 audio track"
else
  echo "FAIL: expected 1 video + 1 audio track, got v=$V a=$A"
  exit 1
fi
