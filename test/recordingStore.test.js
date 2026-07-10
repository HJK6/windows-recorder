'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const RSt = require('../src/main/recording-store');

const SAMPLE = [1, 2, 3, 250, 0, 255];

test('toBuffer accepts every plausible IPC payload shape', () => {
  const expect = Buffer.from(SAMPLE);
  assert.deepEqual(RSt.toBuffer(Uint8Array.from(SAMPLE)), expect, 'Uint8Array');
  assert.deepEqual(RSt.toBuffer(Buffer.from(SAMPLE)), expect, 'Buffer');
  assert.deepEqual(RSt.toBuffer(Uint8Array.from(SAMPLE).buffer), expect, 'ArrayBuffer');
  assert.deepEqual(RSt.toBuffer(SAMPLE.slice()), expect, 'Array');
  // structured-clone of a typed array can arrive array-like
  assert.deepEqual(RSt.toBuffer({ 0: 1, 1: 2, 2: 3, 3: 250, 4: 0, 5: 255, length: 6 }), expect, 'array-like');
});

test('toBuffer throws a clear, user-visible error for an unusable payload', () => {
  assert.throws(() => RSt.toBuffer(undefined), /unsupported recording payload/);
  assert.throws(() => RSt.toBuffer(null), /unsupported recording payload/);
});

test('buildFilename stamps timestamp + sanitized session id', () => {
  const d = new Date(2026, 6, 9, 21, 36, 5); // 2026-07-09 21:36:05 local
  assert.equal(RSt.buildFilename('abcd1234', d), 'HFRecorder-20260709-213605-abcd1234.webm');
  assert.equal(RSt.buildFilename('with/bad:chars!!', d), 'HFRecorder-20260709-213605-withbadc.webm', 'sanitized + 8 chars');
  assert.equal(RSt.buildFilename('', d), 'HFRecorder-20260709-213605-session.webm', 'empty -> session');
});

test('saveRecording writes the exact bytes and returns the path', async () => {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'hfrec-'));
  try {
    const payload = Uint8Array.from(SAMPLE);
    const res = await RSt.saveRecording(docs, payload, 'sess0001', new Date(2026, 6, 9, 1, 2, 3));
    assert.equal(res.bytes, SAMPLE.length);
    assert.ok(fs.existsSync(res.path), 'file exists');
    assert.deepEqual(fs.readFileSync(res.path), Buffer.from(SAMPLE), 'content matches');
    assert.equal(path.dirname(res.path), path.join(docs, 'HFRecorder'));
  } finally {
    fs.rmSync(docs, { recursive: true, force: true });
  }
});

test('saveRecording does NOT create the output dir when the payload is unusable', async () => {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'hfrec-'));
  try {
    await assert.rejects(() => RSt.saveRecording(docs, undefined, 'x'), /unsupported recording payload/);
    assert.equal(fs.existsSync(path.join(docs, 'HFRecorder')), false, 'no empty dir left behind');
  } finally {
    fs.rmSync(docs, { recursive: true, force: true });
  }
});
