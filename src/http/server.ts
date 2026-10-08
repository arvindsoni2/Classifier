/**
 * Loopback API server (LLD §7, plan Task 6). Binds the loopback host only —
 * never a public interface — and fails rather than binding publicly when the
 * port is occupied. Browser security lives in routes.ts/session.ts; this
 * module is wiring only.
 */
import Fastify, { type FastifyInstance, type FastifyListenOptions } from 'fastify';
import { createSessionStore, type SessionConfig } from './session.js';
import { registerRoutes, type ApplicationService } from './routes.js';

export type { ApplicationService } from './routes.js';
export { type SessionConfig, DEFAULT_PORT } from './session.js';

export interface OrganiserServer extends FastifyInstance {
  /** The one-time bootstrap token for this launch (login form only). */
  bootstrapToken: string;
}

/** Builds the authenticated loopback server without binding it. */
export function buildServer(
  service: ApplicationService,
  config: SessionConfig = {},
): OrganiserServer {
  const host = config.host ?? '127.0.0.1';
  const port = config.port ?? 4317;
  const sessionLifetimeMs = config.sessionLifetimeMs ?? 8 * 60 * 60 * 1000;

  const app = Fastify({
    logger: false, // tokens and cookies must never be logged
    bodyLimit: 256 * 1024, // bounded request bodies
    trustProxy: false,
  }) as unknown as OrganiserServer;

  const sessionStore = createSessionStore(config);

  const boundPort = (): number | null => {
    const address = app.server.address();
    return typeof address === 'object' && address !== null ? address.port : null;
  };

  registerRoutes(app, { service, sessionStore, sessionLifetimeMs, boundPort });
  app.bootstrapToken = sessionStore.bootstrapToken;

  // Loopback only: a public bind is never allowed, occupied ports fail loudly
  // (EADDRINUSE surfaces as a listen rejection, never a silent success).
  const originalListen = app.listen.bind(app);
  app.listen = ((options?: FastifyListenOptions) => {
    const listenHost = options?.host ?? host;
    if (listenHost !== '127.0.0.1' && listenHost !== 'localhost' && listenHost !== '::1') {
      throw new Error(`refusing to bind non-loopback host ${JSON.stringify(listenHost)}`);
    }
    const listenPort = options?.port ?? port;
    return originalListen({ host: listenHost, port: listenPort });
  }) as FastifyInstance['listen'];

  return app;
}
