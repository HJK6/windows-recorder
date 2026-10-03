#!/usr/bin/env bash
# Resolve a device's enrollment secret for FR_DEVICE_BOOTSTRAP_SECRET, fail CLOSED
# if the device isn't enrolled. Prints the secret ONLY to stdout (for capture into
# an env var); it is never echoed, logged, or shown on a prompt. Use as:
#
#   export FR_DEVICE_ID=amaterasu-01
#   export FR_DEVICE_BOOTSTRAP_SECRET="$(aws/scripts/device-secret.sh "$FR_DEVICE_ID")"
#
# Source: SSM SecureString /fleet-recorder-poc/enroll/<id> (default; works cross-host),
# or the terraform device_enrollment map with --from-terraform (needs local state).
set -euo pipefail
DEVICE_ID="${1:?usage: device-secret.sh <deviceId> [--from-terraform]}"
SRC="${2:---from-ssm}"

if [ "$SRC" = "--from-terraform" ]; then
  HERE="$(cd "$(dirname "$0")" && pwd)"
  val="$(terraform -chdir="$HERE/.." output -json device_enrollment 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('$DEVICE_ID',''))" 2>/dev/null || true)"
else
  val="$(aws ssm get-parameter --name "/fleet-recorder-poc/enroll/$DEVICE_ID" \
    --with-decryption --region us-east-1 --query Parameter.Value --output text 2>/dev/null || true)"
fi

if [ -z "$val" ] || [ "$val" = "None" ]; then
  echo "device-secret: no enrollment found for device id '$DEVICE_ID' (fail closed)" >&2
  exit 1
fi
printf '%s' "$val"
