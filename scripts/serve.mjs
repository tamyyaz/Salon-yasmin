// Tiny static server for dist/ that applies the same headers as firebase.json (CSP included),
// so what you test locally is what Firebase Hosting will serve.
//   node scripts/serve.mjs [--emulator]      (PORT env var, default 5000)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve('dist');
const port = Number(process.env.PORT) || 5000;
const emulator = process.argv.includes('--emulator');
const rules = JSON.parse(fs.readFileSync('firebase.json', 'utf8')).hosting.headers;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

// minimal glob → regex for the patterns used in firebase.json
const toRegex = (src) => new RegExp('^' + (src.startsWith('/') ? '' : '/') + src
  .replace(/[.+^${}()|[\]\\]/g, (c) => (c === '(' || c === ')' || c === '|' ? c : '\\' + c))
  .replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/@\(/g, '(?:') + '$');

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
  for (const { source, headers } of rules) {
    if (!toRegex(source).test(url.pathname)) continue;
    for (const { key, value } of headers) {
      res.setHeader(key, emulator && key === 'Content-Security-Policy'
        ? value.replace('connect-src', 'connect-src http://127.0.0.1:* http://localhost:*') : value);
    }
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`dist/ on http://localhost:${port}${emulator ? '  (emulator CSP)' : ''}`));
