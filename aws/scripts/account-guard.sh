#!/usr/bin/env bash
# Account/region guard (ruling d956a689 cond. 4). Run before any plan/apply or
# the curl journey. Fails closed if the active credentials are not our account.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# Expected account comes from the environment or the (gitignored) poc.tfvars,
# never hardcoded in this public repo.
EXPECT_ACCT="${AWS_EXPECTED_ACCOUNT:-$(grep -E '^\s*aws_account_id' "$HERE/../poc.tfvars" 2>/dev/null | sed -E 's/.*"([0-9]+)".*/\1/')}"
EXPECT_REGION="${AWS_EXPECTED_REGION:-us-east-1}"

if [ -z "$EXPECT_ACCT" ]; then
  echo "GUARD FAIL: no expected account (set AWS_EXPECTED_ACCOUNT or aws_account_id in aws/poc.tfvars)" >&2
  exit 1
fi

ACCT="$(aws sts get-caller-identity --query Account --output text)"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}"

if [ "$ACCT" != "$EXPECT_ACCT" ]; then
  echo "GUARD FAIL: active account $ACCT != allowed $EXPECT_ACCT" >&2
  exit 1
fi
if [ "$REGION" != "$EXPECT_REGION" ]; then
  echo "GUARD FAIL: region $REGION != $EXPECT_REGION" >&2
  exit 1
fi
echo "guard ok: account $ACCT, region $EXPECT_REGION"
