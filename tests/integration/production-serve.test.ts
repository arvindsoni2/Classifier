import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/http/server.js';
import { serveReview } from '../../src/cli/serve.js';
import { FakeService } from '../helpers/fake-service.js';

const projectRoot = resolve(import.meta.dirname, '../..');
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('production review launch (R8)', () => {
  it('serves the built UI assets from the production composition', async () => {
    const uiDist = tempDir('organiser-ui-');
    writeFileSync(join(uiDist, 'index.html'), '<!doctype html><title>review</title><div id="root"></div>');
    writeFileSync(join(uiDist, 'login.js'), '// login surface');
    mkdirSync(join(uiDist, 'assets'));
    writeFileSync(join(uiDist, 'assets', 'app.js'), '// bundle');
    const instance = buildServer(new FakeService(), { port: 0, host: '127.0.0.1', uiDist });
    await instance.listen({ port: 0, host: '127.0.0.1' });
    try {
      // A browser always sends the matching Host; inject does not by default.
      const host = `127.0.0.1:${(instance.addresses()[0] as { port: number }).port}`;
      const index = await instance.inject({ method: 'GET', url: '/app/', headers: { host } });
      expect(index.statusCode).toBe(200);
      expect(index.body).toContain('div id="root"');

      const loginScript = await instance.inject({ method: 'GET', url: '/app/login.js', headers: { host } });
      expect(loginScript.statusCode).toBe(200);
      expect(loginScript.body).toContain('login surface');

      const bundle = await instance.inject({ method: 'GET', url: '/app/assets/app.js', headers: { host } });
      expect(bundle.statusCode).toBe(200);
    } finally {
      await instance.close();
    }
  });

  it('fails clearly when the built UI is missing', async () => {
    const uiDist = tempDir('organiser-ui-missing-');
    await expect(
      serveReview(
        { cwd: projectRoot, env: { ORGANISER_PORT: '0' } },
        () => {
          throw new Error('the organiser must not be constructed when assets are missing');
        },
        0,
        uiDist,
      ),
    ).rejects.toThrow(/built UI assets missing/);
  });

  it('the real CLI launch serves the UI and accepts a login', async () => {
    const cliEntry = join(projectRoot, 'dist', 'cli', 'main.js');
    const realUiDist = join(projectRoot, 'ui', 'dist');
    if (!existsSync(cliEntry) || !existsSync(realUiDist)) {
      expect.fail('dist/cli/main.js or ui/dist is missing; run "pnpm build" before this suite');
    }
    const root = tempDir('organiser-launch-root-');
    writeFileSync(join(root, 'synthetic.txt'), 'synthetic fixture content\n');
    const dbPath = join(tempDir('organiser-launch-db-'), 'organiser.sqlite');

    const child: ChildProcess = spawn(process.execPath, [cliEntry, 'review'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ORGANISER_ROOT: root,
        ORGANISER_DB: dbPath,
        ORGANISER_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`CLI did not start; stderr: ${stderr}`)), 60_000);
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
          const portMatch = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr);
          // The token is the last stderr line and contains no spaces; the
          // prompt line contains "token" and must not be mistaken for it.
          const lines = stderr.trim().split('\n');
          const token = lines.at(-1)?.trim() ?? '';
          if (portMatch !== null && /^[A-Za-z0-9_-]{16,}$/.test(token)) {
            clearTimeout(timer);
            done();
          }
        });
        child.on('exit', (code) => reject(new Error(`CLI exited early (${code}); stderr: ${stderr}`)));
      });

      const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)?.[1];
      const token = stderr.trim().split('\n').at(-1)?.trim() ?? '';
      expect(port).toMatch(/^\d+$/);
      expect(token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
      expect(stderr).toContain('enter this one-time token');

      // Native form-encoded submit: the login form's no-JS fallback path.
      const form = await fetch(`http://127.0.0.1:${port}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        redirect: 'manual',
      });
      expect(form.status).toBe(302);
      expect(form.headers.get('location')).toBe('/app/');

      const index = await fetch(`http://127.0.0.1:${port}/app/`);
      expect(index.status).toBe(200);
      const shell = await index.text();
      // The built React shell (not the server's login form) must be served.
      expect(shell).toContain('div id="root"');
      expect(shell).toContain('/app/assets/');

      const loginScript = await fetch(`http://127.0.0.1:${port}/app/login.js`);
      expect(loginScript.status).toBe(200);
    } finally {
      child.kill('SIGTERM');
      await new Promise((done) => child.on('exit', done));
    }
  }, 90_000);
});

describe('login content types (415 regression)', () => {
  it('accepts a native form-encoded login and still rejects a wrong token', async () => {
    const instance = buildServer(new FakeService(), { port: 0, host: '127.0.0.1' });
    await instance.listen({ port: 0, host: '127.0.0.1' });
    try {
      const token = (instance as unknown as { bootstrapToken: string }).bootstrapToken;
      const origin = `http://127.0.0.1:${(instance.addresses()[0] as { port: number }).port}`;

      // The user-observed failure: a browser form submit without JSON.
      const form = await instance.inject({
        method: 'POST',
        url: '/login',
        payload: new URLSearchParams({ token }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      });
      expect(form.statusCode).toBe(302);
      expect(String(form.headers['set-cookie'])).toContain('session=');

      const wrongForm = await instance.inject({
        method: 'POST',
        url: '/login',
        payload: new URLSearchParams({ token: 'not-the-token' }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      });
      expect(wrongForm.statusCode).toBe(401);

      // JSON remains the primary path.
      const json = await instance.inject({
        method: 'POST',
        url: '/login',
        payload: { token },
        headers: { origin },
      });
      expect(json.statusCode).toBe(302);
    } finally {
      await instance.close();
    }
  });
});
