# HF Recorder — permission model

Capturing screen + microphone on Windows from an Electron (Chromium) desktop app
requires clearing **two independent permission layers**. Conflating them is the
usual source of "the app can't hear the mic" confusion. Screen capture is gated
only by layer 1; the microphone is gated by both.

## Layer 1 — Chromium / Electron (in-app)

Chromium has its own permission model. A renderer call to `getUserMedia()` or
`getDisplayMedia()` raises a permission request that, in a browser, would prompt
the user. In this app the main process auto-grants it, because the app itself is
the trusted first party:

- `session.setPermissionRequestHandler` grants `media` and `display-capture`.
- `session.setPermissionCheckHandler` returns `true` for the same.
- `session.setDisplayMediaRequestHandler` supplies the primary screen source
  (via `desktopCapturer.getSources`) so `getDisplayMedia` resolves without a
  picker.

Result: no in-app prompt, and no per-user action is needed for this layer.
See `src/main/main.js`.

## Layer 2 — Windows OS privacy (microphone)

Independently, Windows 10/11 gates microphone (and camera) access behind the
**privacy settings** at Settings → Privacy & security → Microphone. For an
unpackaged desktop app (which an Electron NSIS install is), the relevant switches
are "Microphone access", "Let apps access your microphone", and specifically
**"Let desktop apps access your microphone"**. These are backed by the registry:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\
    ConsentStore\microphone\Value                = Allow | Deny   (per-user)
    ConsentStore\microphone\NonPackaged\Value    = Allow | Deny   (desktop apps)
HKLM\...\ConsentStore\microphone\Value                            (device-wide)
```

If layer 2 is `Deny`, `getUserMedia({audio})` fails with `NotAllowedError` even
though layer 1 granted. Screen capture (`getDisplayMedia`) is **not** gated here.

### What the POC does about layer 2

- **Installer (best effort):** `build/installer.nsh` writes the per-user (HKCU)
  microphone ConsentStore `Value = Allow` at install time so a fresh install can
  record without the user hunting through Settings. This is **best effort only**
  — it is a semi-undocumented mechanism, a Windows update can reset it, and it
  cannot set device-wide or policy-managed state.
- **Runtime detect + guide:** on startup and on any capture failure, the app
  probes `ConsentStore\microphone\Value` (via `reg query`) and, if denied, shows
  an actionable banner that deep-links to `ms-settings:privacy-microphone`. So
  even if the pre-grant no-ops, capture never fails silently.

## Production / fleet answer (thousands of managed desktops)

The installer registry write is **not** the fleet strategy. For a managed fleet
the OS-privacy layer is provisioned by policy at device enrollment:

- **Intune (MDM):** Privacy CSP `LetAppsAccessMicrophone` = **Force Allow**
  (and, if a webcam is ever added, `LetAppsAccessCamera`). Deterministic,
  auditable, survives OS updates.
- **Group Policy** equivalent: *App Privacy → Let Windows apps access the
  microphone* = Force Allow, where Intune is not used.

Layer 1 needs no fleet action — it is owned entirely by the app.

This split (app owns layer 1; MDM/GPO owns layer 2; installer pre-grant is a
fallback for unmanaged/POC machines) is the recommendation carried into the
`hf-recorder__upload_auth_permissions_arch` architecture spec.
