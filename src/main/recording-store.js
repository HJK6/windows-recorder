'use strict';

/*
 * recording-store.js — where a finished recording gets written.
 *
 * Extracted from main.js so the save path is testable (pure filename/buffer
 * logic) AND exercisable end-to-end through the real preload+IPC boundary
 * (test/save-harness). The `toBuffer` normalizer is deliberately liberal: the
 * renderer sends the merged WebM as a Uint8Array through contextBridge +
 * ipcRenderer, and depending on Electron/sandbox settings the value can arrive
 * as a Uint8Array, a Buffer, an ArrayBuffer, or an array-like — all must write.
 */

const path = require('node:path');
const fs = require('node:fs');

function pad(n) { return String(n).padStart(2, '0'); }

// YYYYMMDD-HHMMSS in local time, filename-safe. `date` injectable for tests.
function timestamp(date) {
  const d = date || new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function outputDir(documentsDir) {
  return path.join(documentsDir, 'HFRecorder');
}

function buildFilename(recordingId, date) {
  const sid = String(recordingId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'recording';
  return `HFRecorder-${timestamp(date)}-${sid}.webm`;
}

// Normalize whatever the IPC layer delivered into a Buffer, or throw a clear,
// user-visible error naming the offending type.
function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(new Uint8Array(bytes));
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Array.isArray(bytes)) return Buffer.from(bytes);
  // Structured-clone of a typed array can arrive as {0:..,1:..,length:N}.
  if (bytes && typeof bytes === 'object' && typeof bytes.length === 'number') {
    return Buffer.from(bytes);
  }
  throw new Error(`unsupported recording payload: ${Object.prototype.toString.call(bytes)}`);
}

// Write a finished recording. Returns { path, bytes }.
async function saveRecording(documentsDir, bytes, recordingId, date) {
  const buf = toBuffer(bytes); // normalize BEFORE mkdir so a bad payload can't leave an empty dir
  const dir = outputDir(documentsDir);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, buildFilename(recordingId, date));
  await fs.promises.writeFile(file, buf);
  return { path: file, bytes: buf.length };
}

module.exports = { timestamp, outputDir, buildFilename, toBuffer, saveRecording };
