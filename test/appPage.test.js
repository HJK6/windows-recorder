'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderAppPage } = require('../aws/lambda/http/app-page');

test('control page has the four controls and polls status every second', () => {
  const html = renderAppPage({ apiBase: 'https://api.example.com', controlToken: 'tok-123' });
  for (const id of ['start', 'pause', 'resume', 'stop']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /setInterval\(poll,\s*1000\)/);
  assert.match(html, /fetch\(/);
});

test('page talks HTTPS to the API and never opens a socket or localhost listener', () => {
  const html = renderAppPage({ apiBase: 'https://api.example.com', controlToken: 'tok-123' });
  assert.match(html, /https:\/\/api\.example\.com/);
  assert.doesNotMatch(html, /new WebSocket|ws:\/\/|wss:\/\//);
  assert.doesNotMatch(html, /127\.0\.0\.1|localhost/);
});

test('UI confirms state from the applied acknowledgment (observedState), not optimistically', () => {
  const html = renderAppPage({ apiBase: 'https://x', controlToken: 't' });
  assert.match(html, /observedState/);
  // Buttons gate on the confirmed observed state.
  assert.match(html, /observed !== 'RECORDING'/);
});

test('injects the issued control token and allows an override for denial testing', () => {
  const html = renderAppPage({ apiBase: 'https://x', controlToken: 'issued-xyz' });
  assert.match(html, /issued-xyz/);
  assert.match(html, /id="token"/);
});
