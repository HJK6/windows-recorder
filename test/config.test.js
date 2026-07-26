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
  assert.equal(config.demoMode, false);
  assert.equal(config.demoSitePort, 8788);
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

test('demo mode requires an explicit environment flag or command-line switch', () => {
  assert.deepEqual(
    [loadConfig({ HF_DEMO: '1' }, []), loadConfig({}, ['electron', '.', '--demo'])]
      .map((config) => [config.demoMode, config.controlPort]),
    [[true, 18765], [true, 18765]],
  );
  assert.equal(loadConfig({ HF_DEMO: '0' }, []).demoMode, false);
  assert.equal(loadConfig({ HF_DEMO: '1', HF_CONTROL_PORT: '19000' }, []).controlPort, 19000);
});

test('demo origin defaults follow the configured site port unless explicitly overridden', () => {
  const config = loadConfig({ HF_DEMO: '1', HF_DEMO_SITE_PORT: '19088' }, []);
  assert.equal(config.demoSitePort, 19088);
  assert.deepEqual(config.allowedOrigins, [
    'http://127.0.0.1:19088',
    'http://localhost:19088',
  ]);
  assert.deepEqual(loadConfig({
    HF_DEMO: '1',
    HF_DEMO_SITE_PORT: '19088',
    HF_ALLOWED_ORIGINS: 'https://demo.example.invalid',
  }, []).allowedOrigins, ['https://demo.example.invalid']);
});
