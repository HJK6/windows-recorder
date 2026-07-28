'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('standalone demo page is self-contained and drives the app over the HTTP API', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'demo', 'windows', 'HF-Recorder-Demo.html'), 'utf8',
  );

  for (const id of ['start', 'pause', 'resume', 'mute', 'unmute', 'stop']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="retry"/);
  // Script is inlined — the page must not depend on a sibling file.
  assert.doesNotMatch(html, /<script[^>]*\bsrc=/);
  assert.match(html, /http:\/\/127\.0\.0\.1:18765/);
  assert.match(html, /fetch\(/);
  assert.match(html, /not running/i);
  assert.doesNotMatch(html, /new WebSocket|ws:\/\//);
});
