/**
 * Phase 1 Task 8 item 3: an encrypted PDF is `ok`, not a failure.
 *
 * When pdfinfo reports encryption (or fails only because the file is
 * password-protected), the row is `ok` with `encrypted: true` and whatever
 * pdfinfo did report. Built with qpdf when available; skipped with a visible
 * reason otherwise.
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

describe('encrypted PDF (Task 8 item 3)', () => {
  it('is recorded ok with encrypted true', async (context) => {
    let qpdfVersion: string;
    try {
      qpdfVersion = execFileSync('qpdf', ['--version'], { encoding: 'utf8' });
    } catch {
      context.skip('qpdf is not installed, so an encrypted PDF cannot be built');
      return;
    }
    void qpdfVersion;

    const fixture = makeFixture('encrypted-pdf');
    fixture.put('plain.pdf', makePdfWithInfo({ Title: 'Plain', Author: 'A. Fixture' }, 1));
    // Encrypt with empty owner and user passwords: the file is a real PDF but
    // pdfinfo cannot read its contents without a password.
    execFileSync(
      'qpdf',
      ['--encrypt', '', '', '128', '--', join(fixture.root, 'plain.pdf'), join(fixture.root, 'secret.pdf')],
    );

    const store = openStoreFor(fixture);
    const scanId = await scanOnly(fixture, store);
    await extractMetadata(store, scanId);

    const plain = rowFor(store, 'plain.pdf');
    expect(plain?.status).toBe('ok');
    expect(plain?.fields.encrypted).toBe(false);

    const secret = rowFor(store, 'secret.pdf');
    // Encryption is recorded: ok with the flag, not a failed extraction.
    expect(secret?.status).toBe('ok');
    expect(secret?.fields.encrypted).toBe(true);
  });
});
