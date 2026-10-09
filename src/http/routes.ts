/**
 * Loopback API routes and browser security (LLD §7, plan Task 6).
 *
 * Browser security is enforced server-side: authentication on every /api
 * request, Origin checked on every mutation, Host against loopback
 * authorities, self-only CSP with no-referrer, no wildcard CORS, and no
 * token or cookie ever written to logs. Response bodies are JSON data —
 * filenames and evidence are escaped strings, never HTML.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Category, Id, Revision, Sha256 } from '../domain/contracts.js';
import { readSessionCookie, sessionCookie, type SessionStore } from './session.js';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface ApplicationService {
  createBatch(rootId: Id): Promise<Result<unknown>>;
  getBatch(batchId: Id): Promise<Result<unknown>>;
  replaceTaxonomy(body: {
    expectedRevision: Revision;
    tree: Category[];
    mappings: { categoryId: Id; destinationId: Id }[];
  }): Promise<Result<{ revision: Revision; mappingHash: Sha256 }>>;
  listProposals(batchId: Id): Promise<Result<unknown>>;
  patchProposal(
    proposalId: Id,
    body: { expectedVersion: Revision; categoryId?: Id; destinationId?: Id; reject?: boolean },
  ): Promise<Result<unknown>>;
  createApproval(body: {
    batchId: Id;
    actions: { proposalId: Id; version: Revision }[];
    mode: 'apply' | 'undo';
  }): Promise<Result<unknown>>;
  providerHealth(): Promise<unknown>;
}

type Result<T> = { ok: true; value: T } | { ok: false; code: string; detail: string };

export interface RouteDeps {
  service: ApplicationService;
  sessionStore: SessionStore;
  sessionLifetimeMs: number;
  /** Resolved at request time (port may be ephemeral in tests). */
  boundPort: () => number | null;
}

const LOGIN_FORM = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fedora organiser — sign in</title>
</head>
<body>
<h1>Fedora organiser</h1>
<p>Enter the one-time token shown when the server started.</p>
<form method="post" action="/login">
<label for="token">Token</label>
<input id="token" name="token" type="password" autocomplete="off" required>
<button type="submit">Sign in</button>
</form>
</body>
</html>
`;

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function originMatchesBoundPort(origin: string, boundPort: number | null): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:') return false;
    if (!isLoopbackHostname(parsed.hostname)) return false;
    if (boundPort === null) return true; // pre-listen (inject) context
    return parsed.port === String(boundPort);
  } catch {
    return false;
  }
}

function hostMatchesBoundPort(host: string | undefined, boundPort: number | null): boolean {
  if (host === undefined) return false;
  try {
    // Host header carries host[:port] without a scheme.
    const parsed = new URL(`http://${host}`);
    if (!isLoopbackHostname(parsed.hostname)) return false;
    if (boundPort === null) return true;
    return parsed.port === String(boundPort);
  } catch {
    return false;
  }
}

function sendError(reply: FastifyReply, status: number, code: string, detail: string) {
  return reply.code(status).send({ error: { code, detail } });
}

function statusForError(code: string): number {
  if (code === 'STALE') return 409;
  if (code === 'UNAUTHORISED') return 403;
  if (code === 'INVALID_DECISION') return 400;
  if (code === 'OUT_OF_SCOPE') return 422;
  return 500;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { service, sessionStore, sessionLifetimeMs, boundPort } = deps;

  app.addHook('onSend', async (_request, reply) => {
    reply.header('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  });

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url.split('?')[0] ?? request.url;
    if (url === '/login' || url === '/') return;

    const port = boundPort();

    // Host authority: loopback hosts on the bound port only.
    const host = request.headers.host;
    if (!hostMatchesBoundPort(host, port)) {
      return sendError(reply, 403, 'UNAUTHORISED', 'request Host is not the loopback server authority');
    }

    // Session authentication on every API request.
    if (url.startsWith('/api/')) {
      const sessionId = readSessionCookie(request.raw);
      if (!sessionStore.verify(sessionId)) {
        return sendError(reply, 401, 'UNAUTHORISED', 'a valid session is required');
      }
    }

    // Origin on every mutation: another site cannot drive this server.
    if (MUTATION_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (typeof origin !== 'string' || !originMatchesBoundPort(origin, port)) {
        return sendError(
          reply,
          403,
          'UNAUTHORISED',
          'cross-site mutation rejected: Origin must be the loopback server authority',
        );
      }
    }
    return undefined;
  });

  app.get('/', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(LOGIN_FORM));

  app.post('/login', async (request, reply) => {
    const body = request.body as { token?: unknown };
    const token = typeof body?.token === 'string' ? body.token : '';
    const sessionId = sessionStore.issue(token);
    if (sessionId === null) {
      return sendError(reply, 401, 'UNAUTHORISED', 'the bootstrap token was not accepted');
    }
    reply.header('set-cookie', sessionCookie(sessionId, sessionLifetimeMs, reply.raw));
    return reply.send({ ok: true });
  });

  app.post('/logout', async (request, reply) => {
    const sessionId = readSessionCookie(request.raw);
    if (sessionId !== undefined) sessionStore.destroy(sessionId);
    reply.header('set-cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return reply.send({ ok: true });
  });

  app.get('/api/providers', async (_request, reply) =>
    reply.send({ providers: await service.providerHealth() }));

  app.post('/api/batches', async (request, reply) => {
    const body = request.body as { rootId?: unknown };
    if (typeof body?.rootId !== 'string' || body.rootId.length === 0) {
      return sendError(reply, 400, 'INVALID_DECISION', 'rootId is required');
    }
    const result = await service.createBatch(body.rootId);
    if (!result.ok) return sendError(reply, statusForError(result.code), result.code, result.detail);
    return reply.send({ batch: result.value });
  });

  app.get('/api/batches/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await service.getBatch(id);
    if (!result.ok) return sendError(reply, statusForError(result.code), result.code, result.detail);
    return reply.send({ batch: result.value });
  });

  app.put('/api/taxonomy', async (request, reply) => {
    const body = request.body as {
      expectedRevision?: unknown;
      tree?: unknown;
      mappings?: unknown;
    };
    if (typeof body?.expectedRevision !== 'number' || !Array.isArray(body.tree) || !Array.isArray(body.mappings)) {
      return sendError(reply, 400, 'INVALID_DECISION', 'expectedRevision, tree and mappings are required');
    }
    const result = await service.replaceTaxonomy({
      expectedRevision: body.expectedRevision,
      tree: body.tree as Category[],
      mappings: body.mappings as { categoryId: Id; destinationId: Id }[],
    });
    if (!result.ok) return sendError(reply, statusForError(result.code), result.code, result.detail);
    return reply.send({ taxonomy: result.value });
  });

  app.get('/api/batches/:id/proposals', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await service.listProposals(id);
    if (!result.ok) return sendError(reply, statusForError(result.code), result.code, result.detail);
    return reply.send({ proposals: result.value });
  });

  app.patch('/api/proposals/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { expectedVersion?: unknown; categoryId?: unknown; destinationId?: unknown; reject?: unknown };
    if (typeof body?.expectedVersion !== 'number') {
      return sendError(reply, 400, 'INVALID_DECISION', 'expectedVersion is required');
    }
    const patch: { expectedVersion: Revision; categoryId?: Id; destinationId?: Id; reject?: boolean } = {
      expectedVersion: body.expectedVersion,
    };
    if (typeof body.categoryId === 'string') patch.categoryId = body.categoryId;
    if (typeof body.destinationId === 'string') patch.destinationId = body.destinationId;
    if (body.reject === true) patch.reject = true;
    const result = await service.patchProposal(id, patch);
    if (!result.ok) return sendError(reply, statusForError(result.code), result.code, result.detail);
    return reply.send({ proposal: result.value });
  });

  app.post('/api/approvals', async (request, reply) => {
    const body = request.body as { batchId?: unknown; actions?: unknown; mode?: unknown };
    if (
      typeof body?.batchId !== 'string' ||
      !Array.isArray(body.actions) ||
      (body.mode !== 'apply' && body.mode !== 'undo')
    ) {
      return sendError(reply, 400, 'INVALID_DECISION', 'batchId, actions and mode (apply|undo) are required');
    }
    const result = await service.createApproval({
      batchId: body.batchId,
      actions: body.actions as { proposalId: Id; version: Revision }[],
      mode: body.mode,
    });
    if (!result.ok) return sendError(reply, statusForError(result.code), result.code, result.detail);
    return reply.send({ approval: result.value });
  });

  // Mutation endpoints are BLOCKED until the verified executor and
  // journalled apply are wired into the review workflow (plan Task 9).
  // Classifier success never authorises a filesystem move.
  for (const path of [
    '/api/batches/:id/apply',
    '/api/batches/:id/resume',
    '/api/actions/:id/undo',
  ]) {
    app.post(path, async (_request, reply) =>
      sendError(
        reply,
        503,
        'UNSUPPORTED',
        'filesystem execution is not wired into the review workflow yet: the anchored helper and journalled executor are verified (Tasks 7-8), the application service wiring lands in Task 9; classifier output cannot authorise moves',
      ));
  }
}
