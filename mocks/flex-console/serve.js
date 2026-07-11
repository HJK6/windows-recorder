'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.MOCK_FLEX_PORT || 8788);
const root = __dirname;
const types = { '.html': 'text/html', '.js': 'text/javascript' };

http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js'].includes(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] });
  fs.createReadStream(path.join(root, file)).pipe(res);
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`Mock Flex console listening on http://127.0.0.1:${port}\n`);
});
