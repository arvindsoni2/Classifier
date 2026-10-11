/**
 * Built-UI asset serving shared by the production launch and the E2E factory
 * (spec review R8). One composition path: whatever serves `/app/…` in tests is
 * exactly what `organiser review` serves, and a missing build fails loudly
 * instead of silently degrading to a 404 login script.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Default location of the Vite build output, relative to this module. */
export function resolveDefaultUiDist(): string {
  return fileURLToPath(new URL('../../ui/dist', import.meta.url));
}

/** Fails clearly when the built UI is absent (never a silent 404 at runtime). */
export function assertBuiltUi(uiDist: string): void {
  if (!existsSync(join(uiDist, 'index.html'))) {
    throw new Error(`built UI assets missing at ${uiDist}; run "pnpm build" before "organiser review"`);
  }
}

/** Registers the static UI under `/app/` (login script, bundle, styles). */
export function registerUiAssets(app: FastifyInstance, uiDist: string): void {
  // Static import (not a dynamic one): registration must be queued before
  // listen, or Fastify rejects the plugin with "already booted".
  app.register(fastifyStatic, { root: uiDist, prefix: '/app/' });
}
