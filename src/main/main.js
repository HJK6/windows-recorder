'use strict';

const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell } = require('electron');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { wireCapturePermissions } = require('./capture-session');
const Permissions = require('../shared/permissions');
const recordingStore = require('./recording-store');
const { loadConfig } = require('./config');
const { createMockIdentity } = require('./identity');
const { createWsClient } = require('./ws-client');
const { createUploadClient } = require('./upload');

const config = loadConfig();

// P5 synthetic capture (Amaterasu): Chromium fake media — a silent, synthetic
// screen + mic with no real content or sound, and auto-accepted capture prompts.
// Opt-in via HF_FAKE_MEDIA=1; never on in a normal run.
if (/^(1|true|yes)$/i.test(process.env.HF_FAKE_MEDIA || '')) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

const events = new EventEmitter();
const documentsDir = () => app.getPath('documents');
let mainWindow = null;
let rendererReady = false;
let quitting = false;

// Public state mirrored to the renderer. `session` reflects the WS control
// channel (online once the server welcomes us); demo mode has no channel.
let publicState = {
  session: config.demoMode ? 'online' : 'offline',
  recorder: { status: 'idle', muted: false },
  identity: config.demoMode ? null : { email: `${config.deviceId}@device`, agentId: config.deviceId },
  demoMode: config.demoMode,
  connected: config.connected,
};

// Server-authoritative recording id for the recording the desktop is currently
// capturing (set when a start/resume command is applied), used to scope the
// upload grant on stop. Decoupled from ws-client's active tracking so it
// survives the stop→finalize race.
let currentRecordingId = null;

let identity = null;
let wsClient = null;
let uploadClient = null;

if (config.connected) {
  identity = createMockIdentity({
    tokenEndpoint: config.tokenEndpoint,
    deviceId: config.deviceId,
    bootstrapSecret: config.bootstrapSecret,
  });
  uploadClient = createUploadClient({ httpApiUrl: config.httpApiUrl });
}

function rendererPush(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('control:command', payload);
}

function publishState() {
  events.emit('state', publicState);
  rendererPush({ kind: 'state', state: publicState });
}

function publishEvent(event, data = {}) {
  events.emit('event', { event, data });
  rendererPush({ kind: 'event', event, data });
}

function setConnection(status) {
  publicState = { ...publicState, session: status };
  publishState();
}

function setRecorder(status, muted) {
  publicState = { ...publicState, recorder: { status, muted: Boolean(muted) } };
  publishState();
}

// Relay a server-issued command to the capture renderer. The renderer owns the
// real MediaRecorder; main only forwards and later observes the applied state.
function relayCommand(action, ctx = {}) {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) {
    throw new Error('capture window unavailable');
  }
  if ((action === 'start' || action === 'resume') && ctx.recordingId) {
    currentRecordingId = ctx.recordingId;
  }
  mainWindow.webContents.send('control:command', { kind: 'command', action });
}

async function handleRecordingStopped(buffer, meta) {
  publishEvent('recording_stopped', { recordingId: meta.recordingId });
  try {
    if (config.demoMode) {
      const local = await recordingStore.saveRecording(documentsDir(), buffer, meta.recordingId);
      publishEvent('saved_local', local);
      return;
    }
    const { token } = await identity.getDeviceToken();
    const recordingId = currentRecordingId || meta.recordingId;
    const result = await uploadClient.upload({ recordingId, deviceToken: token, buffer, meta });
    publishEvent('uploaded', { objectKey: result.objectKey, sizeBytes: result.sizeBytes });
    publishEvent('metadata_written', {
      objectKey: result.objectKey,
      recordingId,
      verified: result.verified === true,
    });
  } catch (error) {
    publishEvent('capture_error', { reason: 'upload_failed', status: error.status || null });
    if (config.saveLocal) {
      try {
        const local = await recordingStore.saveRecording(documentsDir(), buffer, meta.recordingId);
        publishEvent('capture_error', { reason: 'upload_failed', local });
      } catch (_) { /* best effort */ }
    }
  } finally {
    currentRecordingId = null;
  }
}

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
    queryConsentValue(`${MIC_CONSENT_KEY}\\NonPackaged`),
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
    height: 610,
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
  rendererReady = false;
  win.hfReady = win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')).then(() => {
    rendererReady = true;
    publishState();
  });
  win.on('close', (event) => {
    if (!quitting) { event.preventDefault(); win.hide(); }
  });
  win.on('closed', () => {
    if (mainWindow === win) { mainWindow = null; rendererReady = false; }
  });
  return win;
}

function wireIpc() {
  ipcMain.handle('get-output-dir', () => recordingStore.outputDir(documentsDir()));
  ipcMain.handle('reveal-file', (_event, filePath) => { if (filePath) shell.showItemInFolder(filePath); });
  ipcMain.handle('open-mic-privacy', () => shell.openExternal('ms-settings:privacy-microphone'));
  ipcMain.handle('probe-mic-consent', () => probeWindowsMicConsent());
  ipcMain.on('recorder:state', (_event, payload) => {
    setRecorder(payload.status, payload.muted);
    if (payload.event) publishEvent(payload.event, payload.data || {});
  });
  ipcMain.on('recorder:stopped', (_event, payload) => {
    handleRecordingStopped(payload.buffer, payload.meta).catch(() => {});
  });
}

if (!app.requestSingleInstanceLock()) {
  // Single capture owner per session (spec §8). A second instance would show an
  // idle window that receives no commands, so quit this duplicate immediately.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) { mainWindow = createWindow(); return; }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    wireCapturePermissions(session.defaultSession, desktopCapturer);
    wireIpc();
    mainWindow = createWindow();
    await mainWindow.hfReady;

    if (config.connected) {
      wsClient = createWsClient({
        wsUrl: config.wsUrl,
        identity,
        getState: () => publicState,
        relay: relayCommand,
        events,
        onConnection: setConnection,
        logger: console,
      });
      wsClient.start();
    }

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
      else mainWindow.show();
    });
  });
}

app.on('before-quit', () => {
  quitting = true;
  if (wsClient) wsClient.stop();
});
app.on('window-all-closed', () => {});
