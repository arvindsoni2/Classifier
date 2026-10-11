# Correction plan — Codex spec review 2026-10-11

Source: `docs/Classifier_Spec_Review_2026-10-11.md` (15 findings, R1–R15) plus the
user-reported `415 FST_ERR_CTP_INVALID_MEDIA_TYPE` on the review server (login
form path, part of R8). Executed in the review's own sequence; every task lands
as red tests → green → commit. Pinned baseline: `fe2856a`.

Nothing here authorises real Downloads moves: each phase only restores the
invariant its finding names. The supervised pilot stays where the review left
it (read-only scan recorded; taxonomy handoff pending).

## Phase 0 — unblock the human verification loop

- [x] **R8** Production serve does not serve the UI: `serveReview()` uses plain
  `buildServer()`; only the E2E factory registers `@fastify/static`. Share one
  asset-registration path; fail clearly when the built UI is missing; test the
  actual CLI launch (spawn `review`, login, GET `/app/…`).
  Fixed: `src/http/assets.ts` (shared registration + clear-missing failure),
  `buildServer` takes `uiDist`, `serveReview` resolves/asserts before the
  database is touched. Tests: synthetic `/app/` assets, missing-build
  rejection, real CLI spawn with form login (production-serve.test.ts).
- [x] **415 fix** The login form falls back to a native `POST /login`
  (`application/x-www-form-urlencoded`) when `/app/login.js` is absent; Fastify
  has no parser for it → opaque 415. Accept form-encoded logins (token field
  unchanged) and keep JSON. Fixed with an `application/x-www-form-urlencoded`
  content-type parser in `buildServer`; the bootstrap-token check is
  unchanged, wrong tokens still answer 401.

## Phase 1 — approval and scope invariants (review step 1)

- [ ] **R1** Enforce approval mode (`apply`/`undo`), current taxonomy+policy
  revisions, proposal eligibility and batch/root membership on every transport;
  invalidate proposals/approvals when taxonomy is replaced; revalidate before
  each effect. Negative tests: zero helper calls for wrong mode, stale
  revision, foreign batch, non-pending proposal.
- [ ] **R2** Persist root/destination identity (device+inode) with the approved
  action; compare current observation against the approved pins; a renamed
  destination must surface a conflict, not silently re-pin. Discovery refresh
  must not rewrite outstanding approvals.
- [ ] **R3** Classification opens files through the source adapter with
  anchored, no-symlink/no-mount resolution and verifies the opened descriptor
  against the scanned snapshot before extraction; symlink-to-outside-root
  must defer with a visible conflict, never extract private content.
- [ ] **R4** Monotonic proposal versions; persist rejection; regeneration must
  not revive an invalidated approval; eligibility validated in the domain
  service. Tests: edit→classify-again, reject→reload, apply→regenerate.
- [ ] **R7** Native `probe_kernel()` must never rename user files: use an
  application-owned probe location, treat unexpected errnos (EEXIST etc.) as
  *unsupported/blocked*, not success, and assert no user-root mutation.

## Phase 2 — durable execution (review step 2)

- [ ] **R5** Typed observations (present/absent/unobservable); reconcile
  `undo_intent` records in `resumeBatch`; uncertain post-effect results need
  reconciliation instead of terminal `conflict`; cancel only after resolving
  whether an effect already happened.
- [ ] **R6** Persist complete immutable action snapshots (source/target
  inodes, expected hashes, pins) and real journal payloads; add a root-scoped
  process lock for apply/recovery/undo; transactional claims. Tests: process
  restart after destination edit; concurrent resume from two processes.
- [ ] **R10** New-folder workflow: logical candidates → reviewed mappings →
  physical `mkdir` deferred to approved execution; journal mkdir intent and
  created-directory identity; never adopt or delete an unknown directory;
  fsync the parent directory after mkdir.

## Phase 3 — usable production workflow (review step 3)

- [ ] **R9** Durable taxonomy revisions (persist/reload via
  `taxonomy_revisions`); keep discovered folders separate from the approved
  semantic tree; curation API + UI (add/edit/group/map, ≤7 children enforced
  with actionable errors); classification requires an explicitly reviewed
  taxonomy. Test: >7 physical folders, nested routing, restart before approval.
- [ ] **R13** Review UX: build the exact human-readable summary (source/target
  paths, root, new dirs, conflicts, expiry) *before* issuing approval; approve
  only on explicit confirmation; full destination catalogue + category mapping;
  show evidence, distributions, provider health, progress, receipts;
  conditional undo/recovery controls; proposals leave `pending` after apply;
  focus management; apply the visual/motion spec (incl. the `.sr-only`
  semicolon defect).

## Phase 4 — replayable evaluation and evidence (review step 4)

- [ ] **R11** Matched treatments: load all provider manifests first, fit common
  evidence limits, record per-question request hashes, reject silent
  truncation, one inference queue with per-item deadlines, provider close on
  Organiser close, honest synthetic/real provenance, node calibration filtered
  to the run split.
- [ ] **R12** Persist per-batch membership, exclusions, evidence, exact
  decisions, corrections and action provenance through public repositories;
  handle missing/changed inputs per item; export selected real batches with
  consent-aware redaction; retention preserves active journals; scan
  continuation beyond page zero.
- [ ] **R14** Jev stays explicitly disabled/deferred (no transport invented;
  no local-only guard reused for a hosted endpoint); consent recorded as an
  authorised dataset/subset boundary when it is ever real.

## Phase 5 — release proof (review step 5)

- [ ] **R15** Wire application+UI+E2E typechecks into the required command;
  portable fixture roots (no pre-existing `/tmp/opencode` assumption; no
  root-only permission tests); syscall-boundary race fixtures and real
  process-death recovery fixtures; tests fail when required observations are
  absent; E2E hostile-filename test actually scans; responsive test beyond the
  first screen; README + reproducible Node-22/Linux CI; documentation and plan
  checkboxes updated from fresh results only.
