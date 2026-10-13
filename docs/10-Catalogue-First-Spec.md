# Catalogue-first organiser: specification

Version 2.0 · 2026-10-13 · Branch `pivot/catalogue-first`

This document replaces the scope and classification design of docs 01–08. Those documents remain the reference for **filesystem move safety** (PRD FR-07 to FR-10 and FR-13, LLD §5–§7), which applies unchanged when Phase 5 moves real files. Where the two disagree on anything else, this document wins.

## 1. Problem

Files of every kind (ebooks, music, videos, course videos, documents, PDFs) are scattered across folders, and folders themselves contain unrelated files. The same problem exists in Chrome bookmarks, X bookmarks and Google Drive. The goal is one local tool that understands all of it, proposes an organisation, and applies it only after approval, using local inference only.

The previous pilot (docs 01–08) organised only loose files at depth zero of `~/Downloads`. Its first real run refused all 72 candidates because 499 existing folders could not fit its 7-children-per-node taxonomy. No real file has been classified yet.

## 2. Decisions

| ID | Decision | Reason |
| --- | --- | --- |
| D20 | **Index first, move last.** Catalogue, understand and search everything before any item moves. | Search and a duplicates report are useful on their own and need no write access. |
| D21 | Scan configured roots **recursively**. Detect **bundles** (git repos, course folders, albums, photo sets, extracted archives) and treat each as one item. | The problem is files scattered inside folders. A course or an album must move whole. |
| D22 | One catalogue and one taxonomy across all sources (files, bookmarks, Drive). | "AWS learning" is one category whether it is a PDF, a bookmark or a Drive doc. |
| D23 | Every model sees only an **evidence card**: a short normalised text record per item. | Fair, replayable comparisons; raw files never reach a model. |
| D24 | **Retrieval before decision.** Embed every card; shortlist candidate folders by similarity; only then ask a decision model. The taxonomy has no width or depth limit. | Hand-walking a tree fails with hundreds of folders. |
| D25 | **Laya is retired** from the decision path. The 7-child, 4-level, 12-token and 1,200-character limits are removed when Phase 4 replaces the taxonomy code. | Laya scores 3.2 macro-F1 on CLINC150 and 14.3 on BANKING77 in Cloudflare's Decision Index. Its token budgets were the sole source of those limits. |
| D26 | **Generative naming is allowed** for proposed folders (names and descriptions). The user approves every name. | Naming clusters is what the generative models are good at. |
| D27 | Runtimes: **Unsloth Studio API** for Spark, MiniCPM, embeddings and Whisper; **llama-server** for Clef's `/v1/systemone`. Ollama is not used. | Reuses GGUF files already on disk; Ollama serves Clef as chat and loses per-option probabilities. |
| D28 | Evaluation labels come from **trusted existing folders**: files already sorted are free labelled examples. | Measurement can start without hand-labelling 200 items. |
| D29 | Review is **by group** ("these 43 files → Learning/AWS"), not row by row. | Review time is the product's main cost. |
| D30 | OpenCode implements; **Claude Code reviews**. Every phase ends with a **real-data acceptance check** run by Arvind. | The old process produced guards but never exercised the core job. |

## 3. Architecture

```
Sources ──► 1 Catalogue ──► 2 Evidence card ──► 3 Embed ──► 4 Place ──► 5 Review by group ──► 6 Act per source
(files,      recursive scan,   metadata, text,     vectors in    rules → kNN vote →   approve groups       files: Rust helper move
 Chrome,     bundles,          MiniCPM-V caption,  SQLite        top-k → Clef choice                       Drive: change parents
 X, Drive)   dedupe            Whisper transcript,                     │                                   Chrome: import new folder
                               Spark summary                           └─► far from every folder:          X: local collection
                                                                            cluster → model names →
                                                                            taxonomy review
Corrections made in review become exemplars for the kNN vote (no retraining).
```

Every stage is a separate module with a typed interface, persisted in the catalogue database. A later stage can be re-run without repeating earlier ones.

## 4. Storage

One SQLite database, `catalogue.sqlite`, in the data directory (default `~/.local/share/classifier/`, mode 0700, never inside a scanned root). It is separate from the old `organiser.sqlite`.

Phase 1 tables (Phase 1 plan gives exact columns):

| Table | Holds |
| --- | --- |
| `roots` | Each configured root: path, device, inode, last scan |
| `scans` | One row per scan run: start, end, counts, status |
| `dirs` | Every directory visited: root, relative path, device/inode, child counts, bundle |
| `items` | Every regular file: root, relative path, device/inode, size, mtime, kind, extension, partial and full hash, bundle, status, first/last seen |
| `bundles` | Detected units: type, root, relative path, parent bundle, member count, total size, detection rule |
| `metadata` | Per item and extractor: extractor name and version, status, JSON fields |
| `scan_errors` | Path, error code, message, scan |

Later phases add: `evidence_cards`, `embeddings` (via `sqlite-vec`), `categories` (taxonomy tree with revisions), `exemplars`, `placements`, `groups`, `approvals`, `actions` and per-source item tables for bookmarks and Drive.

## 5. Phases

Each phase has a goal, a real-data acceptance check and an explicit out-of-scope list. A phase is done only when its acceptance check has run on Arvind's machine and Claude Code has reviewed the result.

### Phase 1 — Catalogue and dedupe (read-only, no models)

- **Goal:** one catalogue of every configured root, with bundles, metadata and duplicate groups.
- **Scope:** recursive read-only scan; bundle detection; deterministic kind detection; metadata extractors (ffprobe, pdfinfo, EXIF, EPUB OPF, Office core properties); size → partial hash → full SHA-256 duplicate grouping; incremental rescans; Markdown/CSV/JSON reports; CLI.
- **Acceptance:** Arvind runs `pnpm catalogue scan` and `pnpm catalogue report` on his real roots. Nothing inside the roots changes. The summary and duplicates report match what he knows is on disk. A second scan re-hashes nothing that did not change.
- **Out of scope:** models, network, moves, deletion, UI.
- **Plan:** `docs/11-Phase-1-Plan.md`.

### Phase 2 — Evidence cards, embeddings and search

- **Goal:** every item has an evidence card and a vector; search works across all roots.
- **Scope:** card builder per kind (metadata + extracted text via the existing bounded extractor; MiniCPM-V captions for images, scanned PDFs and 3–5 video keyframes; Whisper transcript of the first minutes of untagged audio and course videos; Spark summary when text exceeds the card budget of ~2,000 characters). Embeddings in `sqlite-vec`. A `search` CLI verb and a minimal search page.
- **First task:** probe Unsloth Studio's API (chat, embeddings, image input, audio) and record what it supports; fall back to `llama-server` on the same GGUF files for anything missing.
- **Acceptance:** "find my Kubernetes course"-style queries return the right items on real data; card build throughput recorded.

### Phase 3 — Taxonomy induction

- **Goal:** an approved taxonomy Arvind would actually use.
- **Scope:** seed categories from existing folders, each marked trusted or messy in review; cluster items far from every trusted folder; MiniCPM-V 35B-A3B (overnight, alone in memory) proposes names and descriptions; tree editor with no width or depth limit; revisioned.
- **Acceptance:** Arvind approves taxonomy revision 1.

### Phase 4 — Placement and evaluation

- **Goal:** proposals good enough to approve in groups.
- **Scope:** rules → nearest-neighbour vote over exemplars → top-k retrieval (8–15 candidates + "none of these") → Clef-Flash typed choice. "None" is decided by Clef probability **and** distance to the nearest folder. Replace `src/domain/taxonomy.ts` and retire `laya.ts`. Evaluation on held-out files from trusted folders (20% per folder, family-aware split, reusing `src/eval/metrics.ts`).
- **Treatments:** rules only; kNN only; top-k + Clef; top-k + Spark constrained choice; top-k + MiniCPM-V 35B-A3B.
- **Acceptance:** recall@5 and top-1 accuracy on real held-out files, with Wilson intervals, compared with the 90% top-1 target.

### Phase 5 — Act on local files

- **Goal:** approved groups move safely.
- **Scope:** fix native probe finding F1 first; apply approved groups through `native/fsops`; bundles move as directories (requires a reviewed amendment to the helper, which currently refuses directory moves); journal, recovery and conditional undo per LLD §5–§7. The workflow layer is rewritten smaller; open findings F2 and F4–F7 must not be carried over.
- **Acceptance:** first 100 real moves and one verified undo.

### Phase 6 — Other sources

- **Chrome bookmarks:** read the profile's `Bookmarks` JSON read-only; optional, opt-in page fetch summarised by Spark; output a bookmarks HTML file to import into a fresh folder. Never edit the live file.
- **X bookmarks:** read via the user's own API access or an export; keep as a local searchable collection; write back only if the available API supports folders.
- **Google Drive:** Drive API with read-only scopes first; moves change parents and keep file IDs; skip files the user does not own.
- Each source reuses Phases 2–4 and adds only a reader and an action.

## 6. Models and runtime

Hardware: Fedora 44, i7, 32 GB RAM, no GPU (Unsloth Studio reports 4 GiB VRAM; verify whether usable).

| Role | Model | Runtime | Approx. memory |
| --- | --- | --- | --- |
| Embeddings | EmbeddingGemma 2 | Unsloth Studio, or `llama-server --embedding` | 0.3–1.5 GB |
| Vision captions, OCR | MiniCPM-V 4.7 1B (MiniCPM5-2B only if it accepts images) | Unsloth Studio | ~1.8 GB |
| Speech | faster-whisper small.en | Unsloth Studio | ~0.5 GB |
| Summaries, naming | Spark-X2.5-4B Q4 | Unsloth Studio | 2.6 GB |
| Placement decision | Clef-Flash Q4_K_M | llama-server `/v1/systemone`, `-b 4096 -ub 4096` | 6.1 GB |
| Taxonomy proposal, hard cases | MiniCPM-V 4.7 35B-A3B (Q4_K_M or mixed-Q3) | Unsloth Studio, overnight, alone | 16.6–22 GB |

Daytime set ≈ 11 GB; overnight set runs alone. Model endpoints, model file paths and revisions are configuration, recorded in `docs/runtime-manifest.json` when first used. Speeds are measured, never assumed.

## 7. Invariants

1. Phases 1–4 are **read-only** on every root and source. Only Phase 5+ actions write, and only after an explicit approval.
2. The catalogue, evidence and reports live in the data directory, never inside a scanned root.
3. No network access except loopback model endpoints, plus Phase 6 source APIs and opt-in page fetches.
4. Model output selects or names categories; it never supplies a path, a command or an action.
5. Symlinks are never followed; scans never cross a mount boundary below a root.
6. Every external tool is spawned with an argument array, a timeout and an output cap; never through a shell.
7. Synthetic fixtures for automated tests; real roots only in the acceptance check Arvind runs.

## 8. Code layout

New code lives beside the old code and does not import from `src/application` or `src/domain`:

```
src/catalogue/      Phase 1: config, scanner, kinds, bundles, hashing, metadata, store, report, cli
src/evidence/       Phase 2
src/search/         Phase 2
src/taxonomy2/      Phase 3 (replaces src/domain/taxonomy.ts in Phase 4)
src/placement/      Phase 4
src/shared/         Code moved out of the old tree for reuse (e.g. the ZIP reader)
```

Reused as they are: `native/fsops` (Phase 5, after F1), `src/adapters/providers/clef.ts`, `src/adapters/extraction/*`, `src/eval/metrics.ts`, `src/http/session.ts`. Old modules are deleted only in the phase that replaces them.
