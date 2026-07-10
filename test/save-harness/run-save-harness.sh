#!/usr/bin/env bash
# Runs the save-path harness under xvfb (real preload + sandbox:true) and checks
# whether the merged-payload actually writes to disk through the IPC boundary.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOCS="$(mktemp -d)"
LOG="$(mktemp)"
export HF_SAVE_DOCS="$DOCS"
cleanup() { rm -rf "$DOCS" "$LOG"; }
trap cleanup EXIT

xvfb-run -a "$ROOT/node_modules/.bin/electron" "$ROOT/test/save-harness/save-main.js" >"$LOG" 2>&1
CODE=$?

echo "--- harness log ---"
grep -E "HARNESS|PAGE" "$LOG" | head -10

FILE=$(ls "$DOCS/HFRecorder/"*.webm 2>/dev/null | head -1)
if [ -n "${FILE:-}" ] && [ -s "$FILE" ]; then
  echo "SAVE OK: $(basename "$FILE") = $(stat -c%s "$FILE") bytes (exit=$CODE)"
  exit 0
else
  echo "SAVE FAILED: no non-empty file in $DOCS/HFRecorder/ (exit=$CODE)"
  exit 1
fi
