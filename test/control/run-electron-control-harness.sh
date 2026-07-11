#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ELECTRON="$ROOT/node_modules/.bin/electron"
DATA="$(mktemp -d)"
LOG="$(mktemp)"
free_port() {
  node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"
}
BACKEND_PORT="$(free_port)"
CONTROL_PORT="$(free_port)"
BACKEND_PID=""
ELECTRON_PID=""

cleanup() {
  [ -z "$ELECTRON_PID" ] || kill "$ELECTRON_PID" 2>/dev/null || true
  [ -z "$BACKEND_PID" ] || kill "$BACKEND_PID" 2>/dev/null || true
  rm -r "$DATA" "$LOG"
}
trap cleanup EXIT

MOCK_BACKEND_PORT="$BACKEND_PORT" MOCK_BACKEND_DATA_DIR="$DATA" \
  node "$ROOT/mocks/backend/server.js" >"$LOG" 2>&1 &
BACKEND_PID=$!

for _ in $(seq 1 50); do
  if (echo >/dev/tcp/127.0.0.1/$BACKEND_PORT) 2>/dev/null; then break; fi
  sleep 0.1
done

HF_BACKEND_BASE_URL="http://127.0.0.1:$BACKEND_PORT" HF_CONTROL_PORT="$CONTROL_PORT" \
  xvfb-run -a -s "-screen 0 1280x720x24" \
  "$ELECTRON" --no-sandbox --use-fake-device-for-media-stream \
  --use-fake-ui-for-media-stream --disable-dev-shm-usage "$ROOT" >>"$LOG" 2>&1 &
ELECTRON_PID=$!

for _ in $(seq 1 100); do
  if (echo >/dev/tcp/127.0.0.1/$CONTROL_PORT) 2>/dev/null; then break; fi
  sleep 0.1
done

if ! HF_CONTROL_PORT="$CONTROL_PORT" HF_HARNESS_EXPECT="$DATA/expected.json" \
  node "$ROOT/test/control/electron-control-driver.js"; then
  tail -n 40 "$LOG"
  exit 1
fi

ROW="$DATA/mock-dynamo.jsonl"
COUNT="$(find "$DATA/mock-s3" -type f -name '*.webm' -size +1000c | wc -l)"
test "$COUNT" -eq 2
test -s "$ROW"
node -e "const f=require('node:fs');const e=JSON.parse(f.readFileSync(process.argv[1]));const rows=f.readFileSync(process.argv[2],'utf8').trim().split('\\n').map(JSON.parse);if(rows.length!==2||rows.some(r=>r.sessionId!==e.sessionId||r.identity.agentId!==e.agentId)||new Set(rows.map(r=>r.recordingId)).size!==2)process.exit(1)" "$DATA/expected.json" "$ROW"
echo "ELECTRON ROUND-TRIP PASS files=$COUNT rows=$(wc -l < "$ROW")"
