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

## 1. Endpoints + per-device secret (resolve on-host, never print the secret)
```
terraform -chdir=aws output -raw ws_url
terraform -chdir=aws output -raw http_api_url
terraform -chdir=aws output -raw app_url                   # sensitive (has ?k=)
```
There is NO single `device_bootstrap_secret`. Each device has its own secret in the
`device_enrollment` map (and in SSM `/fleet-recorder-poc/enroll/<deviceId>`). On
Amaterasu, select amaterasu-01's secret and inject it PRIVATELY — fail closed if the
device is not enrolled, and never echo/log the value:
Assign separately and STOP on failure before launch (do NOT use
`export VAR=$(helper)` — it hides a failed lookup and launches with an empty secret):
```
export FR_DEVICE_ID=amaterasu-01
# cross-host default reads SSM (needs our-account creds); or add --from-terraform on the deploy host:
secret="$(aws/scripts/device-secret.sh "$FR_DEVICE_ID")" \
  || { echo "enrollment lookup failed for $FR_DEVICE_ID — not launching" >&2; exit 1; }
[ -n "$secret" ] || { echo "empty enrollment secret — not launching" >&2; exit 1; }
export FR_DEVICE_BOOTSTRAP_SECRET="$secret"
```

## 2. Launch the desktop (connected mode, SESSION 1, synthetic media)

Capture needs the **interactive session (session 1)** — a process started in
session 0 captures a blank frame. Launch via an **interactive-token scheduled
task** (the `Agent Open Model` pattern in `machine_amaterasu.md`), from WSL, so
the GUI runs in the operator's console session. Use **Chromium fake media** so
the screen + mic are synthetic and silent (no real content/sound):

Env for the run (FR_DEVICE_BOOTSTRAP_SECRET resolved as in §1, never printed):
```
FR_WS_URL=<ws_url>
FR_HTTP_API_URL=<http_api_url>
FR_DEVICE_ID=amaterasu-01
FR_DEVICE_BOOTSTRAP_SECRET=<from aws/scripts/device-secret.sh "$FR_DEVICE_ID">
FR_FAKE_MEDIA=1            # Chromium --use-fake-device-for-media-stream + --use-fake-ui-for-media-stream
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

Expect the window to show connection ONLINE (welcome received). With `FR_FAKE_MEDIA`
the capture is a synthetic test pattern + silent mic.

## 3. Proof 1 — start/pause/resume/stop with applied acks
Open `app_url` in a browser. Click Start → the Amaterasu window begins real
capture and the page flips to **Confirmed: RECORDING** only after the ack. Click
Pause/Resume/Stop; each confirmed state must come from the ack (page never shows
a state optimistically). Capture screenshots of page + window at each step.

## 4. Proof 2 — authorization denial
- Device side: relaunch with a wrong `FR_DEVICE_BOOTSTRAP_SECRET` → device-token
  request returns 401; the WS `$connect` is refused; window stays OFFLINE.
- Browser side: paste a garbage token into the page's override field → control
  calls return 401. Record both.

## 5. Proof 3 — reconnect after a network drop (no duplicate capture)
Coordinate the UI window with the front desk first. While RECORDING, drop egress for
~20 s by blocking **only the recorder executable's** outbound (NOT an API IP/range —
that is brittle and over-broad), with **guaranteed cleanup** via `try/finally` so the
rule is always removed even on error/Ctrl-C:
Use the EXACT recorder process you launched — not `Get-Process electron | First`,
which may pick an unrelated Electron app. Capture the recorder PID at launch (the
interactive-token task's started process id), then resolve its executable from THAT pid:
```
# PowerShell (admin). $recorderPid = the PID recorded when the task launched the app.
$proc = Get-Process -Id $recorderPid -ErrorAction Stop         # fail if that PID is gone
$exe  = $proc.Path                                             # exact executable of OUR recorder
$rule = "fleet-poc-drop-$recorderPid"                          # unique, owned rule name
New-NetFirewallRule -DisplayName $rule -Direction Outbound -Program "$exe" -Action Block | Out-Null
try { Start-Sleep -Seconds 20 }
finally {
  Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
  if (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue) {
    Write-Error "firewall rule $rule NOT removed — remove it manually"    # removal readback
  } else { "firewall rule $rule removed" }
}
```
This is the method the accepted P5 run used (executable-scoped outbound block → the
recorder's socket errors and reconnects while everything else keeps working). The
accepted reconnect receipt stands; do not re-run real capture for this docs fix.
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
  Where-Object { (Get-Process -Id $_.OwningProcess).ProcessName -match 'electron|FleetRecorder|node' } |
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
