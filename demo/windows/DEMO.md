# HF Recorder V1 demo

## Cold start

1. Double-click `HFRecorder-Setup-0.2.0.exe` and complete the installer.
2. Open Start, search for **HF Recorder**, and launch the app normally.
3. Wait for the desktop recorder to open.
4. Double-click `HF-Recorder-Demo.html` to open the browser control page.

## Website-driven rehearsal

1. On the browser page click **Record** and approve screen sharing if Windows asks.
2. Click **Pause**, **Resume**, **Mute**, **Unmute**, then **Stop**.
3. Confirm the page reports that the recording was saved under `Documents\HFRecorder`.

## Desktop-only rehearsal

1. Close the browser tab. Leave the HF Recorder desktop app running.
2. In the desktop app click **Record**, **Pause**, **Resume**, **Mute**, **Unmute**, then **Stop**.
3. Confirm a second recording appears under `Documents\HFRecorder`.

The normal Start-menu launch starts only the recorder UI and a loopback HTTP control
API (`http://127.0.0.1:18765`). The standalone HTML opens directly from this folder in
Edge or Chrome and never starts or restarts the app — each button is a plain HTTP
request to that API. It polls the recorder about once a second, so it mirrors the app's live state whether
you drive it from here or from the app's own desktop buttons; if the app is closed it
says so and keeps retrying, recovering automatically when the app is back. The
token-activation path is retained in the source but off the runtime path in this
build — re-enabling it is a code step (see the project README, "Re-enabling auth"),
not a launch flag.
