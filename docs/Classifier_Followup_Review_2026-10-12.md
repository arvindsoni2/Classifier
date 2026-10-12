# Classifier follow-up review — 12 October 2026

**Verdict: meaningful corrections, but still blocked for real Downloads moves.**

Reviewed [arvindsoni2/Classifier](https://github.com/arvindsoni2/Classifier) at [b0c16da62c9be95df9a1f0065d6a2f9235876bc3](https://github.com/arvindsoni2/Classifier/commit/b0c16da62c9be95df9a1f0065d6a2f9235876bc3), 15 commits after the previous review's fe2856a baseline. The original eight specifications remain the requirements baseline; their substantive requirements were not changed by this correction series.

No commits, PRs, issues or remote review comments were created. Checks used an isolated checkout and synthetic fixture directories. This report distinguishes application reproductions from source-only findings and unavailable native/browser verification.

## What improved

- The actual production CLI launch serves the built UI and accepts form-encoded login. The production startup test passes, including login and GET /app/. The earlier 404/415 findings are addressed.
- Apply and undo approval modes are separated. Wrong-mode approvals are refused in the regression tests.
- Current durable taxonomy revisions invalidate old approvals at batch entry. Destination identity replacement is refused in the tested forward-apply cases.
- Rejections are persisted, edited proposal versions survive regeneration, and reviewed taxonomy revisions survive restart in the added tests.
- Action rows now retain source/target/snapshot data and journal events retain payloads. Interrupted undo and uncertain undo responses have some recovery coverage.
- Provider comparison now fits requests against common healthy-provider budgets; the two-provider matched-request regression passes.
- README, UI typechecking, batch-membership tables, decision persistence, and explicit Jev deferral are useful additions.

These are substantive changes. They do not close the remaining end-to-end gaps below.

## Fresh verification

Environment: Node **24.19.0**, pnpm **11.25.0**, Linux container running as root. Node 22.x is the specified runtime, so this is not a Node-22 compatibility sign-off. No live Laya/Clef weights/endpoints were evaluated.

| Check | Result |
| --- | --- |
| Application TypeScript check | Passed |
| UI TypeScript check | Passed |
| ESLint | Passed |
| Application compile, asset copy and Vite production build | Passed |
| Full repository Vitest suite | **181 passed, 9 failed, 1 skipped**, plus a discovery-suite cleanup error |
| Focused suite excluding helper, discovery and CLI files | **167 passed, 1 skipped; 22 files passed** |
| Additional reviewer reproductions | **14 observed-defect checks passed** |
| Synthetic evaluation fixture | Runs, but prints incorrect synthetic provenance; see F12 |
| Native tests | Blocked: Cargo is absent |
| Playwright | All five attempts blocked at launch: required Chromium is absent |
| Fresh dependency install | Not completed: offline metadata missing; subsequent install failed downloading ONNX Runtime through the network proxy |
| GitHub evidence | Combined-status lookup returned no statuses; workflow-run lookup returned no PR-triggered runs. Neither proves all Actions runs are absent. |

Checks used the previously installed dependency tree for this repository's unchanged lockfile. Commands were run directly through its binaries to avoid pnpm triggering another failed install. Build/typecheck/lint claims refer to the actual command outputs.

Seven full-suite failures require the missing native helper; CLI apply also fails without it. The root-replacement discovery fixture still fails here and discovery teardown still raises EACCES. Thus there are both environment limitations and unresolved fixture reliability problems.

The fourteen reviewer checks **assert the defect occurred**. Their passing result is reproduction evidence, not evidence that the product is correct. Recording helpers performed ordinary moves only inside synthetic fixture roots; they establish application authorisation/recovery behavior, not Linux native-helper correctness.

## Remaining findings

### F1 — P1: the new native probe can delete pre-existing user files

**Previous finding:** R7. **Evidence:** source inspection; Rust helper not executed here.

[resolve.rs, lines 411–500](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/native/fsops/src/resolve.rs#L411) treats an existing directory named `.fsops-probe` as application-owned. `create_probe_file` accepts existing regular `probe-src` and `probe-dst` files. Cleanup unconditionally unlinks both names, including on partial setup failure.

A synthetic fixture containing `.fsops-probe/probe-src` and `.fsops-probe/probe-dst` with user bytes would therefore have those files removed by the inspected control flow. A collision involving a symlink can also reach unconditional cleanup. The new tests protect a file at the directory name and the *old* probe filenames; they do not establish ownership of existing directory contents.

**Required correction:** use an exclusively created, uniquely named fixture directory; never adopt a pre-existing directory/file by name. Track precisely what this attempt created and clean up only those verified identities. Add pre-existing-directory, partial-setup and concurrent-probe tests. This matters even before approved moves because a probe is supposed to be safe to run.

### F2 — P1: refresh still changes the reviewed taxonomy and recreates the pilot blocker

**Previous finding:** R9, also R1. **Evidence:** two real-Organiser reproductions.

[organiser.ts, lines 234–304](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/src/application/organiser.ts#L234) calls `rebuildTaxonomy` during scan and catalogue refresh. It appends every physical destination directly beneath root, including destinations the user deliberately omitted or mapped under custom category IDs.

Reproduced:
1. Discover nine folders.
2. Approve a valid curated tree containing only the Invoices destination.
3. Classify.
4. Refresh appends the discovered folders again; classification throws “taxonomy curation required … more than 7 children”.

With two folders and a custom Billing category, classification adds automatic categories to the active tree **without incrementing its reviewed revision**. Persisted reviewed state and the actual inference tree consequently differ.

**Required correction:** discovery updates only the physical catalogue. Keep the approved semantic tree immutable until an explicit revisioned edit. Surface new/missing destinations separately. Test curation followed by classify, scan, apply and restart, including more than seven physical folders and nested semantic groups.

### F3 — P1: taxonomy UI and API disagree about successful save responses

**Previous findings:** R9/R13. **Evidence:** authenticated HTTP reproduction plus UI source trace.

[PUT route](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/src/http/routes.ts#L206) returns:
`{ taxonomy: { revision, mappingHash } }`.

[TaxonomyReview.tsx, lines 57–85](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/ui/src/TaxonomyReview.tsx#L57) expects top-level `revision`, plus tree, status, reviewed and destinations. A valid save returns HTTP 200 but takes the UI error branch, displaying “HTTP 200”; the UI retains the old revision. Repeated edits then encounter stale state.

Additionally, the new form creates only root-level existing categories. It cannot create virtual groups, choose a parent, or edit existing labels/descriptions, so the promised curation workflow remains incomplete.

**Required correction:** align the response contract, then reload the full authoritative taxonomy or return it consistently. Exercise add/remove/edit/approve in the browser, including subsequent edits and classification. Add group and parent controls.

### F4 — P1: approvals are checked once, while later effects can execute changed/rejected proposals

**Previous finding:** R1. **Evidence:** two application-service reproductions.

[workflow.ts, lines 398–421](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/src/application/workflow.ts#L398) validates the approval before the loop. `runApplyAction` fetches the mutable proposal but does not recheck its version/state or the current taxonomy immediately before the effect.

Reproduced:
- After the first move, advance the durable-taxonomy callback from revision 1 to 2: the second move still executes.
- After the first move, call the domain rejection function on the second proposal, incrementing it to version 2: the second move still executes under its version-1 approval, although its stored state is rejected.

These are ordinary edits between actions, not a claim about an atomic guarantee against malicious same-user programs.

**Required correction:** validate current versions, eligibility, revisions and approved identities before each effect. Serialise relevant edits with execution where necessary. Assert zero additional helper calls after a rejection, edit, expiry or taxonomy change.

### F5 — P1: forward uncertain outcomes remain terminal; undo retry and cancellation are inconsistent

**Previous finding:** R5. **Evidence:** three reproductions plus source tracing.

[Initial forward-error handling](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/src/application/workflow.ts#L853) commits every helper error as terminal conflict. Reproduction: helper moves the file, then returns PROVIDER_FAILED; the file is at its target but the journal becomes conflict, and resume returns no actions.

[undoAction](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/src/application/workflow.ts#L1208) reconciles an existing intent, but if reconciliation returns anything other than an undone receipt it falls through into another undo attempt. A persistent uncertain no-effect error produces **two helper calls on the second undo request**.

[Cancellation reconciliation](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/src/application/workflow.ts#L472) does not swap the observation roles for undo. Reproduction: crash after the reverse move, request cancel, resume; the returned file is recorded as canceled instead of undone.

Other source concerns remain: OUT_OF_SCOPE is treated as definite absence even though native errno mapping includes symlink/non-directory failures; post-effect fsync errors may map to supposedly definite codes; undo recovery and cancellation still use mutable proposal/catalogue data rather than their immutable action fields. Forward recovery also rebuilds receipt.before from the mutable proposal.

**Required correction:** reconcile both modes from immutable action data; distinguish missing locations from invalid/unobservable paths and pre-effect refusal from post-effect uncertainty. Return the reconciliation outcome without falling through into a second attempt. Never convert unresolved effects to terminal cancellation.

### F6 — P1: the root writer lock does not cover undo and can be stolen from a live writer

**Previous finding:** R6. **Evidence:** two reproductions and lock source.

[undoAction](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/src/application/workflow.ts#L1151) acquires only the service-instance Promise queue; it never acquires the SQLite root lock. Reproduction: hold the root lock as another owner, then undo an applied action; the undo succeeds.

[Lock acquisition](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/src/adapters/persistence/repositories.ts#L527) expires after 60 seconds, without heartbeat, fencing, or checking that the owner died. A controlled clock advance of 60,001 ms allows a second owner to acquire the still-held lock.

The existing concurrency test accepts an empty result through `every(...)`, so it does not prove that a clear busy/stale outcome was returned. Retention can also delete a root's lock while purging another batch.

**Required correction:** use a process-safe root lock for apply, resume, undo and conflicting maintenance. Do not assume elapsed time proves process death. If using leases, renew/fence them and halt effects on lost ownership. Test distinct processes, a long-running live writer and owner death; report busy explicitly.

### F7 — P1: batch isolation remains root-wide in review, approval and the HTTP wrapper

**Previous findings:** R1/R12. **Evidence:** three reproductions plus HTTP source.

[itemsForBatch](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/src/application/organiser.ts#L502) interprets an empty membership set as an old database and falls back to every historical root item. A genuinely empty new scan consequently classifies old, now-missing files.

Proposal listing remains root-wide. Approval creation tests [root membership](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/src/application/workflow.ts#L216), not batch membership. Reproduced: an empty later batch can list and approve an earlier batch's proposal.

The HTTP `Organiser.applyBatch(batchId, ...)` still discards its URL batch ID and applies the approval's own batch, bypassing the service-level mismatched-batch check for this transport.

**Required correction:** migrate old memberships explicitly; an empty current batch must stay empty. Bind proposals/decisions/approvals to their actual batch or immutable classification run. Pass and validate the requested batch ID through the HTTP wrapper.

### F8 — P2: changed-file refusals leak descriptors; “anchored” reads are still path-based

**Previous finding:** R3. **Evidence:** descriptor-count reproduction and source inspection.

[openCandidate](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/src/adapters/filesystem/source.ts#L177) closes the descriptor on thrown exceptions, but not on returned errors after open. Ten attempts to classify changed bytes leave **ten additional open descriptors** until later runtime cleanup.

The implementation uses path-based lstat/open, without O_NOFOLLOW or an anchored openat2 read handle. The simple post-scan symlink reproduction is now refused, which is an improvement; the broader no-symlink/no-mount guarantee is not established. `inspect` also hashes the opened descriptor before checking it against lstat.

**Required correction:** close on every unsuccessful return, transferring ownership only on success. Use the specified anchored read boundary and test ancestor/root/source replacement around the actual open/read boundaries.

### F9 — P2: new-folder execution is deferred in code, not implemented

**Previous finding:** R10. **Evidence:** source inspection.

`proposeFolder` now saves a logical candidate and performs no immediate mkdir. That removes the earlier premature mutation. However, there is still no connected accept → taxonomy mapping → placement regeneration → approved mkdir/move workflow. Candidate rows do not provide the promised complete creation intent/identity recovery path. Native mkdir also still adopts an existing directory on EEXIST.

**Required correction:** either complete the specified workflow with durable creation intents and receipts, or clearly narrow the release to existing destinations and leave FR-06/R10 open. A checked box should not imply the full feature exists.

### F10 — P2: live audit/export is neither batch-exact nor replayable

**Previous finding:** R12. **Evidence:** export reproduction and source inspection.

[exportLiveBatch](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/src/eval/live-export.ts#L32) loads all root proposals. Reproduction: export a new empty batch; it contains zero items but one earlier proposal.

Classification persists only the final node's provider decision, discarding earlier route decisions, and does not persist extracted evidence. Exported decisions omit answers/probability vectors and schema hash. The private-evidence option exports snapshots rather than the model evidence state, so it cannot replay the treatment. Default exports still contain raw basenames/proposal/journal data despite the broad “no private evidence” note.

Retention removes action records for applied batches as well as completed payloads, losing conditional-undo history; it does not implement the specified distinct evidence/action retention periods.

**Required correction:** persist complete immutable per-run evidence/routes and explicit batch associations. Export exact selected runs with a documented redaction contract. Preserve undo-capable action state according to the specification.

### F11 — P2: release CI cannot run as written, and important tests remain weak

**Previous finding:** R15. **Evidence:** source inspection and fresh local failures.

[ci.yml line 18](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/.github/workflows/ci.yml#L18) uses `pnpm/action-setup-v4`, lacking the required action ref. It should use `pnpm/action-setup@v4`. Correcting this still requires an actual green Node-22/native/browser run.

Application/UI typechecks are wired and pass here; E2E TypeScript remains outside that command. The hostile-filename browser test still does not scan and conditionally skips its assertion when the filename is absent. Responsive coverage still checks the initial navigation. Journal tests simulate thrown exceptions and release locks in finally, rather than killing an actual writer process.

**Required correction:** fix the action reference, strengthen non-vacuous assertions and add actual process-death/concurrency tests. Rerun on the supported runtime with native helper and browsers, then update release evidence.

### F12 — P2: evaluation provenance is incorrect and R11 remains partial

**Previous finding:** R11. **Evidence:** fresh fixture output, passing matched-request regression and source inspection.

The common-budget comparison fix is real. Exact tokenizer validation, rejection of silent provider clipping, the global inference queue and per-item deadlines remain unimplemented and are explicitly acknowledged in the correction plan.

The synthetic fixture now prints **synthetic: false** from [fixture.ts line 71](https://github.com/arvindsoni2/Classifier/blob/b0c16da62c9be95df9a1f0065d6a2f9235876bc3/src/eval/fixture.ts#L68). Export files use a string under the `synthetic` field rather than a boolean. Calibration defaults to split “all” unless callers explicitly pass a split; it does not inherit the run's split.

**Required correction:** keep provenance and a boolean synthetic flag separate and consistent; derive calibration cohorts from the run by default. Complete exact-encoding and concurrency limits before recommending a provider. No held-out Laya/Clef accuracy evidence was added by this series.

## Status of the previous review

| Previous finding | Follow-up assessment |
| --- | --- |
| R1 approval/revisions | Partial; modes and batch-entry revision checks work, per-effect checks and transport membership remain |
| R2 approved identities | Forward replacement regression passes; recovery/undo coverage remains incomplete |
| R3 scoped classification reads | Simple symlink swap refused; descriptor cleanup and anchored resolution remain |
| R4 rejection/version regression | Targeted added regressions pass; execution must still revalidate edits |
| R5 recovery | Partial; forward uncertainty, undo fallthrough and cancellation defects reproduced |
| R6 journal/isolation | Data fields added; lock coverage/liveness and immutable recovery remain incomplete |
| R7 probe safety | Still blocked; new pre-existing-file deletion path found by inspection |
| R8 production launch | Addressed in fresh production startup tests |
| R9 taxonomy | Still blocked by refresh/curation behavior and UI response contract |
| R10 new folders | Premature mkdir removed; full accepted-folder execution remains absent |
| R11 evaluations | Common budget improved; provenance, exact tokens, deadlines/queue remain |
| R12 audit/export | Partial; membership tables added but end-to-end isolation/replay/retention incomplete |
| R13 review UX | Forward-summary and undo controls added; taxonomy interaction remains broken |
| R14 Jev | Explicitly deferred; no production transport or model comparison claimed |
| R15 release proof | Improved typechecks/docs; malformed CI and incomplete native/browser/crash proof |

The correction plan marks R1/R7/R9/R10/R11/R12/R13 complete while describing or containing unfinished requirements. Keep those findings open until their acceptance criteria pass; split partially fixed findings into completed and pending tasks.

## Next correction sequence

1. **Safety:** F1, F4, F5 and F6, with regression tests at actual helper/process boundaries.
2. **Usable pilot:** F2, F3 and F7. A curated >7-folder collection must classify without silently changing the reviewed tree.
3. **Scope and audit:** F8 and F10. Verify bounded anchored reads, exact batches and replayable evidence.
4. **Scope decision and evaluations:** F9/F12. Complete new-folder execution or explicitly defer it; then run a labelled read-only Laya/Clef comparison.
5. **Release evidence:** F11, supported Node 22, native tests, browser workflow, real process termination and fresh checked status.

**Recommendation:** return this correction list to OpenCode. Preserve the current foundations, but do not treat the corrective commits or unit-test count as clearance for real-file apply.

## Provenance

Generated by Codex from the pinned GitHub revision, unchanged specification baseline, previous review and fresh local checks. The exact reviewer model/reasoning configuration is not exposed and was not inferred. No private Downloads material or live model evidence was used.

