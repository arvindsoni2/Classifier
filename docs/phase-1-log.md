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

---

## Task 4 — Metadata extractors

**Commit:** `45c1e8f` — `feat(catalogue): metadata extractors`

**Files:** `src/catalogue/metadata/{index,types,proc,readfile,ffprobe,pdfinfo,exif,epub,office}.ts`,
`src/shared/zip.ts`, `src/shared/xml.ts`, `tests/catalogue/metadata.test.ts`,
`tests/fixtures/images/exif-photo.jpg`, `tests/fixtures/media.ts`, plus
`src/catalogue/schema.sql` (the `metadata` table), `src/catalogue/store.ts`
(`upsertMetadata`, and metadata deletion on change), `src/adapters/extraction/extract.ts`
(the ZIP reader and entity decoder moved out), `tests/fixtures/documents.ts`
(additive fixture builders), `package.json`, `pnpm-lock.yaml` and
`docs/runtime-manifest.json`.

**Tests:** 15 new tests in `tests/catalogue/metadata.test.ts`. Full suite **264
passed** (249 after Task 3 + 15 new), including the pre-existing extraction
integration tests, which pass unchanged after the ZIP reader moves.
`pnpm typecheck`, `pnpm lint` and `pnpm test` all pass.

Fixtures are byte-built in the test: a PDF with an information dictionary, a
WAV with RIFF INFO tags, an EPUB and a DOCX as ZIPs. The one checked-in binary
is a 1124-byte JPEG carrying real EXIF — camera fields, `DateTimeOriginal`,
pixel dimensions and a real GPS position — because hand-building an APP1
segment would have tested my encoder rather than the extractor. It was
generated once with Pillow and is not regenerated by any test.

`ffprobe` 8.1.3 and `pdfinfo` 26.01.0 are present on this machine, so those two
tests ran for real. Both skip with a visible reason when the tool is absent, as
the plan requires.

Tests were written first and observed failing (module absent). Non-vacuousness
was checked with twelve deliberate breaks. Three survived the first pass:

| Mutation | Result |
| --- | --- |
| exif stores every parsed field (GPS leak) | caught: `exif keeps GPS out of the catalogue` |
| Availability probed per item, not once | caught: `a missing tool is unavailable once…` |
| Settled rows re-extracted anyway | caught: `unchanged items keep their metadata…` |
| Changed item keeps stale metadata | caught: same test |
| Concurrency limit raised to 64 | caught: `extraction runs two at a time` |
| No deadline race around the extraction | **survived** → added `an extractor that ignores its signal…` |
| stdout cap not enforced | caught: `a bounded child tool cannot flood the catalogue` |
| Child never killed at deadline | caught: `a child tool that overruns its deadline is killed` |
| EPUB assumes a fixed OPF path | caught: `epub reads the package document named by the container` |
| Inflate budget lifted | **survived** → budget hoisted to one constant |
| Office stops covering `.docx` | caught after the mutation was fixed (see below) |
| Absolute path not rebuilt for the tool | caught: all five extractor tests |

The two real survivors changed the code, not the tests:

- **No deadline race.** The hung-extractor test's extractor *honoured* the
  abort signal, so removing the race still produced a timeout. The guarantee
  that matters is for an extractor that ignores its signal entirely; a second
  test now covers exactly that, and it fails without the race.
- **The inflate budget was copied into `epub.ts` and `office.ts`.** Lifting the
  copy in `epub.ts` was invisible, because the zip-bomb fixture is a DOCX. The
  budget is now `ZIP_INFLATE_BUDGET_BYTES` in `src/shared/zip.ts`, next to the
  check that enforces it, and lifting it fails.

One mutation was a no-op of mine — a replacement string with the wrong
indentation, so the code never changed and the test correctly stayed green. It
was re-run properly and caught.

### Decisions and interpretations

1. **A file with no EXIF is `ok` with no fields, not `failed`.** Most images
   have no EXIF block at all. Recording those as failures would put a `failed`
   row on most of a photo library and make the status meaningless. A file that
   cannot be parsed at all still fails.
2. **Fields are copied from a named allowlist, never spread.** `exif` copies
   `Make`, `Model`, `DateTimeOriginal`, width and height by name and derives
   `hasGps` without reading the coordinates out. The test asserts the exact key
   set, so adding a field without intending to fails the test.
3. **Changed items lose their metadata during the scan**, in
   `CatalogueStore.upsertItems`, next to the hash invalidation it already does.
   That is the one place that knows an item changed, and it is what makes "has a
   row" and "is current" the same thing. Without it the runner would have to
   re-derive currency from stat values it does not store.
4. **`failed` and `timeout` are retried on the next scan; `ok` and
   `unavailable` are not.** A transient tool failure should not be permanent,
   and a missing tool will still be missing on the next run.
5. **`fields_json` holds `{error}` for failures.** The schema has no error
   column, and a failure without a reason is hard to act on. Messages are
   truncated to 500 characters.
6. **The plan's interface takes a path; the reads still come from a
   descriptor.** `readFileBounded` opens the file, refuses anything above
   64 MiB, reads it in 1 MiB chunks and re-checks size and mtime afterwards, so
   the same discipline the hashing pass uses applies to `exif`, `epub` and
   `office`. A file that changes mid-read is refused rather than half-parsed.
7. **`pdfinfo` applies to `.pdf` only, not to every `document`.** The `document`
   kind also covers txt, md, rtf and doc, none of which pdfinfo can read.
8. **ffprobe's project marker choice and tag set are fixed lists.** Only the
   eight tags the plan names are kept, with stream-level tags filling gaps the
   container left.
9. **EPUB metadata is reached through `META-INF/container.xml`**, never a
   conventional path. A fixture with the OPF at `EPUB/pkg.opf` pins this; the
   first draft's assumption would have failed it.
10. **`ffprobe` and `pdfinfo` are invoked by name from `PATH`**, not through
    `prlimit` as the extraction worker does. The worker's runner pipes the file
    in on stdin, which a probing tool has no use for, and the catalogue has no
    memory-ceiling requirement in the plan. The duplication is ~40 lines of
    spawn-and-bound code with a different shape; the trade-off is recorded here
    because it is a DRY-versus-cohesion call (AGENTS.md rule 12).
11. **An image smaller than the read limit but with no EXIF returns `{}`**, which
    is stored as an `ok` row with no fields.

### Changed outside the task's file list

- `src/adapters/extraction/extract.ts` — the task says the ZIP reader moves here
  and "which then imports it", so this is sanctioned. `findZipEntry`,
  `readZipEntryData` and the entity decoder left for `src/shared/`. The only
  behavioural difference is error text: messages that said `malformed DOCX` now
  say `malformed ZIP`. The adapter's integration tests assert on status and on
  `/uncompressed|budget/i`, not on those strings, and pass unchanged.
- `src/shared/xml.ts` is a new file the task does not list. `epub` and `office`
  both need to read one element's text; sharing the decoder with the adapter
  avoids a second copy of code that validates XML code points.
- `tests/fixtures/documents.ts` — three additive builders (`makePdfWithInfo`,
  `makeEpub`, `makeDocxWithCoreProperties`) and an optional `opfPath`. Nothing
  existing was changed; `makePdf` and `makeDocx` behave identically.
- `package.json` / `pnpm-lock.yaml` / `docs/runtime-manifest.json` — exifr
  7.1.3, pinned exact and recorded, as AGENTS.md rule 8 requires. It is the only
  dependency Phase 1 adds.

### Deferred, with reasons

1. **The 64 MiB in-memory read limit has no automated test.** Proving it needs a
   fixture larger than the limit itself. The zip-bomb test covers the same class
   of defence — a file whose declared expansion exceeds its budget is refused —
   at 21 MiB.
2. **`ffprobe` on a file it cannot read, and `pdfinfo` on a malformed PDF, are
   untested.** Both paths end in `failed` with the tool's own message, which the
   malformed-EPUB test already demonstrates for in-process extractors.
3. **`extractMetadata` is never called by anything yet.** As with Task 3, the
   sequence is `scan` → `computeHashes` → `detectBundles` → `extractMetadata`,
   and wiring it together belongs to Task 5's CLI.
4. **The `album` upgrade the plan mentions after this task ("re-evaluate `album`
   with the album-tag rule") is not done.** It needs tags on real files to
   calibrate, and Task 4's deliverable is the extractors. The rule in
   `bundle-rules.ts` is one predicate against data that now exists.
5. **No test runs with `ffprobe` or `pdfinfo` deliberately absent.** The skip path
   is real code and the missing-tool branch is covered with an injected
   extractor, but hiding a real binary from `PATH` to see it end to end was not
   done.

### Notes for the next session

- `extractMetadata(store, scanId)` returns `{candidates, extracted, ok, failed,
  timeouts, unavailable, unchanged}` for the report, and `metadataRows(store)`
  reads rows back with the item's path already joined.
- `defaultExtractors()` is the registry; `Extractor` is injectable, which is how
  the timeout, concurrency and unavailable tests run without real tools.
- `MAX_EXTRACTOR_INPUT_BYTES` (64 MiB), `ZIP_INFLATE_BUDGET_BYTES` (20 MiB) and
  `EXTRACTION_TIMEOUT_MS` (10 s) / `EXTRACTION_CONCURRENCY` (2) are the plan's
  bounds, each in one place.
- The checked-in JPEG is the only binary fixture in the catalogue tests; if it is
  ever regenerated it must keep its GPS tags, because the test asserts they do
  not appear in the catalogue.

---

## Task 5 — Reports and CLI

**Commit:** `f07e5bf` — `feat(catalogue): reports and CLI`

**Files:** `src/catalogue/report.ts`, `src/catalogue/report-format.ts`,
`src/catalogue/report-summary.ts`, `src/catalogue/cli.ts`,
`tests/catalogue/report.test.ts`, `tests/catalogue/cli.test.ts`, plus
`src/catalogue/dedupe.ts` (optional scan scoping),
`scripts/copy-assets.js` (schema.sql into dist) and `package.json` (the
`catalogue` script).

**Tests:** 20 new tests (11 report, 9 CLI). Full suite **284 passed** (264
after Task 4 + 20 new). `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass.

The CLI tests run `node dist/catalogue/cli.js` as a child process and build
`dist` in `beforeAll` (`tsc -p tsconfig.build.json` then `copy-assets.js`, about
five seconds). That is deliberate: the plan asks for the built entry point, and
it is the only thing that proves `schema.sql` reaches `dist` — without it the
compiled store cannot open a database at all. No UI build is needed for it.

Tests were written first and observed failing. Non-vacuousness was checked with
ten deliberate breaks:

| Mutation | Result |
| --- | --- |
| Largest-files cap removed | caught: `keeps only the largest files the plan asks for` |
| Report directory loses its timestamp | caught: 4 tests |
| CSV quoting disabled | caught: the bundles and escaping tests |
| Report not scoped to one scan | caught: `reports only what that one scan saw` |
| Bundles not scoped to the scan | caught: same test |
| `--root` skips validation | caught: `an invalid --root is refused like an invalid configured root` |

Four mutations appeared to survive at first, and all four turned out to be my own
no-ops: a Python replacement written through two layers of shell escaping that
did not match the source, so the code never changed and the tests correctly
stayed green. They were re-run with the application printed and verified, and
each then failed the test that owns the rule. Two of them did expose a genuine
gap, now closed by the new tests: every earlier fixture reported a single scan,
so nothing could tell a scoped report from an unscoped one.

### Decisions and interpretations

1. **Three modules, not one.** `report.ts` reads the catalogue and knows what the
   rows mean, `report-format.ts` renders them with no I/O at all, and
   `report-summary.ts` holds the shape both need. The first draft of `report.ts`
   was 472 lines, over the ~400 ceiling in AGENTS.md rule 9, and the seam between
   "what this row means" and "how to print it" is the natural one.
2. **Every figure is scoped to the reported scan.** Items by `last_seen_scan`,
   bundles by `detected_scan`, errors by `scan_id`, duplicates through a new
   optional `scanId` on `duplicateGroups`. A report mixing in a stale row would
   disagree with the filesystem at the moment it was read, which is the one thing
   Arvind checks.
3. **`stats` writes nothing.** It prints what a report would contain, through
   `reportSummary`, without calling `writeReport`. An earlier draft had `stats`
   write a report directory as a side effect of printing totals.
4. **`scan` runs the whole pipeline**, not just the walk: hash, bundles, then
   metadata. The plan's CLI has only three verbs, so the pipeline has to live
   inside `scan`, and the figures it prints are then the ones the report holds.
5. **Progress is read from the catalogue, not threaded through the scanner.**
   Every five seconds the CLI asks for the running scan's item count, byte total
   and most recent directory. That avoided changing the scanner's contract for a
   cosmetic feature, and it is honest: those are rows the walk has really written.
6. **Exit codes 0, 1, 2.** The plan only requires non-zero for a configuration or
   database failure. A bad command line is separated as 2 so a script can tell
   "your arguments are wrong" from "your configuration is wrong". A per-file
   error is a count and never an exit code.
7. **`--root` is re-validated, not trusted.** It goes back through
   `validateConfig` with the configured `dataDir`, so the rule that the data
   directory may never sit inside a root still applies to a flag. Pinned by a test
   passing a missing path, a relative path and a file.
8. **CSV quoting is minimal and correct.** A field is quoted only when it
   contains a comma, a quote or a line break; quotes inside are doubled.
   Non-ASCII is written as UTF-8, not escaped, and nothing is truncated — a name
   is data. The test round-trips names containing a comma, quotes, a newline, and
   Chinese and Japanese characters.
9. **The report timestamp is UTC.** The scan id already makes the directory
   unique; UTC means a report generated on two machines is comparable, which is
   what makes review diffs meaningful.
10. **`errors.csv` is one row per error**, not per code. The plan does not fix its
    columns; the counts by code are in both summary forms, and the CSV is more
    useful with the paths.

### Changed outside the task's file list

- `src/catalogue/dedupe.ts` — `duplicateGroups` takes an optional scan id. The
  report needs scan-scoped groups, and duplicating that SQL in `report.ts` would
  have been worse than one optional parameter on the function that owns the query.
- `scripts/copy-assets.js` and `package.json` — the plan's "build inclusion". The
  Task 1 entry flagged that `schema.sql` was not yet copied into `dist` and that
  `pnpm catalogue scan` must not be wired before this task; this is that task.

### Deferred, with reasons

1. **The five-second progress cadence is not observed firing.** A fixture scan
   finishes in milliseconds. What a progress line must contain is tested
   directly through `formatProgressLine`; the interval itself is not, and the
   first real scan is the first thing to exercise it.
2. **A large report holds its groups in memory.** `duplicateGroups` materialises
   every group for the requested scan and the summary keeps the largest 30. Fine
   for a Downloads-folder catalogue, which is what Phase 1 targets; worth
   revisiting if a root holds millions of items.
3. **No report section carries metadata figures.** The plan does not ask for them,
   and Task 6 hands `summary.md` and `summary.json` to review — where per-extractor
   counts would be the obvious next question. Recorded rather than added.
4. **A report of a failed scan still reports it.** `latestFinishedScan` includes
   `failed` scans, and `--scan <id>` reports whatever rows exist. A failed scan
   still saw files; hiding them would make the report disagree with the disk.
5. **The CLI tests rebuild `dist` every run** (~5s). Caching on a source timestamp
   would be faster but would let a stale `dist` produce a confusing failure, and
   the honest cost seemed better for a suite that runs before a review.

### Notes for the next session

- `pnpm build` then `pnpm catalogue scan` is the acceptance path in Task 6. The
  build must include `copy-assets.js` or the store cannot find its schema.
- `reportSummary(store, scanId)` and `writeReport(store, scanId, dataDir)` are the
  two entry points; `listBundles`, `duplicateGroups` and `metadataRows` cover the
  rest if a future report needs finer slices.
- Exit codes are 0/1/2 as above; a review script can rely on 1 meaning
  "configuration or database" and nothing else.
- The scan summary line is stable enough to grep:
  `Scan <id> of <n> root(s) finished.`

---

## Review follow-up — Task 1 symlink test

**Commit:** `ee91600` — `test(catalogue): make the symlink test follow a real
outside directory`

A Task 1 review blocker, fixed on its own. The `escape` symlink pointed at a
directory that was never created, so it was dangling: a scanner that followed it
would have found nothing to catalog and the test would still have passed. The
reviewer's point stands — the test could not detect the behaviour it names.

The fix creates `outside/` with a `secret.txt` in it before linking, and asserts
that no catalogued `rel_path` starts with `escape/` and that `secret.txt` appears
nowhere in the catalogue. The existing file-symlink assertions and
`symlinksSeen === 2` are unchanged.

Proven by mutation: `listDirectory` was temporarily changed to treat a symlink to
a directory as a directory, and the test then failed on `escape/secret.txt` with
the `symlinksSeen` assertion still passing — so the new assertion, not the older
one, is what detects it. A first mutation attempt also catalogued file symlinks
and tripped the older assertion first; it was narrowed so the failure pointed at
the directory case specifically. The mutation was reverted and is not in the
commit.

**Tests:** 284 pass, unchanged in number. `pnpm typecheck`, `pnpm lint` and
`pnpm test` all pass. Only `tests/catalogue/scanner.test.ts` was touched.

The review's "should fix" items were left alone as instructed, and no other task
was started.