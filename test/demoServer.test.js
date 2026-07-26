'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDemoServer } = require('../src/main/demo-server');

test('demo site is served only from loopback with the six controls', async (t) => {
  const server = createDemoServer({ port: 0, controlPort: 19000 });
  const address = await server.start();
  t.after(() => server.close());
  assert.equal(address.address, '127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  for (const id of ['start', 'pause', 'resume', 'mute', 'unmute', 'stop']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(await (await fetch(`http://127.0.0.1:${address.port}/config.js`)).text(), /19000/);
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/secret`)).status, 404);
});
