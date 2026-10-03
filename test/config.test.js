'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/main/config');

test('no endpoints configured => local demo mode, no listener, no channel', () => {
  const c = loadConfig({});
  assert.equal(c.connected, false);
  assert.equal(c.demoMode, true);
  assert.equal(c.wsUrl, '');
  assert.equal(c.httpApiUrl, '');
  assert.equal(c.deviceId, 'poc-device-01');
});

test('WS + HTTP endpoints => connected mode with derived token endpoint', () => {
  const c = loadConfig({
    FR_WS_URL: 'wss://abc.execute-api.us-east-1.amazonaws.com/poc',
    FR_HTTP_API_URL: 'https://def.execute-api.us-east-1.amazonaws.com',
  });
  assert.equal(c.connected, true);
  assert.equal(c.demoMode, false);
  assert.equal(c.tokenEndpoint, 'https://def.execute-api.us-east-1.amazonaws.com/v1/auth/device-token');
});

test('token endpoint and enrollment material come from the environment, never defaults in the build', () => {
  const c = loadConfig({
    FR_WS_URL: 'wss://x/poc',
    FR_HTTP_API_URL: 'https://y',
    FR_TOKEN_ENDPOINT: 'https://y/custom/token',
    FR_DEVICE_ID: 'amaterasu-01',
    FR_DEVICE_BOOTSTRAP_SECRET: 'runtime-only-secret',
  });
  assert.equal(c.tokenEndpoint, 'https://y/custom/token');
  assert.equal(c.deviceId, 'amaterasu-01');
  assert.equal(c.bootstrapSecret, 'runtime-only-secret');
});
