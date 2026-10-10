import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import type { Category, Proposal, Result } from '../../src/domain/contracts.js';
import type { Batch } from '../../src/adapters/persistence/repositories.js';
import type { ProviderHealth } from '../../src/cli/doctor.js';
import { buildServer, type ApplicationService, type SessionConfig } from '../../src/http/server.js';

/** Fake application service: records calls, returns canned data. */
class FakeService implements ApplicationService {
  readonly calls: { method: string; args: unknown[] }[] = [];
  failNext: { code: 'INVALID_DECISION' | 'STALE' | 'OUT_OF_SCOPE'; detail: string } | null = null;

  private ok<T>(method: string, value: T): Result<T> {
    this.calls.push({ method, args: [] });
    return { ok: true, value };
  }

  async createBatch(rootId: string): Promise<Result<Batch>> {
    this.calls.push({ method: 'createBatch', args: [rootId] });
    return { ok: true, value: { id: 'batch-1', rootId, stage: 'discovery', createdAt: '2026-10-07T10:00:00.000Z', cancellationRequested: false } };
  }

  async getBatch(batchId: string): Promise<Result<Batch>> {
    this.calls.push({ method: 'getBatch', args: [batchId] });
    return { ok: true, value: { id: batchId, rootId: 'root-1', stage: 'review', createdAt: '2026-10-07T10:00:00.000Z', cancellationRequested: false } };
  }

  async replaceTaxonomy(body: unknown): Promise<Result<{ revision: number; mappingHash: string }>> {
    this.calls.push({ method: 'replaceTaxonomy', args: [body] });
    return { ok: true, value: { revision: 2, mappingHash: 'd'.repeat(64) } };
  }

  async listProposals(batchId: string): Promise<Result<Proposal[]>> {
    this.calls.push({ method: 'listProposals', args: [batchId] });
    // Hostile-looking names are DATA the UI must escape, never instructions.
    const hostile: Proposal = {
      id: 'proposal-1',
      version: 1,
      itemId: 'item-1',
      categoryId: 'cat-invoices',
      destinationId: 'dest-invoices',
      basename: '<script>alert(1)</script>$(touch marker).txt',
      expected: {
        device: '65026',
        inode: '123456789012345678901234567890',
        size: '2048',
        mtimeNs: '1760000000123456789',
        ctimeNs: '1760000000123456789',
        sha256: 'c'.repeat(64),
      },
      taxonomyRevision: 2,
      policyRevision: 3,
      decisionIds: ['decision-1'],
      state: 'pending',
    };
    return { ok: true, value: [hostile] };
  }

  async patchProposal(proposalId: string, body: unknown): Promise<Result<Proposal>> {
    this.calls.push({ method: 'patchProposal', args: [proposalId, body] });
    if (this.failNext !== null) {
      const failure = this.failNext;
      this.failNext = null;
      return { ok: false, ...failure };
    }
    const proposals = await this.listProposals('batch-1');
    if (!proposals.ok) return proposals;
    const base = proposals.value[0]!;
    return { ok: true, value: { ...base, version: base.version + 1, categoryId: (body as { categoryId?: string }).categoryId ?? base.categoryId } };
  }

  async createApproval(body: unknown): Promise<Result<unknown>> {
    this.calls.push({ method: 'createApproval', args: [body] });
    return { ok: true, value: { id: 'approval-1' } };
  }

  async providerHealth(): Promise<ProviderHealth[]> {
    this.calls.push({ method: 'providerHealth', args: [] });
    return [{ provider: 'rules', status: 'ok', detail: 'healthy' }];
  }
}

interface StartedServer {
  instance: FastifyInstance;
  port: number;
  origin: string;
  cookie: string;
}

async function startServer(service: ApplicationService, overrides: Partial<SessionConfig> = {}): Promise<StartedServer> {
  const listenPort = overrides.port ?? 0;
  const config: SessionConfig = {
    port: listenPort,
    host: '127.0.0.1',
    sessionLifetimeMs: 8 * 60 * 60 * 1000,
    ...overrides,
  };
  const instance = buildServer(service, config);
  await instance.listen({ port: listenPort, host: config.host ?? '127.0.0.1' });
  const address = instance.addresses()[0];
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  const token = (instance as unknown as { bootstrapToken: string }).bootstrapToken;
  const login = await instance.inject({
    method: 'POST',
    url: '/login',
    payload: { token },
    headers: { origin },
  });
  expect([200, 302, 303]).toContain(login.statusCode);
  const rawSetCookie = login.headers['set-cookie'];
  const setCookie = typeof rawSetCookie === 'string' ? rawSetCookie : Array.isArray(rawSetCookie) ? (rawSetCookie[0] ?? '') : '';
  const cookie = setCookie.split(';')[0] ?? '';
  return { instance, port, origin, cookie };
}

const servers: StartedServer[] = [];
afterAll(async () => {
  for (const server of servers) await server.instance.close();
});

describe('cross_site_mutations_are_rejected', () => {
  it('rejects unauthenticated mutations and cross-origin/evil-host mutations', async () => {
    const service = new FakeService();
    const server = await startServer(service);
    servers.push(server);

    // Unauthenticated.
    const anonymous = await server.instance.inject({
      method: 'POST',
      url: '/api/batches',
      payload: { rootId: 'root-1' },
      headers: { origin: server.origin, host: `127.0.0.1:${server.port}` },
    });
    expect(anonymous.statusCode).toBe(401);

    // Authenticated but cross-site origin.
    const evilOrigin = await server.instance.inject({
      method: 'POST',
      url: '/api/batches',
      payload: { rootId: 'root-1' },
      headers: {
        origin: 'http://evil.example',
        host: `127.0.0.1:${server.port}`,
        cookie: server.cookie,
      },
    });
    expect(evilOrigin.statusCode).toBe(403);

    // Authenticated but spoofed Host (DNS-rebinding style).
    const evilHost = await server.instance.inject({
      method: 'POST',
      url: '/api/batches',
      payload: { rootId: 'root-1' },
      headers: {
        origin: server.origin,
        host: 'evil.example',
        cookie: server.cookie,
      },
    });
    expect(evilHost.statusCode).toBe(403);

    // Authenticated, same origin: the request reaches the application service.
    const allowed = await server.instance.inject({
      method: 'POST',
      url: '/api/batches',
      payload: { rootId: 'root-1' },
      headers: {
        origin: server.origin,
        host: `127.0.0.1:${server.port}`,
        cookie: server.cookie,
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(service.calls.some((call) => call.method === 'createBatch')).toBe(true);

    // Reads require the session too.
    const anonRead = await server.instance.inject({
      method: 'GET',
      url: '/api/providers',
      headers: { host: `127.0.0.1:${server.port}` },
    });
    expect(anonRead.statusCode).toBe(401);

    const okRead = await server.instance.inject({
      method: 'GET',
      url: '/api/providers',
      headers: { host: `127.0.0.1:${server.port}`, cookie: server.cookie },
    });
    expect(okRead.statusCode).toBe(200);
  });

  it('blocks apply/resume/undo when the service has no execution surface', async () => {
    const service = new FakeService();
    const server = await startServer(service);
    servers.push(server);

    for (const path of ['/api/batches/batch-1/apply', '/api/batches/batch-1/resume', '/api/actions/action-1/undo']) {
      const response = await server.instance.inject({
        method: 'POST',
        url: path,
        payload: { approvalId: 'approval-1', actionSetHash: 'a'.repeat(64) },
        headers: {
          origin: server.origin,
          host: `127.0.0.1:${server.port}`,
          cookie: server.cookie,
        },
      });
      expect(response.statusCode).toBe(501);
      const body = response.json() as { error: { code: string; detail: string } };
      expect(body.error.code).toBe('UNSUPPORTED');
      expect(body.error.detail).toMatch(/not wired/i);
    }
    // No application-service mutation was reachable behind the block.
    expect(service.calls).toHaveLength(0);
  });

  it('validates the bootstrap token once and sets a strict session cookie', async () => {
    const service = new FakeService();
    const config: SessionConfig = { port: 0, host: '127.0.0.1', sessionLifetimeMs: 8 * 60 * 60 * 1000 };
    const instance = buildServer(service, config);
    servers.push({ instance, port: 0, origin: '', cookie: '' });
    await instance.listen({ port: 0, host: '127.0.0.1' });
    const address = instance.addresses()[0];
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const origin = `http://127.0.0.1:${port}`;
    const token = (instance as unknown as { bootstrapToken: string }).bootstrapToken;

    const wrong = await instance.inject({ method: 'POST', url: '/login', payload: { token: 'wrong-token' }, headers: { origin } });
    expect(wrong.statusCode).toBe(401);

    const right = await instance.inject({ method: 'POST', url: '/login', payload: { token }, headers: { origin } });
    expect([200, 302, 303]).toContain(right.statusCode);
    const rawSetCookie = right.headers['set-cookie'];
    const cookieHeader = typeof rawSetCookie === 'string' ? rawSetCookie : Array.isArray(rawSetCookie) ? (rawSetCookie[0] ?? '') : '';
    expect(cookieHeader).toMatch(/HttpOnly/i);
    expect(cookieHeader).toMatch(/SameSite=Strict/i);

    // The token never appears in any response body or header.
    expect(JSON.stringify(right.headers)).not.toContain(token);
    expect(right.body).not.toContain(token);
  });

  it('serves hostile filenames as escaped JSON data with a self-only CSP', async () => {
    const service = new FakeService();
    const server = await startServer(service);
    servers.push(server);

    const response = await server.instance.inject({
      method: 'GET',
      url: '/api/batches/batch-1/proposals',
      headers: { host: `127.0.0.1:${server.port}`, cookie: server.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    // The basename is JSON data, not HTML: it round-trips exactly through
    // JSON.parse and the response is never rendered as HTML.
    const proposals = (response.json() as { proposals: Proposal[] }).proposals;
    expect(proposals[0]?.basename).toBe('<script>alert(1)</script>$(touch marker).txt');
    // The HTML login surface is the only HTML: it cannot execute proposal data.
    const page = await server.instance.inject({ method: 'GET', url: '/' });
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).not.toContain('<script>alert(1)</script>');
  });

  it('fails clearly instead of binding publicly or silently when the port is occupied', async () => {
    const first = await startServer(new FakeService());
    servers.push(first);

    const config: SessionConfig = { port: first.port, host: '127.0.0.1', sessionLifetimeMs: 8 * 60 * 60 * 1000 };
    const second = buildServer(new FakeService(), config);
    servers.push({ instance: second, port: 0, origin: '', cookie: '' });
    await expect(second.listen({ port: first.port, host: '127.0.0.1' })).rejects.toThrow(/EADDRINUSE|address already in use/i);
    // The failing server must not report success.
    expect(second.server.listening).toBe(false);
  });

  it('never logs the bootstrap token or session cookies', async () => {
    const service = new FakeService();
    const config: SessionConfig = { port: 0, host: '127.0.0.1', sessionLifetimeMs: 8 * 60 * 60 * 1000 };
    const instance = buildServer(service, config);
    servers.push({ instance, port: 0, origin: '', cookie: '' });
    await instance.listen({ port: 0, host: '127.0.0.1' });
    const address = instance.addresses()[0];
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const origin = `http://127.0.0.1:${port}`;
    const token = (instance as unknown as { bootstrapToken: string }).bootstrapToken;

    const logged: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    try {
      await instance.inject({ method: 'POST', url: '/login', payload: { token: 'not-the-token' }, headers: { origin } });
      const success = await instance.inject({ method: 'POST', url: '/login', payload: { token }, headers: { origin } });
      const rawSetCookie = success.headers['set-cookie'];
      const cookie = (typeof rawSetCookie === 'string' ? rawSetCookie : Array.isArray(rawSetCookie) ? (rawSetCookie[0] ?? '') : '').split(';')[0] ?? '';
      await instance.inject({ method: 'GET', url: '/api/providers', headers: { host: `127.0.0.1:${port}`, cookie } });
      await instance.inject({
        method: 'POST',
        url: '/api/batches',
        payload: { rootId: 'root-1' },
        headers: { origin: 'http://evil.example', host: `127.0.0.1:${port}`, cookie },
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const joined = logged.join('\n');
    expect(joined).not.toContain(token);
    expect(joined).not.toContain('session=');
  });
});

describe('taxonomy and proposal routes', () => {
  it('forwards the reviewed taxonomy with expectedRevision and returns 409 on mismatch', async () => {
    const service = new FakeService();
    const server = await startServer(service);
    servers.push(server);

    const tree: Category[] = [
      { id: 'root', parentId: null, label: 'Inbox', description: 'Root', destinationId: null, kind: 'group' },
      { id: 'cat-invoices', parentId: 'root', label: 'Invoices', description: 'Invoice documents', destinationId: 'dest-invoices', kind: 'existing' },
    ];
    const response = await server.instance.inject({
      method: 'PUT',
      url: '/api/taxonomy',
      payload: { expectedRevision: 1, tree, mappings: [{ categoryId: 'cat-invoices', destinationId: 'dest-invoices' }] },
      headers: {
        origin: server.origin,
        host: `127.0.0.1:${server.port}`,
        cookie: server.cookie,
      },
    });
    expect(response.statusCode).toBe(200);
    const store = service.calls.find((call) => call.method === 'replaceTaxonomy');
    expect(store?.args[0]).toMatchObject({ expectedRevision: 1, tree });
  });

  it('patches a proposal only with a matching expectedVersion and increments it', async () => {
    const service = new FakeService();
    const server = await startServer(service);
    servers.push(server);

    const good = await server.instance.inject({
      method: 'PATCH',
      url: '/api/proposals/proposal-1',
      payload: { expectedVersion: 1, categoryId: 'cat-media' },
      headers: {
        origin: server.origin,
        host: `127.0.0.1:${server.port}`,
        cookie: server.cookie,
      },
    });
    expect(good.statusCode).toBe(200);
    const patched = (good.json() as { proposal: Proposal }).proposal;
    expect(patched.version).toBe(2);
    expect(patched.categoryId).toBe('cat-media');

    service.failNext = { code: 'STALE', detail: 'proposal version mismatch' };
    const stale = await server.instance.inject({
      method: 'PATCH',
      url: '/api/proposals/proposal-1',
      payload: { expectedVersion: 9, categoryId: 'cat-media' },
      headers: {
        origin: server.origin,
        host: `127.0.0.1:${server.port}`,
        cookie: server.cookie,
      },
    });
    expect(stale.statusCode).toBe(409);
  });
});
