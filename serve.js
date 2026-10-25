// serve.js — Node.js 版本地服务器（当系统没有 Python 时使用）
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.argv[2] ? parseInt(process.argv[2], 10) : 8765;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mid': 'audio/midi',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': st.size,
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.join(ROOT, path.normalize(url));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('403'); return; }
  sendFile(res, file);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('3D Piano server running at http://127.0.0.1:' + PORT);
});
