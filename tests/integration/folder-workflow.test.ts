import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Organiser } from '../../src/application/organiser.js';
import { reviewScannedTaxonomy } from '../helpers/review-taxonomy.js';
import { createRepositories } from '../../src/adapters/persistence/repositories.js';

/**
 * Spec review R10: new-folder proposals must come from auditable evidence
 * (the persisted provider decisions), the physical directory must never be
 * created by the proposal itself, and the parent identity must be the real
 * destination, not a fabricated root inode.
 */
const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function world(label: string): { rootDir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `folders-${label}-`));
  fixtures.push(dir);
  const rootDir = join(dir, 'Downloads');
  mkdirSync(rootDir, { recursive: true });
  return { rootDir, dbPath: join(dir, 'organiser.sqlite') };
}

describe('reviewed new folders (R10)', () => {
  it('suggests folder groups from the persisted deferral decisions', async () => {
    const { rootDir, dbPath } = world('suggestions');
    mkdirSync(join(rootDir, 'Documents'), { recursive: true });
    writeFileSync(join(rootDir, 'notes-a.txt'), 'alpha beta gamma\n', 'utf8');
    writeFileSync(join(rootDir, 'notes-b.txt'), 'delta epsilon zeta\n', 'utf8');
    writeFileSync(join(rootDir, 'notes-c.txt'), 'eta theta iota\n', 'utf8');
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    await organiser.scan();
    await reviewScannedTaxonomy(organiser);
    const classified = await organiser.classify(undefined, 'rules');
    // The rules baseline cannot place these, so they defer to unknown.
    expect(classified.deferred).toBe(3);

    const groups = organiser.folderGroups();
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const documents = groups.find((group) => group.label === 'Unsorted Documents');
    expect(documents).toBeDefined();
    expect(documents?.members).toHaveLength(3);
    organiser.close();
  }, 60_000);

  it('persists the provider decision with its real provenance', async () => {
    const { rootDir, dbPath } = world('provenance');
    mkdirSync(join(rootDir, 'Documents'), { recursive: true });
    writeFileSync(join(rootDir, 'notes-a.txt'), 'alpha beta gamma\n', 'utf8');
    writeFileSync(join(rootDir, 'notes-b.txt'), 'delta epsilon zeta\n', 'utf8');
    writeFileSync(join(rootDir, 'notes-c.txt'), 'eta theta iota\n', 'utf8');
    const organiser = new Organiser({ dbPath, rootPath: rootDir, stabilityWindowMs: 0 });
    const scanned = await organiser.scan();
    await reviewScannedTaxonomy(organiser);
    await organiser.classify(undefined, 'rules');

    // Read the decisions through the repository on the same database: real
    // provenance, not the routing wrapper's placeholder revision.
    const repositories = createRepositories(dbPath);
    const rows = repositories.decisions.listByRoot(scanned.rootId);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.decision.provider).toBe('rules');
      expect(row.decision.modelRevision).toBe('rules@1.0.0');
      expect(row.decision.modelRevision).not.toBe('route');
      const answers = JSON.parse(row.decision.answersJson) as { selectedId: string }[];
      expect(answers[answers.length - 1]?.selectedId).toBe('unknown');
    }
    repositories.close();
    organiser.close();
  }, 60_000);
});
