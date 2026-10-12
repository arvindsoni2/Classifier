# Follow-up correction plan — review of 2026-10-12

Source: `docs/Classifier_Followup_Review_2026-10-12.md` (F1–F12, baseline
`b0c16da`). Executed in the review's own order. Every fix lands as a red
reproduction test first; checked items are only checked when their acceptance
criteria pass. Findings with unfinished halves stay open in the "pending"
section below — a checked box never covers a missing feature.

## Phase 1 — Safety (F1, F4, F5, F6)

- [x] **F1** Probe fixture is uniquely and exclusively created
  (`.fsops-probe-<pid>-<nanos>`, EEXIST never adopted); cleanup unlinks only
  files whose inode was captured at creation; rmdir only the exact created
  directory. Tests: pre-existing `.fsops-probe/probe-src/dst` user files
  survive; two probes coexist; nothing is deleted that this attempt did not
  create.
- [x] **F4** Per-effect revalidation: approval validity (versions, durable
  revisions, expiry) is re-checked immediately before every helper call; the
  first invalidation stops the loop and every remaining action reports stale
  with zero helper calls. Tests: taxonomy bump and mid-loop rejection after
  action one.
- [x] **F5** (a) forward helper errors use the same definite/uncertain split
  as undo (uncertain stays non-terminal for reconciliation); (b) `undoAction`
  returns the reconciliation outcome for an existing intent instead of
  falling through to a second attempt; (c) cancellation reconciliation swaps
  observation roles for undo mode (crash-after-undo-rename + cancel resolves
  `undone`, never `canceled`); (d) a dedicated `NOT_FOUND` code distinguishes
  definite absence from unobservable inspect failures; (e) undo/cancel
  recovery reads the action's immutable fields, receipts rebuild `before`
  from journalled data.
- [x] **F6** Undo acquires the same root writer lock; the lock is a lease
  with per-action heartbeat/renewal — elapsed time alone never steals a live
  writer's lock; a writer that loses ownership halts further effects; busy
  writers return an explicit stale/locked result (not an empty list);
  retention no longer deletes root locks while purging batches. Tests: undo
  refused while another owner holds the lock; long live writer survives clock
  advance; second writer sees busy; killed holder expires.

## Phase 2 — Usable pilot (F2, F3, F7)

- [x] **F2** Discovery updates only the physical catalogue. The approved
  semantic tree changes only through a revisioned explicit review; refresh
  never appends destinations and never classifies against a silently mutated
  tree. New/missing destinations are surfaced separately (`unmapped`,
  `missing`) with an optional suggested curation. Test: nine folders + a
  reviewed one-category tree classifies; custom categories survive
  scan/classify/restart.
- [x] **F3** PUT /api/taxonomy returns the same shape as GET; the UI reloads
  the authoritative taxonomy after a save. The curation UI gains category and
  group creation with parent selection, and label/description editing.
  Browser test: add → approve → edit → approve again → classify.
- [x] **F7** Batch isolation end to end: legacy fallback only when the
  database truly predates membership tables (empty current batch stays
  empty); proposals listed per batch; approval creation binds batch
  membership, not just root; the HTTP apply wrapper passes and validates the
  requested batch id.

## Phase 3 — Scope and audit (F8, F10)

- [x] **F8** `openCandidate` closes the descriptor on every unsuccessful
  return; reads use O_NOFOLLOW at the actual open boundary with the lstat/
  fstat identity checks; `inspect` verifies identity before hashing.
  Tests: descriptor count stable across repeated refusals; ancestor/path
  replacement refused.
- [x] **F10** Per-run persistence: every route decision (not just the last)
  and the extracted evidence are stored; export is batch-exact; default
  export redacts basenames/paths (documented in the manifest), full evidence
  states only on explicit opt-in; exported decisions carry answers and schema
  hashes; retention keeps undo-capable action records and journals.

## Phase 4 — Scope decisions and evaluations (F9, F12)

- [ ] **F9** New-folder execution stays open as a feature: the release is
  explicitly narrowed to existing destinations; correction plan and release
  evidence state FR-06 is not complete; no checked box claims it.
- [ ] **F12** Provenance separated from the boolean `synthetic` flag
  consistently across manifest/report/run.json; the fixture prints
  `synthetic: true`; node calibration defaults to the run's split.

## Phase 5 — Release evidence (F11)

- [ ] **F11** CI action ref fixed (`pnpm/action-setup@v4`); hostile-filename
  e2e test scans and asserts unconditionally; responsive test exercises the
  placements view; E2E TypeScript included in the required typecheck; real
  process-death lock test (child SIGKILLed, expiry reacquire).

## Explicitly pending (not claimed done)

- Exact provider tokenizer encoding validation / clipping rejection, global
  inference queue and per-item deadlines (F12/F11 remnant of R11).
- Complete accept → map → regenerate → approved mkdir/move workflow (F9:
  FR-06 remains open).
- Distinct evidence/action retention periods (F10 remnant).
- A labelled read-only Laya/Clef comparison (needs user labels, not code).
