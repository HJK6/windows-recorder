'use strict';

// Secure bridge between the isolated renderer and the main process.
// Only these narrow, purpose-built calls cross the boundary.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hf', {
  getOutputDir: () => ipcRenderer.invoke('get-output-dir'),
  revealFile: (filePath) => ipcRenderer.invoke('reveal-file', filePath),
  openMicPrivacy: () => ipcRenderer.invoke('open-mic-privacy'),
  probeMicConsent: () => ipcRenderer.invoke('probe-mic-consent'),
  onCommand: (callback) => ipcRenderer.on('control:command', (_event, payload) => {
    if (payload && payload.kind === 'command') callback(payload.action);
  }),
  onState: (callback) => ipcRenderer.on('control:command', (_event, payload) => {
    if (payload && payload.kind === 'state') callback(payload.state);
  }),
  onEvent: (callback) => ipcRenderer.on('control:command', (_event, payload) => {
    if (payload && payload.kind === 'event') callback(payload);
  }),
  sendRecorderState: (state) => ipcRenderer.send('recorder:state', state),
  sendRecordingStopped: (buffer, meta) => ipcRenderer.send('recorder:stopped', { buffer, meta }),
  platform: process.platform,
});
