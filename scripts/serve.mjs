import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const name = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    const target = path.resolve(root, `.${name === '/' ? '/index.html' : name}`);
    if (!target.startsWith(root) || !(await stat(target)).isFile()) { res.writeHead(404).end(); return; }
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404).end('Not found'); }
});
server.listen(1420, '127.0.0.1', () => console.log('ClearMap: локальный сервер UI-тестов запущен на http://127.0.0.1:1420/'));
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
