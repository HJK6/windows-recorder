#!/usr/bin/env bash
# Resolve a device's enrollment secret for FR_DEVICE_BOOTSTRAP_SECRET, fail CLOSED
# if the device isn't enrolled or the id is malformed. Prints the secret ONLY to
# stdout (for capture into an env var); never echoed, logged, or shown on a prompt.
#
# IMPORTANT caller contract (fail-closed): a command substitution inside
# `export VAR=$(...)` HIDES this script's exit code. Assign separately and stop on
# failure, then export:
#   secret="$(aws/scripts/device-secret.sh "$FR_DEVICE_ID" --from-terraform)" || exit 1
#   [ -n "$secret" ] || exit 1
#   export FR_DEVICE_BOOTSTRAP_SECRET="$secret"
#
# Source: SSM SecureString /fleet-recorder-poc/enroll/<id> (default; cross-host),
# or the terraform device_enrollment map with --from-terraform (needs local state).
set -euo pipefail

DEVICE_ID="${1:-}"
SRC="${2:---from-ssm}"

# Reject empty/malformed ids BEFORE any lookup or interpolation (no code exec).
if [ -z "$DEVICE_ID" ] || ! printf '%s' "$DEVICE_ID" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  echo "device-secret: invalid device id (must match ^[A-Za-z0-9._-]+\$)" >&2
  exit 2
fi

case "$SRC" in
  --from-ssm)
    val="$(aws ssm get-parameter --name "/fleet-recorder-poc/enroll/$DEVICE_ID" \
      --with-decryption --region us-east-1 --query Parameter.Value --output text 2>/dev/null || true)"
    ;;
  --from-terraform)
    HERE="$(cd "$(dirname "$0")" && pwd)"
    # DEVICE_ID is passed as argv to python (sys.argv[1]) — never interpolated into code.
    val="$(terraform -chdir="$HERE/.." output -json device_enrollment 2>/dev/null \
      | python3 -c 'import sys,json
m=json.load(sys.stdin)
print(m.get(sys.argv[1], "") if isinstance(m, dict) else "")' "$DEVICE_ID" 2>/dev/null || true)"
    ;;
  *)
    echo "device-secret: unknown source '$SRC' (use --from-ssm or --from-terraform)" >&2
    exit 2
    ;;
esac

if [ -z "$val" ] || [ "$val" = "None" ]; then
  echo "device-secret: no enrollment found for device id '$DEVICE_ID' (fail closed)" >&2
  exit 1
fi
printf '%s' "$val"
