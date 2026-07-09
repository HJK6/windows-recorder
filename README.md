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
- Saves to `%USERPROFILE%\Documents\HFRecorder\HFRecorder-<timestamp>.webm`.

Not in v1: webcam, system/loopback audio, real call-audio, automatic/triggered
recording, upload, code signing. See the spec's Non-Goals.

## Architecture

```
src/
  shared/recorderState.js   pure state machine (record/pause/resume/mute/unmute/stop)
                            — emits "effects" the renderer applies to real objects
  main/main.js              Electron main: permission handlers, screen source,
                            file save, Windows mic-consent probe
  main/preload.js           narrow contextBridge API (window.hf.*)
  renderer/index.html       UI
  renderer/renderer.js      wires DOM + state machine -> MediaRecorder + tracks
build/installer-standalone.nsi  NSIS installer (native makensis): per-user install,
                            mic ConsentStore pre-grant, shortcuts, uninstaller
test/recorderState.test.js  unit tests for the state machine
docs/permission_model.md    the two-layer permission model, in detail
```

The state machine is deliberately framework-free so the pause-vs-mute semantics
are unit-tested without Electron or a real recorder.

## Develop

```bash
npm install
npm test        # runs the state-machine unit tests (pure Node)
npm start       # launches the Electron app
```

Real screen/microphone capture and the Windows permission behavior must be
validated on Windows (see docs/permission_model.md). A WSLg/Linux dev run
exercises the UI and logic but not the real Windows privacy layer.

## Build the Windows installer

```bash
npm run dist    # electron-builder --win --dir  +  makensis build/installer-standalone.nsi
                # -> dist/HFRecorder-Setup-<ver>.exe
```

`dist` packs the app (`electron-builder --dir`, no signing/rcedit) then wraps it
with a hand-written NSIS script compiled by **native `makensis`** — so the whole
build runs on Linux/WSL with **no wine**. Requires `makensis` (`apt install nsis`).

The installer is **per-user** (no admin), **silent-install capable** (`/S`, for
Intune/GPO fleet rollout), sets the mic ConsentStore pre-grant, and registers an
uninstaller. It is **unsigned** for the POC (expect a SmartScreen warning) — code
signing is a production follow-up.

## Permissions (short version)

Two independent layers must both allow capture:

1. **In-app (Chromium/Electron)** — auto-granted by the app; no user prompt.
2. **Windows OS privacy** (Settings → Privacy → Microphone) — the installer
   makes a best-effort per-user pre-grant, and the app detects a denied state
   and deep-links the user to the setting. The **production** fleet answer is
   Intune/GPO policy, not the installer hack. Full detail:
   [docs/permission_model.md](docs/permission_model.md).
