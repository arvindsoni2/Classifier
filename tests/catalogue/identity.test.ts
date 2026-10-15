/**
 * Task 1b, second half: what counts as the same file on each kind of filesystem.
 *
 * Driven at the store, where the comparison lives, because no fixture can
 * renumber an inode or move a file's timestamp — the two things these rules turn
 * on (plan Task 1b, tests `path_mode_*` and `inode_mode_*`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { duplicateGroups } from '../../src/catalogue/dedupe.js';
import { itemsOf, reupsert, rootRow, scanWorld, world } from './volume-world.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('file identity per filesystem (Phase 1 Task 1b)', () => {
  describe('identity mode', () => {
    it('path mode ignores an inode that changed between scans', async () => {
      const w = world('path-mode-inode', { uuid: null, label: 'MYDRIVE', fstype: 'exfat' }, cleanups);
      const result = await scanWorld(w);
      const rootId = (w.store.db.prepare('SELECT id FROM roots WHERE path = ?').get(w.drive) as { id: number }).id;
      w.store.db.prepare('UPDATE items SET sha256 = ?, partial_hash = ? WHERE root_id = ?').run(
        'kept-by-path',
        'kept-partial',
        rootId,
      );
      expect(rootRow(w.store, w.drive).identity_mode).toBe('path');

      // A USB stick can hand out different inode numbers on every mount. Same
      // files, same sizes, same times, fresh inodes.
      reupsert(w, result.scanId, (row) => ({ ino: `999${row.rel_path.length}${row.size}` }));

      const after = itemsOf(w.store, w.drive);
      expect(after).toHaveLength(2);
      expect(after.every((row) => row.sha256 === 'kept-by-path')).toBe(true);
    });

    it('inode mode does care about an inode that changed', async () => {
      // The mirror of the case above, so the rule cannot be satisfied by ignoring
      // inodes everywhere: on btrfs a new inode is a different file.
      const w = world('inode-mode-inode', { uuid: 'ext4-uuid', label: null, fstype: 'btrfs' }, cleanups);
      const result = await scanWorld(w);
      const rootId = (w.store.db.prepare('SELECT id FROM roots WHERE path = ?').get(w.drive) as { id: number }).id;
      w.store.db.prepare('UPDATE items SET sha256 = ? WHERE root_id = ?').run('dropped-by-inode', rootId);

      reupsert(w, result.scanId, () => ({ ino: 'a-brand-new-inode' }));

      expect(itemsOf(w.store, w.drive).every((row) => row.sha256 === null)).toBe(true);
    });

    it('path mode tolerates a two-second mtime difference and not a three-second one', async () => {
      const w = world('path-mode-mtime', { uuid: null, label: 'STICK', fstype: 'vfat' }, cleanups);
      const result = await scanWorld(w);
      const rootId = (w.store.db.prepare('SELECT id FROM roots WHERE path = ?').get(w.drive) as { id: number }).id;
      w.store.db.prepare('UPDATE items SET sha256 = ?, mtime_ns = ? WHERE root_id = ?').run(
        'kept-by-mtime',
        // An exact even-second timestamp, so the two-second bucket is known.
        '4000000000',
        rootId,
      );

      // FAT stores times with two-second granularity, so a one-second drift is
      // the same file as far as the filesystem is concerned.
      reupsert(w, result.scanId, () => ({ mtimeNs: '5000000000' }));
      expect(itemsOf(w.store, w.drive).every((row) => row.sha256 === 'kept-by-mtime')).toBe(true);

      // Three seconds is a real change: the file was written to.
      reupsert(w, result.scanId, () => ({ mtimeNs: '7000000000' }));
      expect(itemsOf(w.store, w.drive).every((row) => row.sha256 === null)).toBe(true);
    });

    it('a file that changed size is not the same file, on either filesystem', async () => {
      // Same inode, same mtime, different size: a file that was replaced or
      // extended with its timestamps preserved — `cp -p`, or a restore. Size is
      // the only signal left, so it has to count on both kinds of filesystem.
      for (const fstype of ['btrfs', 'exfat']) {
        const w = world(`size-change-${fstype}`, { uuid: `uuid-${fstype}`, label: null, fstype }, cleanups);
        const result = await scanWorld(w);
        const rootId = (w.store.db.prepare('SELECT id FROM roots WHERE path = ?').get(w.drive) as { id: number }).id;
        w.store.db.prepare('UPDATE items SET sha256 = ? WHERE root_id = ?').run('stale-hash', rootId);

        reupsert(w, result.scanId, () => ({ size: 99_000 }));

        expect(itemsOf(w.store, w.drive).every((row) => row.sha256 === null), fstype).toBe(true);
      }
    });

    it('inode mode treats a renamed file as the same file', async () => {
      const w = world('inode-mode-rename', { uuid: 'ext4-uuid', label: null, fstype: 'btrfs' }, cleanups);
      const result = await scanWorld(w);
      const rootId = (w.store.db.prepare('SELECT id FROM roots WHERE path = ?').get(w.drive) as { id: number }).id;
      w.store.db.prepare('UPDATE items SET sha256 = ?, partial_hash = ? WHERE root_id = ?').run(
        'hash-before-rename',
        'partial-before-rename',
        rootId,
      );

      // The file is renamed. Its inode, size and mtime are what identify it.
      reupsert(w, result.scanId, (row) => ({ relPath: `renamed-${row.rel_path}` }));

      const after = itemsOf(w.store, w.drive).filter((row) => row.rel_path.startsWith('renamed-'));
      expect(after).toHaveLength(2);
      // Both new paths carry the hash the file already had: a rename is not a
      // new file, and a 40 GB film does not get re-hashed for a new name.
      expect(after.every((row) => row.sha256 === 'hash-before-rename')).toBe(true);
    });

    it('path mode does not carry a hash across a rename', async () => {
      // The mirror again: the carry-over is an inode-mode rule, not a free lunch.
      const w = world('path-mode-rename', { uuid: null, label: 'STICK', fstype: 'vfat' }, cleanups);
      const result = await scanWorld(w);
      const rootId = (w.store.db.prepare('SELECT id FROM roots WHERE path = ?').get(w.drive) as { id: number }).id;
      w.store.db.prepare('UPDATE items SET sha256 = ? WHERE root_id = ?').run('must-not-travel', rootId);

      reupsert(w, result.scanId, (row) => ({ relPath: `renamed-${row.rel_path}` }));

      const after = itemsOf(w.store, w.drive).filter((row) => row.rel_path.startsWith('renamed-'));
      expect(after).toHaveLength(2);
      expect(after.every((row) => row.sha256 === null)).toBe(true);
    });

    it('does not collapse distinct files that share an inode number', async () => {
      // exFAT and vfat hand out synthetic inode numbers, so two different files
      // can share one. Hard-link detection must not be attempted on those roots,
      // or a real duplicate group disappears from the report.
      const w = world('path-mode-duplicates', { uuid: null, label: 'MYDRIVE', fstype: 'exfat' }, cleanups);
      const result = await scanWorld(w);
      const rootId = (w.store.db.prepare('SELECT id FROM roots WHERE path = ?').get(w.drive) as { id: number }).id;
      // Two files with identical bytes (so the same size and digest), and the
      // same inode number, which on exFAT means nothing at all.
      w.store.db
        .prepare('UPDATE items SET sha256 = ?, ino = ?, size = 1000 WHERE root_id = ?')
        .run('shared-digest', '42', rootId);

      const groups = duplicateGroups(w.store, result.scanId);
      expect(groups).toHaveLength(1);
      expect(groups[0]?.copies).toBe(2);
      expect(groups[0]?.wastedBytes).toBeGreaterThan(0);
    });

    it('still collapses hard links on an inode-mode root', async () => {
      // Same inode, same bytes, two paths: one copy, not a duplicate. This is
      // why the rule above is about the filesystem and not about inodes alone.
      const w = world('inode-mode-duplicates', { uuid: 'ext4-uuid', label: null, fstype: 'btrfs' }, cleanups);
      const result = await scanWorld(w);
      const rootId = (w.store.db.prepare('SELECT id FROM roots WHERE path = ?').get(w.drive) as { id: number }).id;
      // The same bytes at two paths, sharing an inode: a hard link, on a
      // filesystem where that means something.
      w.store.db
        .prepare('UPDATE items SET sha256 = ?, ino = ?, size = 1000 WHERE root_id = ?')
        .run('one-copy', '42', rootId);

      expect(duplicateGroups(w.store, result.scanId)).toEqual([]);
    });
  });
});
