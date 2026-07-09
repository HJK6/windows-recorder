'use strict';

/*
 * Main process for HF Recorder.
 *
 * Responsibilities:
 *  - Create the window (contextIsolation on, nodeIntegration off).
 *  - Auto-grant the app's own Chromium capture permissions (trusted first-party
 *    app) — this is the *in-app* permission layer.
 *  - Serve the screen source to getDisplayMedia via setDisplayMediaRequestHandler.
 *  - Save finished recordings to the per-user output folder.
 *  - Best-effort probe of the *Windows OS* microphone-consent layer so the
 *    renderer can guide the user when the OS (not the app) is blocking capture.
 */

const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { wireCapturePermissions } = require('./capture-session');
const Permissions = require('../shared/permissions');

const OUTPUT_DIR = () => path.join(app.getPath('documents'), 'HFRecorder');

function ensureOutputDir() {
  const dir = OUTPUT_DIR();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp() {
  // YYYYMMDD-HHMMSS in local time, filename-safe.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- Windows OS microphone-consent probe (best effort) --------------------
// A desktop (unpackaged) app's mic is gated by BOTH the global consent
// (microphone\Value) AND the desktop-apps consent (microphone\NonPackaged\Value)
// — either 'Deny' blocks capture. We read both and combine. Non-Windows (WSLg
// dev) returns supported:false so dev is never blocked.
const MIC_CONSENT_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

function queryConsentValue(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', 'Value'], { windowsHide: true }, (err, stdout) => {
      resolve(err ? 'unknown' : Permissions.parseConsentValue(stdout));
    });
  });
}

function probeWindowsMicConsent() {
  if (process.platform !== 'win32') {
    return Promise.resolve({ supported: false, value: 'unknown', reason: 'not win32' });
  }
  return Promise.all([
    queryConsentValue(MIC_CONSENT_KEY),
    queryConsentValue(MIC_CONSENT_KEY + '\\NonPackaged'),
  ]).then(([globalValue, nonPackaged]) => ({
    supported: true,
    value: Permissions.effectiveMicConsent(globalValue, nonPackaged),
    global: globalValue,
    nonPackaged,
  }));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 640,
    height: 560,
    resizable: true,
    title: 'HF Recorder',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

function wireIpc() {
  ipcMain.handle('get-output-dir', () => OUTPUT_DIR());

  ipcMain.handle('save-recording', async (_evt, bytes, sessionId) => {
    const dir = ensureOutputDir();
    // session id + timestamp so two stops in the same second never collide.
    const sid = String(sessionId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'session';
    const file = path.join(dir, `HFRecorder-${timestamp()}-${sid}.webm`);
    const buf = Buffer.from(bytes); // bytes: Uint8Array transferred from renderer
    await fs.promises.writeFile(file, buf);
    return { path: file, bytes: buf.length };
  });

  ipcMain.handle('reveal-file', (_evt, filePath) => {
    if (filePath) shell.showItemInFolder(filePath);
  });

  ipcMain.handle('open-mic-privacy', () => {
    // Deep-link straight to the Windows microphone privacy page.
    shell.openExternal('ms-settings:privacy-microphone');
  });

  ipcMain.handle('probe-mic-consent', () => probeWindowsMicConsent());
}

app.whenReady().then(() => {
  wireCapturePermissions(session.defaultSession, desktopCapturer);
  wireIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
