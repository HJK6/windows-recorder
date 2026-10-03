# Fleet Recorder — AWS WebSocket control POC

A proof-of-concept screen + microphone desktop recorder whose control plane is an
**outbound-only AWS WebSocket channel**, replacing the previously rejected
localhost control server. The desktop opens a single encrypted outbound
connection to API Gateway; a browser page talks HTTPS to AWS; AWS pushes narrowly
scoped commands down the desktop's connection; media uploads directly to private
S3 by presigned PUT. **There is no network listener on the workstation.**

This POC proves one desktop client on an architecture designed to scale. It is
**not** fleet/production qualified. See [Future work](#future-work).

## What the POC proves

1. Browser **start / pause / resume / stop**, each confirmed by the desktop's
   **applied acknowledgment** (the UI shows a confirmed state only from an ack).
2. **Authorization denial** — expired / wrong-scope / tampered / wrong-target
   tokens are rejected.
3. **Reconnect after a network drop** with no duplicate capture (the encoder is
   not restarted; the recording keeps its identity).
4. **Upload on stop**, verified by size + SHA-256 checksum at the backend.
5. **No application network listener** (port/listener scan, incl. IPv6).

## Architecture

```
Browser page ── HTTPS ─▶ API Gateway HTTP API ─▶ Lambda (control) ─▶ DynamoDB (state)
                                                        │
                                                        ▼  ApiGateway Management API
Windows desktop ◀── WSS (outbound, desktop-initiated) ── API Gateway WebSocket API
      │                                                  ($connect Lambda authorizer)
      └── HTTPS presigned PUT ─▶ private KMS-encrypted S3 ─▶ (verify size + checksum)
```

- `src/main/ws-client.js` — outbound WSS client: hello / heartbeat / command /
  applied-ack / jittered reconnect; survives a drop without restarting capture.
- `src/main/identity.js` — `IdentityProvider` interface + mock IdP (short-lived,
  scoped, signed device tokens via device enrollment material). Swap in real
  SSO / Twilio Flex validation later with no handler change.
- `src/main/upload.js` — just-in-time upload grant → presigned PUT → verified complete.
- `src/shared/jwt.js` — HS256 sign/verify (no external deps), fail-closed.
- `aws/` — Terraform root + the three control Lambdas (`aws/lambda/`).
- The browser control page is served same-origin at `GET /app` (no CORS, no
  local web server); its source is `aws/lambda/http/app-page.js`.

## Tests

```
npm install
npm test            # pure state machines, ws-client, identity, upload, jwt, app page
```

The in-tree mock WebSocket server (`test/ws/mock-ws-server.js`) is **test-only**
and is never imported by the packaged app.

## Deploy (our AWS account only)

Prereqs: Terraform ≥ 1.6, AWS creds for your POC account, `node`.

```
cd aws
printf 'aws_account_id = "<your-account-id>"\naws_region = "us-east-1"\n' > poc.tfvars  # gitignored
( cd lambda && npm install --omit=dev )   # bundle the Lambda SDK deps
terraform init
bash scripts/account-guard.sh             # refuses any account but ours
terraform plan  -var-file=poc.tfvars -out=build/poc.tfplan
terraform apply build/poc.tfplan
```

The provider's `allowed_account_ids` and a `check` block hard-fail on any account
but your configured account / us-east-1. Every resource is tagged `project=fleet-recorder-poc`,
pay-per-request, no reserved capacity.

Outputs (read with `terraform output`): `ws_url`, `http_api_url`, `app_url`
(sensitive — includes the browser login key), `device_enrollment` (sensitive —
a `{ deviceId: secret }` map; each enrolled device has its own secret),
`media_bucket`, `control_table`.

### Prove the control path (synthetic device, no UI)

```
bash scripts/curl-journey.sh
```

Starts a synthetic headless device (reusing the real desktop modules), then drives
start → applied-ack → pause/resume → stop → checksum-verified upload, and checks
authorization denial. Prints `CURL JOURNEY PASS`.

### Run the real desktop (connected mode)

Each device has its own enrollment secret (there is no single `device_bootstrap_secret`).
Select it for your `FR_DEVICE_ID` and inject it privately — the helper fails closed if
the device isn't enrolled and never prints the secret:

```
export FR_WS_URL="$(terraform -chdir=aws output -raw ws_url)"
export FR_HTTP_API_URL="$(terraform -chdir=aws output -raw http_api_url)"
export FR_DEVICE_ID="amaterasu-01"
# From the enrollment map in local state (or drop --from-terraform to read SSM):
export FR_DEVICE_BOOTSTRAP_SECRET="$(aws/scripts/device-secret.sh "$FR_DEVICE_ID" --from-terraform)"
npm start
```

With no `FR_WS_URL`/`FR_HTTP_API_URL` the app runs in local demo mode (window
buttons, saves locally) — still no listener. Open the control page at the
`app_url` output. See `aws/P5-AMATERASU-RUNBOOK.md` for the Windows end-to-end.

## Teardown

```
terraform -chdir=aws destroy -var-file=poc.tfvars
```

Removes every tagged resource (the bucket is `force_destroy`; the KMS key has a
7-day deletion window). **Rollback** of the POC is this destroy — the stack is
net-new and modifies nothing pre-existing.

## Security / repo hygiene

- Public repo. **No** company identifiers, account IDs, tenant/Twilio IDs,
  bucket/table names, `*.tfvars`/state/plans, secrets, media, or bearer/presigned
  URLs are committed (see `.gitignore`). Company values are Terraform variables
  from an uncommitted tfvars.
- Server-side secrets (token signing, device bootstrap, browser login key) are
  generated by Terraform and live only in Lambda env + local state. The desktop
  holds no static AWS credentials; the browser holds only short-lived tokens.
- Terraform state is local and gitignored; it contains secrets — protect it.

## Future work

Not in this POC (named, not scheduled): crash recovery of in-flight media; 120 s
capture leases and >120 s outage pause; 30 s segmentation / journal / encrypted
spool / manifests; device enrollment, corporate SSO and pairing; Twilio call-audio
+ Flex plugin + webhook reconciliation; the company pipeline-table adapter;
load/scale qualification; observability/alarms; code-signing/Intune. The scalable
architecture supports these; full requirements live in the implementation spec.
