import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('demo server', () => {
  let directory: string;
  let server: ChildProcess;
  let origin: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'spin-scan-serve-'));
    await mkdir(join(directory, 'scripts'));
    await mkdir(join(directory, 'dist'));
    await cp(new URL('../scripts/serve.mjs', import.meta.url), join(directory, 'scripts/serve.mjs'));
    await cp(new URL('../demo', import.meta.url), join(directory, 'demo'), { recursive: true });
    for (const name of ['index', 'testing']) {
      await writeFile(join(directory, `dist/${name}.js`), 'export {};\n');
    }
    server = spawn(process.execPath, ['scripts/serve.mjs', '--port=0'], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    origin = await new Promise<string>((resolve, reject) => {
      let output = '';
      let errors = '';
      server.stderr!.on('data', (chunk) => { errors += chunk; });
      server.stdout!.on('data', (chunk) => {
        output += chunk;
        const port = output.match(/Demo: http:\/\/localhost:(\d+)\/demo\//)?.[1];
        if (port) resolve(`http://127.0.0.1:${port}`);
      });
      server.once('error', reject);
      server.once('exit', (code) => reject(new Error(`Demo server exited (${code}): ${errors}`)));
    });
  });

  afterAll(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('redirects directory URLs to a trailing slash and preserves the query', async () => {
    const response = await fetch(`${origin}/demo?test=1`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/demo/?test=1');
  });

  it.each(['/', '/demo', '/demo/'])('loads the demo module and its imports from %s', async (path) => {
    const page = await fetch(`${origin}${path}`);
    expect(page.status).toBe(200);
    expect(new URL(page.url).pathname).toBe('/demo/');
    const html = await page.text();
    const script = html.match(/<script type="module" src="([^"]+)"/)?.[1];
    expect(script).toBeDefined();
    const module = await fetch(new URL(script!, page.url));
    expect(module.status).toBe(200);
    expect(module.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const source = await module.text();
    const imports = [...source.matchAll(/from '([^']+)'/g)];
    expect(imports).toHaveLength(2);
    for (const [, specifier] of imports) {
      const dependency = await fetch(new URL(specifier, module.url));
      expect(dependency.status).toBe(200);
      expect(dependency.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    }
  });
});
