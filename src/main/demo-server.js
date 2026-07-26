'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const ALLOWED_FILES = new Set(['index.html', 'app.js', 'config.js']);

function createDemoServer({ host = '127.0.0.1', port = 8788, controlPort = 18765, root } = {}) {
  const siteRoot = root || path.join(__dirname, '..', 'demo');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!ALLOWED_FILES.has(file)) {
      res.writeHead(404).end();
      return;
    }
    if (file === 'config.js') {
      res.writeHead(200, {
        'content-type': CONTENT_TYPES['.js'],
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(`window.HF_DEMO_CONFIG = ${JSON.stringify({ controlPort })};`);
      return;
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file)],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(path.join(siteRoot, file)).pipe(res);
  });

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
    address: () => server.address(),
  };
}

module.exports = { createDemoServer };
