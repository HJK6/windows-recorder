'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, DEFAULT_ORIGINS } = require('../src/main/config');

test('config defaults to loopback and both mock-console origins', () => {
  const config = loadConfig({});
  assert.equal(config.bindAddr, '127.0.0.1');
  assert.equal(config.controlPort, 8765);
  assert.deepEqual(config.allowedOrigins, DEFAULT_ORIGINS);
  assert.equal(config.saveLocal, false);
});

test('bind address cannot be overridden to a non-loopback interface', () => {
  const config = loadConfig({
    HF_BIND_ADDR: '0.0.0.0',
    HF_ALLOWED_ORIGINS: 'https://console.example.invalid',
    HF_SAVE_LOCAL: 'true',
  });
  assert.equal(config.bindAddr, '127.0.0.1');
  assert.deepEqual(config.allowedOrigins, ['https://console.example.invalid']);
  assert.equal(config.saveLocal, true);
});
