/**
 * Phase 1 Task 8 review blocker 1: password-locked PDFs are `ok`, not failures.
 *
 * Three states, one row each: an unencrypted PDF (`Encrypted: no`, exit 0), a
 * user-readable encrypted one (`Encrypted: yes`, exit 0), and a locked one
 * (non-zero exit, `Incorrect password` on stderr). The locked row is `ok` with
 * `encrypted: true` and `password_protected: true`; anything else still fails.
 *
 * Fixtures are built with `qpdf --encrypt <user> <owner> 256 --`; qpdf 11+
 * refuses the 128-bit RC4 the earlier draft used, and also requires the 256-bit
 * form to state both passwords. Skipped with a visible reason only when qpdf is
 * absent.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractMetadata, metadataRows } from '../../src/catalogue/metadata/index.js';
import { loadConfig } from '../../src/catalogue/config.js';
import { scan } from '../../src/catalogue/scanner.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import { makeFixture, type Fixture } from './fixtures.js';
import { makePdfWithInfo } from '../fixtures/documents.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function openStoreFor(fixture: Fixture): CatalogueStore {
  const store = openStore(join(fixture.parent, 'data'));
  cleanups.push(() => store.close());
  return store;
}

function writeConfig(fixture: Fixture): string {
  const configPath = join(fixture.parent, 'catalogue.json');
  const dataDir = join(fixture.parent, 'data');
  writeFileSync(configPath, JSON.stringify({ roots: [fixture.root], dataDir }), 'utf8');
  return configPath;
}

async function scanOnly(fixture: Fixture, store: CatalogueStore): Promise<number> {
  const result = await scan(loadConfig(writeConfig(fixture)), store, {});
  return result.scanId;
}

function rowFor(store: CatalogueStore, relPath: string) {
  return metadataRows(store).find((row) => row.relPath === relPath);
}

/** Encrypts `source` into `dest` with the given user and owner passwords. */
function encryptPdf(source: string, dest: string, user: string, owner: string): void {
  execFileSync('qpdf', ['--encrypt', user, owner, '256', '--', source, dest]);
}

describe('password-protected PDFs (Task 8 review blocker 1)', () => {
  it('records readable encrypted as ok, locked as ok with password_protected, plain as ok', async (context) => {
    try {
      execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
    } catch {
      context.skip('qpdf is not installed, so an encrypted PDF cannot be built');
      return;
    }

    const fixture = makeFixture('encrypted-pdf');
    fixture.put('plain.pdf', makePdfWithInfo({ Title: 'Plain', Author: 'A. Fixture' }, 1));
    encryptPdf(join(fixture.root, 'plain.pdf'), join(fixture.root, 'readable.pdf'), '', '');
    encryptPdf(join(fixture.root, 'plain.pdf'), join(fixture.root, 'locked.pdf'), 'secret', 'ownersecret');

    const store = openStoreFor(fixture);
    const scanId = await scanOnly(fixture, store);
    await extractMetadata(store, scanId);

    const plain = rowFor(store, 'plain.pdf');
    expect(plain?.status).toBe('ok');
    expect(plain?.fields.encrypted).toBe(false);
    expect(plain?.fields.password_protected).toBeUndefined();

    // Empty user password: pdfinfo opens it and reports `Encrypted: yes`.
    const readable = rowFor(store, 'readable.pdf');
    expect(readable?.status).toBe('ok');
    expect(readable?.fields.encrypted).toBe(true);
    expect(readable?.fields.password_protected).toBeUndefined();

    // Non-empty user password: pdfinfo refuses with `Incorrect password`.
    const locked = rowFor(store, 'locked.pdf');
    expect(locked?.status).toBe('ok');
    expect(locked?.fields.encrypted).toBe(true);
    expect(locked?.fields.password_protected).toBe(true);
  });
});
