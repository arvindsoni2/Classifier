/**
 * Task 1b: filesystem-aware volume handling (plan Task 1, second session).
 *
 * Everything here is driven by an injected probe or by checked-in `findmnt`
 * output, so the whole file runs on a machine with no external drive attached.
 * The cases come straight from the situation this feature exists for: an
 * external drive that is unplugged, reformatted, or replaced.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatStats } from '../../src/catalogue/cli.js';
import { computeHashes } from '../../src/catalogue/dedupe.js';
import { reportSummary, writeReport } from '../../src/catalogue/report.js';
import { defaultVolumeProbe, findmntAvailable, identityModeFor, parseFindmnt } from '../../src/catalogue/volume.js';
import {
  FINDMNT_EXFAT,
  FINDMNT_EXT4,
  FINDMNT_MISSING,
  FINDMNT_NTFS3,
  FINDMNT_VFAT,
  FINDMNT_WITH_WARNING,
} from '../fixtures/findmnt-samples.js';
import { makeFixture } from './fixtures.js';
import {
  emptyMountPoint,
  itemsOf,
  rootRow,
  scanWorld,
  volumeErrors,
  world,
  LAPTOP_FS,
} from './volume-world.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('volume handling (Phase 1 Task 1b)', () => {
  describe('the findmnt probe', () => {
    it('parses what findmnt actually prints', () => {
      expect(parseFindmnt(FINDMNT_EXT4)).toEqual({
        uuid: 'b7113a2d-1b38-4845-9977-93a633912265',
        label: 'fedora',
        fstype: 'btrfs',
        mountPoint: '/home',
      });
      // exFAT has no uuid. That is the case that stops identity being the uuid.
      expect(parseFindmnt(FINDMNT_EXFAT)).toEqual({
        uuid: null,
        label: 'MYDRIVE',
        fstype: 'exfat',
        mountPoint: '/run/media/asoni/MYDRIVE',
      });
      expect(parseFindmnt(FINDMNT_NTFS3)).toMatchObject({
        uuid: '3A2B1C0D-4E5F-6071-8293-A4B5C6D7E8F9',
        label: null,
        fstype: 'ntfs3',
      });
      expect(parseFindmnt(FINDMNT_VFAT)).toEqual({
        uuid: null,
        label: null,
        fstype: 'vfat',
        mountPoint: '/run/media/asoni/USBSTICK',
      });
      // A warning line before the JSON must not stop it being parsed.
      expect(parseFindmnt(FINDMNT_WITH_WARNING)).toMatchObject({
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      });
    });

    it('treats output it cannot read as no volume at all', () => {
      expect(parseFindmnt(FINDMNT_MISSING)).toBeNull();
      expect(parseFindmnt('')).toBeNull();
      expect(parseFindmnt('not json at all')).toBeNull();
      expect(parseFindmnt('{"filesystems": [ {"fstype": "ext4"} ]}')).toBeNull();
      expect(parseFindmnt('{"filesystems": [ {"fstype": "ext4", "target": ""} ]}')).toBeNull();
    });

    it('maps a filesystem to an identity mode', () => {
      for (const fs of ['ext4', 'xfs', 'btrfs', 'f2fs', 'ext3', 'ext2']) {
        expect(identityModeFor(fs), fs).toBe('inode');
      }
      for (const fs of ['vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'tmpfs', 'zfs', '']) {
        expect(identityModeFor(fs), fs).toBe('path');
      }
    });

    it('resolves a real path, or reports it missing', async (context) => {
      if (!(await findmntAvailable())) {
        // A visible reason, not a silent pass: the parse cases above still ran.
        console.warn('skipping the live findmnt call: findmnt is not on PATH');
        context.skip();
        return;
      }
      const fx = makeFixture('probe-live');
      const found = await defaultVolumeProbe(fx.root);
      expect(found).not.toBeNull();
      expect(found?.fstype).not.toBe('');
      expect(typeof found?.mountPoint).toBe('string');
      // A path that does not exist has no filesystem.
      expect(await defaultVolumeProbe(join(fx.parent, 'no-such-path-at-all'))).toBeNull();
    });
  });

  describe('offline roots', () => {
    it('leaves everything an unplugged drive holds untouched', async () => {
      const w = world('volume-offline', { uuid: 'drive-uuid-1', label: 'MYDRIVE', fstype: 'exfat' }, cleanups);

      const first = await scanWorld(w);
      await computeHashes(w.store, first.scanId);
      const before = itemsOf(w.store, w.drive);
      expect(before).toHaveLength(2);
      expect(before.every((row) => row.status === 'present')).toBe(true);
      expect(first.rootsOnline).toBe(2);

      // Unplugged. The automount directory is still there and now empty.
      emptyMountPoint(w);
      w.driveIs(null);
      const second = await scanWorld(w);

      expect(second.rootsOffline).toBe(1);
      expect(second.rootsOnline).toBe(1);
      // Nothing the drive held was retired, and its hashes are still there.
      expect(itemsOf(w.store, w.drive)).toEqual(before);
      expect(rootRow(w.store, w.drive).status).toBe('offline');
      // The volume facts are kept, so a different drive at this path is still
      // recognised as a different volume next time.
      expect(rootRow(w.store, w.drive).volume_uuid).toBe('drive-uuid-1');
      // The laptop's own files are unaffected.
      expect(itemsOf(w.store, w.root).every((item) => item.status === 'present')).toBe(true);
    });

    it('an unmounted mount point is offline even though the directory exists', async () => {
      const w = world('volume-unmounted-mount', {
        uuid: 'drive-uuid-2',
        label: 'MYDRIVE',
        fstype: 'exfat',
      }, cleanups);
      await scanWorld(w);
      expect(itemsOf(w.store, w.drive)).toHaveLength(2);
      expect(rootRow(w.store, w.drive).is_mount_point).toBe(1);

      // The drive is unplugged. What is left at that path is an empty directory
      // on the laptop disk, so the probe now reports the laptop's filesystem —
      // the path exists, and it is very much not the drive any more.
      emptyMountPoint(w);
      w.driveIs({ ...LAPTOP_FS, mountPoint: w.root });
      const result = await scanWorld(w);

      expect(result.rootsOffline).toBe(1);
      expect(rootRow(w.store, w.drive).status).toBe('offline');
      // Its files are still recorded as present: a drive that was unplugged did
      // not delete them, and nothing under it was walked.
      expect(itemsOf(w.store, w.drive).every((item) => item.status === 'present')).toBe(true);
    });

    it('an offline root is recorded per scan, so a report can say what was skipped', async () => {
      const w = world('volume-offline-record', { uuid: 'drive-uuid-3', label: null, fstype: 'vfat' }, cleanups);
      await scanWorld(w);

      w.driveIs(null);
      const result = await scanWorld(w);
      const rows = w.store.db
        .prepare('SELECT path, status, fstype FROM scan_roots WHERE scan_id = ? ORDER BY path')
        .all(result.scanId) as { path: string; status: string; fstype: string | null }[];

      expect(rows).toEqual([
        { path: w.drive, status: 'offline', fstype: null },
        { path: w.root, status: 'online', fstype: 'btrfs' },
      ]);
    });
  });

  describe('a volume that changed', () => {
    it('retires the old items and says so', async () => {
      const w = world('volume-changed', { uuid: 'old-uuid', label: 'MYDRIVE', fstype: 'exfat' }, cleanups);
      await scanWorld(w);
      const rootId = (w.store.db.prepare('SELECT id FROM roots WHERE path = ?').get(w.drive) as { id: number }).id;
      w.store.db.prepare('UPDATE items SET sha256 = ?, partial_hash = ? WHERE root_id = ?').run(
        'hash-of-the-old-volume',
        'partial-of-the-old-volume',
        rootId,
      );

      // The drive is reformatted, or a different drive is plugged into the same
      // port. Same path, different volume, different contents.
      emptyMountPoint(w);
      w.fixture.put('drive/other-film.mp4', 'a different film entirely\n');
      w.driveIs({ uuid: 'new-uuid', label: 'FORMATTED', fstype: 'ext4' });
      const result = await scanWorld(w);

      const after = itemsOf(w.store, w.drive);
      // The old rows are retired rather than deleted, with their hashes cleared:
      // none of those bytes can be trusted to be at that path any more.
      const retired = after.filter((row) => row.rel_path !== 'other-film.mp4');
      expect(retired.map((row) => row.rel_path)).toEqual(['movie.mp4', 'notes.txt']);
      expect(retired.every((row) => row.status === 'missing')).toBe(true);
      expect(retired.every((row) => row.sha256 === null)).toBe(true);
      // The new volume's files are catalogued.
      expect(after.find((row) => row.rel_path === 'other-film.mp4')?.status).toBe('present');

      // And the change is on the record, once, for the root.
      const errors = volumeErrors(w.store, result.scanId);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.rel_path).toBe(w.drive);
      expect(errors[0]?.message).toMatch(/old-uuid/);
      expect(errors[0]?.message).toMatch(/new-uuid/);

      const row = rootRow(w.store, w.drive);
      expect(row.status).toBe('online');
      expect(row.volume_uuid).toBe('new-uuid');
      expect(row.volume_label).toBe('FORMATTED');
      expect(row.fstype).toBe('ext4');
      expect(row.identity_mode).toBe('inode');
      expect(result.rootsOnline).toBe(2);
    });

    it('an unchanged volume is not retired, even with a different uuid when both are null', async () => {
      const w = world('volume-unchanged', { uuid: null, label: 'STICK', fstype: 'vfat' }, cleanups);
      await scanWorld(w);

      // vfat has no uuid. The same filesystem type means the same volume, and a
      // renamed label is not a new one: this must be an ordinary incremental
      // scan, with nothing retired.
      w.driveIs({ uuid: null, label: 'STICK-RENAMED', fstype: 'vfat' });
      const result = await scanWorld(w);

      expect(itemsOf(w.store, w.drive).every((row) => row.status === 'present')).toBe(true);
      expect(volumeErrors(w.store, result.scanId)).toEqual([]);
    });

    it('the same filesystem type with a real uuid change is still a new volume', async () => {
      const w = world('volume-uuid-change', { uuid: 'first', label: null, fstype: 'exfat' }, cleanups);
      const first = await scanWorld(w);
      await computeHashes(w.store, first.scanId);

      emptyMountPoint(w);
      w.fixture.put('drive/replacement.mp4', 'a different drive at the same path\n');
      w.driveIs({ uuid: 'second', label: null, fstype: 'exfat' });
      const result = await scanWorld(w);

      expect(volumeErrors(w.store, result.scanId)).toHaveLength(1);
      expect(itemsOf(w.store, w.drive).filter((row) => row.status === 'present').map((row) => row.rel_path)).toEqual([
        'replacement.mp4',
      ]);
    });

    it('a root catalogued before volumes existed is scanned, not retired', async () => {
      // The migration case: roots have no fstype, so there is no volume identity
      // to compare. Retiring them here would mark a whole machine's catalogue
      // missing after a schema change.
      const w = world('volume-legacy-root', { uuid: 'drive-uuid-9', label: null, fstype: 'exfat' }, cleanups);
      const first = await scanWorld(w);
      await computeHashes(w.store, first.scanId);

      // Wipe the volume facts, exactly as the ALTER TABLE migration leaves them.
      w.store.db.prepare('UPDATE roots SET fstype = NULL, volume_uuid = NULL, identity_mode = NULL').run();
      const result = await scanWorld(w);

      expect(volumeErrors(w.store, result.scanId)).toEqual([]);
      expect(itemsOf(w.store, w.drive).every((row) => row.status === 'present')).toBe(true);
      expect(first.scanId).toBeLessThan(result.scanId);
    });
  });

  describe('an offline root in the report and stats', () => {
    it('keeps its last known count and says it was not scanned this run', async () => {
      // The plan's acceptance step 6: "confirm stats shows it offline with its
      // item count unchanged". Without this, an unplugged drive silently drops
      // out of the totals and reads as a drive that lost everything.
      const w = world('report-unplugged-drive', { uuid: 'drive-uuid-r', label: 'MYDRIVE', fstype: 'exfat' }, cleanups);
      const first = await scanWorld(w);
      const driveBefore = reportSummary(w.store, first.scanId).roots.find((root) => root.path === w.drive);
      expect(driveBefore?.status).toBe('online');
      expect(driveBefore?.fstype).toBe('exfat');
      const driveFiles = driveBefore?.files ?? -1;
      expect(driveFiles).toBeGreaterThan(0);

      // Unplugged: this scan records the drive offline and touches none of its
      // items, so they keep an older last_seen_scan.
      emptyMountPoint(w);
      w.driveIs(null);
      const second = await scanWorld(w);

      const summary = reportSummary(w.store, second.scanId);
      expect(summary.roots.map((root) => root.path).sort()).toEqual([...w.roots].sort());

      const drive = summary.roots.find((root) => root.path === w.drive);
      expect(drive?.status).toBe('offline');
      expect(drive?.files).toBe(driveFiles);
      // The drive is away, but which drive it was is still known and worth saying.
      expect(drive?.fstype).toBe('exfat');

      const laptop = summary.roots.find((root) => root.path === w.root);
      expect(laptop?.status).toBe('online');
      expect(laptop?.fstype).toBe('btrfs');

      // All three surfaces say so: the Markdown table, summary.json, and stats.
      const report = writeReport(w.store, second.scanId, join(w.fixture.parent, 'data'));
      const markdown = readFileSync(join(report.dir, 'summary.md'), 'utf8');
      expect(markdown).toMatch(/offline, not scanned this run/);
      expect(markdown).toMatch(/exfat/);
      expect(JSON.parse(readFileSync(join(report.dir, 'summary.json'), 'utf8'))).toMatchObject({
        roots: expect.arrayContaining([
          expect.objectContaining({ path: w.drive, status: 'offline', fstype: 'exfat', files: driveFiles }),
        ]),
      });
      expect(formatStats(summary)).toMatch(/offline/);
      // The status is on the drive's own line, not merely somewhere in the output
      // (the fixture's own directory name once satisfied a bare /offline/ match).
      expect(formatStats(summary)).toContain(
        `${w.drive} (offline, not scanned this run, exfat): ${driveFiles} files`,
      );
    });
  });

});
