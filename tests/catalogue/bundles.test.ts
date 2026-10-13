/**
 * Phase 1 Task 3: bundle detection (plan docs/11-Phase-1-Plan.md Task 3).
 *
 * Two shapes of detection are under test:
 *  - `code_repo` / `code_project` are found from a directory listing during the
 *    scan; the walk stops there, so nothing inside is catalogued as an item;
 *  - `course` / `album` / `photo_set` / `extracted_archive` are evaluated after
 *    the scan from catalogue data, and their members stay in `items` with
 *    `bundle_id` set.
 *
 * Every rule gets a positive fixture and a near-miss negative. Everything runs
 * on synthetic fixture trees (AGENTS.md rule 3).
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleScanHook, detectBundles, listBundles } from '../../src/catalogue/bundles.js';
import { loadConfig } from '../../src/catalogue/config.js';
import { computeHashes, duplicateGroups } from '../../src/catalogue/dedupe.js';
import { scan } from '../../src/catalogue/scanner.js';
import { openStore, type CatalogueStore } from '../../src/catalogue/store.js';
import { makeFixture, type Fixture } from './fixtures.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Scanned {
  store: CatalogueStore;
  scanId: number;
  fixture: Fixture;
}

/** Scans a fixture with bundle detection wired in, then evaluates post-scan rules. */
async function scanFixture(fixture: Fixture): Promise<Scanned> {
  const dataDir = join(fixture.parent, 'data');
  const store = openStore(dataDir);
  cleanups.push(() => store.close());
  const configPath = join(fixture.parent, 'catalogue.json');
  writeFileSync(configPath, JSON.stringify({ roots: [fixture.root], dataDir }), 'utf8');
  const result = await scan(loadConfig(configPath), store, { onDirectory: bundleScanHook(store) });
  detectBundles(store, result.scanId);
  return { store, scanId: result.scanId, fixture };
}

/** Item rows at `relPath` itself or anywhere below it. */
function itemsUnder(store: CatalogueStore, relPath: string): { rel_path: string; bundle_id: number | null }[] {
  if (relPath === '') {
    return store.db.prepare('SELECT rel_path, bundle_id FROM items ORDER BY rel_path').all() as {
      rel_path: string;
      bundle_id: number | null;
    }[];
  }
  return store.db
    .prepare('SELECT rel_path, bundle_id FROM items WHERE rel_path = ? OR rel_path LIKE ? ORDER BY rel_path')
    .all(relPath, `${relPath}/%`) as { rel_path: string; bundle_id: number | null }[];
}

/** A video/audio/image payload; the kind comes from the extension, bytes are irrelevant. */
function media(label: string): string {
  return `synthetic ${label} payload\n`;
}

describe('bundle detection (Phase 1 Task 3)', () => {
  it('code_repo is recorded and never descended into', async () => {
    const fixture = makeFixture('code-repo');
    fixture.put('shared-dup.txt', 'the bytes that also live inside a repo\n');
    fixture.put('repo/.git/config', '[core]\n');
    fixture.put('repo/src/main.ts', 'export const main = 1;\n');
    fixture.put('repo/shared-dup.txt', 'the bytes that also live inside a repo\n');
    const { store, scanId } = await scanFixture(fixture);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('code_repo');
    expect(found[0]?.rule).toBe('contains .git');
    expect(found[0]?.relPath).toBe('repo');
    // Sizes and member counts stay null: the contents were never catalogued.
    expect(found[0]?.totalSize).toBeNull();
    expect(found[0]?.memberCount).toBeNull();

    expect(itemsUnder(store, 'repo')).toEqual([]);
    // Only the copy outside the repo exists, so it is not a duplicate.
    await computeHashes(store, scanId);
    expect(duplicateGroups(store)).toEqual([]);
    expect(itemsUnder(store, '').map((item) => item.rel_path)).toEqual(['shared-dup.txt']);
  });

  it('code_project is recorded and never descended into', async () => {
    const fixture = makeFixture('code-project');
    fixture.put('python-app/pyproject.toml', '[project]\nname = "app"\n');
    fixture.put('python-app/src/app.py', 'print("hi")\n');
    fixture.put('python-app/tests/test_app.py', 'def test(): pass\n');
    fixture.put('vs-solution/App.sln', 'Microsoft Visual Studio Solution File\n');
    fixture.put('vs-solution/App.csproj', '<Project />\n');
    const { store } = await scanFixture(fixture);

    const found = listBundles(store);
    expect(found.map((bundle) => [bundle.relPath, bundle.type, bundle.rule])).toEqual([
      ['python-app', 'code_project', 'contains pyproject.toml'],
      ['vs-solution', 'code_project', 'contains App.sln'],
    ]);
    expect(itemsUnder(store, 'python-app')).toEqual([]);
    expect(itemsUnder(store, 'vs-solution')).toEqual([]);
  });

  it('numbered videos make a course and mark its members', async () => {
    const fixture = makeFixture('course-positive');
    fixture.put('ml-course/01 intro.mp4', media('01'));
    fixture.put('ml-course/02 regression.mp4', media('02'));
    fixture.put('ml-course/Lecture 7 recap.mp4', media('lecture'));
    fixture.put('ml-course/notes.txt', 'slides and links\n');
    const { store } = await scanFixture(fixture);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    const course = found[0];
    expect(course?.type).toBe('course');
    expect(course?.rule).toBe('>=3 videos, >=60% with a sequence marker');
    // Four files in the directory, all of them members.
    expect(course?.memberCount).toBe(4);
    const expectedBytes = itemsUnder(store, 'ml-course').reduce((total, item) => {
      const row = store.db.prepare('SELECT size FROM items WHERE rel_path = ?').get(item.rel_path) as { size: number };
      return total + row.size;
    }, 0);
    expect(course?.totalSize).toBe(expectedBytes);
    for (const item of itemsUnder(store, 'ml-course')) {
      expect(item.bundle_id).toBe(course?.id);
    }
  });

  it('keyword markers alone can carry a course', async () => {
    const fixture = makeFixture('course-keyword');
    // Only two of three videos carry any marker, and both are keyword-form:
    // the keyword branch of the marker is what lifts this over 60%.
    fixture.put('talks/lecture 1 opening.mp4', media('one'));
    fixture.put('talks/Episode 4 recap.mp4', media('four'));
    fixture.put('talks/untitled recording.mp4', media('untitled'));
    const { store } = await scanFixture(fixture);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('course');
    expect(found[0]?.memberCount).toBe(3);
  });

  it('two numbered videos are not a course', async () => {
    const fixture = makeFixture('course-too-few');
    fixture.put('clips/01 highlight.mp4', media('01'));
    fixture.put('clips/02 blooper.mp4', media('02'));
    const { store } = await scanFixture(fixture);

    expect(listBundles(store)).toEqual([]);
    expect(itemsUnder(store, 'clips').every((item) => item.bundle_id === null)).toBe(true);
  });

  it('unnumbered videos are not a course', async () => {
    const fixture = makeFixture('course-unnumbered');
    fixture.put('vids/intro.mp4', media('intro'));
    fixture.put('vids/outro.mp4', media('outro'));
    fixture.put('vids/demo.mp4', media('demo'));
    fixture.put('vids/extra.mp4', media('extra'));
    const { store } = await scanFixture(fixture);

    expect(listBundles(store)).toEqual([]);
  });

  it('albums need three audio files with leading track numbers', async () => {
    const fixture = makeFixture('album');
    fixture.put('great-album/01 opener.mp3', media('01'));
    fixture.put('great-album/02 middle.mp3', media('02'));
    fixture.put('great-album/03 closer.mp3', media('03'));
    fixture.put('loose-tracks/one.mp3', media('one'));
    fixture.put('loose-tracks/two.mp3', media('two'));
    fixture.put('loose-tracks/three.mp3', media('three'));
    const { store } = await scanFixture(fixture);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.relPath).toBe('great-album');
    expect(found[0]?.type).toBe('album');
    expect(found[0]?.rule).toBe('>=3 audio files, >=60% with a leading track number');
    expect(found[0]?.memberCount).toBe(3);
    expect(itemsUnder(store, 'loose-tracks').every((item) => item.bundle_id === null)).toBe(true);
  });

  it('photo sets need ten images that are most of the directory', async () => {
    const fixture = makeFixture('photo-set');
    for (let index = 1; index <= 10; index += 1) {
      fixture.put(`holiday/img-${index}.jpg`, media(`img ${index}`));
    }
    for (let index = 1; index <= 3; index += 1) {
      fixture.put(`holiday/note-${index}.txt`, 'a note\n');
    }
    for (let index = 1; index <= 9; index += 1) {
      fixture.put(`too-few/img-${index}.jpg`, media(`img ${index}`));
    }
    for (let index = 1; index <= 10; index += 1) {
      fixture.put(`too-many-pics/img-${index}.jpg`, media(`img ${index}`));
    }
    for (let index = 1; index <= 5; index += 1) {
      fixture.put(`too-many-pics/doc-${index}.txt`, 'a document\n');
    }
    const { store } = await scanFixture(fixture);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.relPath).toBe('holiday');
    expect(found[0]?.type).toBe('photo_set');
    expect(found[0]?.rule).toBe('>=10 images, images >=70% of its files');
    // 13 files, 10 of them images.
    expect(found[0]?.memberCount).toBe(13);
  });

  it('a directory beside its own archive is an extracted_archive', async () => {
    const fixture = makeFixture('extracted');
    fixture.put('holiday-pics.zip', 'not a real zip, only the extension matters\n');
    fixture.put('holiday-pics/one.jpg', media('one'));
    fixture.put('holiday-pics/two.jpg', media('two'));
    // Same archive, differently named directory: a near miss.
    fixture.put('holiday-pics-copy/one.jpg', media('one'));
    fixture.put('holiday-pics-copy/two.jpg', media('two'));
    const { store } = await scanFixture(fixture);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.relPath).toBe('holiday-pics');
    expect(found[0]?.type).toBe('extracted_archive');
    expect(found[0]?.rule).toBe('sibling archive holiday-pics.zip');
    expect(found[0]?.memberCount).toBe(2);
  });

  it('a course parent links its numbered module bundles', async () => {
    const fixture = makeFixture('course-parent');
    for (const module of ['01 foundations', '02 macros']) {
      fixture.put(`rust course/${module}/01 part one.mp4`, media(`${module} 01`));
      fixture.put(`rust course/${module}/02 part two.mp4`, media(`${module} 02`));
      fixture.put(`rust course/${module}/03 part three.mp4`, media(`${module} 03`));
    }
    fixture.put('rust course/resources/schedule.txt', 'syllabus\n');
    fixture.put('rust course/resources/glossary.txt', 'terms\n');
    // A numbered but non-course subdirectory: its name counts towards the
    // parent's numbering ratio, yet the parent must not adopt it as a module.
    fixture.put('rust course/03 bonus album/01 opener.mp3', media('opener'));
    fixture.put('rust course/03 bonus album/02 middle.mp3', media('middle'));
    fixture.put('rust course/03 bonus album/03 closer.mp3', media('closer'));
    const { store } = await scanFixture(fixture);

    const found = listBundles(store);
    expect(found).toHaveLength(4);
    const byPath = new Map(found.map((bundle) => [bundle.relPath, bundle]));
    const parent = byPath.get('rust course');
    expect(parent?.type).toBe('course');
    expect(parent?.rule).toBe('>=2 course subdirectories, >=60% of subdirectory names numbered');
    expect(parent?.parentBundleId).toBeNull();
    // The parent aggregates its two modules (3 files each), not its own
    // resources, and not the album that sits beside the modules.
    expect(parent?.memberCount).toBe(6);

    const first = byPath.get('rust course/01 foundations');
    const second = byPath.get('rust course/02 macros');
    expect(first?.parentBundleId).toBe(parent?.id);
    expect(second?.parentBundleId).toBe(parent?.id);
    expect(first?.parentBundleId).not.toBeNull();
    // Only course modules are adopted: an album in the same parent stays top-level.
    expect(byPath.get('rust course/03 bonus album')?.type).toBe('album');
    expect(byPath.get('rust course/03 bonus album')?.parentBundleId).toBeNull();
    // Members belong to their own module, not to the parent.
    for (const item of itemsUnder(store, 'rust course/01 foundations')) {
      expect(item.bundle_id).toBe(first?.id);
    }
    // The parent has no members of its own, so none of its rows claim membership.
    for (const item of itemsUnder(store, 'rust course/resources')) {
      expect(item.bundle_id).toBeNull();
    }
  });

  it('a module without enough numbered subdirectories is not a course parent', async () => {
    const fixture = makeFixture('course-parent-negative');
    for (const module of ['videos', 'slides']) {
      fixture.put(`mixed/${module}/01 clip.mp4`, media('01'));
      fixture.put(`mixed/${module}/02 clip.mp4`, media('02'));
      fixture.put(`mixed/${module}/03 clip.mp4`, media('03'));
    }
    const { store } = await scanFixture(fixture);

    const found = listBundles(store);
    expect(found.map((bundle) => bundle.relPath).sort()).toEqual(['mixed/slides', 'mixed/videos']);
    expect(found.every((bundle) => bundle.parentBundleId === null)).toBe(true);
  });

  it('code_repo wins over a course-like listing', async () => {
    const fixture = makeFixture('precedence-repo');
    fixture.put('study/.git/config', '[core]\n');
    fixture.put('study/01 lecture.mp4', media('01'));
    fixture.put('study/02 lecture.mp4', media('02'));
    fixture.put('study/03 lecture.mp4', media('03'));
    const { store } = await scanFixture(fixture);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('code_repo');
    expect(itemsUnder(store, 'study')).toEqual([]);
  });

  it('course outranks album when both rules match', async () => {
    const fixture = makeFixture('precedence-course-album');
    for (let index = 1; index <= 3; index += 1) {
      fixture.put(`lecture/0${index} lecture.mp4`, media(`lecture ${index}`));
      fixture.put(`lecture/0${index} take.mp3`, media(`take ${index}`));
    }
    const { store } = await scanFixture(fixture);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('course');
    // The three videos are what make it a course; the audio rides along.
    expect(found[0]?.memberCount).toBe(6);
  });

  it('album wins over photo_set when both rules match', async () => {
    const fixture = makeFixture('precedence-album');
    for (let index = 1; index <= 3; index += 1) {
      fixture.put(`both/0${index} take.mp3`, media(`take ${index}`));
    }
    // 10 images of 13 files clears the photo_set threshold; course does not match.
    for (let index = 1; index <= 10; index += 1) {
      fixture.put(`both/track-shot-${index}.jpg`, media(`shot ${index}`));
    }
    const { store } = await scanFixture(fixture);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('album');
  });

  it('the root directory itself is never a bundle', async () => {
    const fixture = makeFixture('root-not-a-bundle');
    fixture.dir('.git');
    fixture.put('01 clip.mp4', media('01'));
    fixture.put('02 clip.mp4', media('02'));
    fixture.put('03 clip.mp4', media('03'));
    const { store } = await scanFixture(fixture);

    // Even with a .git and three numbered videos at the top, the configured
    // root is scanned: bundling it would hide the entire root.
    expect(listBundles(store)).toEqual([]);
    expect(itemsUnder(store, '').map((item) => item.rel_path)).toEqual([
      '01 clip.mp4',
      '02 clip.mp4',
      '03 clip.mp4',
    ]);
  });

  it('a rescan updates bundle rows instead of duplicating them', async () => {
    const fixture = makeFixture('rescan');
    fixture.put('album/01 one.mp3', media('01'));
    fixture.put('album/02 two.mp3', media('02'));
    fixture.put('album/03 three.mp3', media('03'));
    fixture.put('app/pyproject.toml', '[project]\nname = "app"\n');
    fixture.put('app/main.py', 'print("hi")\n');

    const first = await scanFixture(fixture);
    expect(listBundles(first.store)).toHaveLength(2);

    const configPath = join(fixture.parent, 'catalogue.json');
    const store = first.store;
    const second = await scan(loadConfig(configPath), store, { onDirectory: bundleScanHook(store) });
    detectBundles(store, second.scanId);

    const found = listBundles(store);
    expect(found).toHaveLength(2);
    expect(found.every((bundle) => bundle.detectedScan === second.scanId)).toBe(true);
    expect(found.map((bundle) => bundle.type).sort()).toEqual(['album', 'code_project']);
  });

  it('detection is read only on the roots', async () => {
    const fixture = makeFixture('readonly');
    fixture.put('album/01 one.mp3', media('01'));
    fixture.put('album/02 two.mp3', media('02'));
    fixture.put('album/03 three.mp3', media('03'));
    fixture.put('app/pyproject.toml', '[project]\n');
    fixture.put('app/main.py', 'print("hi")\n');

    const before = snapshot(fixture.root);
    await scanFixture(fixture);
    expect(snapshot(fixture.root)).toEqual(before);
  });
});

/** (path, size, mtime) for every entry under a directory, recursively. */
function snapshot(dir: string): Record<string, string> {
  const rows: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        rows[full] = 'dir';
        walk(full);
        continue;
      }
      const stat = statSync(full);
      rows[full] = `${stat.size}:${stat.mtimeMs}`;
    }
  };
  walk(dir);
  return rows;
}