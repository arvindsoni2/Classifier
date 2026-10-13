# Phase 1 plan: catalogue and dedupe

Version 1.0 · 2026-10-13 · Spec: `docs/10-Catalogue-First-Spec.md` §5 Phase 1 · Branch `pivot/catalogue-first`

Build a read-only catalogue of every configured root: files, directories, bundles, metadata and duplicate groups, with reports. No models, no network, no moves.

## How to work

- Do the tasks in order, **one task per session**. Each task is a few hundred lines at most.
- For each task: write the listed tests first, see them fail for the expected reason, implement, then run `pnpm typecheck && pnpm lint && pnpm test`. Commit with the message given.
- Tests use synthetic fixture trees built in a temporary directory. Never point a test at a real home directory.
- Do not modify files under `src/application`, `src/domain`, `src/http`, `ui` or `native`. The only permitted change to old code is Task 4's move of the ZIP reader into `src/shared/zip.ts`.
- New runtime dependencies allowed in this phase: `exifr` only. Pin it and record its version in `docs/runtime-manifest.json`. Everything else uses Node built-ins, `better-sqlite3` and the external tools `ffprobe` and `pdfinfo`.
- When a task is done, append a short entry to `docs/phase-1-log.md`: task, commit, test count, anything deferred.

## Task 1 — Config, store and scanner

**Files:** `src/catalogue/config.ts`, `src/catalogue/store.ts`, `src/catalogue/schema.sql`, `src/catalogue/scanner.ts`, `src/catalogue/kinds.ts`, `tests/catalogue/fixtures.ts`, `tests/catalogue/scanner.test.ts`, `config/catalogue.example.json`.

**Config** (`config/local/catalogue.json`, gitignored; path overridable with `CLASSIFIER_CONFIG`):

```json
{
  "roots": ["/home/asoni/Downloads", "/home/asoni/Documents"],
  "exclude": ["node_modules", "__pycache__", ".venv", "venv", ".tox", ".cache", ".Trash-*"],
  "dataDir": "~/.local/share/classifier"
}
```

`loadConfig()` validates: every root is an absolute, existing directory; no root is inside another root; `dataDir` is not inside any root. Invalid config is an error with a clear message, never a silent fallback.

**Schema** (`schema.sql`; WAL, foreign keys on, `synchronous=NORMAL`; database file mode 0600, data dir 0700):

```sql
roots(id INTEGER PK, path TEXT UNIQUE, dev TEXT, ino TEXT, added_at TEXT, last_scan_id INTEGER)
scans(id INTEGER PK, started_at TEXT, finished_at TEXT, status TEXT,   -- running|done|failed
      files_seen INTEGER, dirs_seen INTEGER, bytes_seen INTEGER, files_hashed INTEGER, errors INTEGER)
dirs(id INTEGER PK, root_id INTEGER, rel_path TEXT, dev TEXT, ino TEXT,
     file_count INTEGER, dir_count INTEGER, bundle_id INTEGER, last_seen_scan INTEGER,
     UNIQUE(root_id, rel_path))
items(id INTEGER PK, root_id INTEGER, rel_path TEXT, dir_id INTEGER, name TEXT, ext TEXT,
      kind TEXT, size INTEGER, mtime_ns TEXT, dev TEXT, ino TEXT, nlink INTEGER,
      partial_hash TEXT, sha256 TEXT, bundle_id INTEGER,
      status TEXT,                -- present|missing|incomplete
      first_seen_scan INTEGER, last_seen_scan INTEGER,
      UNIQUE(root_id, rel_path))
scan_errors(id INTEGER PK, scan_id INTEGER, root_id INTEGER, rel_path TEXT, code TEXT, message TEXT)
```

(`bundles` and `metadata` tables arrive in Tasks 3 and 4.) Integer stat values that can exceed 2^53 (`dev`, `ino`, `mtime_ns`) are stored as decimal strings, read with `bigint: true`.

**Scanner rules:**

1. Walk each root with `fs.opendir` and `lstat` (`bigint: true`). Iterative, not recursive, so deep trees cannot overflow the stack.
2. Never follow symlinks: record nothing for them except a count in the scan totals.
3. Never cross a mount: a directory whose `dev` differs from its root's is recorded in `scan_errors` with code `MOUNT_BOUNDARY` and not entered.
4. Skip sockets, FIFOs and devices.
5. Directory names matching `exclude` (simple name or `*` glob) are not entered. Hidden names (leading `.`) are not catalogued, except that a `.git` entry is noted on its parent for bundle detection in Task 3.
6. Names ending `.part`, `.crdownload`, `.download` or `.tmp` get `status = 'incomplete'`.
7. Permission and I/O errors go to `scan_errors`; the scan continues.
8. Insert in transactions of 1,000 rows. Memory must not grow with the number of files beyond one directory's listing.
9. Incremental: an item whose `(dev, ino, size, mtime_ns)` is unchanged keeps its hashes (and later its metadata). Items not seen in this scan become `status = 'missing'`; rows are never deleted.

**Kinds** (`kinds.ts`): extension map plus a magic-byte check on the first 16 bytes for files with no or a misleading extension (`%PDF`, `PK\x03\x04`, `\x89PNG`, `\xFF\xD8\xFF`, `ID3`, `fLaC`, `OggS`, `RIFF…WAVE`, `ftyp` at offset 4, `\x1A\x45\xDF\xA3`). Kinds: `document`, `ebook`, `audio`, `video`, `image`, `archive`, `installer`, `code`, `data`, `other`. Magic wins over extension when they disagree.

**Tests** (`scanner.test.ts`), each on a fresh fixture tree:

- `catalogues_nested_files_with_kinds`: files three levels deep are found with correct `rel_path`, `size`, `kind`.
- `does_not_follow_symlinks_or_enter_excluded_dirs`: a symlink to a directory outside the root and a `node_modules` dir yield no items.
- `records_errors_and_continues`: an unreadable directory (`chmod 000`, skipped when running as root) produces one `scan_errors` row and the rest is catalogued.
- `marks_incomplete_and_missing`: a `.crdownload` file is `incomplete`; a file deleted between two scans becomes `missing` and keeps its row.
- `kind_from_magic_bytes`: a PDF named `report.bin` is `document`.
- `scan_is_read_only`: snapshot `(path, size, mtime, sha256)` of every fixture file before and after the scan; they are identical, and no new file exists inside the fixture root.
- `config_rejects_nested_roots_and_data_dir_inside_root`.

**Commit:** `feat(catalogue): read-only recursive scanner and store`

## Task 2 — Duplicate detection

**Files:** `src/catalogue/hashing.ts`, `src/catalogue/dedupe.ts`, `tests/catalogue/dedupe.test.ts`.

**Rules:**

1. Candidates: `present` items with `size > 0` whose size is shared by at least one other present item, across all roots.
2. Partial hash: SHA-256 over `size || first 64 KiB || last 64 KiB` (whole file when ≤ 128 KiB). Computed only for candidates.
3. Full SHA-256: computed only where partial hashes collide. Streamed with a fixed buffer; never read a whole file into memory.
4. Hash from an opened file descriptor, and check `fstat` size and mtime before and after; if they changed, record `CHANGED_DURING_HASH` in `scan_errors` and leave `sha256` null.
5. Unchanged items (Task 1 rule 9) are not re-hashed.
6. `duplicateGroups()` returns groups of ≥ 2 present items with equal `sha256`, each with `wastedBytes = (n − 1) × size`, sorted by wasted bytes descending. Hard links (same `dev`+`ino`) count as one copy, not a duplicate.

**Tests:**

- `groups_identical_files_across_roots`: same content in two roots and a nested dir → one group of 3.
- `same_size_different_content_not_grouped`: partial hash separates them; no full hash computed (assert via a counter on the hashing function).
- `same_head_and_tail_different_middle`: partial hashes collide, full hashes separate them.
- `hard_links_are_not_duplicates`.
- `rescan_does_not_rehash_unchanged_files`: second scan's `files_hashed` is 0.

**Commit:** `feat(catalogue): size, partial and full hash duplicate groups`

## Task 3 — Bundle detection

**Files:** `src/catalogue/bundles.ts`, `tests/catalogue/bundles.test.ts`; add `bundles` to `schema.sql`:

```sql
bundles(id INTEGER PK, root_id INTEGER, rel_path TEXT, type TEXT, parent_bundle_id INTEGER,
        rule TEXT, member_count INTEGER, total_size INTEGER, detected_scan INTEGER,
        UNIQUE(root_id, rel_path))
```

**Rules** (deterministic; evaluated on each directory after the scan, from catalogue data):

| Type | Rule | Descend into it? |
| --- | --- | --- |
| `code_repo` | Directory contains a `.git` entry | No: record the bundle only |
| `code_project` | Contains `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`, `*.sln` or `CMakeLists.txt` | No |
| `course` | ≥ 3 video files directly inside, and ≥ 60% of them have a sequence marker: leading `\d{1,3}[ ._-]` or `(lesson\|lecture\|module\|part\|episode\|ep\|chapter\|week\|day)\s*\d+` (case-insensitive) | Yes |
| `course` (parent) | ≥ 2 immediate subdirectories are `course` bundles and ≥ 60% of subdirectory names have a sequence marker; the subdirectories become child bundles via `parent_bundle_id` | Yes |
| `album` | ≥ 3 audio files directly inside and ≥ 60% have a leading track number; upgraded in Task 4 to "≥ 80% share an album tag" | Yes |
| `photo_set` | ≥ 10 images directly inside and images are ≥ 70% of its files | Yes |
| `extracted_archive` | A sibling archive file has the directory's name as its stem (`foo/` beside `foo.zip`) | Yes |

`code_repo` and `code_project` are detected **during the scan**: add a hook to the scanner so that when a directory's listing contains `.git` or a project marker, the bundle row is created and the scanner does not descend further. Their contents are never catalogued as separate items, and their sizes stay null in Phase 1. The other types are evaluated after the scan from catalogue data; their members stay in `items` with `bundle_id` set. Precedence when several rules match: `code_repo` > `code_project` > `course` > `album` > `photo_set` > `extracted_archive`.

**Tests:** one fixture per rule (positive and a near-miss negative, e.g. 2 numbered videos is not a course); parent course with module subfolders; precedence (`.git` inside a course-like folder → `code_repo`); files inside a `code_repo` or `code_project` never appear in `items`, and a duplicate inside a repo is therefore not reported.

**Commit:** `feat(catalogue): deterministic bundle detection`

## Task 4 — Metadata extractors

**Files:** `src/catalogue/metadata/index.ts`, `.../ffprobe.ts`, `.../pdfinfo.ts`, `.../exif.ts`, `.../epub.ts`, `.../office.ts`, `src/shared/zip.ts` (moved from `src/adapters/extraction/extract.ts`, which then imports it), `tests/catalogue/metadata.test.ts`; add `metadata` to `schema.sql`:

```sql
metadata(item_id INTEGER, extractor TEXT, extractor_version TEXT,
         status TEXT,        -- ok|unavailable|failed|timeout
         fields_json TEXT, extracted_scan INTEGER, PRIMARY KEY(item_id, extractor))
```

**Interface:**

```ts
interface Extractor {
  name: string; version: string;
  appliesTo(kind: Kind, ext: string): boolean;
  available(): Promise<boolean>;           // tool on PATH / module loads
  extract(absPath: string, signal: AbortSignal): Promise<Record<string, unknown>>;
}
```

| Extractor | Kinds | Fields kept |
| --- | --- | --- |
| `ffprobe` (`ffprobe -v error -print_format json -show_format -show_streams <path>`) | audio, video | duration, container, codecs, width, height, tags: title, artist, album, album_artist, track, disc, date, genre |
| `pdfinfo` (`pdfinfo <path>`) | PDF | Title, Author, Subject, Keywords, Creator, Producer, CreationDate, Pages, Encrypted |
| `exif` (`exifr`) | image | DateTimeOriginal, Make, Model, width, height, `hasGps` (boolean only; coordinates are not stored) |
| `epub` (ZIP → `META-INF/container.xml` → OPF) | ebook (.epub) | title, creator, subject, language, publisher, date |
| `office` (ZIP → `docProps/core.xml`) | .docx, .xlsx, .pptx | title, creator, subject, keywords, created, modified |

Rules: argument arrays only, no shell; 10-second timeout per call; output capped at 1 MiB; two extractions at a time; a missing tool gives `unavailable` once per scan, not an error per file; unchanged items keep their metadata. ZIP reads keep the existing 20 MiB inflate budget. After this task, re-evaluate `album` with the album-tag rule.

**Tests:** fixtures generated in the test (a tiny PDF, a minimal EPUB and DOCX built as ZIPs, a JPEG with EXIF from a checked-in 1 KB file, a short WAV); tests that need `ffprobe` or `pdfinfo` are skipped with a visible reason when the tool is absent. Assert: fields extracted; GPS coordinates absent from `fields_json`; timeout produces `timeout`; malformed EPUB produces `failed` and the scan continues; old extraction tests still pass after the ZIP reader moves.

**Commit:** `feat(catalogue): metadata extractors`

## Task 5 — Reports and CLI

**Files:** `src/catalogue/report.ts`, `src/catalogue/cli.ts`, `tests/catalogue/report.test.ts`, `tests/catalogue/cli.test.ts`; `package.json` script `"catalogue": "node dist/catalogue/cli.js"` and build inclusion.

**CLI:**

```
pnpm catalogue scan   [--root <abs path> ...]    # default: roots from config
pnpm catalogue report [--scan <id>]               # default: latest finished scan
pnpm catalogue stats                              # one-screen totals
```

`scan` prints progress every 5 seconds (files, bytes, current root) and a final summary with elapsed time. Exit code non-zero only on config or database failure; per-file errors are counted, not fatal.

**Report** to `<dataDir>/reports/<scanId>-<yyyymmdd-hhmm>/`:

- `summary.md`: totals per root; counts and bytes per kind; bundles per type with the 10 largest of each; top 20 largest files; duplicate groups, total wasted bytes and the 30 largest groups; incomplete files; error counts by code; scan duration and files hashed.
- `duplicates.csv`: `group, sha256, size, wasted_bytes, root, rel_path, mtime, bundle_type`.
- `bundles.csv`: `type, root, rel_path, members, total_size, rule, parent`.
- `errors.csv` and `summary.json` (the same totals, machine-readable, for review).

**Tests:** report on a fixture catalogue contains the expected totals and groups; CSV escaping of names with commas, quotes, newlines and non-ASCII; CLI `scan` then `report` end to end on a fixture root via the built `dist` entry point; the report directory is created under `dataDir` and nothing is written inside the root.

**Commit:** `feat(catalogue): reports and CLI`

## Task 6 — Real-data acceptance (Arvind runs this)

1. `pnpm install && pnpm build`.
2. Create `config/local/catalogue.json` with the real roots.
3. Create a marker, then scan: `touch /tmp/before-scan && pnpm catalogue scan && pnpm catalogue report`.
4. Confirm nothing inside the roots changed: `find <each root> -newer /tmp/before-scan -not -path '*/.*'` lists only files other programs changed.
5. Run `pnpm catalogue scan` again and note `files_hashed` (should be near 0) and elapsed time.
6. Hand Claude Code: `summary.md`, `summary.json`, the first 50 lines of `duplicates.csv` and `bundles.csv`, both scan times, and the output of `pnpm test`.

Phase 1 is done when Claude Code's review finds the catalogue matches what is on disk and no blockers remain.
