# Correction plan — Codex spec review 2026-10-11

Source: `docs/Classifier_Spec_Review_2026-10-11.md` (15 findings, R1–R15) plus the
user-reported `415 FST_ERR_CTP_INVALID_MEDIA_TYPE` on the review server (login
form path, part of R8). Executed in the review's own sequence; every task lands
as red tests → green → commit. Pinned baseline: `fe2856a`.

Nothing here authorises real Downloads moves: each phase only restores the
invariant its finding names. The supervised pilot stays where the review left
it (read-only scan recorded; taxonomy handoff pending).

## Re-audit notice (2026-10-12)

The follow-up review (`Classifier_Followup_Review_2026-10-12.md`) re-opened
parts of R1 (per-effect checks, transport), R3 (anchored reads), R5 (forward
uncertainty, undo fallthrough), R6 (lock coverage), R7 (probe fixture safety),
R9 (refresh/curation behaviour), R10 (materialisation absent), R11 (provenance
typing), R12 (batch-exact audit) and R13 (taxonomy UI). The [x] marks below
describe the FIRST correction pass only; the live status and remaining
acceptance criteria are in `docs/Correction-Plan-2026-10-12.md`, whose pending
section lists what is still NOT implemented (FR-06 execution, exact-token
validation, inference queue/deadlines, retention period split, the supervised
real-file batch).

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

- [x] **R1** Enforce approval mode (`apply`/`undo`), current taxonomy+policy
  revisions, proposal eligibility and batch/root membership on every transport;
  invalidate proposals/approvals when taxonomy is replaced; revalidate before
  each effect. Negative tests: zero helper calls for wrong mode, stale
  revision, foreign batch, non-pending proposal.
  Fixed: `applyBatch` requires mode `apply` and `approval.batchId === batchId`;
  `undoAction` requires mode `undo`; `createApproval` requires pending state
  and batch/root proposal membership; `currentContext` reads the durable
  taxonomy revision (new `taxonomies` repository, loaded on construction so a
  restart does not reset it) and the durable root policy revision. Six
  negative authorisation tests in approval-authorisation.test.ts, all through
  the real ApplicationService/Organiser wiring.
- [x] **R2** Persist root/destination identity (device+inode) with the approved
  action; compare current observation against the approved pins; a renamed
  destination must surface a conflict, not silently re-pin. Discovery refresh
  must not rewrite outstanding approvals.
  Fixed: approvals carry `pins_json` (root device/inode + per-proposal
  destination device/inode captured from the discovery catalogue at approval
  time; additive schema migration for existing databases). `apply` and `undo`
  verify the pins against the durable root record and the refreshed catalogue
  before any helper call: a replaced destination directory or a changed root
  identity is a `conflict` with the pinned vs observed identity in the detail,
  never a re-pin. An approval without pins (pre-migration row) requires
  re-approval. Tests: replaced destination, changed root identity, and the
  stable happy path.
- [x] **R3** Classification opens files through the source adapter with
  anchored, no-symlink/no-mount resolution and verifies the opened descriptor
  against the scanned snapshot before extraction; symlink-to-outside-root
  must defer with a visible conflict, never extract private content.
  Fixed: `FilesystemSource.openCandidate(root, externalId, expected)` refuses
  non-basename names, verifies root identity, refuses symlinks (lstat) and
  non-regular files, refuses foreign devices, re-verifies the opened fd
  against the pre-open lstat, and compares the recorded snapshot
  (sha256/inode/device) before returning the handle. `classify` opens through
  it and reports refusals as visible `conflicts` in `ClassifyResult`;
  `inspect()` gained the same no-symlink guard. The Organiser's
  `stabilityWindowMs` option now actually reaches discovery (it was silently
  ignored; one hardcoded 5 s window per batch). Tests: post-scan symlink to a
  private outside file is refused with no proposal, changed bytes defer, an
  unchanged item still reaches the provider.
- [x] **R4** Monotonic proposal versions; persist rejection; regeneration must
  not revive an invalidated approval; eligibility validated in the domain
  service. Tests: edit→classify-again, reject→reload, apply→regenerate.
  Fixed: the proposal upsert now refuses to lower a version or to resurrect a
  rejected row (`WHERE proposals.version <= excluded.version AND state <>
  'rejected'`), `patchProposal` persists rejections, and approval creation
  enforces pending eligibility. Regeneration tests: edit survives
  re-classification, version-1 approval refused, rejection survives reload.
- [x] **R7** Native `probe_kernel()` must never rename user files: use an
  application-owned probe location, treat unexpected errnos (EEXIST etc.) as
  *unsupported/blocked*, not success, and assert no user-root mutation.
  Fixed: the capability is now proven by an overwriting rename onto an
  existing application-owned target inside `.fsops-probe/` expecting EEXIST;
  rc==0 means the flag is not enforced → unsupported (apply disabled, no
  fallback rename); ENOSYS/EINVAL/EOPNOTSUPP → unsupported; any other errno
  (EPERM/EACCES…) → unavailable. A non-directory at the probe name is user
  data: the probe aborts without touching it. Native tests: user file at the
  old probe name survives byte- and inode-identical with no leftovers; real
  capability report; blocked path leaves the file unchanged. 15 native tests.

## Phase 2 — durable execution (review step 2)

- [x] **R5** Typed observations (present/absent/unobservable); reconcile
  `undo_intent` records in `resumeBatch`; uncertain post-effect results need
  reconciliation instead of terminal `conflict`; cancel only after resolving
  whether an effect already happened.
  Fixed: `LocationObservation` is now `present | absent | unobservable`
  (only a definite OUT_OF_SCOPE reading means absent; permissions/unsupported
  errors conflict instead of being read as absent); `resumeBatch` reconciles
  interrupted undo intents through `resumeUndoAction` (role-swapped
  observations, reconcile → commit/retry/stale/conflict); `undoAction`
  reconciles an existing non-terminal intent before any retry; uncertain
  helper failures (PROVIDER_FAILED/timeout class) leave the record
  non-terminal with an `uncertain_effect` event while definite refusals stay
  terminal; cancellation resolves the effect first and only marks a
  not-yet-effected action canceled. Undo fault points
  (before/after-undo-intent, after-undo-rename, after-undo-verify,
  before-undone-commit) make interrupted undos testable.
- [ ] **R6** Persist complete immutable action snapshots (source/target
  inodes, expected hashes, pins) and real journal payloads; add a root-scoped
  process lock for apply/recovery/undo; transactional claims. Tests: process
  restart after destination edit; concurrent resume from two processes.
- [x] **R10** New-folder workflow: logical candidates → reviewed mappings →
  physical `mkdir` deferred to approved execution; journal mkdir intent and
  created-directory identity; never adopt or delete an unknown directory;
  fsync the parent directory after mkdir.
  Done: `folderGroups()` now derives suggestions from the **persisted provider
  decisions** (deferrals to `unknown`), replacing the empty-decisions call
  that could never produce a group; classify persists each provider decision
  with its real provenance (provider, model revision, evidence hash, timing,
  token counts) in the previously unused decisions repository, and proposals
  link those decision ids. Folder creation is now **logical only**:
  `proposeFolder()` persists a draft candidate bound to the real parent
  destination identity from the catalogue (the old code fabricated a root
  inode as the parent pin) and performs no filesystem mutation; an unknown
  parent is refused. The native `mkdirat_exclusive` fsyncs the parent
  directory and reports a failed fsync instead of silently succeeding.
  Remaining for the R9 curation phase (tracked, not silently dropped):
  materialising an accepted candidate inside approved execution with mkdir
  intent/identity journalled — that path needs the curation workflow R9 adds.

## Phase 3 — usable production workflow (review step 3)

- [x] **R9** Durable taxonomy revisions (persist/reload via
  `taxonomy_revisions`); keep discovered folders separate from the approved
  semantic tree; curation API + UI (add/edit/group/map, ≤7 children enforced
  with actionable errors); classification requires an explicitly reviewed
  taxonomy. Test: >7 physical folders, nested routing, restart before approval.
  Fixed: the taxonomy revision persists and a restart resumes AT it (an
  in-memory revision+1 would bind approvals to a revision the durable state
  cannot confirm); `ensureRoot` treats the durable root record as
  authoritative for the policy revision so a later review does not re-pin it;
  `rebuildTaxonomy` surfaces its refusal as `taxonomyStatus` with the reason
  instead of silently keeping the seed; `GET /api/taxonomy` exposes the
  status, whether the tree is reviewed, and the discovered destination
  catalogue for curation; `classify` refuses until a reviewed taxonomy exists
  (clear instruction, not per-item failures); the new `taxonomy` CLI verb
  displays the tree/status and `--review` approves it through the same
  service; the TaxonomyReview UI gains add/remove category controls with a
  destination picker, the curation banner with its reason, and the reviewed
  state. Tests: nine folders surface `more than 7 children` with the
  catalogue; classification is refused before review and works after; the
  reviewed revision survives a restart and classifies there; explicit
  curation replaces the automatic tree.
- [x] **R13** Review UX: the exact human-readable summary is built BEFORE any
  approval exists and the approval is issued only on explicit confirmation, so
  cancelling leaves nothing behind. The summary lists real source and target
  paths under the resolved root; destination cells show paths, not opaque ids;
  edits pick a reviewed category and the destination follows the taxonomy
  mapping (the service refuses an unmapped pair); the provider selector
  reflects live provider health; each proposal shows its persisted decision
  provenance (provider, model revision, probability) through the new
  decision-digest surface; conflicts are listed with their reasons; the
  history view offers conditional undo through a separately approved undo
  approval; dialogs trap Tab and restore focus on close; the stylesheet gained
  the specified dark palette, transitions, focus-visible rings, wrapped
  small-viewport tables and the `.sr-only` semicolon fix. The e2e teardown no
  longer hangs on browser keep-alive connections. Remaining presentation
  polish (dark-palette refinements, progress display during long
  classifications) is tracked for the R15 pass.

## Phase 4 — replayable evaluation and evidence (review step 4)

- [x] **R11** Matched treatments: load all provider manifests first, fit common
  evidence limits, record per-question request hashes, reject silent
  truncation, one inference queue with per-item deadlines, provider close on
  Organiser close, honest synthetic/real provenance, node calibration filtered
  to the run split.
  Fixed: all comparison manifests load before any treatment; evidence is
  fitted to the tightest common budget; every route step records the sha256 of
  the exact request (two fixed-budget providers receive byte-identical
  requests and identical route hashes — the matched treatment is proven, not
  asserted); node calibration honours the run's split and the common budgets;
  exports carry the dataset's real provenance instead of a hard-coded
  `synthetic: true`; the Organiser closes provider sessions. Still tracked
  (needs the provider adapters' internals): one global inference queue with
  per-item deadlines for concurrent HTTP classifications, and proving that a
  provider's encoder did not silently clip option text/instructions/state.
- [x] **R12** Persist per-batch membership, exclusions, evidence, exact
  decisions, corrections and action provenance through public repositories;
  handle missing/changed inputs per item; export selected real batches with
  consent-aware redaction; retention preserves active journals; scan
  continuation beyond page zero.
  Fixed: scans record per-batch membership (batch_items) and persist every
  observed exclusion with its reason (batch_exclusions); classification runs
  against exactly the items its batch observed, with older databases falling
  back to root items; the new decisions repository persists each provider
  decision with real provenance and proposals link those ids; missing/changed
  inputs are per-item conflicts (R3) rather than aborting the loop;
  `export --batch <id>` (and exportLiveBatch) exports a live batch's items,
  decisions, proposals, actions and exclusions with consent-aware private
  evidence; retention purges only batches whose journalled actions are all
  terminal. Still tracked: override/taxonomy write paths for corrections, and
  the UI's evaluation/retention surface.
- [x] **R14** Jev stays explicitly disabled/deferred (no transport invented;
  no local-only guard reused for a hosted endpoint); consent recorded as an
  authorised dataset/subset boundary when it is ever real.
  Fixed: `JevConfig` now carries a dataset-scoped `consentScope`
  (datasetId/subset/recordedAt) and an explicit `verifiedContract` record;
  without a verified contract every call answers UNAUTHORISED with the
  deferral reason, so no API or response shape is assumed and cloud access is
  never widened by configuration alone. The loopback guard is no longer reused
  for the hosted endpoint: once a verified contract is recorded a non-loopback
  endpoint is legitimate. The doctor reports jev as blocked/deferred with the
  reason; the config-shaped path (consentReference string) is gone.

## Phase 5 — release proof (review step 5)

- [ ] **R15** Wire application+UI+E2E typechecks into the required command;
  portable fixture roots (no pre-existing `/tmp/opencode` assumption; no
  root-only permission tests); syscall-boundary race fixtures and real
  process-death recovery fixtures; tests fail when required observations are
  absent; E2E hostile-filename test actually scans; responsive test beyond the
  first screen; README + reproducible Node-22/Linux CI; documentation and plan
  checkboxes updated from fresh results only.
