/**
 * Phase 1 Task 3: bundle detection for the shapes decided after the scan —
 * `course`, `album` and `photo_set` (plan docs/11-Phase-1-Plan.md Task 3).
 *
 * `code_repo` / `code_project` stop the walk rather than describing one, and
 * `extracted_archive` owns a subtree, so both live in
 * `bundles-archive.test.ts`. What is here is the rule set evaluated from
 * catalogue data after the walk, and its precedence.
 *
 * Every rule gets a positive fixture and a near-miss negative. Everything runs
 * on synthetic fixture trees (AGENTS.md rule 3), through `bundle-world.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { listBundles } from '../../src/catalogue/bundles.js';
import { makeFixture } from './fixtures.js';
import { itemsUnder, media, scanFixture } from './bundle-world.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('bundle detection (Phase 1 Task 3)', () => {
  it('numbered videos make a course and mark its members', async () => {
    const fixture = makeFixture('course-positive');
    fixture.put('ml-course/01 intro.mp4', media('01'));
    fixture.put('ml-course/02 regression.mp4', media('02'));
    fixture.put('ml-course/Lecture 7 recap.mp4', media('lecture'));
    fixture.put('ml-course/notes.txt', 'slides and links\n');
    const { store } = await scanFixture(fixture, cleanups);

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
    const { store } = await scanFixture(fixture, cleanups);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('course');
    expect(found[0]?.memberCount).toBe(3);
  });

  it('a trailing number can mark a course video', async () => {
    const fixture = makeFixture('course-trailing-number');
    // Arvind's largest course: 20 videos named `Extra 1.mp4` … `Extra13.mp4`,
    // none of which starts with a number or a keyword. ~50 GB left loose.
    fixture.put('genai course/Extra_1.mp4', 'video bytes\n');
    fixture.put('genai course/Extra 2.mp4', 'video bytes\n');
    fixture.put('genai course/Extra13.mp4', 'video bytes\n');
    fixture.put('genai course/Extra 9#.mp4', 'video bytes\n');
    const { store } = await scanFixture(fixture, cleanups);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('course');
    expect(found[0]?.relPath).toBe('genai course');
    expect(found[0]?.memberCount).toBe(4);
  });

it('camera and date-stamped names are not sequence markers', async () => {
    const fixture = makeFixture('course-trailing-number-negative');
    // Timestamps, in their own directory: digits, but a run preceded by a digit.
    fixture.put('clips/VID_20240101_120000.mp4', 'video bytes\n');
    fixture.put('clips/VID_20240101_130000.mp4', 'video bytes\n');
    fixture.put('clips/VID_20240102_090000.mp4', 'video bytes\n');
    // Four-digit counters, in their own directory: this is what pins the digit
    // ceiling at three. Were it four, all three would be marked and this folder
    // would become a course.
    fixture.put('camera/clip_1234.mp4', 'video bytes\n');
    fixture.put('camera/clip_2345.mp4', 'video bytes\n');
    fixture.put('camera/clip_3456.mp4', 'video bytes\n');
    const { store } = await scanFixture(fixture, cleanups);

    expect(listBundles(store)).toEqual([]);
  });

it('subdirectory names need a leading number or a keyword, not a trailing one', async () => {
    const fixture = makeFixture('course-parent-subdir-marker');
    // Two module courses, and two directories whose names end in a number. The
    // trailing-number form is for video *files*; letting it count here would
    // make this folder a course parent on the strength of four numbers.
    for (const module of ['session 1', 'session 2']) {
      fixture.put(`course/${module}/01 one.mp4`, 'video bytes\n');
      fixture.put(`course/${module}/02 two.mp4`, 'video bytes\n');
      fixture.put(`course/${module}/03 three.mp4`, 'video bytes\n');
    }
    fixture.put('course/notes 3/one.txt', 'text\n');
    fixture.put('course/notes 4/two.txt', 'text\n');
    const { store } = await scanFixture(fixture, cleanups);

    const found = listBundles(store);
    expect(found.map((bundle) => bundle.relPath).sort()).toEqual(['course/session 1', 'course/session 2']);
    expect(found.every((bundle) => bundle.type === 'course' && bundle.parentBundleId === null)).toBe(true);
  });

it('a trailing number does not change what an album needs', async () => {
    const fixture = makeFixture('album-trailing-number');
    // Albums are matched on a *leading* track number only. These carry trailing
    // numbers, which the course rule now accepts but this one must not.
    fixture.put('side one/opener 1.mp3', 'track bytes\n');
    fixture.put('side one/middle 2.mp3', 'track bytes\n');
    fixture.put('side one/closer 3.mp3', 'track bytes\n');
    const { store } = await scanFixture(fixture, cleanups);

    expect(listBundles(store)).toEqual([]);
  });

it('two numbered videos are not a course', async () => {
    const fixture = makeFixture('course-too-few');
    fixture.put('clips/01 highlight.mp4', media('01'));
    fixture.put('clips/02 blooper.mp4', media('02'));
    const { store } = await scanFixture(fixture, cleanups);

    expect(listBundles(store)).toEqual([]);
    // The length first: `every()` on an empty list is true, so without this a
    // scanner that dropped the files outright would pass.
    const loose = itemsUnder(store, 'clips');
    expect(loose).toHaveLength(2);
    expect(loose.every((item) => item.bundle_id === null)).toBe(true);
  });

  it('unnumbered videos are not a course', async () => {
    const fixture = makeFixture('course-unnumbered');
    fixture.put('vids/intro.mp4', media('intro'));
    fixture.put('vids/outro.mp4', media('outro'));
    fixture.put('vids/demo.mp4', media('demo'));
    fixture.put('vids/extra.mp4', media('extra'));
    const { store } = await scanFixture(fixture, cleanups);

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
    const { store } = await scanFixture(fixture, cleanups);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.relPath).toBe('great-album');
    expect(found[0]?.type).toBe('album');
    expect(found[0]?.rule).toBe('>=3 audio files, >=60% with a leading track number');
    expect(found[0]?.memberCount).toBe(3);
    // As above: the length is the assertion that makes the next one mean anything.
    const loose = itemsUnder(store, 'loose-tracks');
    expect(loose).toHaveLength(3);
    expect(loose.every((item) => item.bundle_id === null)).toBe(true);
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
    const { store } = await scanFixture(fixture, cleanups);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.relPath).toBe('holiday');
    expect(found[0]?.type).toBe('photo_set');
    expect(found[0]?.rule).toBe('>=10 images, images >=70% of its files');
    // 13 files, 10 of them images.
    expect(found[0]?.memberCount).toBe(13);
  });

  it('a course parent is not broken by an extracted archive beneath it', async () => {
    const fixture = makeFixture('archive-in-course');
    // An archive extracted into a course folder, beside two module courses.
    for (const module of ['01 foundations', '02 macros']) {
      fixture.put(`course/${module}/01 one.mp4`, 'video bytes\n');
      fixture.put(`course/${module}/02 two.mp4`, 'video bytes\n');
      fixture.put(`course/${module}/03 three.mp4`, 'video bytes\n');
    }
    fixture.put('course/slides.zip', 'not a real zip\n');
    fixture.put('course/slides/deck.txt', 'slide text\n');
    const { store } = await scanFixture(fixture, cleanups);

    const byPath = new Map(listBundles(store).map((bundle) => [bundle.relPath, bundle]));
    const archive = byPath.get('course/slides');
    expect(archive?.type).toBe('extracted_archive');
    // The archive is not a course, so the parent course still forms and adopts
    // only its two modules.
    expect(byPath.get('course')?.type).toBe('course');
    expect(byPath.get('course')?.parentBundleId).toBeNull();
    expect(byPath.get('course/01 foundations')?.parentBundleId).toBe(byPath.get('course')?.id);
    expect(byPath.get('course/02 macros')?.parentBundleId).toBe(byPath.get('course')?.id);
    expect(archive?.parentBundleId).toBeNull();
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
    const { store } = await scanFixture(fixture, cleanups);

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
    const { store } = await scanFixture(fixture, cleanups);

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
    const { store } = await scanFixture(fixture, cleanups);

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
    const { store } = await scanFixture(fixture, cleanups);

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
    const { store } = await scanFixture(fixture, cleanups);

    const found = listBundles(store);
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('album');
  });
});
