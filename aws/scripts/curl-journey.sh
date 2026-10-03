#!/usr/bin/env bash
# P2 acceptance: prove the full control path in AWS with a SYNTHETIC headless
# device — start -> applied ack -> pause/resume -> stop -> checksum-verified
# upload — plus an authorization-denial check. Run after `terraform apply`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AWS_DIR="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$AWS_DIR/.." && pwd)"

bash "$HERE/account-guard.sh"

tf() { terraform -chdir="$AWS_DIR" output -raw "$1"; }
WS_URL="$(tf ws_url)"
HTTP_API="$(tf http_api_url)"
LOGIN_KEY="$(tf browser_login_key)"
DEVICE_ID="poc-curl-01"
BOOTSTRAP="$(terraform -chdir="$AWS_DIR" output -json device_enrollment | python3 -c 'import sys,json;print(json.load(sys.stdin)["poc-curl-01"])')"

echo "== HTTP API: $HTTP_API"
echo "== WS URL:   $WS_URL"

DEVLOG="$(mktemp)"
HF_WS_URL="$WS_URL" HF_HTTP_API_URL="$HTTP_API" HF_DEVICE_ID="$DEVICE_ID" \
  HF_DEVICE_BOOTSTRAP_SECRET="$BOOTSTRAP" \
  node "$HERE/fake-device.js" >"$DEVLOG" 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null || true' EXIT

jqget() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"; }

# control token for the browser side
CTRL="$(curl -s -X POST "$HTTP_API/v1/auth/control-token" -H 'content-type: application/json' \
  -d "{\"loginKey\":\"$LOGIN_KEY\"}" | jqget token)"
[ -n "$CTRL" ] || { echo "FAIL: no control token"; exit 1; }

echo "== waiting for device online ..."
for i in $(seq 1 30); do
  ONLINE="$(curl -s "$HTTP_API/v1/recorder/status" -H "authorization: Bearer $CTRL" | jqget deviceOnline)"
  [ "$ONLINE" = "True" ] && break
  sleep 1
done
[ "$ONLINE" = "True" ] || { echo "FAIL: device never came online"; cat "$DEVLOG"; exit 1; }
echo "   device online"

poll_observed() {  # $1 recordingId  $2 expected  -> wait up to 20s
  for i in $(seq 1 20); do
    OBS="$(curl -s "$HTTP_API/v1/recorder/status?recordingId=$1" -H "authorization: Bearer $CTRL" | jqget observedState)"
    [ "$OBS" = "$2" ] && return 0
    sleep 1
  done
  echo "FAIL: $1 observed '$OBS' != '$2'"; cat "$DEVLOG"; return 1
}

echo "== start"
REC="$(curl -s -X POST "$HTTP_API/v1/recordings" -H "authorization: Bearer $CTRL" -H 'content-type: application/json' -d "{\"deviceId\":\"$DEVICE_ID\"}" | jqget recordingId)"
[ -n "$REC" ] || { echo "FAIL: no recordingId"; exit 1; }
echo "   recordingId=$REC"
poll_observed "$REC" RECORDING
echo "   confirmed RECORDING"

echo "== pause";  curl -s -X POST "$HTTP_API/v1/recordings/$REC/pause"  -H "authorization: Bearer $CTRL" >/dev/null; poll_observed "$REC" PAUSED;    echo "   confirmed PAUSED"
echo "== resume"; curl -s -X POST "$HTTP_API/v1/recordings/$REC/resume" -H "authorization: Bearer $CTRL" >/dev/null; poll_observed "$REC" RECORDING; echo "   confirmed RECORDING"
echo "== stop";   curl -s -X POST "$HTTP_API/v1/recordings/$REC/stop"   -H "authorization: Bearer $CTRL" >/dev/null; poll_observed "$REC" IDLE;      echo "   confirmed IDLE"

echo "== waiting for checksum-verified upload ..."
for i in $(seq 1 20); do
  grep -q "upload verified=true" "$DEVLOG" && break
  sleep 1
done
grep -q "upload verified=true" "$DEVLOG" || { echo "FAIL: upload not verified"; cat "$DEVLOG"; exit 1; }
echo "   $(grep 'upload verified=true' "$DEVLOG")"

echo "== authorization denial (garbage control token)"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HTTP_API/v1/recordings" -H "authorization: Bearer not-a-real-token" -H 'content-type: application/json' -d '{}')"
[ "$CODE" = "401" ] || { echo "FAIL: expected 401 for bad token, got $CODE"; exit 1; }
echo "   denied with 401 as expected"

echo "== device-token denial (wrong enrollment secret)"
CODE2="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HTTP_API/v1/auth/device-token" -H 'content-type: application/json' -d '{"deviceId":"x","bootstrapSecret":"wrong"}')"
[ "$CODE2" = "401" ] || { echo "FAIL: expected 401 for bad enrollment, got $CODE2"; exit 1; }
echo "   denied with 401 as expected"

echo
echo "CURL JOURNEY PASS"
