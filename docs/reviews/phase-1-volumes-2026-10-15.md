# Review: Phase 1 blocker fixes and Task 1a/1b (volumes), commits 67db903..7535e89

**Verdict: blocked** on one item. The three earlier blockers are fixed correctly, and the volume handling added by
spec change `fa2d906` (D31) is sound and well tested. But the plan's new acceptance step cannot be carried out:
Task 6 step 6 asks Arvind to "confirm `stats` shows it offline with its item count unchanged", and neither
`stats` nor the report mentions an offline root at all.

No new real-data run exists yet. The live `catalogue.sqlite` still has the pre-volume `roots` shape and its latest
scan predates these fixes. So this review is of the code, the tests and a read-only check against the old
catalogue. The real-data verdict comes after Arvind's next run, which must include the external drive.

## Earlier blockers: fixed

| Blocker | Commit | Check |
| --- | --- | --- |
| Virtualenvs catalogued | `f97a2d2` | A directory containing `pyvenv.cfg` is skipped like an excluded name; the root is exempt. Test plus mutation. |
| Course marker | `0806757` | The trailing-number rule is applied to the stem, not the full name. Without that, the `4` in `.mp4` would mark every video, and a test pins this. Subdirectory naming is left as it was, which is a sensible call. |
| Archive subtree | `da9284c` | Counts cover the whole subtree. Unclaimed items are adopted, nested bundles get a parent, and a nested album keeps its own files. |

## Blockers

1. **An offline drive vanishes from `stats` and the report.** `report.ts:79-82` selects items with
   `last_seen_scan = @scanId`, and `report.ts:142-148` builds the per-root list from those rows. An offline
   root's items keep their older `last_seen_scan`, so the root is missing from `roots` altogether. Totals drop by
   the drive's contents and nothing says why. `scan_roots` already holds the per-scan status
   (`store.ts:216`), but nothing reads it. The log defers this as "Task 5's files", yet the amended plan requires
   it: "`scans` also records, per root, whether it was online and its `fstype`, so a report can say which drives
   were included", and acceptance step 6 depends on it.
   *Repro:* in `volume.test.ts`'s offline world, run a second scan with the drive unplugged, then
   `reportSummary(store, second.scanId).roots`. It lists only the laptop root.
   *Smallest fix:* build `summary.roots` from `scan_roots` for the scan. Give each root `status`, `fstype`, and
   files/bytes. For an offline root, take the files/bytes from its `present` items, whatever their
   `last_seen_scan`, and label them "not scanned this run". Print the status and fstype in `summary.md`,
   `summary.json` and `stats`. Leave every other figure scoped to the scan as it is now.

## Should fix

1. **The subtree SQL uses an unescaped `LIKE`** (`store.ts` `subtreeItemStats`, `setItemsBundleInSubtree`,
   `setBundlesParentInSubtree`). In `LIKE`, `_` matches any character and ASCII matching ignores case, so an
   archive `files/` would also claim the items of a sibling `Files/`. Arvind's current catalogue has no such
   collision (checked read-only). Use `substr(rel_path, 1, length(@relPath) + 1) = @relPath || '/'`.
2. **The 2-second mtime rule uses buckets, not distance** (`identity.ts:224-236`). Times of 5 s and 6 s are 1 s
   apart but fall in different buckets, so the file counts as changed. The test passes only because it uses 4 s
   and 5 s. The cost is a needless re-hash, which is safe. Compare `|a − b| < 2 s` and add a straddling case.
3. **A probe failure is reported as "offline"** (`volume.ts:123-124`). If `findmnt` is missing, times out or
   prints something unparsable, the root is skipped with the message "the path is not present". That is safe,
   since nothing is changed, but it is silent and wrong. Return a distinct outcome and record a `PROBE_FAILED`
   scan error.
4. **Windows system folders on NTFS or exFAT drives.** `System Volume Information` (usually unreadable, so it
   produces an `EACCES` error every scan) and `$RECYCLE.BIN` (deleted files catalogued as items). Add both to
   `config/catalogue.example.json`'s `exclude`, and Arvind to his local config.
5. **Phase log commit hashes are stale.** The blocker entry lists `24214b6`, `a3d5376` and `810a6ff`; the commits
   in history are `f97a2d2`, `da9284c` and `0806757`. The Task 1b entry has no hash. AGENTS.md rule 10 requires
   accurate hashes.
6. **Plan line 13 still lists only `ffprobe` and `pdfinfo` as external tools.** `findmnt` is named in the
   Volumes section; add it to that line too.
7. **Test files are over 400 lines** (`bundles.test.ts` 553, `scanner.test.ts` 527; disclosed in the log).
   Split them when they are next touched.
8. **Open from the previous review:** should-fix items 1–9 of `phase-1-phase-2026-10-15.md`, untouched as
   agreed. Two of them will show up on the next real run: the 87 metadata failures under "0 errors", and
   historical reports losing their bundles.

## Checked and fine

- **D31 semantics:** an offline root changes no item and keeps its volume facts. An unmounted mount point is
  offline even though its directory still exists. A volume change retires items once, with one
  `VOLUME_CHANGED` row. `dev` is never compared across scans. Inode mode carries hashes across a rename; path
  mode does not. A root with no recorded `fstype` (the migration case) is scanned, never retired, which
  protects Arvind's existing catalogue on its first volume-aware scan.
- **Dedupe on path-mode roots** counts copies by path. Without that, synthetic inode numbers on exFAT would hide
  every duplicate on the drive. There are tests for both modes.
- **Migration:** additive `ALTER TABLE`, one column at a time. The log reports it was tested on a copy of the
  live database. I did not repeat that.
- **Invariants:** `findmnt` is spawned with an argument array, no shell, a 5 s SIGKILL and an output cap
  (`volume.ts:92-111`). No writes inside roots, no network. Old modules, `package.json` and the lockfile are
  untouched.
- **Splits** (`store-types.ts`, `store-extras.ts`, `list-directory.ts`, `migrate.ts`, `identity.ts`) are one
  concern each and disclosed. All source files are under 400 lines (largest: `scanner.ts` 395).
- **Tests** can fail. The offline test compares the drive's rows before and after with `toEqual`, and length is
  asserted before `every()`. The live `findmnt` call skips with a visible reason.

## Checks run

- `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test`: 36 files, **322 passed**, at `7535e89`.
- Read-only `sqlite3 -readonly` on the live catalogue: no case or wildcard collisions under the archive bundles;
  the schema has not been migrated yet.
- Not run: any scan of real roots or the external drive (Arvind's: plan Task 6 steps 1–7).
