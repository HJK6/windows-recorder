'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('standalone file demo has six controls and drives the app over the HTTP API', () => {
  const root = path.join(__dirname, '..', 'demo', 'windows');
  const html = fs.readFileSync(path.join(root, 'HF-Recorder-Demo.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

  for (const id of ['start', 'pause', 'resume', 'mute', 'unmute', 'stop']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /src="app\.js"/);
  assert.match(html, /id="retry"/);
  assert.match(script, /http:\/\/127\.0\.0\.1:18765/);
  assert.match(script, /fetch\(/);
  assert.match(script, /not running/i);
  assert.doesNotMatch(script, /new WebSocket|ws:\/\//);
});
