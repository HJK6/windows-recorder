'use strict';

/*
 * Headless capture smoke harness (Electron main).
 *
 * Proves the end-to-end capture->merge->file path without real hardware:
 * Chromium fake devices provide a synthetic camera video + mic audio track;
 * the page composes them into ONE MediaStream, records through a
 * pause/resume + mute/unmute cycle, and writes the merged WebM. run-smoke.sh
 * then asserts with ffprobe that the output has exactly 1 video + 1 audio
 * track — i.e. the merge worked and pause/mute didn't corrupt the container.
 *
 * This is test-only code; it does not import or alter production main.js. It
 * uses a fake CAMERA (not getDisplayMedia) because the screen path needs a real
 * desktop and is validated separately on Windows; the merge/mux/control logic
 * proven here is identical.
 */

const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.disableHardwareAcceleration();

const OUT = process.env.HF_SMOKE_OUT || path.join(app.getPath('temp'), 'hf-smoke.webm');

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(true));

  ipcMain.handle('smoke-save', async (_e, bytes) => {
    await fs.promises.writeFile(OUT, Buffer.from(bytes));
    return OUT;
  });
  ipcMain.on('smoke-done', (_e, ok) => {
    // small delay so the invoke() write settles
    setTimeout(() => app.exit(ok ? 0 : 1), 100);
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.loadFile(path.join(__dirname, 'smoke-page.html'));

  // Hard timeout so a hung capture fails the smoke instead of hanging CI.
  setTimeout(() => { console.error('SMOKE-TIMEOUT'); app.exit(2); }, 20000);
});
