# Fedora Downloads Organiser Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans when available to implement this plan task-by-task. Execution method is OpenCode as specified by the user; delegation is optional only when explicitly authorised. Steps use checkbox syntax for tracking.

**Goal:** Organise direct-child Downloads files into reviewed Downloads folders and produce reproducible Laya/Clef evaluation evidence.

**Architecture:** One modular TypeScript application with source/provider interfaces, SQLite persistence and a local review UI. A small Rust helper owns anchored no-overwrite Linux operations. Domain policy, approval and recovery are shared by CLI and HTTP; MCP writes and cloud sources are later scope.

**Tech Stack:** Node.js 22.18+ within 22.x, strict TypeScript, React/Vite, Fastify, better-sqlite3, ONNX Laya, local Clef SystemOne server, Rust stable edition 2024, Vitest, Playwright.

**Spec:** [03-LLD-and-Specification.md](03-LLD-and-Specification.md), with [01-PRD.md](01-PRD.md) and [05-Evaluation.md](05-Evaluation.md).

## Global Constraints

- Inbox depth 0; destination directory depth 3; all mutations remain beneath the selected Downloads root and on the same mount.
- Batch size 200; document input 20 MiB; candidate hash/move ceiling 100 MiB; extracted text 16 KiB and ten PDF pages; extractor timeout 10 seconds/memory 512 MiB.
- Folder content samples are opt-in, at most three documents per selected folder.
- Provider concurrency 1, deadline 120 seconds, one transient retry; seven child categories plus unknown per question and at most four route decisions.
- Explicit approval binds proposal versions and policy/taxonomy revisions; expiry 24 hours; all pilot moves need review.
- Preserve basenames/bytes; no overwrite, directory moves, deletion, cross-mount fallback, OCR or cloud fallback.
- Loopback port 4317, authenticated session eight hours, checked Origin/Host, self-only CSP and no wildcard CORS.
- Evidence retention 30 days for completed payloads and action records 90 days; pending/recovery state retained.
- OpenCode coding; Codex review. Synthetic fixture roots only for automated tests.

## Review Focus

1. Shell-like/Unicode filenames render and move as data; no shell interpolation (Tasks 2, 7, 9).
2. Long headers and hidden truncation cannot invalidate model comparisons (Tasks 4, 5).
3. Concurrent source replacement and occupied targets become explicit conflicts, preserving material (Tasks 7, 8).
4. Lost receipts and expired approvals cannot cause duplicate operations during resume (Task 8).
5. Another website cannot approve or apply a batch through an active localhost session (Tasks 6, 9).

## Execution rules

Read the spec before each task. Write the behavioural test first, run it to establish the expected failing assertion/module boundary, implement, run the relevant checks and commit. Do not count an unrelated missing dependency or broken test runner as a valid red test. Each task's proposed interfaces below must be exported from the named modules. Dependencies are sequential unless a task explicitly states otherwise.

Project scripts created in Task 1: `test` (Vitest), `test:e2e` (Playwright), `typecheck` (application and UI), `lint`, `build`, `test:native` (Cargo tests), `doctor`, `eval:fixture`. Never wire an automatic real-Downloads scan into `test`, `build`, install hooks or CI. Commit commands are run in the user's eventual project repository, not this document workspace.

## Milestone A — read-only evidence and evaluation-ready contracts

### Task 1: Contracts, project boot and repositories

**Files:** Create `package.json`, `pnpm-lock.yaml`, TypeScript/Vite/Vitest configs, `src/domain/contracts.ts`, `src/adapters/persistence/schema.sql`, `src/adapters/persistence/repositories.ts`, `tests/unit/contracts.test.ts`, `tests/integration/persistence.test.ts`, `tests/fixtures/collection-source.ts`, `docs/runtime-manifest.json`.

**Interfaces:** Produces the LLD types and `createRepositories(dbPath:string):Repositories`. Repositories expose `batches.create(rootId:Id):Batch`, `proposals.save(p:Proposal):void`, `actions.appendEvent(actionId:Id,event:ActionEvent):void`, `actions.get(actionId:Id):ActionRecord|null`, and transaction wrapper `transaction<T>(fn:()=>T):T`. Define Batch/ActionEvent/ActionRecord and repository contracts next to the persisted types; event states match the LLD. Add `CollectionFixtureSource implements SourceAdapter` with read-only capability (actions empty, recovery none); catalogue/decision services must consume normalised items without filesystem access. Tag execution is an extension shape only and stays disabled.

- [x] Write `rejects_probability_nan_and_precision_loss` and `persists_unique_action_and_rolls_back_event_on_failure`. Assert that NaN/unknown IDs fail schema validation, decimal stat strings survive roundtrip, duplicate `(proposal,version,mode)` fails, and rollback leaves zero new events.
- [x] Run `pnpm test -- tests/unit/contracts.test.ts tests/integration/persistence.test.ts`; verify those behavioural failures.
- [x] Implement contracts, schema/migrations and repository boundary. Set foreign keys/WAL/FULL; owner-only storage. Verify current Node/package compatibility and pin resolved dependencies.
- [x] Run the two tests, `pnpm typecheck`, and fixture source contract test. Record actual versions, not placeholder runtime claims.
- [x] Commit: `git add package.json pnpm-lock.yaml src tests ui docs/runtime-manifest.json` then `git commit -m "feat: establish organiser contracts and catalogue"` (include only files actually created).

### Task 2: Scoped discovery and snapshots

**Files:** Create `src/adapters/filesystem/source.ts`, `src/adapters/filesystem/root.ts`, `tests/integration/discovery.test.ts`, synthetic fixture builders in `tests/fixtures/files.ts`.

**Interfaces:** Consumes RootConfig/Item/Snapshot/Result. Produces `resolveRoot(configuredPath?:string):Promise<Result<RootConfig>>`, `FilesystemSource.discover(config:RootConfig):AsyncIterable<Result<Item>>`, `discoverDirectories(config:RootConfig):Promise<Result<Destination[]>>`, `snapshot(pathHandle:FileHandle):Promise<Result<Snapshot>>`. Destination is opaque ID, relative segments, device/inode and approved/observed status.

- [x] Write `only_lists_stable_direct_regular_files`. Build top-level normal/Unicode/`$(touch marker).txt` files, nested files, symlinks, `.part`, multi-hardlink and oversize fixtures. Assert only stable eligible direct files enter the candidate set; others have exclusions/reasons; no marker is created.
- [x] Run `pnpm test -- tests/integration/discovery.test.ts`; verify expected failure.
- [x] Implement read-only discovery, two observations five seconds apart via an injectable clock, 200-item pagination and depth-three directory discovery. Large files are listed but excluded from executable candidates. Opt-in sampling is explicit configuration.
- [x] Run discovery suite with outside-root byte snapshots unchanged. Include root replacement and permission-denied cases.
- [x] Commit: `git add src/adapters/filesystem tests` then `git commit -m "feat: discover scoped Downloads candidates"`.

### Task 3: Bounded extraction

**Files:** Create `src/adapters/extraction/extract.ts`, `src/adapters/extraction/worker.ts`, `tests/integration/extraction.test.ts`, fixture PDFs/DOCX/TXT.

**Interfaces:** Consumes Item and safely opened input handles. Produces `extractEvidence(item:Item, input:ReadableInput, limits:ExtractionLimits):Promise<Result<Evidence>>`. ReadableInput is an adapter-owned handle/stream, not an arbitrary UI path. Defaults match PRD.

- [x] Write `caps_text_and_reports_unsupported_timeout_and_zip_budget`. Assert extracted text <=16 KiB, no more than ten PDF pages, explicit truncated flags, scanned/encrypted PDF metadata status, malformed DOCX failure and DOCX inflated bytes capped at 20 MiB.
- [x] Run `pnpm test -- tests/integration/extraction.test.ts`; verify assertions fail before implementation.
- [x] Implement UTF-8 decoding, bounded DOCX XML and pinned pdftotext worker using argument arrays, ten-second limit and 512 MiB resource limit. Disable relationship fetching and executable content. Record extractor revision.
- [x] Run extraction suite, including shell-like filenames and document instructions to ignore policy. Assert no network request or executable action results.
- [x] Commit: `git add src/adapters/extraction tests` then `git commit -m "feat: extract bounded local document evidence"`.

### Task 4: Taxonomy, providers and doctor

**Files:** Create `src/domain/taxonomy.ts`, `src/adapters/providers/{rules,laya,clef,jev}.ts`, `src/cli/doctor.ts`, `tests/unit/taxonomy.test.ts`, `tests/integration/providers.test.ts`.

**Interfaces:** Produces `validateTaxonomy(tree:Category[], destinations:Destination[]):Result<Taxonomy>`, `buildMatchedRequest(evidence:Evidence,node:Category,manifests:ProviderManifest[]):Result<DecisionRequest>`, and DecisionProvider implementations. Taxonomy is revision/tree/mappingHash. Doctor produces `probeProviders(config:ProviderConfig):Promise<ProviderHealth[]>`.

- [x] Write `requires_unknown_and_rejects_oversized_headers`. Assert <=7 children plus unknown, <=4 route levels, immutable category IDs, explicit failure for cycles/invalid destinations and provider headers that exceed actual tokenizer limits. Preserve identical evidence hashes across matched treatments.
- [x] Write provider contract fixtures: distribution with missing ID, sum 0.8, NaN, selected nonmaximum, timeout and correct SystemOne response. Assert invalid decisions defer; cloud adapter requires consent.
- [x] Run taxonomy/provider tests and verify behavioural failures.
- [x] Implement virtual grouping, vocabulary candidates and exact-token request validation. Pin Laya model/tokenizer; probe Clef `/v1/systemone` using synthetic state. Do not substitute chat completion. Build retry/deadline handling and explicit Jev opt-in configuration.
- [x] Run contract tests. Run optional real-model smoke tests on synthetic material and record pass/blocked status separately; fixture tests cannot claim a laptop model passed.
- [x] Commit: `git add src/domain/taxonomy.ts src/adapters/providers src/cli/doctor.ts tests docs/runtime-manifest.json` then `git commit -m "feat: add typed local decision providers"`.

### Task 5: Frozen evaluation runner

**Files:** Create `src/eval/{dataset,runner,metrics,report}.ts`, `tests/unit/metrics.test.ts`, `tests/integration/eval.test.ts`, synthetic fixture manifest and golden labels.

**Interfaces:** `loadDataset(path:string):Result<EvalDataset>`, `runEvaluation(dataset:EvalDataset,providers:DecisionProvider[],config:EvalConfig):Promise<EvalRun>`, `scoreRun(run:EvalRun,labels:EvalLabels):EvalReport`. Define all evaluation types and consent/evidence treatments in dataset.ts. Reports preserve failures and support.

- [x] Write a four-item golden report: 3 correct completed predictions out of 4, one provider failure. Assert completion-adjusted accuracy=0.75, conditional accuracy=1, completion=0.75; perfect per-node one-hot predictions have Brier=0. Also assert split assignment keeps duplicate families together and model input excludes labels.
- [x] Run `pnpm test -- tests/unit/metrics.test.ts tests/integration/eval.test.ts`; verify expected failures.
- [x] Implement JSONL exports, family-aware bootstrap, Wilson intervals, five-bin ECE, per-node versus full-route separation, serial timing and manifest hashing. Mark fixture results synthetic; no invented hardware performance.
- [x] Run tests and `pnpm eval:fixture`. Verify deterministic synthetic report and valid manifest. An optional real run needs user-labelled data and actual machine runtime manifest.
- [x] Commit: `git add src/eval tests` then `git commit -m "feat: add reproducible decision evaluation"`.

**Milestone A review evidence:** read-only fixture checks, limits validation, real-provider health status, synthetic eval report and architecture conformance. Codex reviews before widening to mutation work.

## Milestone B — concrete review and authenticated proposals

### Task 6: Planner, approvals and HTTP boundary

**Files:** Create `src/domain/{planner,policy}.ts`, `src/http/{server,routes,session}.ts`, `tests/unit/planner.test.ts`, `tests/integration/http-security.test.ts`.

**Interfaces:** `planPlacement(item:Item,path:DecisionPath,taxonomy:Taxonomy):Result<Proposal>`, `suggestFolderGroups(items:Item[],decisions:Decision[],vocabulary:Vocabulary):FolderCandidate[]`, `createApproval(batch:Batch,selected:Proposal[],mode:'apply'|'undo',now:Date):Result<Approval>`, `validateApproval(approval:Approval,current:ApprovalContext,now:Date):Result<void>`, `buildServer(service:ApplicationService,session:SessionConfig):FastifyInstance`. DecisionPath is ordered node answers; ApprovalContext contains exact versions/revisions/hash. All defined in domain contracts.

- [x] Write `unknown_cannot_plan_and_taxonomy_change_invalidates_approval`: unknown yields no proposal; two selected versions hash consistently; version/taxonomy mismatch gives STALE; 24-hour expiry rejects. Candidate groups require >=3 members unless userRequested.
- [x] Write `cross_site_mutations_are_rejected`: unauthenticated request and active-session evil Origin yield 403; allowed session still needs exact approval. Evidence/filenames are response data, not HTML; sensitive tokens never logged.
- [x] Run planner/security tests; verify behavioural failures.
- [x] Implement proposed paths from approved mappings, explicit override preview, revision changes, random one-time login token, strict cookies/Origin/Host/CSP and LLD endpoints. Mutation endpoints return blocked until the verified executor is installed.
- [x] Run tests and `pnpm typecheck`. Confirm port binding is loopback only and occupied port fails clearly.
- [x] Commit: `git add src/domain src/http tests` then `git commit -m "feat: create authenticated review and approval service"`.

## Milestone C — executor and recovery on synthetic fixtures

### Task 7: Linux operations helper

**Files:** Create `native/fsops/Cargo.toml`, `native/fsops/Cargo.lock`, `native/fsops/src/{main,resolve,operations}.rs`, `native/fsops/tests/operations.rs`, `src/adapters/filesystem/helper.ts`, `tests/integration/helper.test.ts`.

**Interfaces:** Native JSON request/receipt implements LLD verbs. TypeScript exposes `probeFilesystem(root:RootConfig):Promise<Result<FilesystemHealth>>`, `inspectAt(root:RootConfig,segments:string[]):Promise<Result<Snapshot>>`, `moveAt(action:ApprovedMove):Promise<Result<MoveReceipt>>`, `mkdirAt(root:RootConfig,parent:Destination,segment:string):Promise<Result<Destination>>`. No delete/shell verb.

- [x] Write native fixtures `no_replace_preserves_existing_target`, `symlink_ancestor_cannot_escape`, `cross_mount_is_deferred`, `unsupported_primitives_disable_apply`, `source_swap_reports_conflict`, `unicode_and_shell_names_are_literal`, `hardlink_and_oversize_are_rejected`. Assert target/original bytes preserved where appropriate and outside sentinel unchanged.
- [x] Run `cargo test --manifest-path native/fsops/Cargo.toml`; establish behavioural red tests using a compilable stub before implementation.
- [x] Implement descriptor-based openat2 restrictions, pinned root/destination identities, RENAME_NOREPLACE, bounded hashing, post-verification and directory fsync. Map kernel errors explicitly. Source-swap test expects conflict detection, not a fictional atomic identity guarantee.
- [x] Run native suite and `pnpm test -- tests/integration/helper.test.ts`; attach kernel/filesystem context. Cross-mount integration requires a real suitable fixture capability; if absent, report blocked and keep apply disabled for that unverified environment until the check is run.
- [x] Commit: `git add native src/adapters/filesystem/helper.ts tests` then `git commit -m "feat: add anchored non-overwriting Linux moves"`.

### Task 8: Journalled execution, resume and conditional undo

**Files:** Create `src/application/{workflow,recovery}.ts`, `tests/integration/execution.test.ts`, `tests/integration/recovery.test.ts`.

**Interfaces:** `applyBatch(batchId:Id,approvalId:Id,actionSetHash:Sha256):Promise<BatchResult>`, `resumeBatch(batchId:Id):Promise<BatchResult>`, `undoAction(actionId:Id,approvalId:Id):Promise<Result<MoveReceipt>>`, `reconcileAction(record:ActionRecord,observations:LocationObservations):Result<ReconcileOutcome>`. ApplicationService exposes these plus scan/classify/review/eval. Inject repositories, source/helper, clock and fault hook through constructor; no global filesystem access.

- [x] Write `crash_at_every_effect_boundary_recovers_without_duplicate_move`: faults before/after intent, mkdir, rename, verification and Applied commit. Matching source-only retries only on valid approval; target-only records Applied; both/neither/mismatch conflicts. An unrecorded mkdir identity requires destination review and leaves the directory intact.
- [x] Write `undo_refuses_changed_target_and_occupied_original`, `expired_approval_cannot_resume`, `duplicate_apply_returns_existing_receipt`, and `cancel_stops_between_actions`. Assert zero overwritten/lost bytes and explicit result per action.
- [x] Run execution/recovery tests; verify red assertions.
- [x] Implement writer lock, short claim transactions, intent events, helper receipts and reconciliation; separately approved reverse actions. Defer cross-mount/unsupported cases. Preserve created folders and ambiguous material.
- [x] Run suites, native tests and typecheck. Run fault matrix repeatedly only if nondeterminism/failures require it; attach results, not just pass counts.
- [x] Commit: `git add src/application tests` then `git commit -m "feat: persist and recover approved organisation actions"`.

**Milestone C review evidence:** syscall fixture results, concurrency limitations, journal event traces, recovery matrix and undo tests. Passing classification tests alone cannot release apply.

## Milestone D — review interface and supervised pilot

### Task 9: UI, CLI and adapter-contract integration

**Files:** Create `ui/src/{App,TaxonomyReview,PlacementReview,RunHistory}.tsx`, UI styles, `src/cli/main.ts`, `tests/e2e/review.spec.ts`, `tests/integration/adapter-contract.test.ts`.

**Interfaces:** UI consumes only HTTP contracts; CLI calls ApplicationService. `organiser review` starts authenticated loopback review; `organiser apply --approval <id> --hash <hash>` uses the same policy. A fixture collection source can discover normalised items, participate in classification and advertise read-only capability without invoking the filesystem helper; mutation is rejected as UNSUPPORTED.

- [x] Write Playwright flow: approve category, regenerate placements, select exactly two rows, edit one (version changes), review exact summary, approve, apply and inspect verified outcomes. Unknown/stale rows are disabled; fake high confidence cannot bypass approval.
- [x] Add keyboard/dialog-focus, 360 px wrapping, reduced-motion and escaped hostile filename checks. Real HTTP security tests cover cross-site actions; UI warnings are not treated as security controls.
- [x] Run `pnpm test:e2e -- tests/e2e/review.spec.ts`; verify behavioural red state with mock service fixture.
- [x] Implement the UI from 04-UI-UX and mockup, CLI commands and honest provider/evaluation status. No optimistic disappearance of real rows before verification. Add retention/export UI and preserve active journals.
- [x] Run e2e, adapter contract, API tests, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and native tests. Verify Chromium/Firefox where available; report unavailable browser verification explicitly.
- [x] Commit: `git add ui src/cli tests` then `git commit -m "feat: deliver reviewed organisation workflow"`.

### Task 10: Release evidence and supervised laptop run

**Files:** Create `docs/installation.md`, `docs/release-evidence.md`, `docs/adapter-extension.md`, `docs/model-evaluation-report.md`; update runtime manifest and README. No predetermined real-file data is shipped in the repository.

**Interfaces:** Consumes doctor, all check scripts and evaluation manifests. Produces a report distinguishing verified fixtures, actual local-model results, blocked checks and user-reviewed real batch outcomes.

- [x] Run `pnpm test`, `pnpm test:native`, `pnpm test:e2e`, `pnpm typecheck`, `pnpm lint`, `pnpm build` and `pnpm eval:fixture`; record exact commands/exit statuses.
- [x] Run doctor on the laptop using synthetic inference/fixture operations. Record CPU/RAM/GPU, exact Laya/Clef/runtime revisions and memory/latency. Missing Clef health produces a blocked comparison, not substituted chat results.
- [ ] Create development/calibration/test labels with Arvind and run matched treatments. Report held-out performance, failed cases and proposed usefulness targets without tuning against test labels.
- [ ] Configure resolved Downloads root in read-only mode; show scan/exclusions, taxonomy and proposed additions. Do not create a runtime approval on the user's behalf from development approval.
- [ ] After the user approves a concrete small batch in the app, execute up to ten initial moves, inspect receipts, request undo for one eligible action and inspect recovery. This step remains pending until runtime approval exists; elapsed time does not provide approval.
- [x] Write extension guidance covering normalised source capabilities, future account/API discovery and narrow MCP read tools. External writes/MCP approval transport need separate review.
- [x] Commit the documentation and reviewed code changes; do not commit private files, credentials, labels or evidence blobs. Supply Codex with diff plus verification evidence for final review.

## Requirement traceability

| PRD requirement | Implementing tasks |
| --- | --- |
| FR-01 | 2 |
| FR-02 | 4, 6, 9 |
| FR-03 | 3 |
| FR-04 | 1, 4, 5 |
| FR-05 | 4, 6 |
| FR-06 | 4, 6, 9 |
| FR-07 | 6, 8, 9 |
| FR-08 | 7, 8 |
| FR-09 | 8 |
| FR-10 | 7, 8, 9 |
| FR-11 | 5, 9, 10 |
| FR-12 | 1, 6, 8, 9 |
| FR-13 | 6, 9 |
| FR-14 | 1, 9, 10 |

## Plan review and execution handoff

The architecture direction has been approved and the user requested the next deliverables. This is a newly written plan for their chosen OpenCode execution method. Review its detailed defaults and milestone evidence before implementation; no coding was performed while preparing it. Filesystem helper and recovery receive high-reasoning Codex review. Routine UI/persistence review can use medium reasoning. Keep implementation small enough to review each milestone independently.
