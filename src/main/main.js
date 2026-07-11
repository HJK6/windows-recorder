'use strict';

const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell } = require('electron');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { wireCapturePermissions } = require('./capture-session');
const Permissions = require('../shared/permissions');
const SessionState = require('../shared/sessionState');
const recordingStore = require('./recording-store');
const { loadConfig } = require('./config');
const { createActivationClient } = require('./activation');
const { createControlServer } = require('./control-server');

const config = loadConfig();
const events = new EventEmitter();
const documentsDir = () => app.getPath('documents');
let mainWindow = null;
let rendererReady = false;
let quitting = false;
let publicState = SessionState.initialState();
let activationSession = null;
let activationContext = {};
let activationGeneration = 0;
let pendingDeactivate = false;
let recordingFinalizing = false;
let queuedStart = false;

const activation = createActivationClient({
  baseUrl: config.backendBaseUrl,
  saveLocal: config.saveLocal
    ? (buffer, recordingId) => recordingStore.saveRecording(documentsDir(), buffer, recordingId)
    : null,
});

function rendererPush(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('control:command', payload);
}

function publishState() {
  events.emit('state', publicState);
  rendererPush({ kind: 'state', state: publicState });
}

function publishEvent(event, data = {}) {
  const payload = { event, data };
  events.emit('event', payload);
  rendererPush({ kind: 'event', ...payload });
}

function transition(event) {
  publicState = SessionState.reduce(publicState, event);
  publishState();
}

function relayCommand(action) {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) {
    throw new Error('capture window unavailable');
  }
  if (action === 'start' && recordingFinalizing) {
    queuedStart = true;
    return;
  }
  if (action === 'stop' && publicState.recorder.status !== 'idle') recordingFinalizing = true;
  mainWindow.webContents.send('control:command', { kind: 'command', action });
}

async function activate(message) {
  if (recordingFinalizing || !SessionState.canActivate(publicState)) {
    const error = new Error('activation is already active or recording is not finalized');
    error.code = 'already_activated';
    throw error;
  }
  const generation = ++activationGeneration;
  transition({ type: 'ACTIVATE_START' });
  try {
    const result = await activation.validateFlexToken(message.flexToken);
    if (generation !== activationGeneration || publicState.session !== SessionState.ACTIVATING) return;
    activationSession = result;
    activationContext = message.context || {};
    transition({ type: 'ACTIVATE_SUCCESS', identity: result.identity, sessionId: result.sessionId });
    publishEvent('activated', { identity: result.identity, sessionId: result.sessionId });
  } catch (error) {
    if (generation !== activationGeneration || publicState.session !== SessionState.ACTIVATING) return;
    activationSession = null;
    activationContext = {};
    transition({ type: 'ACTIVATE_FAILURE' });
    publishEvent('activation_error', { status: error.status || null });
    throw error;
  }
}

function finishDeactivation() {
  activationGeneration += 1;
  pendingDeactivate = false;
  activationSession = null;
  activationContext = {};
  transition({ type: 'DEACTIVATE' });
  publishEvent('deactivated');
}

async function deactivate() {
  if (recordingFinalizing) {
    pendingDeactivate = true;
    return;
  }
  if (publicState.recorder.status !== 'idle') {
    pendingDeactivate = true;
    relayCommand('stop');
    return;
  }
  finishDeactivation();
}

async function handleRecordingStopped(buffer, meta) {
  publishEvent('recording_stopped', { recordingId: meta.recordingId });
  try {
    const result = await activation.processRecording({
      session: activationSession,
      buffer,
      meta,
      context: activationContext,
    });
    publishEvent('uploaded', { objectKey: result.objectKey, sizeBytes: result.sizeBytes });
    publishEvent('metadata_written', { objectKey: result.objectKey, recordingId: meta.recordingId });
  } catch (error) {
    if (error.status === 401) publishEvent('activation_error', { status: 401 });
    if (config.saveLocal) {
      try {
        const local = await recordingStore.saveRecording(documentsDir(), buffer, meta.recordingId);
        publishEvent('capture_error', { reason: 'upload_failed', local });
      } catch (_) {
        publishEvent('capture_error', { reason: 'upload_and_local_save_failed' });
      }
    } else {
      publishEvent('capture_error', { reason: 'upload_failed' });
    }
  } finally {
    const restart = queuedStart && !pendingDeactivate
      && publicState.session === SessionState.ONLINE;
    queuedStart = false;
    recordingFinalizing = false;
    if (pendingDeactivate) finishDeactivation();
    else if (restart) relayCommand('start');
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
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
      rendererReady = false;
    }
  });
  return win;
}

function wireIpc() {
  ipcMain.handle('get-output-dir', () => recordingStore.outputDir(documentsDir()));
  ipcMain.handle('reveal-file', (_event, filePath) => { if (filePath) shell.showItemInFolder(filePath); });
  ipcMain.handle('open-mic-privacy', () => shell.openExternal('ms-settings:privacy-microphone'));
  ipcMain.handle('probe-mic-consent', () => probeWindowsMicConsent());
  ipcMain.on('recorder:state', (_event, payload) => {
    if (payload.finishing) recordingFinalizing = true;
    transition({ type: 'RECORDER_STATE', status: payload.status, muted: payload.muted });
    if (payload.event) publishEvent(payload.event, payload.data || {});
  });
  ipcMain.on('recorder:stopped', (_event, payload) => {
    handleRecordingStopped(payload.buffer, payload.meta).catch(() => {});
  });
}

app.whenReady().then(async () => {
  wireCapturePermissions(session.defaultSession, desktopCapturer);
  wireIpc();
  mainWindow = createWindow();
  await mainWindow.hfReady;
  const control = createControlServer({
    host: config.bindAddr,
    port: config.controlPort,
    allowedOrigins: config.allowedOrigins,
    getState: () => publicState,
    onCommand: relayCommand,
    onActivate: activate,
    onDeactivate: deactivate,
    events,
  });
  await control.start();
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
    else mainWindow.show();
  });
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {});
