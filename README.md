# HF Recorder (POC)

Screen + microphone desktop recorder — a proof-of-concept replacement for the
Calabrio recording client used by Health First agents. This POC records
**locally**: it captures the screen + microphone, merges them into a single
`.webm`, and saves it to `Documents\HFRecorder\`. There is **no upload** in this
POC — the secure AWS upload + fleet authentication are designed separately (see
the `hf-recorder__upload_auth_permissions_arch` spec in Triforce memory).

## What it does

- Captures **screen video** (primary display) + **microphone audio**.
- Merges both into one WebM via a single `MediaRecorder` over a combined
  `MediaStream` (no post-hoc muxing, no A/V drift).
- Controls: **Record / Pause / Resume / Mute / Unmute / Stop**.
  - **Pause** halts the whole recording (video + audio); **Resume** continues.
  - **Mute** silences the microphone while **video keeps recording**
    (`audioTrack.enabled = false`); **Unmute** restores audio.
- Saves to `%USERPROFILE%\Documents\HFRecorder\HFRecorder-<timestamp>-<id>.webm`.

Not in v1: webcam, system/loopback audio, real call-audio, automatic/triggered
recording, upload, code signing. See the spec's Non-Goals.

## Architecture

```
src/
  shared/recorderState.js   pure state machine (record/pause/resume/mute/unmute/stop)
                            — emits "effects" the renderer + smoke apply to real objects
  shared/applyEffect.js     shipped effect layer: effect -> MediaRecorder/track action
  shared/permissions.js     pure permission logic (capture-grant + two-key mic consent)
  main/main.js              Electron main: window, IPC, file save, Windows mic-consent probe
  main/capture-session.js   permission + getDisplayMedia wiring (shared with the smoke)
  main/preload.js           narrow contextBridge API (window.hf.*)
  renderer/index.html       UI
  renderer/renderer.js      wires DOM + state machine -> MediaRecorder + tracks
build/installer-standalone.nsi  NSIS installer (native makensis): per-user install,
                            mic ConsentStore pre-grant, shortcuts, uninstaller
test/*.test.js              21 unit tests: state machine, permissions, effect layer
test/smoke/                 headless fake-device capture smoke (xvfb + ffprobe)
docs/permission_model.md    the two-layer permission model, in detail
```

The state machine is deliberately framework-free so the pause-vs-mute semantics
are unit-tested without Electron or a real recorder.

## Develop

```bash
npm install
npm test        # 21 unit tests (state machine, permissions, effect layer) — pure Node
npm run smoke   # headless fake-device capture smoke (Linux: needs xvfb + ffmpeg)
npm start       # launches the Electron app
```

Real screen/microphone capture and the Windows permission behavior must be
validated on Windows (see docs/permission_model.md). A WSLg/Linux dev run
exercises the UI and logic but not the real Windows privacy layer.

## Build the Windows installer (the `.exe`)

Prerequisites: **Node 20+** and **`makensis`** (`sudo apt install nsis` on
Linux/WSL; already on most Windows NSIS installs). No wine required.

```bash
npm install            # once, to fetch electron + electron-builder
npm run dist           # -> dist/HFRecorder-Setup-<version>.exe   (~106 MB)
```

`npm run dist` runs two steps: `electron-builder --win --dir` packs the app into
`dist/win-unpacked/` (no signing/rcedit, so no wine), then **native `makensis`**
compiles `build/installer-standalone.nsi` around it. The `<version>` comes from
`package.json`.

The resulting installer is **per-user** (no admin), **silent-install capable**
(`HFRecorder-Setup-<ver>.exe /S`, for Intune/GPO fleet rollout), sets the mic
ConsentStore pre-grant, creates Desktop + Start-menu shortcuts, and registers an
uninstaller in Add/Remove Programs. It is **unsigned** for the POC (expect a
SmartScreen "More info → Run anyway") — code signing is a production follow-up.

To uninstall: Add/Remove Programs → "HF Recorder", or run
`%LOCALAPPDATA%\Programs\HFRecorder\Uninstall.exe` (`/S` for silent).

## Permissions (short version)

Two independent layers must both allow capture:

1. **In-app (Chromium/Electron)** — auto-granted by the app; no user prompt.
2. **Windows OS privacy** (Settings → Privacy → Microphone) — the installer
   makes a best-effort per-user pre-grant, and the app detects a denied state
   and deep-links the user to the setting. The **production** fleet answer is
   Intune/GPO policy, not the installer hack. Full detail:
   [docs/permission_model.md](docs/permission_model.md).
