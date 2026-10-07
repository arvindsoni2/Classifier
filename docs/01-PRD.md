# Product requirements: Fedora Downloads organiser

Version 1.0 · 2026-10-06 · Architecture direction approved; detailed defaults proposed for review.

## 1. Problem and outcome

Arvind's Downloads contains mixed incoming material. Manual organisation requires inspecting unclear files, selecting suitable existing folders and deciding whether new folders are useful. The first product should reduce this effort while providing evidence to compare Laya and Clef-flash Q4. Future sources should reuse the taxonomy, decision, review and workflow services.

Success means the user can scan, review folder meanings, review a concrete placement batch, execute selected moves and inspect verified outcomes. Classification accuracy alone is insufficient: correction effort, excessive folder creation and recovery matter.

## 2. Confirmed decisions

| Decision | Requirement |
| --- | --- |
| First source | Fedora local filesystem; loose regular files directly inside Downloads |
| Destinations | Existing or explicitly approved new folders beneath the same Downloads root |
| Folder policy | Reuse first; propose additions for user review |
| Operating mode | Manual batches; every move needs explicit approval |
| Local models | Compare Laya and Clef-flash Q4 independently before choosing operational routing |
| Development | OpenCode codes; Codex plans and reviews |
| Expansion | Google Drive, GitHub stars and X through adapters |

Resolve Downloads through the user's XDG directory configuration when available, otherwise offer `~/Downloads`. Display the resolved absolute path and have the user select the root during setup. Do not assume this execution environment is their laptop.

## 3. Pilot boundaries

The inbox is depth zero: direct child regular files. Discover destination directories to depth three below the selected root, without following symlinks or crossing mount boundaries. Directory discovery reads names/metadata only. Reading existing folder contents is opt-in per folder; sample at most three supported documents per folder, using the extraction budgets below. User-authored descriptions are preferred. Existing folder files are never move candidates.

The pilot supports same-filesystem moves preserving basename and bytes. Renaming, deletion, deduplication removal, moving directories, archive extraction, recursive inbox organisation, OCR, image/video understanding, automatic scheduling and cloud-source writes are later scope. A source or destination on another mount is deferred. There is no broad shell executor in the runtime.

Hidden files, symlinks, special files and names ending `.part`, `.crdownload`, `.download`, or `.tmp` are excluded. A file is eligible only after size and mtime remain unchanged across two observations at least five seconds apart. This is a stability heuristic, not a guarantee that another program will not change it later.

## 4. Users and journeys

One local user and one active writer process. The UI supports:

1. Configure root and inspect exclusions.
2. Scan loose files and discover destination folders without changes.
3. Review/edit folder descriptions and approve the active taxonomy.
4. Classify with a selected provider or compare providers in shadow mode.
5. Review proposed new categories before generating the final placement batch.
6. Select placements, inspect an exact execution summary, approve and apply.
7. Inspect verified results, interrupted work and conditional undo.

A single classification correction applies to that item. Saving an ongoing rule is a separate explicit action with a preview of its matching scope.

## 5. Functional requirements

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| FR-01 | Read-only scoped discovery | Fixture root has outside files and nested inbox files; neither becomes a candidate |
| FR-02 | Versioned folder taxonomy | Editing a label/description/destination increments revision and marks affected proposals stale |
| FR-03 | Bounded extraction | Text/Markdown, text PDFs and DOCX supported; timeout/oversize/encrypted/scanned/unsupported files get an explicit status |
| FR-04 | Provider interchangeability | Rules, Laya and Clef consume the same recorded evidence/questions and validated category IDs |
| FR-05 | Deferral | Unknown, malformed output, insufficient evidence or provider failure produces no executable proposal |
| FR-06 | New-folder review | Suggested groups have examples, controlled names and no physical folder until accepted execution |
| FR-07 | Concrete batch approval | Approval binds selected action versions, destinations and current taxonomy/policy revisions |
| FR-08 | Non-overwriting moves | Existing or concurrently created destination is retained unchanged; source is retained or explicitly reconciled |
| FR-09 | Recovery and resume | Injected interruption around filesystem/journal boundaries is reconciled without duplicate moves |
| FR-10 | Conditional undo | Original location free and target identity/hash unchanged permits reversal; otherwise conflict, no overwrite |
| FR-11 | Evaluation export | Per-item predictions, versions, timing, errors and metrics can be exported without raw content by default |
| FR-12 | Audit and corrections | User actions and execution receipts are recorded; exact-item overrides are inspectable and removable |
| FR-13 | Local access controls | Loopback UI requires session authentication and request-origin checks; other sites cannot approve/apply |
| FR-14 | Extension boundary | A mock second source can list normalised items and advertise read-only capabilities without changing domain services |

## 6. Engineering defaults

These are proposed limits, not measured laptop capacity or model performance.

| Setting | Default |
| --- | --- |
| Candidate batch | 200 files; further items paginated |
| Evidence input | Up to 20 MiB per supported document; SHA-256 candidate eligibility limit 100 MiB |
| Extracted text | First 16 KiB UTF-8, at most ten PDF pages; visible truncation flag |
| Extraction worker | One process at a time, 10-second timeout, 512 MiB memory limit |
| Provider worker | One inference at a time; serial model comparison |
| Provider deadline | 120 seconds per item; one retry for transient failure |
| Taxonomy question | At most seven child categories plus `unknown`; maximum four routing questions per item |
| Routing | Default mode `review_all`; no unattended moves |
| Storage | SQLite and evidence outside Downloads, owner-only access |
| Telemetry | Local structured events; raw document text and full paths omitted by default |

TXT/Markdown decoding uses UTF-8 with explicit decoding failure, not silent replacement. DOCX XML is read with a streaming parser and uncompressed-byte budget of 20 MiB; scripts, macros and external relationships are not executed/resolved. Text PDF uses a pinned `pdftotext` process with argument-array spawning and limits. Scanned PDFs remain pending for later OCR. Installers/archives/images use metadata only and remain reviewable. Files exceeding 100 MiB are listed as oversize and cannot be moved in the pilot.

## 7. Product and release measures

Hard release gates: zero outside-root mutation, overwrite, approval bypass or unintended deletion in the defined fixture suite; all crash/undo scenarios produce defined outcomes; no private cloud transmission in local mode. This establishes evidence on tested cases, not a universal guarantee against malicious same-user programs or all hardware failures.

Proposed usefulness targets: at least 90% top-1 existing-folder accuracy on held-out eligible items, at least 80% accepted suggested placements, and 30% less review time than a manual baseline. Report confidence intervals and per-category support; sparse results are exploratory. Missing a usefulness target does not justify lowering the hard gates. Pilot classification is still review-only.

Measure memory, cold load, warmed p50/p95 and end-to-end throughput on the actual laptop. No fixed speed promise. A model can be rejected on resource cost even when its classification accuracy is stronger.

## 8. Privacy, accessibility and adoption

No cloud fallback. Jev is opt-in for public/synthetic material or an explicitly selected, previewed dataset. Private labels and paths are not sent by default. Downloads contents are treated as untrusted data. UI uses keyboard navigation, text status indicators, accessible contrasts and reduced motion.

The user must understand which files will change before approval and where recovery information lives afterward. Approval of this design authorises development planning; runtime approval for particular file moves is obtained by the finished application.

## 9. Delivery sequence

Milestone A: read-only catalogue, taxonomy and replayable evidence. Milestone B: independent model evaluations and review UI. Milestone C: verified executor, recovery and undo on fixtures. Milestone D: supervised Downloads pilot. Cloud adapters and MCP writes each receive their own requirements and capability verification.

