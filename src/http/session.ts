/**
 * Loopback session authentication (LLD §7, plan Task 6): a random
 * per-launch bootstrap token is entered once in a login form (never a query
 * URL) and exchanged for an HttpOnly SameSite=Strict session cookie. The
 * token is compared in constant time and is never logged.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface SessionConfig {
  /** Port the server will bind; default 4317 (LLD §7). */
  port?: number;
  /** Loopback bind host. */
  host?: string;
  /** Session lifetime; eight hours by default (LLD §7). */
  sessionLifetimeMs?: number;
  /** Pre-issued bootstrap token (tests); random per launch otherwise. */
  bootstrapToken?: string;
}

export interface SessionStore {
  /** Bootstrap token for this launch; shown in the login form context. */
  readonly bootstrapToken: string;
  /** Issues a session for the correct token; null otherwise. */
  issue(token: string): string | null;
  /** True when the session id exists and has not expired. */
  verify(sessionId: string | undefined): boolean;
  destroy(sessionId: string): void;
}

export const DEFAULT_PORT = 4317;
export const DEFAULT_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

export function randomBootstrapToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Parses the session cookie from an HTTP request without any logging. */
export function readSessionCookie(request: IncomingMessage): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'session' && rest.length > 0) return rest.join('=');
  }
  return undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function createSessionStore(config: SessionConfig): SessionStore {
  const bootstrapToken = config.bootstrapToken ?? randomBootstrapToken();
  const lifetimeMs = config.sessionLifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS;
  const sessions = new Map<string, number>();

  return {
    bootstrapToken,
    issue(token) {
      if (!constantTimeEquals(token, bootstrapToken)) return null;
      const sessionId = randomUUID();
      sessions.set(sessionId, Date.now() + lifetimeMs);
      return sessionId;
    },
    verify(sessionId) {
      if (sessionId === undefined) return false;
      const expiresAt = sessions.get(sessionId);
      if (expiresAt === undefined) return false;
      if (Date.now() > expiresAt) {
        sessions.delete(sessionId);
        return false;
      }
      return true;
    },
    destroy(sessionId) {
      sessions.delete(sessionId);
    },
  };
}

/** Serialises the session Set-Cookie header value. */
export function sessionCookie(sessionId: string, lifetimeMs: number, _response: ServerResponse): string {
  const maxAge = Math.floor(lifetimeMs / 1000);
  return `session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
