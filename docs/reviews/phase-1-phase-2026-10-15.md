# Review: Phase 1 (catalogue and dedupe), commits c6d362d..67db903

**Verdict: blocked.** The code does what the plan says, holds the invariants, and the second scan re-hashed
nothing. But on Arvind's real roots the catalogue is mostly not his files: 83% of items are Python virtualenv
internals. It also misses his largest course, and an extracted-archive bundle reports 0 members. Blockers 1 and 2
are gaps in the plan's rules rather than coding errors, so the fix text below amends the rule, and Arvind needs to
approve that amendment before it goes to OpenCode.

Evidence: `~/.local/share/classifier/reports/1-20261015-1002/` and read-only queries
(`sqlite3 -readonly`) against `catalogue.sqlite`. Nothing was run against the roots.

## Real-data result

| Check | Result |
| --- | --- |
| Totals | 23,323 files, 2,000 dirs, 84.7 GB, 0 scan errors. Plausible bytes; implausible item mix (blocker 1). |
| Duplicates | Top 50 CSV rows checked: all are real copies (same name or `(1)` / `_OceanofPDF` variants, same size, same SHA-256). 649 of the 1,185 groups sit entirely inside virtualenvs. |
| Bundles | 30 code bundles look right and nothing inside them was catalogued (0 items, 0 dirs under every one). 4 photo sets look right. Blockers 2 and 3 cover the course and extracted-archive bundles. |
| Rescan | Scan 2: `files_hashed = 0`, no new items, walk 2.9 s (scan 1 walk 5.8 s). Meets the plan. |
| Read-only | Code writes only to `dataDir` (`report.ts:125-131`, `store.ts:144-151`). Arvind's `find -newer` output (plan Task 6 step 4) was not in the hand-off. Please confirm it was empty. |

## Blockers

1. **Python virtualenvs are catalogued file by file.** `Assignment/pytorch_env/pytorch_env`,
   `Assignment/Demo_API/myenv` and `AI agent (Langchain)/Module 1/Environment_Setup/env1` hold 19,287 of the
   23,323 items (83%). That includes 7,010 torch headers in one directory and 649 of the 1,185 duplicate groups.
   They escape `exclude` because it matches `.venv`/`venv` by name. Without them the catalogue is 4,036 items
   and 536 duplicate groups. The plan clearly meant to skip virtualenvs. Name matching cannot catch renamed ones.
   *Repro:* fixture `envs/torch_env/pyvenv.cfg` + `envs/torch_env/lib/python3.12/site-packages/x.py`; today `x.py`
   is an item.
   *Fix (plan amendment):* a directory whose listing contains `pyvenv.cfg` is treated exactly like an excluded
   name: not entered, nothing recorded. Check in `scanner.ts` where the listing is read (`:137`); the root
   itself is exempt.

2. **The course rule misses the largest course on disk.** `Documents/Geekforgeeks GenAI course` has 20 videos
   (≈ 50 GB) named `Extra_1.mp4`, `Extra 2.mp4` … `Extra13.mp4`, `Extra 9#.mp4`. No name has a leading number or a
   keyword, so all 20 are loose items. Spec §1 and D21 name course videos as the core case.
   *Fix (plan amendment):* `bundle-rules.ts:32-36` also accepts a 1–3 digit number at the end of the stem, not
   preceded by a digit and followed by at most two non-digits: `(?<!\d)\d{1,3}\D{0,2}$` on the name without its
   extension. Checked against every video folder in Arvind's catalogue. It turns `Geekforgeeks GenAI course`
   into a course (20/20 marked) and creates no other new course (`Artificial Intelligence` 1/14, `Natoora/Photos`
   0/7). Four or more digits (`IMG_1234`, `VID_20240101_123456`, years) do not match, so camera folders stay out.
   *Test:* `Extra_1.mp4`, `Extra 2.mp4`, `Extra13.mp4` is a course; `VID_20240101_120000.mp4` ×3 is not.

3. **`extracted_archive` claims only files directly inside it.** `bundles.ts:232` attaches items by `dir_id`.
   `Documents/AWS SAA _C03/code_v2025-10-27` (beside its `.zip`) is reported with **0 members, 0 bytes**, while
   its 13 subdirectories hold 23 files that stay loose. `Natoora/15.773-spring-2024` reports 6 members, but its
   subtree holds 337 files. An archive's whole tree is one unit, and this reports it wrong.
   *Fix:* for `extracted_archive` only, members are all items in the subtree whose `bundle_id` is still null
   after pass 1. `member_count`/`total_size` count every item in the subtree. Bundles nested inside it get
   `parent_bundle_id` set to the archive.
   *Test:* `foo.zip` beside `foo/a/1.txt`, `foo/b/2.txt` gives `member_count = 2` and both items carry the bundle id.

## Should fix (next phase or a follow-up task)

1. **`Duration` in the report is the walk only.** `scanner.ts:313` finishes the scan before `cli.ts:184-186`
   hashes, detects bundles and extracts metadata, so "Duration: 5.8s" excludes 15,418 hashes. A crash during
   hashing would also leave a scan marked `done`. Record the whole pipeline's elapsed time and status.
2. **Metadata outcomes are invisible.** 87 extractions failed (pdfinfo 39, 20 of them password-protected; exif 38
   "Unknown file format"; epub 5, 4 over the 64 MiB read limit; office 5 with no `core.xml`). The summary still
   says "0 errors". All 87 were retried in scan 2 even though most are deterministic. Add per-extractor status
   counts to the summary. Record an encrypted PDF as `ok` with `Encrypted: yes`.
3. **Large EPUBs get no metadata.** `metadata/readfile.ts` reads the whole file. Reading the ZIP central
   directory by seeking would cover the 4 real EPUBs over 64 MiB.
4. **`Movier+Serials` is typed `course`.** It holds Ep1–Ep8 of a serial plus one movie. As a unit that is
   acceptable, but the label is wrong. Decide on a `series` type in Phase 2/3; there is no code change now.
5. **Python projects without a listed marker stay loose** (`hatch-main/backend`, `Assignment/jobpilot/backend`,
   `Assignment/genai-research-agent`, which have `requirements.txt` only). Do **not** add `requirements.txt` as a
   marker: `Geekforgeeks GenAI course` has one beside its videos and would vanish into a `code_project`.
   Leave this for Phase 3 review.
6. **Historical reports change.** Bundles are scoped by `detected_scan`, and scan 2 re-stamped all 39 bundles,
   so `report --scan 1` now shows 0 bundles.
7. **`src/shared/zip.ts:21` imports `../domain/contracts.js`**, which spec §8 forbids for new code. Move `Result`
   into `src/shared/`.
8. **Task 1 review items still open:** `readHead` swallows open errors (`scanner.ts:84-99`). Files are opened with
   plain `'r'` (`scanner.ts:87`, `dedupe.ts:93`, `metadata/readfile.ts:32`), so a file swapped for a FIFO blocks
   the scan; use `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`. Items under an errored directory are marked `missing`. Store
   errors are recorded as scan errors (`scanner.ts:233`). `MOUNT_BOUNDARY` is untested.
9. **`bundles.test.ts:155` and `:185`** call `every()` on `itemsUnder(...)` with no length check, so a scanner
   that dropped the files would still pass. Assert the length first.

## Checked and fine

- Invariants: there is one `spawn`, in `metadata/proc.ts:51`, with an argument array, no shell, a SIGKILL
  timeout, a 1 MiB stdout cap and a bounded stderr. No network code. Symlinks are not followed and mounts are not
  crossed (the latter untested; see should-fix 8). No model code.
- Plan fidelity: no changes under `src/application`, `src/domain`, `src/http`, `ui` or `native`. `exifr` 7.1.3
  is the only new dependency, pinned and recorded. Files outside each task's list are disclosed in the log and
  justified. All files are under 400 lines (largest: `store.ts` 345).
- Tests: the planned tests are all present. Hashing, bundle and metadata rules were mutation-checked per the
  log. The `ffprobe`/`pdfinfo` skips have a visible reason and did not skip here.
- `67db903` (CLI `--help` fix) is correct and tested.

## Checks run

- `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`: clean.
- `pnpm test`: 34 files, **286 passed**, 0 skipped, at `67db903`.
- Read-only `sqlite3 -readonly` queries on Arvind's `catalogue.sqlite` for the figures above, and the proposed
  course marker run in Node over the catalogued video names.
- Not run: any scan of the real roots (Arvind's). Arvind's own `pnpm test` output, the CLI "Elapsed" lines and
  the `find -newer` result were not in the reports folder. The scan times above come from the `scans` table.
