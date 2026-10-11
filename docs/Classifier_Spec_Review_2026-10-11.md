# Classifier implementation review

**Verdict: blocked for real-file apply; substantial foundations, incomplete integration and release evidence.**

Reviewed 11 October 2026 against the eight attached documents. Repository: [arvindsoni2/Classifier](https://github.com/arvindsoni2/Classifier). Pinned revision: [`fe2856aa1a6c43490ff710a1d94f9792c072a3b8`](https://github.com/arvindsoni2/Classifier/commit/fe2856aa1a6c43490ff710a1d94f9792c072a3b8).

Seven repository specification files are byte-identical to the attachments. The implementation plan differs through execution tracking and annotations; the attached PRD and LLD remain the review baseline. No repository files, issues, comments or PRs were changed. Tests and reproductions used synthetic roots only.

This implementation does not need a wholesale rewrite. The modules, narrow native helper and typed decision contracts are useful. However, the actual application does not enforce several invariants that its pure functions and happy-path tests appear to enforce. The claim “Milestones A–D code complete” in release evidence is too strong.

## Verification and limits

Review environment: Node **24.19.0**, pnpm **11.25.0**, Linux container, running as root. The project's supported runtime is Node 22.x; all executed checks therefore carry that compatibility limitation. Rust/Cargo, the required Playwright Chromium binary, Laya weights and a live Clef endpoint are absent here. Laptop measurements in repository documentation were read but not independently repeated.

| Check | Fresh result | Meaning |
| --- | --- | --- |
| Frozen-lockfile dependency installation | Passed | Resolved repository dependencies installed |
| `pnpm build` | Passed | Application compilation and Vite bundling work here |
| `pnpm lint` | Passed | Existing lint rules pass |
| `pnpm typecheck` | Passed | Its configuration excludes UI and E2E |
| `pnpm exec tsc -p ui/tsconfig.json --noEmit` | **Failed: six errors** | Missing JSX namespace in four components; missing `mappingHash` types in TaxonomyReview |
| Initial `pnpm test` | Failed | Many fixtures assume `/tmp/opencode` already exists |
| Full test run after creating that fixture parent | **144 passed, 9 failed, 1 skipped**, plus a discovery suite cleanup error | Seven helper failures and CLI apply failure depend on absent Cargo/helper; root replacement test and permission-sensitive cleanup also fail here |
| Focused non-native suite | **130 passed, 1 skipped; 12 files passed** | Unit, persistence, execution/recovery doubles, extraction, providers, evaluation, HTTP security and adapter contract checks |
| `pnpm eval:fixture` | Passed | Rules completion-adjusted accuracy 0.375; conditional accuracy 1.0; macro-F1 0.3333 on eight synthetic examples; Laya blocked here |
| `pnpm test:native` | Blocked: Cargo missing | No native suite pass is claimed |
| `pnpm test:e2e` | Blocked: required Chromium missing | Five tests fail at browser launch, not at product assertions |
| Targeted application reproductions | Defects reproduced | Details below; mutation tests use a recording helper double |
| Real-model comparison / supervised pilot | Not run | No accuracy, throughput or real-file safety recommendation from this review |

The focused test selection was:

```sh
pnpm exec vitest run tests/unit \
  tests/integration/persistence.test.ts \
  tests/integration/execution.test.ts \
  tests/integration/recovery.test.ts \
  tests/integration/extraction.test.ts \
  tests/integration/providers.test.ts \
  tests/integration/eval.test.ts \
  tests/integration/http-security.test.ts \
  tests/integration/adapter-contract.test.ts
```

“Reproduced” below means the current application or pure service ran on synthetic inputs. Calls reaching a recording helper prove an authorisation failure at the application boundary; they do not claim a real native rename was executed. Findings marked “source inspection” were traced through the implementation but were not verified with a native runtime or browser.

## Findings to fix before real Downloads moves

### R1 — P1: approval mode and current revisions are not enforced

**Files:** [workflow.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/application/workflow.ts#L155), [organiser.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/application/organiser.ts#L553). **Requirements:** FR-02, FR-07, FR-10; LLD §§4, 6.

`currentContext()` reads taxonomy/policy revisions from the first stored proposal. `replaceTaxonomySync()` changes only the in-memory taxonomy; it does not stale proposals or approvals. `applyBatch()` does not require approval mode `apply`, and `undoAction()` does not require mode `undo`.

**Reproductions:**

- Approve a version-1 placement, replace taxonomy revision 1 with revision 2, then apply the old approval: the helper is called and the result is `applied`.
- Create an approval with mode `undo` for a pending placement, then pass its ID/hash to apply: a forward move is authorised.
- Apply a placement, then supply that original apply approval to `undoAction`: the reverse helper is called without a separate undo approval.

Batch/root ownership is also not comprehensively bound: approval creation loads arbitrary proposal IDs without checking their membership, the workflow does not verify `approval.batchId === batchId`, and the HTTP wrapper discards its apply URL's batch ID.

**Correction:** Validate against durable current root, taxonomy and policy state; enforce mode, selection state and batch/root membership on every transport. Invalidate affected proposals/approvals on edits. Revalidate before each effect, not only at batch start. Tests must use the real Organiser wiring as well as the pure validator.

### R2 — P1: apply silently refreshes the identity of an approved destination

**Files:** [organiser.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/application/organiser.ts#L459), [repositories.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/adapters/persistence/repositories.ts#L218). **Requirements:** FR-07/08; LLD §5.

Destination IDs hash relative path segments, not directory identity. `apply()` refreshes the catalogue and passes the newly observed inode as the helper's pin. `ensureRoot()` similarly resolves and upserts root identity rather than checking the originally approved record.

**Reproduction:** Approve a move to `Invoices`, rename that directory to `Invoices-old`, and create a different `Invoices` directory. Applying the old approval calls the helper with the **replacement inode**. The helper's pin check cannot detect a replacement once the caller supplies the new identity as expected.

**Correction:** Persist root/destination identity with the approved action. Compare current observations with those original pins and require review on mismatch. Refreshing discovery must not rewrite an outstanding approval's expectations.

### R3 — P1: classification can read outside the selected root

**Files:** [organiser.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/application/organiser.ts#L258), [source.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/adapters/filesystem/source.ts#L155). **Requirements:** FR-01, privacy/scope constraints; LLD §§1, 5.

Classification constructs an ordinary path and calls `open(path, 'r')`. It neither refuses symlinks nor verifies the opened descriptor against the scanned snapshot before extraction. `FilesystemSource.inspect()` also uses ordinary open. Directory discovery uses path-based stat/read operations with race windows.

**Reproduction:** Scan `invoice-01.txt`, replace it with a symlink to a synthetic file outside Downloads, then classify. The provider receives `compactText: "PRIVATE OUTSIDE ROOT CONTENT"`.

**Correction:** Obtain read handles through the source adapter using anchored, no-symlink/no-mount resolution. Validate root and item identity, file type, size and content revision before extraction. A changed file becomes a visible conflict/pending item. Fix this before private-file classification, even in read-only mode.

### R4 — P1: regeneration revives old approvals; rejection is not persisted

**Files:** [organiser.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/application/organiser.ts#L400), [planner.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/domain/planner.ts#L79), [repositories.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/adapters/persistence/repositories.ts#L245). **Requirements:** FR-02/07/12.

Planner regeneration produces the same deterministic proposal ID at version 1; repository upsert replaces any edited version. The rejection branch returns `rejectProposal()` without saving it. Approval creation also does not enforce pending/eligible state.

**Reproductions:** Edit a version-1 placement to version 2: its old approval becomes invalid. Classify again: the stored placement returns to version 1 and the old approval becomes valid. Reject a placement: the response says `rejected`, but reloading still returns `pending`.

**Correction:** Use monotonic proposal versions or immutable revisions. Preserve explicit corrections/rejections until the user removes them. Persist rejected state, validate proposal eligibility in the domain service, and test regeneration after editing, rejecting and applying.

### R5 — P1: interrupted undo and ambiguous helper outcomes are not fully recoverable

**Files:** [workflow.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/application/workflow.ts#L533). **Requirements:** FR-09/10; LLD §6. **Evidence:** source inspection.

- `resumeBatch()` reconciles only records whose mode is `apply`; interrupted `undo_intent` records are skipped.
- `undoAction()` retries an existing nonterminal undo intent by calling the helper again without inspecting inverse source/target state first.
- `observe()` treats every failed inspection as “location absent”, including permissions, unsupported operations and symlink/type errors.
- A returned helper error after an uncertain effect is committed as terminal `conflict`; resume skips terminal records. A helper timeout or post-rename fsync failure may have occurred after the file moved.
- Cancellation marks unfinished records canceled before resolving whether an effect already occurred.

**Correction:** Preserve typed present/absent/unobservable observations. Reconcile both forward and inverse intents against immutable action data before retry or cancellation. Treat uncertain post-effect results as needing reconciliation. Add interrupted-undo, timeout-after-rename, unreadable-location and cancel-after-effect tests.

### R6 — P1: journal data and writer isolation are insufficient for the recovery contract

**Files:** [schema.sql](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/adapters/persistence/schema.sql), [workflow.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/application/workflow.ts#L104). **Requirements:** FR-09/12; LLD §4. **Evidence:** source inspection.

Actions reference a mutable proposal but do not store the promised immutable source/target mapping and expected snapshot. Intent events hash a JSON payload without retaining that payload; recovery reads the current proposal and current destination catalogue. The writer lock is a Promise queue inside one ApplicationService instance. Two CLI/server processes have independent queues; SQLite claim uniqueness does not serialise resume of an existing intent or distinct actions.

**Correction:** Persist complete immutable action/attempt data and useful journal payloads. Add a root-scoped process lock covering apply, recovery and undo, plus short transactional claims. Test process restart after a destination edit and concurrent resume from two processes. Do not rely on a payload hash as the recoverable payload.

### R7 — P1: the supposedly read-only native probe can rename a real file

**File:** [resolve.rs](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/native/fsops/src/resolve.rs#L360). **Requirements:** read-only probe and no approval bypass; LLD §5.

`probe_kernel()` invokes RENAME_NOREPLACE from `.fsops-kernel-probe-a` to `.fsops-kernel-probe-b` inside the configured root, assuming both names never exist. If the first exists and the second does not, the probe performs an unapproved rename. It also treats every errno except ENOSYS as capability success, including blocked/unsupported cases.

**Evidence:** Source inspection plus execution of the identical `renameat2` call through libc in a synthetic directory: return code 0, original absent, target present. This confirms syscall behaviour; the Rust helper itself was not built here.

**Correction:** Use an application-owned synthetic probe location and a real no-overwrite capability fixture, or a genuinely non-mutating test. Report unavailable/blocked support explicitly. Test existing probe-like filenames and assert no user-root mutation.

### R8 — P1: production review launch does not serve the UI

**Files:** [serve.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/cli/serve.ts#L15), [server.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/http/server.ts#L85). **Requirements:** Milestone D / UI delivery.

Only `createServerForE2E()` registers static UI assets. `serveReview()` calls plain `buildServer()`. Normal login redirects to `/app/`, which is not served. The login script at `/app/login.js` is also absent on that route.

**Reproduction:** Start the production serve factory with a synthetic root; successful injected login returns 302 to `/app/`; an authenticated GET there returns **404**. E2E uses a different server factory and masks this gap.

**Correction:** Share one production composition/asset registration path with E2E and test the actual CLI launch. Fail clearly if built assets are missing. Add valid documented startup instructions.

### R9 — P1: taxonomy curation cannot resolve the real pilot blocker

**Files:** [organiser.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/application/organiser.ts#L217), [TaxonomyReview.tsx](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/ui/src/TaxonomyReview.tsx). **Requirement:** FR-02.

Every discovered directory is appended beneath root. More than seven destinations invalidates the whole rebuilt tree, and failure is silently ignored. The UI displays a table and resubmits it; it has no category add/edit/group/map controls. The active taxonomy is in memory only, despite the taxonomy_revisions table. Classification does not require an explicitly approved taxonomy.

**Reproductions:** Eight folders and one eligible invoice produce a root-only taxonomy and zero proposals. Replace a taxonomy with revision 2, close/reopen the Organiser: it returns to revision 1 with only the root node.

This matches the documented 499-folder pilot failure. The seven-child constraint is valid; the missing curation and persistence workflow prevents users from satisfying it.

**Correction:** Keep discovered folders separate from the approved semantic tree. Provide controlled curation, virtual groups, destination mapping and explicit taxonomy status/errors. Persist/reload revisions. Test more than seven physical folders, nested routing and restart before approval/apply.

## Other substantial specification gaps

### R10 — P1: new-folder mutations bypass the planned deferred workflow

**Files:** [organiser.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/application/organiser.ts#L619), [workflow.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/application/workflow.ts#L712). **Requirement:** FR-06. **Evidence:** source inspection.

`folderGroups()` supplies an empty decisions array, so it cannot produce suggested groups. The folder endpoint invokes mkdir immediately without a concrete placement approval or durable intent; it saves a draft candidate only after the effect. Nested parent identity is incorrectly set to the root inode. There are no mkdir crash fault points or recoverable created-directory identity journal. Native mkdir does not fsync the relevant directory metadata.

**Correction:** Persist logical candidates, review/accept their mappings, regenerate placements and defer physical mkdir to approved execution. Journal mkdir intent/identity and handle lost receipts without deleting or silently adopting an unknown directory.

### R11 — P1 for the model recommendation: matched evaluations are not actually matched

**Files:** [runner.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/eval/runner.ts#L304), [taxonomy.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/domain/taxonomy.ts#L158), [laya.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/adapters/providers/laya.ts#L146). **Requirement:** FR-04/11; evaluation §§3–5.

The runner fits evidence independently using `[manifest]` for each provider, rather than the common limits of all compared providers. Token fitting estimates UTF-8 bytes divided by three; it does not encode the full provider template or reserve all framing/header tokens. Inspection of installed @receptron/laya 0.1.2 confirms its sequence builder clips option text, instructions and state; the adapter never proves that clipping did not happen. Laya lacks a decision deadline/retry controller. Neither concurrent HTTP classifications nor repeated health probes share a global inference queue; provider instances are not closed when Organiser closes.

**Reproduction:** Run one frozen synthetic item with 600 compact-text characters through two recording providers having different input limits. The nominal matched treatment delivers **225 versus 600 characters**, with different evidence hashes.

Exports hard-code `synthetic: true` even for arbitrary frozen datasets; manifest fields omit several promised actual model/tokenizer/hash settings. Teacher-forced node calibration iterates all dataset items regardless of the run's requested split. No held-out Laya/Clef accuracy comparison has been provided; the smoke tests in the docs are not such a comparison.

**Correction:** Load all comparison manifests first; freeze common semantic evidence before provider routing and record per-question request hashes. Validate exact provider encodings and reject silent truncation. Separate longer-context treatments. Enforce one inference queue, per-item deadlines, cleanup and honest synthetic/real provenance. Filter node calibration to the selected cohort.

### R12 — P2: live audit, batch membership and exports are largely unwired

**Files:** [organiser.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/application/organiser.ts#L239), [repositories.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/adapters/persistence/repositories.ts), [main.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/cli/main.ts#L172). **Requirements:** FR-11/12/14.

Live classification saves proposals but not extracted evidence or decisions. Route decisions overwrite real provenance with model revision `route`, schema hash `route`, zero latency and an ID reused across items. The evidence/decision/override/taxonomy tables lack the necessary repository/application write paths. Retention is absent. `export` always evaluates the repository's synthetic fixture, rather than exporting the live batch. The UI has no evaluation or retention/export surface.

Items/proposals are queried by root, not scan batch. Historic revisions remain candidates for later classification, and missing files abort the whole loop because file-open errors are not handled per item. App scan consumes only discovery page zero without continuation.

**Reproduction:** Remove a previously scanned item and classify again: an uncaught ENOENT rejects the entire classification call.

**Correction:** Persist per-batch membership, observed exclusions, evidence, exact decisions, correction events and action provenance through public repositories. Handle missing/changed inputs individually. Export selected real runs with consent-aware redaction, preserve active journals during retention and support scan continuation. Keep source-specific file opens out of the application core.

### R13 — P1 for approval UX, P2 for presentation: exact review is incomplete

**Files:** [PlacementReview.tsx](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/ui/src/PlacementReview.tsx#L86), [RunHistory.tsx](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/ui/src/RunHistory.tsx), [styles.css](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/ui/src/styles.css). **Requirements:** FR-07/10; UI §§2–7. **Evidence:** source inspection.

“Review exact summary” already creates an approval before the confirmation dialog. Canceling does not revoke it. The summary lists filenames only, omitting actual source/target paths, root, new directories, conflicts and expiry. Destination cells display opaque IDs. The selector lists only destinations already present in proposals and submits destination ID as category ID, without enforcing a valid taxonomy mapping.

Classification is hard-coded to rules. Provider health is fetched and discarded. Evidence details and distributions are absent. History has no undo/recovery controls. Proposal states stay pending after apply. Dialogs lack focus trapping/restoration; mobile uses horizontal table scrolling; the specified dark palette and interaction transitions are absent. The `.sr-only` CSS has a missing semicolon.

**Correction:** Build a human-readable summary before issuing the approval; create it only on explicit confirmation. Use the complete approved destination catalogue and category mapping. Show evidence, providers, progress and receipts; add conditional undo and recovery controls. Verify keyboard focus and populated 360px layouts. Apply the supplied visual/motion spec after behaviour is sound.

### R14 — P2: Jev is a test seam, not a usable configured provider

**Files:** [jev.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/adapters/providers/jev.ts#L59), [organiser.ts](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/src/application/organiser.ts#L85).

Normal construction passes configuration only, but Jev requires an injected transport and has no production transport. It also reuses the local-only endpoint guard, so an actual hosted endpoint is refused even with consent. `/v1/choice` and Clef's response format are implementation assumptions without a recorded verified Jev integration contract. Consent is a global config string, not an authorised dataset/subset boundary.

**Reproduction:** Configure a consent reference and loopback endpoint; health returns UNAUTHORISED because transport is missing.

**Correction:** Keep Jev explicitly disabled/deferred until its actual provider API, authentication and dataset-scoped consent are implemented and verified. A subscription exposing a model does not establish a usable standalone API for this application. Do not broaden cloud access as part of routine local-provider fixes.

### R15 — P2: checks and release evidence overstate required coverage

**Files:** [package.json](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/package.json), [tsconfig.json](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/tsconfig.json), [native tests](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/native/fsops/tests/operations.rs#L275), [E2E tests](https://github.com/arvindsoni2/Classifier/blob/fe2856aa1a6c43490ff710a1d94f9792c072a3b8/tests/e2e/review.spec.ts).

Fresh UI typechecking fails although advertised typecheck/build pass. Fixtures depend on a pre-existing `/tmp/opencode`; permission tests are not portable to root and the root replacement test can reuse the just-freed inode. Native `source_swap_reports_conflict` supplies a bad expected hash before the move; it does not replace source between verification and syscall. `unsupported_primitives_disable_apply` tests only a supported-kernel happy path. The fault enum has no mkdir/undo boundaries; “after-rename” executes after the helper has already completed verification. The hostile-filename E2E test never scans and passes when the expected text is absent. The responsive test examines only the initial screen. No Firefox project or repository CI workflow was found.

Installation refers to undeclared `tsx` and `scan --root`, whereas the CLI takes the first scan argument as the path. No README is present. Runtime notes retain contradictory historical blocked/installed statuses.

**Correction:** Wire application, UI and E2E typechecks into the required command; use portable temporary roots; verify actual production launch; add syscall-boundary races and process-death recovery fixtures. Make tests fail when required observations are absent. Update evidence and plan checkboxes from fresh results, with pending work explicit. Add a reproducible Node-22/Linux check pipeline.

## Requirement coverage

Statuses describe current end-to-end conformance, not whether a similarly named module exists.

| Requirement | Assessment | Main reason |
| --- | --- | --- |
| FR-01 scoped discovery | Partial | Initial scope checks exist; re-open classification escapes via symlink; batch continuation absent |
| FR-02 versioned taxonomy | Blocked | No durable current taxonomy, usable curation or stale invalidation |
| FR-03 bounded extraction | Partial | Format and byte-limit tests pass; TXT/DOCX execute in main process without specified worker timeout/memory isolation; DOCX uses a custom scanner |
| FR-04 interchangeable matched providers | Partial | Typed adapters exist; actual matched inputs/token budgets differ |
| FR-05 visible deferral | Partial | Unknown is rejected by planner; failed/changed items and provenance are not durably exposed |
| FR-06 reviewed new folders | Blocked | Candidate generation unwired; physical mkdir precedes execution intent |
| FR-07 concrete approval | Blocked | Modes/current revisions/identities and exact human summary fail |
| FR-08 no-overwrite moves | Promising native implementation; release unverified | RENAME_NOREPLACE/openat2 present; native suite unavailable here; approved pins overwritten upstream |
| FR-09 recovery | Blocked | Immutable journal, undo reconciliation and process isolation incomplete |
| FR-10 conditional undo | Partial/blocked | Native conditions exist; mode separation and interrupted undo fail; no UI controls |
| FR-11 evaluation export | Partial | Fixture runner/export works; live run export, provenance and matched inputs incomplete |
| FR-12 audit/corrections | Blocked | Rejection not saved, edits reset, live evidence/decisions absent |
| FR-13 local access control | Partial with passing focused security suite | Loopback/session/Origin controls exist; bootstrap token is reusable and login bypasses Host/Origin hook |
| FR-14 extension boundary | Partial | Contracts and collection fixtures exist; concrete Organiser remains filesystem-specific |

## What is worth retaining

- Narrow Rust operations with argument-array transport, openat2 containment, basename preservation and RENAME_NOREPLACE; no copy/delete or ordinary rename fallback in the production helper.
- Strict probability/option validation and unknown deferral in domain contracts.
- SQLite WAL/FULL/foreign keys and owner-only database permissions.
- Server-side loopback/session/Origin protections covered by passing focused tests.
- Family-aware evaluation utilities, separate conditional/completion-adjusted metrics and explicit reporting of blocked providers.
- Documentation that labels the current usefulness results synthetic and leaves held-out model comparison and real moves pending.

These strengths reduce the corrective scope, but do not establish the hard release gates.

## Recommended OpenCode correction sequence

1. **Approval and scope:** R1–R4 and R7, with concrete negative tests. Require zero helper calls for wrong-mode/stale/changed-destination cases and zero outside-root reads.
2. **Durable execution:** R5–R6 and R10. Immutable action snapshots, root process lock, real process-crash/undo/mkdir reconciliation and explicit observation errors.
3. **Usable production workflow:** R8–R9 and R13. Serve the actual UI, support/persist a taxonomy for more than seven folders, show exact source/target summaries and conditional undo.
4. **Replayable evaluation and evidence:** R11–R12 and R14. Shared exact-token inputs, real batch evidence exports, provider lifecycle limits; keep Jev deferred if its API remains unverified.
5. **Release proof:** R15, then rerun required checks on Node 22/Fedora with the native helper and Chromium/Firefox. Update claims to match the actual tested cases.

After the application fixes pass, begin a read-only labelled Laya/Clef comparison. Choose provider order from held-out destination accuracy, failure rate, memory and review effort. The existing smoke figures—Laya approximately 419 ms and Clef approximately 23 s on one synthetic invoice—suggest a timing difference only; they do not establish which model organises this Downloads collection better. A cheap-first cascade remains a later experiment, as specified.

Do not count independent classifier success as executor approval. The next Codex review should receive the affected diff, fresh outputs and targeted reproductions before a supervised real-file batch.

## Provenance

Review generated by Codex from the pinned repository, attached specifications, fresh local checks and synthetic reproductions. The exact reviewer model identifier/reasoning setting is not exposed in this session and was not inferred. The repository runtime manifest records OpenCode/GLM-5.3 as the coding agent; that is repository-reported metadata. No private Downloads evidence or credentials were used.
