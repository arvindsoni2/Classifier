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