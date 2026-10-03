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

## 2. Launch the desktop (connected mode)
```
set HF_WS_URL=<ws_url>
set HF_HTTP_API_URL=<http_api_url>
set HF_DEVICE_ID=amaterasu-01
set HF_DEVICE_BOOTSTRAP_SECRET=<device_bootstrap_secret>
npm start
```
Expect the window to show connection ONLINE (welcome received).

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
