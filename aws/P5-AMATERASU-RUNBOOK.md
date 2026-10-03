# P5 — Amaterasu Windows end-to-end runbook (synthetic capture)

Goal: prove the five POC proofs with the **real** Electron desktop doing **real
screen + mic capture** on Amaterasu (Windows), against the deployed AWS stack.
Synthetic screen content and a synthetic/mic test source only — no real customer
data. Do not change Amaterasu's existing services. Run in the interactive
desktop session (capture needs a real session, not Session 0).

Secrets (device bootstrap secret, browser login key) come from `terraform
output` at run time; never paste them into the repo, logs, or chat.

## 0. Prereqs on Amaterasu
- Node + the repo checked out at the reviewed SHA; `npm ci`.
- Network egress 443 to `*.execute-api.us-east-1.amazonaws.com` (outbound only).
- A synthetic screen (test pattern / looping video window) and a mic test tone or
  the "Stereo Mix"/virtual mic; or accept silence (silence is not failure).

## 1. Endpoints (read on the deploy host, pass over to Amaterasu securely)
```
terraform -chdir=aws output -raw ws_url
terraform -chdir=aws output -raw http_api_url
terraform -chdir=aws output -raw device_bootstrap_secret   # sensitive
terraform -chdir=aws output -raw app_url                   # sensitive (has ?k=)
```

## 2. Launch the desktop (connected mode, SESSION 1, synthetic media)

Capture needs the **interactive session (session 1)** — a process started in
session 0 captures a blank frame. Launch via an **interactive-token scheduled
task** (the `Agent Open Model` pattern in `machine_amaterasu.md`), from WSL, so
the GUI runs in the operator's console session. Use **Chromium fake media** so
the screen + mic are synthetic and silent (no real content/sound):

Env for the run:
```
HF_WS_URL=<ws_url>
HF_HTTP_API_URL=<http_api_url>
HF_DEVICE_ID=amaterasu-01
HF_DEVICE_BOOTSTRAP_SECRET=<device_bootstrap_secret>
HF_FAKE_MEDIA=1            # Chromium --use-fake-device-for-media-stream + --use-fake-ui-for-media-stream
```

Launch (one of):
- **Interactive-token task (preferred).** Register a one-shot task that runs a
  `.cmd` wrapper which `set`s the env above and runs `npm start` (Windows-native
  Electron), with an interactive token / `RunLevel=Highest`, then `schtasks /run`
  it so it lands in session 1. Mirror the registrar used for `Agent Open Model` /
  `TriforceInteropKeeper` (RunLevel=Highest minted an interactive token). Keep the
  run to minutes; stop the task and close the app when done.
- **Operator-run.** The operator starts it from the console session with the env
  above.

**Execution options for this lane:** either (a) the lead spawns a Claude seat on
`--host amaterasu` to run this runbook with the deployed endpoints (device work on
the wired host), or (b) the operator runs it. Coordinate which with the front desk.

Expect the window to show connection ONLINE (welcome received). With `HF_FAKE_MEDIA`
the capture is a synthetic test pattern + silent mic.

## 3. Proof 1 — start/pause/resume/stop with applied acks
Open `app_url` in a browser. Click Start → the Amaterasu window begins real
capture and the page flips to **Confirmed: RECORDING** only after the ack. Click
Pause/Resume/Stop; each confirmed state must come from the ack (page never shows
a state optimistically). Capture screenshots of page + window at each step.

## 4. Proof 2 — authorization denial
- Device side: relaunch with a wrong `HF_DEVICE_BOOTSTRAP_SECRET` → device-token
  request returns 401; the WS `$connect` is refused; window stays OFFLINE.
- Browser side: paste a garbage token into the page's override field → control
  calls return 401. Record both.

## 5. Proof 3 — reconnect after a network drop (no duplicate capture)
While RECORDING, drop egress briefly, e.g. block the endpoint for ~20 s:
```
# PowerShell (admin), outbound block to API Gateway, then remove it:
New-NetFirewallRule -DisplayName hf-poc-drop -Direction Outbound -Action Block -RemoteAddress <api-ip-or-range>
Start-Sleep 20; Remove-NetFirewallRule -DisplayName hf-poc-drop
```
Expect: capture continues through the drop; on restore the client reconnects and
re-acks the SAME recordingId; the encoder is NOT restarted; exactly one recording
is produced. Confirm via the window state and the single uploaded object.

## 6. Proof 4 — upload on stop, checksum verified
On Stop, the desktop finalizes the WebM, requests an upload grant, PUTs to S3 with
the signed SHA-256, and the backend verifies size + checksum. Confirm:
```
# On the deploy host:
aws s3api list-objects-v2 --bucket "$(terraform -chdir=aws output -raw media_bucket)" --query 'Contents[].{Key:Key,Size:Size}'
aws s3api head-object --bucket <bucket> --key <key> --checksum-mode ENABLED --query '{Len:ContentLength,Sum:ChecksumSHA256,Enc:ServerSideEncryption}'
```
Object present, SSE=aws:kms, checksum matches the desktop's computed SHA-256.

## 7. Proof 5 — no application network listener
In the interactive session while the app runs:
```
# PowerShell — show any LISTENING sockets owned by the recorder process(es):
Get-NetTCPConnection -State Listen |
  Where-Object { (Get-Process -Id $_.OwningProcess).ProcessName -match 'electron|HFRecorder|node' } |
  Format-Table LocalAddress,LocalPort,OwningProcess
# IPv6 + IPv4 full view for the evidence pack:
netstat -ano -p TCP ; netstat -ano -p TCPv6
```
Expected: the recorder owns only OUTBOUND/ESTABLISHED connections to 443, and
**no LISTENING** socket (no localhost server, debug port, or OAuth callback).

## 8. Evidence pack
Collect under an evidence folder (gitignored, not committed): screenshots per
step, the netstat/Get-NetTCPConnection output, the `head-object` JSON, and the
app log. Summarize pass/fail per proof. Hand the summary to the lead for the final
Luna review; keep raw media/URLs out of shared memory (pointers only).
