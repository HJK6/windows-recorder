'use strict';

// Secure bridge between the isolated renderer and the main process.
// Only these narrow, purpose-built calls cross the boundary.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hf', {
  getOutputDir: () => ipcRenderer.invoke('get-output-dir'),
  // bytes: Uint8Array of the finished WebM blob.
  saveRecording: (bytes) => ipcRenderer.invoke('save-recording', bytes),
  revealFile: (filePath) => ipcRenderer.invoke('reveal-file', filePath),
  openMicPrivacy: () => ipcRenderer.invoke('open-mic-privacy'),
  probeMicConsent: () => ipcRenderer.invoke('probe-mic-consent'),
  platform: process.platform,
});
