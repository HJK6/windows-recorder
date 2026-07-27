'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/main/config');

test('config defaults to a controllable no-auth local demo', () => {
  const config = loadConfig({});
  assert.equal(config.bindAddr, '127.0.0.1');
  assert.equal(config.controlPort, 18765);
  assert.equal(config.saveLocal, false);
  assert.equal(config.demoMode, true);
});

test('bind address is fixed to loopback regardless of env', () => {
  const config = loadConfig({ HF_BIND_ADDR: '0.0.0.0', HF_SAVE_LOCAL: 'true' });
  assert.equal(config.bindAddr, '127.0.0.1');
  assert.equal(config.saveLocal, true);
});

test('activation mode requires an explicit environment flag or command-line switch', () => {
  assert.deepEqual(
    [loadConfig({ HF_AUTH: '1' }, []), loadConfig({}, ['electron', '.', '--auth'])]
      .map((config) => [config.demoMode, config.controlPort]),
    [[false, 8765], [false, 8765]],
  );
  assert.equal(loadConfig({ HF_AUTH: '0' }, []).demoMode, true);
  assert.equal(loadConfig({ HF_AUTH: '1', HF_CONTROL_PORT: '19000' }, []).controlPort, 19000);
});
