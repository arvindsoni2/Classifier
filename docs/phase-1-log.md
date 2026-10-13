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