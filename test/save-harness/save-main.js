'use strict';

/*
 * Save-path harness (Electron main). Reproduces the PRODUCTION save boundary:
 * the real preload (contextBridge) under contextIsolation + sandbox:true, the
 * real `recorder:stopped` IPC, and the real recording-store. Logs what the WebM
 * payload arrives as at the main side and whether the file writes — this is the
 * end-to-end coverage the earlier smoke lacked (it saved from a nodeIntegration
 * page, not through the sandboxed contextBridge boundary the app actually uses).
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const recordingStore = require('../../src/main/recording-store');

app.commandLine.appendSwitch('disable-dev-shm-usage');
app.disableHardwareAcceleration();

const DOCS = process.env.HF_SAVE_DOCS || os.tmpdir();

app.whenReady().then(() => {
  ipcMain.on('recorder:stopped', async (_e, { buffer: bytes, meta }) => {
    console.log('HARNESS payload:', Object.prototype.toString.call(bytes),
      '| ctor=', bytes && bytes.constructor && bytes.constructor.name,
      '| length=', bytes && bytes.length, '| byteLength=', bytes && bytes.byteLength);
    try {
      const res = await recordingStore.saveRecording(DOCS, bytes, meta.recordingId);
      console.log('HARNESS saved:', res.bytes, 'bytes ->', res.path);
      setTimeout(() => app.exit(0), 150);
    } catch (err) {
      console.error('HARNESS save error:', err.message);
      setTimeout(() => app.exit(1), 150);
    }
  });
  // Stub the rest of the preload's channels so window.hf calls don't reject.
  ipcMain.handle('get-output-dir', () => recordingStore.outputDir(DOCS));
  ipcMain.handle('reveal-file', () => {});
  ipcMain.handle('open-mic-privacy', () => {});
  ipcMain.handle('probe-mic-consent', () => ({ supported: false, value: 'unknown' }));

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'src', 'main', 'preload.js'), // REAL preload
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // REAL production setting
    },
  });
  win.loadFile(path.join(__dirname, 'save-page.html'));
  setTimeout(() => { console.error('HARNESS-TIMEOUT'); app.exit(2); }, 15000);
});
