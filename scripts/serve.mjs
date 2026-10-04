// Zero-dependency static server for the demo.
//   node scripts/serve.mjs            → http://localhost:5173/demo/
//   node scripts/serve.mjs --https    → https on all interfaces with a self-signed cert (for phones)
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const useHttps = args.includes('--https');
const port = Number(args.find((a) => a.startsWith('--port='))?.split('=')[1] ?? (useHttps ? 5443 : 5173));

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    let path = decodeURIComponent(url.pathname);
    if (path === '/') {
      res.writeHead(302, { Location: '/demo/' });
      return res.end();
    }
    const file = normalize(join(root, path));
    if (!file.startsWith(root) || file.includes('node_modules')) {
      res.writeHead(403);
      return res.end();
    }
    let target = file;
    if ((await stat(target)).isDirectory()) target = join(target, 'index.html');
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

async function getCert() {
  const dir = join(root, '.cert');
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    await mkdir(dir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
      '-keyout', key, '-out', cert, '-subj', '/CN=spin-scan-dev',
    ], { stdio: 'ignore' });
  }
  return { key: await readFile(key), cert: await readFile(cert) };
}

const server = useHttps ? createHttps(await getCert(), handler) : createHttp(handler);
const host = useHttps ? '0.0.0.0' : '127.0.0.1';
server.listen(port, host, () => {
  const proto = useHttps ? 'https' : 'http';
  console.log(`Demo: ${proto}://localhost:${port}/demo/`);
  if (useHttps) {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`      ${proto}://${a.address}:${port}/demo/  (accept the self-signed certificate warning)`);
      }
    }
  } else {
    console.log('Camera access from a phone needs HTTPS: run `npm run demo:https`.');
  }
});
