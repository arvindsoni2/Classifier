/**
 * Phase 1 Task 3: the two bundle shapes that are not "a directory of media".
 *
 * `code_repo` and `code_project` are found while the walk runs and stop it, so
 * nothing inside them is ever catalogued as an item. `extracted_archive` is the
 * opposite: it is found after the walk and owns its whole subtree, including any
 * bundle nested inside it. Both were split out of `bundles.test.ts` because
 * together they are a third of that file, and because "the walk stops here" and
 * "this subtree is one unit" are different ideas.
 *
 * Everything runs on synthetic fixture trees (AGENTS.md rule 3).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { listBundles } from '../../src/catalogue/bundles.js';
import { computeHashes, duplicateGroups } from '../../src/catalogue/dedupe.js';
import { makeFixture } from './fixtures.js';
import { itemsUnder, media, scanFixture } from './bundle-world.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('bundle detection: walk-stopping types and archive subtrees (Phase 1 Task 3)', () => {
  it('a directory beside its own archive is an extracted_archive', async () => {
    const fixture = makeFixture('extracted');
    fixture.put('holiday-pics.zip', 'not a real zip, only the extension matters\n');
    fixture.put('holiday-pics/one.jpg', media('one'));
    fixture.put('holiday-pics/two.jpg', media('two'));
    // Same archive, differently named directory: a near miss.
    fixture.put('holiday-pics-copy/one.jpg', media('one'));
    fixture.put('holiday-pics-copy/two.jpg', media('two'));
    const { store } = await scanFixture(fixture, cleanups);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.relPath).toBe('holiday-pics');
    expect(found[0]?.type).toBe('extracted_archive');
    expect(found[0]?.rule).toBe('sibling archive holiday-pics.zip');
    expect(found[0]?.memberCount).toBe(2);
  });

  it('an extracted archive owns its whole subtree, not just its top level', async () => {
    const fixture = makeFixture('archive-subtree');
    // An archive's contents are rarely flat: the review found one with 23 files
    // across 14 directories, reported as 0 members.
    fixture.put('foo.zip', 'not a real zip, only the extension matters\n');
    fixture.put('foo/a/1.txt', 'one\n');
    fixture.put('foo/a/deeper/2.txt', 'two\n');
    fixture.put('foo/b/3.txt', 'three\n');
    const { store } = await scanFixture(fixture, cleanups);

    const archive = listBundles(store).find((bundle) => bundle.relPath === 'foo');
    expect(archive?.type).toBe('extracted_archive');
    expect(archive?.memberCount).toBe(3);
    expect(archive?.totalSize).toBe('one\n'.length + 'two\n'.length + 'three\n'.length);
    // Every loose file in the subtree is a member, at any depth.
    const underFoo = itemsUnder(store, 'foo');
    expect(underFoo).toHaveLength(3);
    for (const item of underFoo) expect(item.bundle_id).toBe(archive?.id);
  });

  it('a bundle inside an extracted archive becomes its child', async () => {
    const fixture = makeFixture('archive-nested-bundle');
    fixture.put('foo.zip', 'not a real zip, only the extension matters\n');
    fixture.put('foo/loose.txt', 'loose\n');
    // An album inside the archive keeps its own identity as a bundle...
    fixture.put('foo/album/01 one.mp3', 'first track bytes\n');
    fixture.put('foo/album/02 two.mp3', 'second track bytes\n');
    fixture.put('foo/album/03 three.mp3', 'third track bytes\n');
    const { store } = await scanFixture(fixture, cleanups);

    const byPath = new Map(listBundles(store).map((bundle) => [bundle.relPath, bundle]));
    const archive = byPath.get('foo');
    const album = byPath.get('foo/album');
    expect(archive?.type).toBe('extracted_archive');
    expect(album?.type).toBe('album');
    // ...but it belongs to the archive as its parent.
    expect(album?.parentBundleId).toBe(archive?.id);
    expect(archive?.parentBundleId).toBeNull();
    // The album's own files stay the album's; the archive counts the subtree.
    for (const item of itemsUnder(store, 'foo/album')) {
      expect(item.bundle_id).toBe(album?.id);
    }
    expect(archive?.memberCount).toBe(4);
    expect(itemsUnder(store, 'foo/loose.txt')[0]?.bundle_id).toBe(archive?.id);
  });

  it('an archive is not confused by a directory that merely looks like it', async () => {
    const fixture = makeFixture('archive-name-collision');
    fixture.put('foo.zip', 'not a real zip, only the extension matters\n');
    fixture.put('bar/1.txt', 'in another directory\n');
    fixture.put('bar/2.txt', 'and another\n');
    const { store } = await scanFixture(fixture, cleanups);

    expect(listBundles(store)).toEqual([]);
  });
  it('code_repo is recorded and never descended into', async () => {
    const fixture = makeFixture('code-repo');
    fixture.put('shared-dup.txt', 'the bytes that also live inside a repo\n');
    fixture.put('repo/.git/config', '[core]\n');
    fixture.put('repo/src/main.ts', 'export const main = 1;\n');
    fixture.put('repo/shared-dup.txt', 'the bytes that also live inside a repo\n');
    const { store, scanId } = await scanFixture(fixture, cleanups);

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
    const { store } = await scanFixture(fixture, cleanups);

    const found = listBundles(store);
    expect(found.map((bundle) => [bundle.relPath, bundle.type, bundle.rule])).toEqual([
      ['python-app', 'code_project', 'contains pyproject.toml'],
      ['vs-solution', 'code_project', 'contains App.sln'],
    ]);
    expect(itemsUnder(store, 'python-app')).toEqual([]);
    expect(itemsUnder(store, 'vs-solution')).toEqual([]);
  });
});
