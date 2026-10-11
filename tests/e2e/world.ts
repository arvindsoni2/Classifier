import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end world for the review flow (plan Task 9): a synthetic Downloads
 * root, a real SQLite repository, real discovery, the REAL Linux helper and
 * the REAL application service — only the provider set is fixed to the
 * deterministic rules provider, and the Clef/Laya/Jev adapters are not
 * required. The HTTP server is started on an ephemeral loopback port with
 * the UI served from ui/dist when present.
 */
import { createServerForE2E } from '../../src/http/server.js';

export interface E2EWorld {
  rootDir: string;
  dbPath: string;
  baseUrl: string;
  bootstrapToken: string;
  close(): Promise<void>;
}

export async function startWorld(files: Record<string, string> = {
  'invoice-01.txt': 'first invoice for hosting\n',
  'invoice-02.txt': 'second invoice for hosting\n',
  'beach-photo.jpg': 'not-an-image\n',
  'resume.pdf': 'resume draft content\n',
  '$(touch marker).txt': 'shell-like name is data\n',
}, directories: string[] = ['Invoices', 'Media', 'Documents']): Promise<E2EWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-world-'));
  const rootDir = join(dir, 'Downloads');
  mkdirSync(rootDir, { recursive: true });
  for (const name of directories) mkdirSync(join(rootDir, name), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(rootDir, name), content, 'utf8');
  }

  const dbPath = join(dir, 'organiser.sqlite');
  const handle = await createServerForE2E({
    dbPath,
    rootPath: rootDir,
    port: 0,
    uiDist: join(process.cwd(), 'ui', 'dist'),
  });
  await handle.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.addresses()[0];
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    rootDir,
    dbPath,
    baseUrl: `http://127.0.0.1:${port}`,
    bootstrapToken: handle.bootstrapToken,
    async close() {
      // A still-open browser page holds a keep-alive connection that keeps
      // Fastify's close() pending; force the connections closed so teardown is
      // deterministic regardless of test order.
      handle.server.closeAllConnections?.();
      await Promise.race([
        handle.close(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
