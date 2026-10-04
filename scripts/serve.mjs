// Zero-dependency static server for the demo.
//   node scripts/serve.mjs            → http://localhost:5173/demo/
//   node scripts/serve.mjs --https    → HTTPS on all interfaces; the self-signed key is stored in the user's home directory
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { chmod, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, networkInterfaces } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicRoots = [
  { prefix: '/demo', directory: await realpath(resolve(projectRoot, 'demo')) },
  { prefix: '/dist', directory: await realpath(resolve(projectRoot, 'dist')) },
];
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
    const mount = publicRoots.find(({ prefix }) => path === prefix || path.startsWith(`${prefix}/`));
    if (!mount) {
      res.writeHead(404);
      return res.end('Not found');
    }
    let target = resolve(mount.directory, `.${path.slice(mount.prefix.length)}`);
    const isWithinMount = (candidate) => {
      const rel = relative(mount.directory, candidate);
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    if (!isWithinMount(target)) {
      res.writeHead(403);
      return res.end();
    }
    target = await realpath(target);
    if (!isWithinMount(target)) {
      res.writeHead(403);
      return res.end();
    }
    if ((await stat(target)).isDirectory()) {
      target = await realpath(join(target, 'index.html'));
      if (!isWithinMount(target)) {
        res.writeHead(403);
        return res.end();
      }
    }
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

async function getCert() {
  const dir = join(homedir(), '.spin-scan', 'dev-cert');
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
      '-keyout', key, '-out', cert, '-subj', '/CN=spin-scan-dev',
    ], { stdio: 'ignore' });
  }
  await chmod(dir, 0o700);
  await chmod(key, 0o600);
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
