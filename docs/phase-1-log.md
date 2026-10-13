# Phase 1 log: catalogue and dedupe

Branch `pivot/catalogue-first` · Spec `docs/10-Catalogue-First-Spec.md` · Plan `docs/11-Phase-1-Plan.md`

Entries are appended after each task: what was built, the commit, the test
count, and anything skipped or deferred with the reason (AGENTS.md rule 10).

---

## Task 1 — Config, store and scanner

**Commit:** `0b35f5f` — `feat(catalogue): read-only recursive scanner and store`

**Files:** `src/catalogue/config.ts`, `src/catalogue/schema.sql`,
`src/catalogue/store.ts`, `src/catalogue/kinds.ts`, `src/catalogue/scanner.ts`,
`tests/catalogue/fixtures.ts`, `tests/catalogue/scanner.test.ts`,
`config/catalogue.example.json`, plus `vitest.config.ts` (see below).

**Tests:** 7 new tests in `tests/catalogue/scanner.test.ts`. Full suite
**226 passed** (219 pre-existing + 7 new), all on synthetic fixture trees.
`pnpm typecheck`, `pnpm lint` and `pnpm test` all pass. Nothing was run against
a real home directory, Downloads folder or Drive account.

Tests were written first and observed failing before implementation. They were
also checked for non-vacuousness by deliberately breaking the symlink rule,
the missing-marking rule, the magic-byte rule and the dataDir validation;
each of those four tests failed as expected. (The read-only test passes under
those mutations, as it should: it asserts a property that no mutation of
those rules breaks.)

### Decisions and interpretations

1. **Magic vs extension, with one carve-out.** The plan says magic wins when it
   disagrees with the extension. Applied literally, every `.docx`, `.epub` and
   `.xlsx` would be catalogued as `archive`, because OOXML and EPUB files are
   ZIP containers. The carve-out keeps the extension-derived kind when the
   magic is `PK\x03\x04` **and** the extension is itself a ZIP-based format
   (`ZIP_BASED_EXTENSIONS` in `kinds.ts`), because there the magic agrees with
   the extension instead of contradicting it. Every other disagreement
   resolves to the magic.
2. **Hook for Task 3.** `scan()` accepts `hooks.onDirectory(relPath, names)`,
   which receives all entry names (including hidden ones, so `.git` is
   visible) and may return `false` to stop the walk descending. Task 3 needs
   this to stop at a `code_repo`/`code_project` boundary; without it the walk
   would have to be rewritten.
3. **`scans` table has no symlink column.** Rule 2 says symlinks are recorded
   "in the scan totals", but the plan's fixed `scans` schema has no column for
   them. `ScanResult.totals.symlinksSeen` carries the count and the tests assert
   it, so it is not lost in-process — but it is **not persisted**. If the report
   needs it, a column has to be added when the schema is next touched (Task 5).

### Changed outside the task's file list

`vitest.config.ts` — added `tests/catalogue/**/*.test.ts` to `include`. Without
this the new tests would never have been collected and `pnpm test` would have
reported a green run that did not include them.

### Deferred, with reasons

1. **`MOUNT_BOUNDARY` has no automated test.** Rule 3 is implemented (a
   directory whose device differs from its root's is written to `scan_errors`
   and not entered), but provoking it needs a real mount point or privileges to
   bind one, and the plan's test list does not ask for it. Untested at
   `0b35f5f`; the acceptance check on real roots is the first real exercise of
   it.
2. **`schema.sql` is not yet copied into `dist`.** `openStore` reads the
   schema next to the module via `import.meta.url`, which works from `src`
   (tests) but not from compiled output. The plan puts "build inclusion" in
   Task 5, so it is left there rather than done early; `pnpm catalogue scan`
   must not be wired up before Task 5.
3. **Hash preservation on unchanged items is implemented but unobservable
   yet.** `upsertItems` keeps hashes when `(dev, ino, size, mtime_ns)` match
   and clears them otherwise, but nothing writes hashes until Task 2, so no
   test can assert it in this task. It is covered by Task 2's
   `rescan_does_not_rehash_unchanged_files`.
4. **`records_errors_and_continues` self-skips as root.** The run this entry
   describes was uid 1000, so the `chmod 000` case really executed. On a root
   shell it logs a visible skip reason instead of asserting something untrue.

### Notes for the next session

- Memory is bounded by one directory's listing plus a 1000-row insert buffer;
  the pending-directory stack holds paths, which grows with breadth, as any
  walk must.
- `scan()` is the only entry point and takes `(config, store, hooks)`. No
  catalogue writes happen anywhere else.

---

## Task 2 — Duplicate detection

**Commit:** `d19ea18` — `feat(catalogue): size, partial and full hash duplicate
groups`

**Files:** `src/catalogue/hashing.ts`, `src/catalogue/dedupe.ts`,
`tests/catalogue/dedupe.test.ts`, plus `src/catalogue/store.ts` (three write
methods and one bug fix, see below) and `tests/catalogue/fixtures.ts`
(a `makeRoots` helper for multi-root fixtures).

**Tests:** 6 new tests in `tests/catalogue/dedupe.test.ts`. Full suite **232
passed** (226 after Task 1 + 6 new), all on synthetic fixture trees.
`pnpm typecheck`, `pnpm lint` and `pnpm test` all pass. Nothing was run against
a real home directory, Downloads folder or Drive account.

The plan lists five tests; all five are present, plus a sixth that snapshots
`(path, size, mtime)` for both roots before and after the hashing pass and
asserts nothing moved — the read-only property stated in the module contract,
which a policy test cannot cover.

Tests were written first and observed failing (module absent) before
implementation. Non-vacuousness was checked by three deliberate breaks, each
caught by exactly the test that owns the rule:

| Mutation | Test that failed |
| --- | --- |
| Full-hash every candidate, not only colliding partials | `same_size_different_content_not_grouped` |
| Count rows instead of distinct `dev:ino` in groups | `hard_links_are_not_duplicates` |
| Recompute partials even when one exists | `rescan_does_not_rehash_unchanged_files` |

### A defect in Task 1, found and fixed here

`rescan_does_not_rehash_unchanged_files` failed on first run: the second scan
recomputed hashes for files that had not changed. `selectItem` read
`mtime_ns` while the comparison used `existing.mtimeNs`, so the mtime test was
always `undefined === '<ns>'`, false — **every** rescan classified every
present file as changed and dropped its hashes via `dropHashes`. The Task 1
tests never noticed because nothing wrote a hash yet. Fixed by aliasing the
column to camelCase in the prepared statement, with a comment saying why.
This is the concrete cost of rule 9 being untestable in Task 1.

### Decisions and interpretations

1. **`files_hashed` counts files, not hash operations.** A candidate that gets
   a partial hash and then, in the same run, a full hash because its partial
   collided is one file. A `Set` of `rootId:relPath` keys for the current run
   keeps the count distinct. The set is bounded by the work the pass does, not
   by the catalogue's size.
2. **Hashes come from an opened descriptor, never a path.** `withCandidateOpen`
   opens read-only, hashes through that descriptor, and closes it before any
   row is written. A path swapped between the scan and the hash cannot be
   hashed by mistake (AGENTS.md rule 6's concern applied to reads).
3. **The size prefix in the partial hash is decimal text**, so files of
   different sizes can never produce an equal partial even if their windows
   coincide. Sizes are already filtered by the candidate query, so this is
   belt-and-braces rather than the primary filter.
4. **Candidate rows are materialised per stage** (`.all()`, not `.iterate()`).
   Writing catalogue rows while a better-sqlite3 iterator is open is unsafe,
   and the stage batch is bounded by the number of files that need hashing
   this run.
5. **`duplicateGroups` groups in SQL and fetches members per group**, so memory
   holds the group heads (plus one group's rows), not every hashed item. The
   returned array does hold every group and every member path — acceptable for
   a one-shot report, worth revisiting if it is ever called per-scan.
6. **Extra store methods.** `setItemPartialHash`, `setItemFullHash` and
   `setFilesHashed` were not in the task's file list. Dedupe needs to write
   hashes and the scan total, and the store already owns all catalogue writes;
   the policy module keeps its SQL read-only. The `items` table already had the
   hash columns from Task 1's schema, as did `scans.files_hashed`.

### Deferred, with reasons

1. **`CHANGED_DURING_HASH` has no automated test.** The check is implemented —
   `fstat` size and mtime before and after, both hash kinds, result discarded
   and an error row written. Proving it needs a writer racing the read at the
   right moment, which no deterministic fixture can arrange without a
   cooperating test double. The `Hasher` interface is the seam for such a test;
   it is the natural place to add one if a real occurrence shows up.
2. **Open failures during hashing are recorded, not tested.** A file that
   becomes unreadable between scan and hash lands in `scan_errors` with the
   `errno` code and the pass continues. Same reason as above: the scanner's
   own permission test already covers the read path.
3. **`duplicateGroups` does not exclude `nlink > 1` members from a group's
   item list.** Hard links collapse to one copy for the *threshold* and
   `wastedBytes`, but every catalogued path is still listed. This is deliberate
   — a report wants to show all the names — and is not what the plan asked
   either way. Revisit if the report shows it as confusing.

### Notes for the next session

- `computeHashes(store, scanId, { hasher })` returns a `HashRunSummary`
  (`candidates`, `partialHashed`, `fullHashed`, `filesHashed`,
  `changedDuringHash`, `openErrors`). Task 3 bundles and the Task 5 report can
  surface it without re-querying.
- Nothing clears `partial_hash`/`sha256` except `upsertItems` on change, so
  both passes are naturally idempotent across rescans.
- `hashing.ts` exports `PARTIAL_WINDOW_BYTES`; the 128 KiB threshold is
  `2 * PARTIAL_WINDOW_BYTES` and is computed, not retyped.

---

## Task 3 — Bundle detection

**Commit:** `74a6588` — `feat(catalogue): deterministic bundle detection`

**Files:** `src/catalogue/bundle-rules.ts`, `src/catalogue/bundles.ts`,
`tests/catalogue/bundles.test.ts`, plus `src/catalogue/schema.sql` (the
`bundles` table), `src/catalogue/store.ts` (four bundle methods, the
`BundleType`/`BundleRow` types) and `src/catalogue/scanner.ts` (hook signature,
boundary handling, `bundlesSeen`).

**Tests:** 17 new tests in `tests/catalogue/bundles.test.ts`. Full suite **249
passed** (232 after Task 2 + 17 new), all on synthetic fixture trees.
`pnpm typecheck`, `pnpm lint` and `pnpm test` all pass. Nothing was run against
a real home directory, Downloads folder or Drive account.

Tests were written first and observed failing (module absent) before
implementation. Non-vacuousness was checked with thirteen deliberate breaks.
Three survived the first pass and each one changed something:

| Mutation | Result |
| --- | --- |
| `.git` no longer forces `code_repo` | caught: `code_repo is recorded and never descended into` |
| Project markers never detected | caught: `code_project is recorded and never descended into` |
| Hook records but never stops the walk | caught: all three code tests |
| Hook records no scan id | caught: code tests and the rescan test |
| Root guard removed from the hook | caught: `the root directory itself is never a bundle` |
| Root eligible in the post-scan pass | caught: same test |
| Course↔album precedence swapped | **survived** → added `course outranks album when both rules match` |
| Parents adopt any bundle child | **survived** → added an album subdirectory to the parent fixture |
| Course minimum 3 → 1 | caught: `two numbered videos are not a course` |
| Course 60% rule dropped | caught: `unnumbered videos are not a course` |
| Course keyword markers ignored | **survived** → added `keyword markers alone can carry a course` |
| Photo-set minimum 10 → 1 | caught: `photo sets need ten images…` and the extracted-archive test |
| Sibling-archive name comparison broken | caught: `a directory beside its own archive…` |

The three survivors were gaps in the fixtures, not in the rules: precedence was
only ever exercised between album and photo_set, the course parent's children
were all courses, and nothing separated the keyword branch of the marker from
the leading-number branch.

### Defect found and fixed here

The scanner's `onDirectory` hook was wired in Task 1 but never exercised. Its
original signature could not work for Task 3: it received `relPath` and names
but no `rootId` and no `scanId`, and the hook's `false` return skipped the
`dirs` row as well as the descent. Changed to a `ScanDirectoryContext` object
and the boundary now records the directory, then stops. `ScanHooks` has one
consumer, so there was no other call site to update.

### Decisions and interpretations

1. **Split into `bundle-rules.ts` and `bundles.ts`.** The first draft of
   `bundles.ts` was 464 lines, over the ~400 line ceiling in AGENTS.md rule 9.
   The rules are pure functions of names and counts; the orchestration reads the
   catalogue and writes rows. Splitting on that seam makes the rules testable
   without a database and keeps both files small.
2. **The configured root is never a bundle.** The plan does not say so, but a
   bundle is a unit *inside* a root; bundling the root would make the entire
   root one item and hide every file in it from the report. Both passes skip
   `rel_path = ''` and the hook returns nothing there. Pinned by a test that puts
   a `.git` and three numbered videos directly in the root.
3. **`code_repo`/`code_project` precedence needs no code.** My first draft read
   the boundary bundle rows and skipped them. That check was dead: the walk
   stopped there, so those directories have no catalogued files and no
   catalogued children, and neither pass can match on exactly those. The
   precedence is structural. The dead check and its query are removed, and the
   module says why.
4. **Integer percentages.** `count * 100 >= total * percent` rather than
   `count / total >= 0.6`. 3 of 5 and 6 of 10 both land exactly on the boundary,
   and the plan states the rule as "≥60%". Float division would make the outcome
   depend on which side of the representable gap the ratio fell.
5. **`extracted_archive` reads the parent's archives.** The archive sits *beside*
   the directory, not inside it, so `DirFacts` carries `siblingArchives`. The
   first draft looked for it among the directory's own files and never fired —
   caught by the extracted-archive test.
6. **A course parent's counts aggregate its modules, not its own files.** The
   plan gives no rule text for the count. Folding a parent's loose files into a
   total that also includes its modules would double-count them; the modules'
   totals already cover the subtree.
7. **Only course bundles are adopted.** The plan says "the subdirectories become
   child bundles", read as applying to the subdirectories that are courses — the
   clause's subject. Any subdirectory name, numbered or not, counts towards the
   ≥60% naming ratio. The parent test pins both halves with a numbered album
   beside two numbered modules.
8. **A directory keeps one bundle row** (`UNIQUE(root_id, rel_path)`), and
   precedence resolves to a single type. When the shape changes on a rescan the
   row is updated in place, so bundle ids stay stable.
9. **`code_bundle` marker choice is sorted.** Directory listing order is the
   filesystem's, so the first matching marker would make `rule` text vary
   between scans. Matching markers are sorted before one is chosen.
10. **Items are attached by `dir_id`, not by path prefix.** A prefix would let a
    bundle claim items of a nested directory that has its own bundle; matching
    the directory makes double membership impossible.

### Changed outside the task's file list

`src/catalogue/scanner.ts` — the hook signature and boundary handling, as above.
The plan explicitly says to "add a hook to the scanner so that when a
directory's listing contains `.git` or a project marker, the bundle row is
created and the scanner does not descend further", so this is the sanctioned
change, but it is a Task 1 file.

### Deferred, with reasons

1. **No bundle rows are ever removed or marked stale.** If a directory stops
   matching — the `pyproject.toml` is deleted, a course loses its numbering —
   its old row keeps its previous `detected_scan` and stays in `bundles`. The
   post-scan pass has no way to know: a code bundle's contents are deliberately
   not catalogued, so it cannot re-check them, and the plan's schema has no
   status column. A rescan therefore updates rows that still match and leaves
   the rest. Deciding what a stale bundle means for a report belongs with the
   report (Task 5); it should not be guessed at here.
2. **`ScanTotals.bundlesSeen` is not persisted**, like `symlinksSeen` in Task 1:
   the plan's `scans` table has no column for it. It counts boundaries found
   during the walk, not bundles detected afterwards.
3. **`bundles_seen` on the scan row and `bundles` in the report** are Task 5's
   problem; `listBundles()` exists so it does not have to write SQL.
4. **Detection holds one scan's directories and members in memory.** A
   single-root pass is the size of the catalogue's directory list; unlike the
   scanner, this pass is allowed to see everything at once because it reads the
   database, not the filesystem. If a root ever holds millions of rows this
   becomes the first thing to stream.

### Notes for the next session

- `scan(config, store, { onDirectory: bundleScanHook(store) })` then
  `detectBundles(store, scanId)` is the whole sequence. Nothing is automatic
  yet: Task 5's CLI will have to call both, and `detectBundles` will run after
  `computeHashes` so a bundle's duplicate suppression is visible in the report.
- `bundleScanHook` must be given a `store`, not a database handle, so bundle
  writes go through the store like every other catalogue write.
- The rules module exports its thresholds as named constants, so a later
  revision (Task 4 upgrades `album` to "≥80% share an album tag") is a one-line
  change plus the metadata extractor.