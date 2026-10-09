/**
 * Batch orchestration, cancellation and stage progression (LLD §1/§6,
 * plan Task 8). The application service owns the writer lock, claims
 * actions transactionally, journals intent BEFORE effects, invokes the
 * helper exactly once per effect, and reconciles interrupted work from the
 * journal — never by blindly re-running a filesystem syscall.
 */

import { randomUUID } from 'node:crypto';
import {
  err,
  ok,
  type ApprovedMove,
  type Destination,
  type ErrorCode,
  type Id,
  type Item,
  type MoveReceipt,
  type Proposal,
  type Result,
  type Revision,
  type RootConfig,
  type Sha256,
  type Snapshot,
} from '../domain/contracts.js';
import { createApproval as createApprovalCore, validateApproval } from '../domain/planner.js';
import type { Repositories } from '../adapters/persistence/repositories.js';
import type { FilesystemHealth } from '../adapters/filesystem/helper.js';
import { reconcileAction } from './recovery.js';

/** Points where a simulated process death may be injected (tests). */
export type FaultPoint =
  | 'before-intent'
  | 'after-intent'
  | 'after-rename'
  | 'after-verify'
  | 'before-applied-commit';

export interface HelperPort {
  probe(root: RootConfig): Promise<Result<FilesystemHealth>>;
  inspectAt(root: RootConfig, segments: readonly string[]): Promise<Result<Snapshot>>;
  moveAt(
    action: ApprovedMove,
    root: RootConfig,
    destination: Destination,
  ): Promise<Result<MoveReceipt>>;
  mkdirAt(
    root: RootConfig,
    parent: Destination,
    segment: string,
  ): Promise<Result<Destination>>;
  undoAt(
    action: {
      actionId: Id;
      approvalId: Id;
      basename: string;
      targetSegments: string[];
      expected: Snapshot;
    },
    root: RootConfig,
  ): Promise<Result<MoveReceipt>>;
}

export interface WorkflowDeps {
  repositories: Repositories;
  helper: HelperPort;
  clock: () => Date;
  /** Discovery-time destination catalogue (id → pinned identity). */
  destinations: Map<Id, Destination>;
  /** Fault injection for crash simulation; may throw CrashSignal. */
  faultHook?: (point: FaultPoint, context: { actionId: string; proposalId: string }) => void;
  requestId?: () => string;
}

export type ActionOutcome =
  | 'applied'
  | 'conflict'
  | 'stale'
  | 'canceled'
  | 'undone';

export interface ActionResult {
  actionId: Id;
  proposalId: Id;
  outcome: ActionOutcome;
  receipt?: MoveReceipt;
  detail: string;
}

export interface BatchResult {
  batchId: Id;
  results: ActionResult[];
}

const TERMINAL_STATES = new Set(['applied', 'conflict', 'stale', 'canceled', 'undone']);

export class ApplicationService {
  private readonly repositories: Repositories;
  private readonly helper: HelperPort;
  private readonly clock: () => Date;
  private readonly destinations: Map<Id, Destination>;
  private readonly faultHook?: WorkflowDeps['faultHook'];
  private readonly requestIdFn: () => string;
  /** The writer lock: one apply/recovery operation at a time (LLD §4). */
  private writerLock: Promise<unknown> = Promise.resolve();

  constructor(deps: WorkflowDeps) {
    this.repositories = deps.repositories;
    this.helper = deps.helper;
    this.clock = deps.clock;
    this.destinations = deps.destinations;
    this.faultHook = deps.faultHook;
    this.requestIdFn = deps.requestId ?? (() => `req-${randomUUID()}`);
  }

  /** Creates and journals an approval binding the current versions. */
  createApproval(
    batchId: Id,
    actions: { proposalId: Id; version: Revision }[],
    mode: 'apply' | 'undo',
    now: Date,
  ): Result<{ id: Id; actionSetHash: Sha256; expiresAt: string }> {
    const selected: Proposal[] = [];
    for (const action of actions) {
      const proposal = this.repositories.proposals.get(action.proposalId);
      if (proposal === null || proposal.version !== action.version) {
        return err('STALE', `proposal ${action.proposalId} is not at version ${action.version}`);
      }
      selected.push(proposal);
    }
    const batch = this.repositories.batches.get(batchId);
    if (batch === null) return err('OUT_OF_SCOPE', `unknown batch ${batchId}`);
    const created = createApprovalCore(batch, selected, mode, now);
    if (!created.ok) return created;
    this.repositories.approvals.insert({
      id: created.value.id,
      batchId,
      actionSetHash: created.value.actionSetHash,
      taxonomyRevision: created.value.taxonomyRevision,
      policyRevision: created.value.policyRevision,
      selectedActionsJson: JSON.stringify(created.value.actions),
      expiresAt: created.value.expiresAt,
      mode,
    });
    return ok({ id: created.value.id, actionSetHash: created.value.actionSetHash, expiresAt: created.value.expiresAt });
  }

  /** Serialises writer operations: apply/recovery/undo never overlap. */
  private withWriterLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writerLock.then(fn, fn);
    this.writerLock = next.catch(() => undefined);
    return next;
  }

  /** Current bound state an approval is validated against. */
  private currentContext(approvalActions: { proposalId: Id; version: Revision }[]): {
    taxonomyRevision: Revision;
    policyRevision: Revision;
    actions: { proposalId: Id; version: Revision }[];
  } {
    const current = approvalActions.map((action) => {
      const proposal = this.repositories.proposals.get(action.proposalId);
      return { proposalId: action.proposalId, version: proposal?.version ?? -1 };
    });
    const first = this.repositories.proposals.get(approvalActions[0]?.proposalId ?? '');
    return {
      taxonomyRevision: first?.taxonomyRevision ?? 0,
      policyRevision: first?.policyRevision ?? 0,
      actions: current,
    };
  }

  private approvalValid(approvalId: Id | null): boolean {
    if (approvalId === null) return false;
    const approval = this.repositories.approvals.get(approvalId);
    if (approval === null) return false;
    const selected = JSON.parse(approval.selectedActionsJson) as {
      proposalId: Id;
      version: Revision;
    }[];
    const validation = validateApproval(
      {
        id: approval.id,
        batchId: approval.batchId,
        actions: selected,
        actionSetHash: approval.actionSetHash,
        taxonomyRevision: approval.taxonomyRevision,
        policyRevision: approval.policyRevision,
        approvedAt: '',
        expiresAt: approval.expiresAt,
        mode: approval.mode,
      },
      this.currentContext(selected),
      this.clock(),
    );
    return validation.ok;
  }

  /**
   * Applies a concrete approved batch: every selected action is claimed
   * transactionally, journalled before effects, executed once, and its
   * receipt recorded. A repeated apply reuses verified results.
   */
  applyBatch(batchId: Id, approvalId: Id, actionSetHash: Sha256): Promise<BatchResult> {
    return this.withWriterLock(async () => {
      const batch = this.repositories.batches.get(batchId);
      if (batch === null) {
        return { batchId, results: [] };
      }
      const approval = this.repositories.approvals.get(approvalId);
      if (approval === null) {
        return {
          batchId,
          results: [],
        };
      }
      const selected = JSON.parse(approval.selectedActionsJson) as {
        proposalId: Id;
        version: Revision;
      }[];
      if (approval.actionSetHash !== actionSetHash) {
        return {
          batchId,
          results: selected.map((action) => ({
            actionId: action.proposalId,
            proposalId: action.proposalId,
            outcome: 'stale' as ActionOutcome,
            detail: 'the supplied action-set hash does not match the approval; refusal, not a partial run',
          })),
        };
      }
      if (!this.approvalValid(approvalId)) {
        return {
          batchId,
          results: selected.map((action) => ({
            actionId: action.proposalId,
            proposalId: action.proposalId,
            outcome: 'stale' as ActionOutcome,
            detail: 'the approval is stale or expired against current versions; nothing executed',
          })),
        };
      }

      const results: ActionResult[] = [];
      for (const action of selected) {
        if (this.repositories.batches.get(batchId)?.cancellationRequested === true) {
          results.push({
            actionId: action.proposalId,
            proposalId: action.proposalId,
            outcome: 'canceled',
            detail: 'cancellation was requested before this action',
          });
          continue;
        }
        results.push(await this.runApplyAction(batch, approval.id, action));
      }
      return { batchId, results };
    });
  }

  /**
   * Runs one approved action: claim → intent → helper → verified commit.
   * Every step is journalled; fault points simulate process death.
   */
  private async runApplyAction(
    batch: { id: Id; rootId: Id },
    approvalId: Id,
    action: { proposalId: Id; version: Revision },
    existingActionId?: Id,
  ): Promise<ActionResult> {
    const actionId = existingActionId ?? `action-${randomUUID()}`;
    const proposal = this.repositories.proposals.get(action.proposalId);
    if (proposal === null) {
      return { actionId, proposalId: action.proposalId, outcome: 'stale', detail: 'proposal vanished' };
    }

    // A repeated claim is idempotent; the journal's UNIQUE constraint is
    // the double-claim backstop in concurrent writers.
    const existing = this.repositories.actions.find(action.proposalId, action.version, 'apply');
    if (existing !== null && existingActionId === undefined) {
      if (existing.state === 'applied' && existing.receiptJson !== null) {
        const receipt = JSON.parse(existing.receiptJson) as MoveReceipt;
        return {
          actionId: existing.id,
          proposalId: action.proposalId,
          outcome: 'applied',
          receipt,
          detail: 'idempotent replay: the verified receipt is reused without re-running the move',
        };
      }
      // Fall through to resume-style handling below via reconciliation.
      return this.resumeApplyAction(batch, existing);
    }

    const root = this.rootConfigFor(batch.rootId);
    if (root === null) {
      return { actionId, proposalId: action.proposalId, outcome: 'conflict', detail: 'root record is unavailable' };
    }
    const destination = this.destinations.get(proposal.destinationId);
    if (destination === undefined) {
      return {
        actionId,
        proposalId: action.proposalId,
        outcome: 'conflict',
        detail: `destination ${proposal.destinationId} is not in the discovery catalogue`,
      };
    }

    // Claim first: a crash at any later point leaves a journalled, resumable
    // action. UNIQUE(proposal, version, mode) makes a double claim fail
    // loudly rather than duplicate an effect.
    if (existingActionId === undefined) {
      this.repositories.transaction(() => {
        this.repositories.actions.save({
          id: actionId,
          proposalId: action.proposalId,
          proposalVersion: action.version,
          mode: 'apply',
          approvalId,
          state: 'planned',
        });
        this.repositories.actions.appendEvent(actionId, {
          event: 'planned',
          recordedAt: this.clock().toISOString(),
        });
      });
    }

    this.faultHook?.('before-intent', { actionId, proposalId: action.proposalId });
    this.repositories.transaction(() => {
      this.repositories.actions.update(actionId, { state: 'intent' });
      this.repositories.actions.appendEvent(actionId, {
        event: 'intent',
        recordedAt: this.clock().toISOString(),
        payloadJson: JSON.stringify({
          sourceBasename: proposal.basename,
          destinationSegments: destination.segments,
          expected: proposal.expected,
          requestId: this.requestIdFn(),
        }),
      });
    });
    this.faultHook?.('after-intent', { actionId, proposalId: action.proposalId });

    const approvedMove: ApprovedMove = {
      kind: 'move_file',
      actionId,
      rootId: batch.rootId,
      sourceBasename: proposal.basename,
      destinationSegments: destination.segments,
      expected: proposal.expected,
      approvalId,
    };
    const result = await this.helper.moveAt(approvedMove, root, destination);
    this.faultHook?.('after-rename', { actionId, proposalId: action.proposalId });

    if (!result.ok) {
      this.repositories.transaction(() => {
        this.repositories.actions.update(actionId, { state: 'conflict' });
        this.repositories.actions.appendEvent(actionId, {
          event: 'conflict',
          recordedAt: this.clock().toISOString(),
          payloadJson: JSON.stringify({ code: result.code, detail: result.detail }),
        });
      });
      return {
        actionId,
        proposalId: action.proposalId,
        outcome: 'conflict',
        detail: `${result.code}: ${result.detail}`,
      };
    }

    if (result.value.outcome === 'conflict') {
      this.repositories.transaction(() => {
        this.repositories.actions.update(actionId, { state: 'conflict', receiptJson: JSON.stringify(result.value) });
        this.repositories.actions.appendEvent(actionId, {
          event: 'conflict',
          recordedAt: this.clock().toISOString(),
          payloadJson: JSON.stringify({ outcome: 'conflict', verified: result.value.verified }),
        });
      });
      return {
        actionId,
        proposalId: action.proposalId,
        outcome: 'conflict',
        receipt: result.value,
        detail: 'the helper reported a conflict after the rename; material preserved, never overwritten',
      };
    }

    this.faultHook?.('after-verify', { actionId, proposalId: action.proposalId });
    this.faultHook?.('before-applied-commit', { actionId, proposalId: action.proposalId });
    this.repositories.transaction(() => {
      this.repositories.actions.update(actionId, {
        state: 'applied',
        receiptJson: JSON.stringify(result.value),
      });
      this.repositories.actions.appendEvent(actionId, {
        event: 'applied',
        recordedAt: this.clock().toISOString(),
        payloadJson: JSON.stringify({ verified: result.value.verified }),
      });
    });

    return {
      actionId,
      proposalId: action.proposalId,
      outcome: 'applied',
      receipt: result.value,
      detail: 'applied and verified by the helper',
    };
  }

  /** Resume handling for an already-claimed action (interrupted work). */
  private async resumeApplyAction(
    batch: { id: Id; rootId: Id },
    existing: { id: Id; proposalId: Id; approvalId: Id },
  ): Promise<ActionResult> {
    const proposal = this.repositories.proposals.get(existing.proposalId);
    if (proposal === null) {
      return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'stale', detail: 'proposal vanished' };
    }
    const root = this.rootConfigFor(batch.rootId);
    if (root === null) {
      return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'conflict', detail: 'root record is unavailable' };
    }
    const destination = this.destinations.get(proposal.destinationId);
    if (destination === undefined) {
      return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'conflict', detail: 'destination absent from the catalogue' };
    }

    const observations = await this.observe(root, proposal.basename, destination.segments);
    if (!observations.ok) {
      return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'conflict', detail: observations.detail };
    }
    const outcome = reconcileAction(
      {
        actionId: existing.id,
        proposalId: existing.proposalId,
        proposalVersion: proposal.version,
        mode: 'apply',
        approvalId: existing.approvalId,
        state: 'intent',
        expected: proposal.expected,
        sourceBasename: proposal.basename,
        targetSegments: destination.segments,
        approvalValid: this.approvalValid(existing.approvalId),
      },
      observations.value,
    );
    if (!outcome.ok) {
      return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'conflict', detail: outcome.detail };
    }
    switch (outcome.value.kind) {
      case 'applied': {
        const receipt: MoveReceipt = {
          kind: 'move_file',
          actionId: existing.id,
          requestId: this.requestIdFn(),
          outcome: 'moved',
          before: proposal.expected,
          after: outcome.value.after,
          createdDirectoryIds: [],
          verified: true,
        };
        this.repositories.transaction(() => {
          this.repositories.actions.update(existing.id, { state: 'applied', receiptJson: JSON.stringify(receipt) });
          this.repositories.actions.appendEvent(existing.id, {
            event: 'applied',
            recordedAt: this.clock().toISOString(),
            payloadJson: JSON.stringify({ recovered: true, reason: outcome.value.kind === 'applied' ? outcome.value.reason : '' }),
          });
        });
        return {
          actionId: existing.id,
          proposalId: existing.proposalId,
          outcome: 'applied',
          receipt,
          detail: 'recovered from the journal: the move took effect; recorded without re-running the syscall',
        };
      }
      case 'retry': {
        this.repositories.transaction(() => {
          this.repositories.actions.appendEvent(existing.id, {
            event: 'reconciled',
            recordedAt: this.clock().toISOString(),
            payloadJson: JSON.stringify({ reason: outcome.value.kind === 'retry' ? outcome.value.reason : '' }),
          });
        });
        // Revalidate then retry with the SAME action id: the claim exists.
        return this.runApplyAction(
          batch,
          existing.approvalId,
          { proposalId: existing.proposalId, version: proposal.version },
          existing.id,
        );
      }
      case 'stale': {
        this.repositories.transaction(() => {
          this.repositories.actions.update(existing.id, { state: 'stale' });
          this.repositories.actions.appendEvent(existing.id, {
            event: 'stale',
            recordedAt: this.clock().toISOString(),
            payloadJson: JSON.stringify({ reason: outcome.value.reason }),
          });
        });
        return {
          actionId: existing.id,
          proposalId: existing.proposalId,
          outcome: 'stale',
          detail: outcome.value.reason,
        };
      }
      default:
        this.repositories.transaction(() => {
          this.repositories.actions.update(existing.id, { state: 'conflict' });
          this.repositories.actions.appendEvent(existing.id, {
            event: 'conflict',
            recordedAt: this.clock().toISOString(),
            payloadJson: JSON.stringify({ reason: outcome.value.reason }),
          });
        });
        return {
          actionId: existing.id,
          proposalId: existing.proposalId,
          outcome: 'conflict',
          detail: outcome.value.reason,
        };
    }
  }

  /** Reads both locations through the helper; never by direct fs access. */
  private async observe(
    root: RootConfig,
    basename: string,
    targetSegments: readonly string[],
  ): Promise<Result<{ source: { exists: boolean; snapshot: Snapshot | null }; target: { exists: boolean; snapshot: Snapshot | null } }>> {
    const source = await this.helper.inspectAt(root, [basename]);
    const target = await this.helper.inspectAt(root, [...targetSegments, basename]);
    return ok({
      source: source.ok ? { exists: true, snapshot: source.value } : { exists: false, snapshot: null },
      target: target.ok ? { exists: true, snapshot: target.value } : { exists: false, snapshot: null },
    });
  }

  private rootConfigFor(rootId: Id): RootConfig | null {
    const record = this.repositories.roots.get(rootId);
    if (record === null) return null;
    return {
      rootId: record.id,
      absolutePath: record.canonicalPath,
      device: record.device,
      inode: record.inode,
      inboxDepth: 0,
      directoryDepth: 3,
      policyRevision: record.policyRevision,
    };
  }

  /**
   * Reconciles unfinished actions for a batch: source-only retries only
   * with a valid approval, target-only records Applied, everything else
   * conflicts. No action is blindly re-run.
   */
  resumeBatch(batchId: Id): Promise<BatchResult> {
    return this.withWriterLock(async () => {
      const batch = this.repositories.batches.get(batchId);
      if (batch === null) return { batchId, results: [] };
      const approvals = this.repositories.approvals.listByBatch(batchId);
      const results: ActionResult[] = [];
      const seen = new Set<string>();
      for (const approval of approvals) {
        for (const record of this.repositories.actions.listByApproval(approval.id)) {
          if (seen.has(record.id) || TERMINAL_STATES.has(record.state)) continue;
          seen.add(record.id);
          if (batch.cancellationRequested === true) {
            this.repositories.actions.update(record.id, { state: 'canceled' });
            results.push({
              actionId: record.id,
              proposalId: record.proposalId,
              outcome: 'canceled',
              detail: 'cancellation was requested before this action',
            });
            continue;
          }
          if (record.mode === 'apply') {
            results.push(
              await this.resumeApplyAction(
                { id: batch.id, rootId: batch.rootId },
                { id: record.id, proposalId: record.proposalId, approvalId: record.approvalId },
              ),
            );
          }
        }
      }
      return { batchId, results };
    });
  }

  /**
   * Conditional undo of one applied action under a SEPARATE undo approval.
   * The original location must be free and the target identity/hash
   * unchanged; otherwise it is a conflict, never an overwrite.
   */
  undoAction(actionId: Id, undoApprovalId: Id): Promise<Result<MoveReceipt>> {
    return this.withWriterLock(async () => {
      const action = this.repositories.actions.get(actionId);
      if (action === null) return err('OUT_OF_SCOPE', `unknown action ${actionId}`);
      if (action.state !== 'applied' || action.receiptJson === null) {
        return err('STALE', 'only an applied action with a verified receipt can be undone');
      }
      const receipt = JSON.parse(action.receiptJson) as MoveReceipt;
      const undoApproval = this.repositories.approvals.get(undoApprovalId);
      if (undoApproval === null) return err('UNAUTHORISED', 'unknown undo approval');
      const undoSelected = JSON.parse(undoApproval.selectedActionsJson) as {
        proposalId: Id;
        version: Revision;
      }[];
      if (!this.approvalValid(undoApprovalId)) {
        return err('STALE', 'the undo approval is stale or expired against current versions');
      }
      const selected = undoSelected.find((entry) => entry.proposalId === action.proposalId);
      if (selected === undefined || selected.version !== action.proposalVersion) {
        return err('STALE', 'the undo approval does not bind this action version');
      }

      const proposal = this.repositories.proposals.get(action.proposalId);
      if (proposal === null) return err('OUT_OF_SCOPE', 'proposal vanished');
      const destination = this.destinations.get(proposal.destinationId);
      if (destination === undefined) return err('OUT_OF_SCOPE', 'destination absent from the catalogue');
      const batch = this.repositories.batches.get(undoApproval.batchId);
      if (batch === null) return err('OUT_OF_SCOPE', 'batch vanished');
      const root = this.rootConfigFor(batch.rootId);
      if (root === null) return err('OUT_OF_SCOPE', 'root record is unavailable');

      // Undo has its own intent record (mode 'undo', same proposal+version).
      const undoAction = this.repositories.actions.find(action.proposalId, action.proposalVersion, 'undo');
      if (undoAction !== null && undoAction.state === 'undone' && undoAction.receiptJson !== null) {
        return ok(JSON.parse(undoAction.receiptJson) as MoveReceipt);
      }
      const undoActionId = undoAction?.id ?? `action-${randomUUID()}`;
      this.repositories.transaction(() => {
        if (undoAction === null) {
          this.repositories.actions.save({
            id: undoActionId,
            proposalId: action.proposalId,
            proposalVersion: action.proposalVersion,
            mode: 'undo',
            approvalId: undoApprovalId,
            state: 'undo_intent',
          });
        } else {
          this.repositories.actions.update(undoAction.id, { state: 'undo_intent' });
        }
        this.repositories.actions.appendEvent(undoActionId, {
          event: 'undo_intent',
          recordedAt: this.clock().toISOString(),
          payloadJson: JSON.stringify({ targetSegments: destination.segments, basename: proposal.basename }),
        });
      });

      const result = await this.helper.undoAt(
        {
          actionId: undoActionId,
          approvalId: undoApprovalId,
          basename: proposal.basename,
          targetSegments: destination.segments,
          expected: receipt.after ?? proposal.expected,
        },
        root,
      );
      if (!result.ok) {
        this.repositories.transaction(() => {
          this.repositories.actions.update(undoActionId, { state: 'conflict' });
          this.repositories.actions.appendEvent(undoActionId, {
            event: 'conflict',
            recordedAt: this.clock().toISOString(),
            payloadJson: JSON.stringify({ code: result.code, detail: result.detail }),
          });
        });
        return result;
      }
      if (result.value.outcome === 'conflict') {
        this.repositories.transaction(() => {
          this.repositories.actions.update(undoActionId, { state: 'conflict', receiptJson: JSON.stringify(result.value) });
          this.repositories.actions.appendEvent(undoActionId, {
            event: 'conflict',
            recordedAt: this.clock().toISOString(),
          });
        });
        return err('CONFLICT', 'the reverse move ended in conflict; material preserved');
      }
      this.repositories.transaction(() => {
        this.repositories.actions.update(undoActionId, { state: 'undone', receiptJson: JSON.stringify(result.value) });
        this.repositories.actions.appendEvent(undoActionId, {
          event: 'undone',
          recordedAt: this.clock().toISOString(),
          payloadJson: JSON.stringify({ verified: result.value.verified }),
        });
      });
      return ok(result.value);
    });
  }

  /**
   * Creates one approved new folder segment and records a reviewed
   * candidate group (FR-06): no proposal targets a candidate until the
   * group is accepted, and the directory already exists until then only if
   * the user asked for it.
   */
  mkdirAt(
    root: RootConfig,
    parentSegments: readonly string[],
    segment: string,
    batchId: Id,
    label: string,
  ): Promise<Result<Destination>> {
    return this.withWriterLock(async () => {
      const parent: Destination = {
        id: `dest-${JSON.stringify(parentSegments).slice(0, 32)}`,
        segments: [...parentSegments],
        device: root.device,
        inode: root.inode,
        status: 'observed',
      };
      const created = await this.helper.mkdirAt(root, parent, segment);
      if (!created.ok) return created;
      this.repositories.folderCandidates.insert({
        id: created.value.id,
        batchId,
        label,
        membersJson: JSON.stringify([]),
        destinationParentId: created.value.id,
        reviewState: 'draft',
      });
      return ok(created.value);
    });
  }

  /** Read-only catalogue surfaces for the HTTP layer (plan Task 6). */
  listProposals(batchId: Id): Result<Proposal[]> {
    const proposals: Proposal[] = [];
    for (const approval of this.repositories.approvals.listByBatch(batchId)) {
      for (const record of this.repositories.actions.listByApproval(approval.id)) {
        const proposal = this.repositories.proposals.get(record.proposalId);
        if (proposal !== null) proposals.push(proposal);
      }
    }
    return ok(proposals);
  }

  listFolderCandidates(batchId: Id): Result<{ id: Id; label: string; reviewState: string }[]> {
    return ok(
      this.repositories.folderCandidates.listByBatch(batchId).map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        reviewState: candidate.reviewState,
      })),
    );
  }

  /** Items are part of the batch catalogue; exposed for the HTTP layer. */
  createBatch(_rootId: Id): Result<{ id: Id }> {
    return err('UNSUPPORTED', 'scan orchestration arrives with the discovery workflow');
  }

  /** Placeholder for classify orchestration (Milestone B review surfaces). */
  classifyBatch(_batchId: Id, _provider: string): Promise<Result<unknown>> {
    return Promise.resolve(err('UNSUPPORTED', 'classification orchestration arrives with the review workflow'));
  }
}

export type { ErrorCode, Item };
