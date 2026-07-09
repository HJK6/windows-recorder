'use strict';

/*
 * Headless capture smoke harness (Electron main).
 *
 * Exercises the SHIPPED main-process capture wiring (wireCapturePermissions
 * from src/main/capture-session.js, incl. setDisplayMediaRequestHandler) and,
 * in the page, the SHIPPED state machine + effect layer (recorderState +
 * applyEffect). Chromium fake devices remove the hardware dependency; the page
 * tries real getDisplayMedia (through the production handler) and falls back to
 * a fake camera if xvfb can't screen-capture. run-smoke.sh then asserts with
 * ffprobe that the merged WebM has exactly 1 video + 1 audio track.
 */

const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { wireCapturePermissions } = require('../../src/main/capture-session');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.disableHardwareAcceleration();

const OUT = process.env.HF_SMOKE_OUT || path.join(app.getPath('temp'), 'hf-smoke.webm');

app.whenReady().then(() => {
  // Real production permission + display-media wiring.
  wireCapturePermissions(session.defaultSession, desktopCapturer);

  ipcMain.handle('smoke-save', async (_e, bytes) => {
    await fs.promises.writeFile(OUT, Buffer.from(bytes));
    return OUT;
  });
  ipcMain.on('smoke-done', (_e, ok) => {
    setTimeout(() => app.exit(ok ? 0 : 1), 100);
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.loadFile(path.join(__dirname, 'smoke-page.html'));

  setTimeout(() => { console.error('SMOKE-TIMEOUT'); app.exit(2); }, 20000);
});
