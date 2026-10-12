/**
 * Batch orchestration, cancellation and stage progression (LLD §1/§6,
 * plan Task 8). The application service owns the writer lock, claims
 * actions transactionally, journals intent BEFORE effects, invokes the
 * helper exactly once per effect, and reconciles interrupted work from the
 * journal — never by blindly re-running a filesystem syscall.
 */

import { createHash, randomUUID } from 'node:crypto';
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
import type { LocationObservations, ReconcileRecord } from './recovery.js';

/** Points where a simulated process death may be injected (tests). */
export type FaultPoint =
  | 'before-intent'
  | 'after-intent'
  | 'after-rename'
  | 'after-verify'
  | 'before-applied-commit'
  // Undo boundaries (spec review R5/R15): an interrupted undo must be as
  // testable and recoverable as an interrupted apply.
  | 'before-undo-intent'
  | 'after-undo-intent'
  | 'after-undo-rename'
  | 'after-undo-verify'
  | 'before-undone-commit';

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
  /** Durable current taxonomy revision (spec review R1: validate against
   *  durable state, not the approval's own bound values). */
  currentTaxonomyRevision?: () => Revision;
  /** Durable current policy revision from the root record. */
  currentPolicyRevision?: () => Revision;
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

/** A lock older than this belongs to a crashed writer and may be taken over. */
const WRITER_LOCK_STALE_MS = 60_000;

/**
 * Helper failures that definitely mean "nothing happened" (the helper
 * verifies before any effect). Everything else — transport failures,
 * timeouts, post-effect fsync errors — is uncertain and must be reconciled
 * against reality rather than committed as a terminal conflict.
 */
const DEFINITE_REFUSALS = new Set([
  'COLLISION',
  'OUT_OF_SCOPE',
  'NOT_FOUND',
  'OVERSIZE',
  'CROSS_MOUNT',
  'STALE',
  'INVALID_DECISION',
  'UNSUPPORTED',
  'UNAUTHORISED',
]);

function isDefiniteRefusal(failure: { code: string }): boolean {
  return DEFINITE_REFUSALS.has(failure.code);
}

/** A confirmed-missing location (ENOENT) is the only reading that means
 * "absent"; symlink/type/mount refusals (OUT_OF_SCOPE) are unobservable
 * and must never be mistaken for an empty location (spec review F5). */
function isDefiniteAbsence(failure: { code: string }): boolean {
  return failure.code === 'NOT_FOUND';
}

/**
 * Root/destination identity captured when an approval was created (spec
 * review R2). `apply` and `undo` must act on these pins: a directory that was
 * replaced after approval conflicts instead of silently re-pinning.
 */
export interface ApprovalPins {
  root: { device: string; inode: string };
  destinations: { proposalId: Id; destinationId: Id; device: string; inode: string }[];
}

/** The approval's pin for one proposal, when present. */
function pinFor(pins: ApprovalPins, proposalId: Id): { destinationId: Id; device: string; inode: string } | null {
  const pin = pins.destinations.find((entry) => entry.proposalId === proposalId);
  if (pin === undefined) return null;
  return { destinationId: pin.destinationId, device: pin.device, inode: pin.inode };
}

function parsePins(approval: { pinsJson?: string | null }): ApprovalPins | null {
  if (approval.pinsJson === undefined || approval.pinsJson === null) return null;
  try {
    const parsed = JSON.parse(approval.pinsJson) as ApprovalPins;
    if (typeof parsed.root?.device !== 'string' || !Array.isArray(parsed.destinations)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export class ApplicationService {
  private readonly repositories: Repositories;
  private readonly helper: HelperPort;
  private readonly clock: () => Date;
  private readonly destinations: Map<Id, Destination>;
  private readonly faultHook?: WorkflowDeps['faultHook'];
  private readonly requestIdFn: () => string;
  /** Durable current taxonomy revision, supplied by the application (R1). */
  private readonly currentTaxonomyRevisionFn?: () => Revision;
  /** Durable current policy revision, supplied by the application (R1). */
  private readonly currentPolicyRevisionFn?: () => Revision;
  /** The writer lock: one apply/recovery operation at a time (LLD §4). */
  private writerLock: Promise<unknown> = Promise.resolve();

  constructor(deps: WorkflowDeps) {
    this.repositories = deps.repositories;
    this.helper = deps.helper;
    this.clock = deps.clock;
    this.destinations = deps.destinations;
    this.faultHook = deps.faultHook;
    this.requestIdFn = deps.requestId ?? (() => `req-${randomUUID()}`);
    if (deps.currentTaxonomyRevision !== undefined) {
      this.currentTaxonomyRevisionFn = deps.currentTaxonomyRevision;
    }
    if (deps.currentPolicyRevision !== undefined) {
      this.currentPolicyRevisionFn = deps.currentPolicyRevision;
    }
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
      // Eligibility (spec review R4): only a pending proposal can be approved;
      // rejected, stale or already-approved proposals are refused.
      if (proposal.state !== 'pending') {
        return err('STALE', `proposal ${action.proposalId} is ${proposal.state} and cannot be approved`);
      }
      selected.push(proposal);
    }
    const batch = this.repositories.batches.get(batchId);
    if (batch === null) return err('OUT_OF_SCOPE', `unknown batch ${batchId}`);
    // Batch/root membership: an approval can only bind proposals scanned into
    // its own batch root (spec review R1).
    const rootItems = new Set(this.repositories.items.listByRoot(batch.rootId).map((row) => row.item.id));
    for (const proposal of selected) {
      if (!rootItems.has(proposal.itemId)) {
        return err('OUT_OF_SCOPE', `proposal ${proposal.id} does not belong to batch ${batchId}`);
      }
    }
    // Identity pins (spec review R2): the root and destination identities as
    // observed now. A later re-discovery that replaces a directory must not
    // rewrite these expectations — it conflicts instead.
    const root = this.rootConfigFor(batch.rootId);
    if (root === null) return err('OUT_OF_SCOPE', `root record for batch ${batchId} is unavailable`);
    const pins: ApprovalPins = {
      root: { device: root.device, inode: root.inode },
      destinations: [],
    };
    for (const proposal of selected) {
      const destination = this.destinations.get(proposal.destinationId);
      if (destination === undefined) {
        return err(
          'OUT_OF_SCOPE',
          `destination ${proposal.destinationId} is absent from the catalogue; re-scan before approving`,
        );
      }
      pins.destinations.push({
        proposalId: proposal.id,
        destinationId: destination.id,
        device: destination.device,
        inode: destination.inode,
      });
    }
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
      pinsJson: JSON.stringify(pins),
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
    // Durable current state (spec review R1): the taxonomy revision comes from
    // the persisted reviewed revision when the application supplies it, and
    // the policy revision from the root record — never from the approval's
    // own bound values or from whichever proposal happens to be first.
    const taxonomyRevision =
      this.currentTaxonomyRevisionFn?.() ?? first?.taxonomyRevision ?? 0;
    const policyRevision = this.currentPolicyRevisionFn?.() ?? first?.policyRevision ?? 0;
    return { taxonomyRevision, policyRevision, actions: current };
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
      // Root-scoped lock (spec review R6): one writer per root across every
      // process, so a concurrent apply/resume/undo cannot interleave.
      const rootId = this.repositories.batches.get(batchId)?.rootId ?? '';
      const claim = rootId === '' ? null : this.repositories.locks.acquire(rootId, WRITER_LOCK_STALE_MS);
      if (rootId !== '' && claim === null) {
        return { batchId, results: [] };
      }
      try {
        return await this.applyBatchLocked(batchId, approvalId, actionSetHash);
      } finally {
        if (rootId !== '' && claim !== null) {
          this.repositories.locks.release(rootId, claim);
        }
      }
    });
  }

  /** The apply body, run while holding this root's writer lock. */
  private async applyBatchLocked(batchId: Id, approvalId: Id, actionSetHash: Sha256): Promise<BatchResult> {
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
      // Mode separation (spec review R1): an apply approval can only apply.
      if (approval.mode !== 'apply') {
        const selectedForMode = JSON.parse(approval.selectedActionsJson) as { proposalId: Id }[];
        return {
          batchId,
          results: selectedForMode.map((action) => ({
            actionId: action.proposalId,
            proposalId: action.proposalId,
            outcome: 'stale' as ActionOutcome,
            detail: `approval ${approval.id} has mode ${approval.mode}; an apply approval is required; nothing executed`,
          })),
        };
      }
      // Batch membership: an approval authorises its own batch only.
      if (approval.batchId !== batchId) {
        const selectedForBatch = JSON.parse(approval.selectedActionsJson) as { proposalId: Id }[];
        return {
          batchId,
          results: selectedForBatch.map((action) => ({
            actionId: action.proposalId,
            proposalId: action.proposalId,
            outcome: 'stale' as ActionOutcome,
            detail: `approval is bound to batch ${approval.batchId}, not ${batchId}; nothing executed`,
          })),
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
        // Per-effect revalidation (spec review F4): the approval was checked
        // once at batch entry, but an ordinary edit, rejection, taxonomy
        // review or expiry between actions must stop every LATER effect.
        // Invalidation ends the run; remaining actions are refused, not run.
        if (!this.approvalValid(approval.id)) {
          const remaining = selected.slice(results.length);
          for (const refused of remaining) {
            results.push({
              actionId: refused.proposalId,
              proposalId: refused.proposalId,
              outcome: 'stale' as ActionOutcome,
              detail: 'the approval no longer matches current state (edit, rejection, revision change or expiry); nothing further executed',
            });
          }
          break;
        }
        results.push(await this.runApplyAction(batch, approval.id, action));
      }
      return { batchId, results };
  }

  /**
   * Verifies the approval's identity pins against the current durable root
   * record and discovery catalogue (spec review R2). A missing pin means an
   * approval created before pins existed: re-approval is required, never a
   * silent pass.
   */
  private pinnedIdentity(
    batch: { rootId: Id },
    approvalId: Id,
    proposalId: Id,
  ): Result<void> {
    const approval = this.repositories.approvals.get(approvalId);
    if (approval === null) return err('STALE', 'the approval vanished');
    const pins = parsePins(approval);
    if (pins === null) {
      return err('STALE', 'the approval carries no identity pins; re-approve the current selection');
    }
    const pin = pins.destinations.find((entry) => entry.proposalId === proposalId);
    if (pin === undefined) {
      return err('STALE', 'the approval does not pin this proposal destination');
    }
    const destination = this.destinations.get(pin.destinationId);
    if (destination === undefined || destination.device !== pin.device || destination.inode !== pin.inode) {
      return err(
        'CONFLICT',
        `destination ${pin.destinationId} identity changed since approval ` +
          `(pinned ${pin.device}:${pin.inode}, observed ${destination === undefined ? 'absent' : `${destination.device}:${destination.inode}`}); review required`,
      );
    }
    const root = this.rootConfigFor(batch.rootId);
    if (root === null || root.device !== pins.root.device || root.inode !== pins.root.inode) {
      return err(
        'CONFLICT',
        `root identity changed since approval ` +
          `(pinned ${pins.root.device}:${pins.root.inode}, observed ${root === null ? 'absent' : `${root.device}:${root.inode}`}); review required`,
      );
    }
    return ok(undefined);
  }

  /**
   * Resolves a cancellation request against reality (spec review R5): if the
   * effect already happened the record is committed as applied/undone — a
   * cancellation never erases an effect — and only a not-yet-effected action
   * is marked canceled.
   */
  private async resolveForCancellation(
    batch: { id: Id; rootId: Id },
    record: { id: Id; proposalId: Id; approvalId: Id; mode: 'apply' | 'undo'; proposalVersion: Revision },
  ): Promise<ActionResult> {
    const proposal = this.repositories.proposals.get(record.proposalId);
    const root = proposal === null ? null : this.rootConfigFor(batch.rootId);
    const destination = proposal === null ? undefined : this.destinations.get(proposal.destinationId);
    if (proposal === null || root === null || destination === undefined) {
      this.repositories.actions.update(record.id, { state: 'canceled' });
      return {
        actionId: record.id,
        proposalId: record.proposalId,
        outcome: 'canceled',
        detail: 'cancellation was requested and the action cannot be resolved against the catalogue',
      };
    }
    // The immutable journalled fields win over the mutable proposal row.
    const stored = this.repositories.actions.get(record.id);
    const sourceBasename = stored?.sourceBasename ?? proposal.basename;
    const targetSegments = stored?.targetSegments ?? destination.segments;
    const expected =
      stored?.expectedSnapshot ??
      (record.mode === 'apply'
        ? proposal.expected
        : (this.appliedAfter({ proposalId: record.proposalId, proposalVersion: record.proposalVersion }) ?? proposal.expected));
    const observed = await this.observe(root, sourceBasename, targetSegments);
    if (!observed.ok) {
      this.repositories.actions.update(record.id, { state: 'canceled' });
      return {
        actionId: record.id,
        proposalId: record.proposalId,
        outcome: 'canceled',
        detail: `cancellation was requested; ${observed.detail}`,
      };
    }
    // For an undo the EFFECT location is the original inbox name, so the
    // observed roles swap — cancellation of a completed undo resolves to
    // `undone`, never a blind `canceled` (spec review F5).
    const observations =
      record.mode === 'undo'
        ? { source: observed.value.target, target: observed.value.source }
        : observed.value;
    // approvalValid false: cancellation never re-runs an effect.
    const outcome = reconcileAction(
      this.reconcileRecord(record, proposal, destination, expected, false),
      observations,
    );
    if (outcome.ok && outcome.value.kind === 'applied') {
      return this.commitReconciledEffect(record, proposal, destination, outcome.value.after);
    }
    this.repositories.actions.update(record.id, { state: 'canceled' });
    return {
      actionId: record.id,
      proposalId: record.proposalId,
      outcome: 'canceled',
      detail: outcome.ok
        ? `cancellation was requested and no effect had occurred (${outcome.value.reason})`
        : `cancellation was requested and the locations could not be resolved (${outcome.detail})`,
    };
  }

  /** Looks up the current catalogue entry for journalled target segments. */
  private destinationForSegments(segments: string[]): Destination | undefined {
    for (const destination of this.destinations.values()) {
      if (destination.segments.length === segments.length && destination.segments.every((segment, index) => segment === segments[index])) {
        return destination;
      }
    }
    return undefined;
  }

  /** The verified "after" snapshot of a completed forward move. */
  private appliedAfter(record: { proposalId: Id; proposalVersion: Revision }): Snapshot | null {
    const applyAction = this.repositories.actions.find(record.proposalId, record.proposalVersion, 'apply');
    if (applyAction === null || applyAction.receiptJson === null) return null;
    try {
      const receipt = JSON.parse(applyAction.receiptJson) as MoveReceipt;
      return receipt.after ?? null;
    } catch {
      return null;
    }
  }

  private reconcileRecord(
    record: { id: Id; proposalId: Id; approvalId: Id; mode: 'apply' | 'undo' },
    proposal: Proposal,
    destination: Destination,
    expected: Snapshot,
    approvalValid: boolean,
  ): ReconcileRecord {
    return {
      actionId: record.id,
      proposalId: record.proposalId,
      proposalVersion: proposal.version,
      mode: 'apply',
      approvalId: record.approvalId,
      state: 'intent',
      expected,
      sourceBasename: proposal.basename,
      targetSegments: destination.segments,
      approvalValid,
    };
  }

  /** Commits a reconciled effect (apply: moved; undo: returned) with a receipt. */
  private commitReconciledEffect(
    record: { id: Id; proposalId: Id; mode: 'apply' | 'undo' },
    proposal: Proposal,
    destination: Destination,
    after: Snapshot,
  ): ActionResult {
    const undone = record.mode === 'undo';
    const receipt: MoveReceipt = {
      kind: 'move_file',
      actionId: record.id,
      requestId: this.requestIdFn(),
      outcome: 'moved',
      before: undone
        ? (this.appliedAfter({ proposalId: record.proposalId, proposalVersion: proposal.version }) ?? proposal.expected)
        : proposal.expected,
      after,
      createdDirectoryIds: [],
      verified: true,
    };
    this.repositories.transaction(() => {
      this.repositories.actions.update(record.id, {
        state: undone ? 'undone' : 'applied',
        receiptJson: JSON.stringify(receipt),
      });
      this.repositories.actions.appendEvent(record.id, {
        event: undone ? 'undone' : 'applied',
        recordedAt: this.clock().toISOString(),
        payloadJson: JSON.stringify({ verified: true, reconciled: true }),
      });
    });
    return {
      actionId: record.id,
      proposalId: record.proposalId,
      outcome: undone ? 'undone' : 'applied',
      receipt,
      detail: undone
        ? 'reconciled: the file is back at its original location'
        : 'reconciled: the move took effect; the receipt was rebuilt from observations',
    };
  }

  /**
   * Reconciles an interrupted undo (spec review R5): the reverse intent is
   * resolved against immutable observations before any retry.
   */
  private async resumeUndoAction(
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
      return {
        actionId: existing.id,
        proposalId: existing.proposalId,
        outcome: 'conflict',
        detail: 'destination absent from the catalogue',
      };
    }
    const expected = this.appliedAfter({ proposalId: existing.proposalId, proposalVersion: proposal.version }) ?? proposal.expected;
    const observed = await this.observe(root, proposal.basename, destination.segments);
    if (!observed.ok) {
      return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'conflict', detail: observed.detail };
    }
    // Swap the roles: the undo's effect location is the original inbox name.
    const swapped = { source: observed.value.target, target: observed.value.source };
    const outcome = reconcileAction(
      this.reconcileRecord(
        { id: existing.id, proposalId: existing.proposalId, approvalId: existing.approvalId, mode: 'undo' },
        proposal,
        destination,
        expected,
        this.approvalValid(existing.approvalId),
      ),
      swapped,
    );
    if (!outcome.ok) {
      return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'conflict', detail: outcome.detail };
    }
    switch (outcome.value.kind) {
      case 'applied':
        return this.commitReconciledEffect(
          { id: existing.id, proposalId: existing.proposalId, mode: 'undo' },
          proposal,
          destination,
          outcome.value.after,
        );
      case 'retry':
        return this.retryUndo({ id: batch.id, rootId: batch.rootId }, existing, proposal, destination, expected);
      case 'stale':
        this.repositories.actions.update(existing.id, { state: 'stale' });
        return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'stale', detail: outcome.value.reason };
      default:
        this.repositories.actions.update(existing.id, { state: 'conflict' });
        return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'conflict', detail: outcome.value.reason };
    }
  }

  /** Re-runs an approved reverse move whose effect never happened. */
  private async retryUndo(
    batch: { id: Id; rootId: Id },
    existing: { id: Id; proposalId: Id; approvalId: Id },
    proposal: Proposal,
    destination: Destination,
    expected: Snapshot,
  ): Promise<ActionResult> {
    const root = this.rootConfigFor(batch.rootId);
    if (root === null) {
      return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'conflict', detail: 'root record is unavailable' };
    }
    this.repositories.actions.update(existing.id, { state: 'undo_intent' });
    const result = await this.helper.undoAt(
      {
        actionId: existing.id,
        approvalId: existing.approvalId,
        basename: proposal.basename,
        targetSegments: destination.segments,
        expected,
      },
      root,
    );
    if (!result.ok) {
      // An uncertain failure is not a terminal conflict (spec review R5):
      // the record stays non-terminal so a later resume reconciles it.
      if (!isDefiniteRefusal(result)) {
        this.repositories.actions.appendEvent(existing.id, {
          event: 'uncertain_effect',
          recordedAt: this.clock().toISOString(),
          payloadJson: JSON.stringify({ code: result.code, detail: result.detail }),
        });
        return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'conflict', detail: `${result.code}: ${result.detail}; effect uncertain, reconciliation required` };
      }
      this.repositories.transaction(() => {
        this.repositories.actions.update(existing.id, { state: 'conflict' });
        this.repositories.actions.appendEvent(existing.id, {
          event: 'conflict',
          recordedAt: this.clock().toISOString(),
          payloadJson: JSON.stringify({ code: result.code, detail: result.detail }),
        });
      });
      return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'conflict', detail: `${result.code}: ${result.detail}` };
    }
    if (result.value.outcome === 'conflict') {
      this.repositories.transaction(() => {
        this.repositories.actions.update(existing.id, { state: 'conflict', receiptJson: JSON.stringify(result.value) });
        this.repositories.actions.appendEvent(existing.id, {
          event: 'conflict',
          recordedAt: this.clock().toISOString(),
        });
      });
      return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'conflict', detail: 'the reverse move ended in conflict; material preserved' };
    }
    this.repositories.transaction(() => {
      this.repositories.actions.update(existing.id, { state: 'undone', receiptJson: JSON.stringify(result.value) });
      this.repositories.actions.appendEvent(existing.id, {
        event: 'undone',
        recordedAt: this.clock().toISOString(),
        payloadJson: JSON.stringify({ verified: result.value.verified }),
      });
    });
    return {
      actionId: existing.id,
      proposalId: existing.proposalId,
      outcome: 'undone',
      receipt: result.value,
      detail: 'the approved reverse move completed after reconciliation',
    };
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

    // Identity pins (spec review R2): the approved root/destination identity
    // must still be what discovery observes now. A replaced directory is a
    // conflict, never a silent re-pin.
    const pinned = this.pinnedIdentity(batch, approvalId, action.proposalId);
    if (!pinned.ok) {
      return { actionId, proposalId: action.proposalId, outcome: 'conflict', detail: pinned.detail };
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
      // Immutable action data (spec review R6): what was promised, written
      // once at claim time and never re-read from the mutable proposal.
      const destinationPin = this.repositories.approvals
        .get(approvalId)
        ?.pinsJson !== undefined && this.repositories.approvals.get(approvalId)?.pinsJson !== null
        ? pinFor(JSON.parse(this.repositories.approvals.get(approvalId)!.pinsJson!) as ApprovalPins, action.proposalId)
        : null;
      this.repositories.transaction(() => {
        this.repositories.actions.save({
          id: actionId,
          proposalId: action.proposalId,
          proposalVersion: action.version,
          mode: 'apply',
          approvalId,
          state: 'planned',
          sourceBasename: proposal.basename,
          targetSegments: [...destination.segments],
          expectedSnapshot: proposal.expected,
          ...(destinationPin === null ? {} : { destinationPin }),
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
      // A definite refusal (verified pre-effect) is terminal; an uncertain
      // failure (transport/timeout/post-effect class) may have moved the
      // file: the record stays non-terminal for reconciliation, never a
      // blind terminal conflict (spec review F5).
      if (!isDefiniteRefusal(result)) {
        this.repositories.actions.appendEvent(actionId, {
          event: 'uncertain_effect',
          recordedAt: this.clock().toISOString(),
          payloadJson: JSON.stringify({ code: result.code, detail: result.detail }),
        });
        return {
          actionId,
          proposalId: action.proposalId,
          outcome: 'conflict',
          detail: `${result.code}: ${result.detail}; effect uncertain, reconciliation required`,
        };
      }
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
    const record = this.repositories.actions.get(existing.id);
    const proposal = this.repositories.proposals.get(existing.proposalId);
    if (proposal === null) {
      return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'stale', detail: 'proposal vanished' };
    }
    const root = this.rootConfigFor(batch.rootId);
    if (root === null) {
      return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'conflict', detail: 'root record is unavailable' };
    }
    // The journal's own immutable data wins over the current proposal row
    // (spec review R6): recovery must act on what was journalled.
    const sourceBasename = record?.sourceBasename ?? proposal.basename;
    const targetSegments = record?.targetSegments ?? null;
    const expected = record?.expectedSnapshot ?? proposal.expected;
    const destination =
      targetSegments === null ? this.destinations.get(proposal.destinationId) : this.destinationForSegments(targetSegments);
    if (destination === undefined) {
      return { actionId: existing.id, proposalId: existing.proposalId, outcome: 'conflict', detail: 'destination absent from the catalogue' };
    }
    // The journaled destination pin must still match the observed catalogue.
    const pin = record?.destinationPin ?? null;
    if (pin !== null && (pin.destinationId !== destination.id || pin.device !== destination.device || pin.inode !== destination.inode)) {
      return {
        actionId: existing.id,
        proposalId: existing.proposalId,
        outcome: 'conflict',
        detail: `destination ${pin.destinationId} identity changed since the action was journalled; review required`,
      };
    }

    const observations = await this.observe(root, sourceBasename, destination.segments);
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
        expected,
        sourceBasename,
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
  /**
   * Observes both locations with typed outcomes (spec review R5). A failed
   * inspection is `unobservable`, never silently `absent`.
   */
  private async observe(
    root: RootConfig,
    basename: string,
    targetSegments: readonly string[],
  ): Promise<Result<LocationObservations>> {
    const source = await this.helper.inspectAt(root, [basename]);
    const target = await this.helper.inspectAt(root, [...targetSegments, basename]);
    return ok({
      source: source.ok
        ? { kind: 'present', snapshot: source.value }
        : isDefiniteAbsence(source)
          ? { kind: 'absent' }
          : { kind: 'unobservable', detail: `${source.code}: ${source.detail}` },
      target: target.ok
        ? { kind: 'present', snapshot: target.value }
        : isDefiniteAbsence(target)
          ? { kind: 'absent' }
          : { kind: 'unobservable', detail: `${target.code}: ${target.detail}` },
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
      // Root-scoped lock (spec review R6): resume serialises with apply/undo
      // across processes, so an interrupted action is never reconciled twice.
      const claim = this.repositories.locks.acquire(batch.rootId, WRITER_LOCK_STALE_MS);
      if (claim === null) return { batchId, results: [] };
      try {
        return await this.resumeBatchLocked(batchId, batch);
      } finally {
        this.repositories.locks.release(batch.rootId, claim);
      }
    });
  }

  private async resumeBatchLocked(batchId: Id, batch: { id: Id; rootId: Id; cancellationRequested: boolean }): Promise<BatchResult> {
      const approvals = this.repositories.approvals.listByBatch(batchId);
      const results: ActionResult[] = [];
      const seen = new Set<string>();
      for (const approval of approvals) {
        for (const record of this.repositories.actions.listByApproval(approval.id)) {
          if (seen.has(record.id) || TERMINAL_STATES.has(record.state)) continue;
          seen.add(record.id);
          if (batch.cancellationRequested === true) {
            // Cancellation never erases an effect: the record is resolved
            // against reality first, and only a not-yet-effected action is
            // marked canceled (spec review R5).
            const resolved = await this.resolveForCancellation({ id: batch.id, rootId: batch.rootId }, record);
            results.push(resolved);
            continue;
          }
          if (record.mode === 'apply') {
            results.push(
              await this.resumeApplyAction(
                { id: batch.id, rootId: batch.rootId },
                { id: record.id, proposalId: record.proposalId, approvalId: record.approvalId },
              ),
            );
          } else {
            results.push(
              await this.resumeUndoAction(
                { id: batch.id, rootId: batch.rootId },
                { id: record.id, proposalId: record.proposalId, approvalId: record.approvalId },
              ),
            );
          }
        }
      }
      return { batchId, results };
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
      // Mode separation (spec review R1): undo needs an undo approval.
      if (undoApproval.mode !== 'undo') {
        return err('UNAUTHORISED', `approval ${undoApproval.id} has mode ${undoApproval.mode}; an undo approval is required`);
      }
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
      // Identity pins (spec review R2): the reverse move must also target the
      // destination identity the undo approval pinned.
      const undoPins = parsePins(undoApproval);
      if (undoPins === null) {
        return err('STALE', 'the undo approval carries no identity pins; re-approve the undo');
      }
      const undoPin = undoPins.destinations.find((entry) => entry.proposalId === action.proposalId);
      if (undoPin === undefined) {
        return err('STALE', 'the undo approval does not pin this action');
      }
      const destination = this.destinations.get(proposal.destinationId);
      if (
        destination === undefined ||
        destination.id !== undoPin.destinationId ||
        destination.device !== undoPin.device ||
        destination.inode !== undoPin.inode
      ) {
        return err(
          'CONFLICT',
          `destination ${proposal.destinationId} identity changed since the undo approval; review required`,
        );
      }
      const batch = this.repositories.batches.get(undoApproval.batchId);
      if (batch === null) return err('OUT_OF_SCOPE', 'batch vanished');
      const root = this.rootConfigFor(batch.rootId);
      if (root === null) return err('OUT_OF_SCOPE', 'root record is unavailable');

      // Undo has its own intent record (mode 'undo', same proposal+version).
      const undoAction = this.repositories.actions.find(action.proposalId, action.proposalVersion, 'undo');
      if (undoAction !== null && undoAction.state === 'undone' && undoAction.receiptJson !== null) {
        return ok(JSON.parse(undoAction.receiptJson) as MoveReceipt);
      }
      // An existing non-terminal intent is reconciled against reality and
      // its outcome RETURNED (spec review F5): a reconcile that does not end
      // in `undone` must never fall through into a second attempt inside the
      // same request, or one request multiplies helper calls.
      if (undoAction !== null && !TERMINAL_STATES.has(undoAction.state)) {
        const reconciled = await this.resumeUndoAction({ id: batch.id, rootId: batch.rootId }, {
          id: undoAction.id,
          proposalId: undoAction.proposalId,
          approvalId: undoApprovalId,
        });
        if (reconciled.outcome === 'undone' && reconciled.receipt !== undefined) {
          return ok(reconciled.receipt);
        }
        return err(
          reconciled.outcome === 'stale' ? 'STALE' : 'CONFLICT',
          reconciled.detail ?? 'the undo could not be reconciled; retry after reviewing the journal',
        );
      }
      const undoActionId = undoAction?.id ?? `action-${randomUUID()}`;
      this.faultHook?.('before-undo-intent', { actionId: undoActionId, proposalId: action.proposalId });
      const undoPinForSave = pinFor(undoPins, action.proposalId);
      this.repositories.transaction(() => {
        if (undoAction === null) {
          this.repositories.actions.save({
            id: undoActionId,
            proposalId: action.proposalId,
            proposalVersion: action.proposalVersion,
            mode: 'undo',
            approvalId: undoApprovalId,
            state: 'undo_intent',
            sourceBasename: proposal.basename,
            targetSegments: [...destination.segments],
            expectedSnapshot: receipt.after ?? proposal.expected,
            ...(undoPinForSave === null ? {} : { destinationPin: undoPinForSave }),
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

      this.faultHook?.('after-undo-intent', { actionId: undoActionId, proposalId: action.proposalId });
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
      this.faultHook?.('after-undo-rename', { actionId: undoActionId, proposalId: action.proposalId });
      if (!result.ok) {
        // A definite refusal is terminal; an uncertain failure (timeout,
        // transport, post-effect fsync) keeps the record non-terminal so a
        // later resume reconciles it (spec review R5).
        if (isDefiniteRefusal(result)) {
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
        this.repositories.actions.appendEvent(undoActionId, {
          event: 'uncertain_effect',
          recordedAt: this.clock().toISOString(),
          payloadJson: JSON.stringify({ code: result.code, detail: result.detail }),
        });
        return err('CONFLICT', `${result.code}: ${result.detail}; effect uncertain, reconciliation required`);
      }
      this.faultHook?.('after-undo-verify', { actionId: undoActionId, proposalId: action.proposalId });
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
      this.faultHook?.('before-undone-commit', { actionId: undoActionId, proposalId: action.proposalId });
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
  /**
   * Proposes a reviewed new folder (spec review R10). The physical directory
   * is NOT created here: this persists a logical candidate bound to the real
   * parent destination identity, and approved execution materialises it later.
   * The old behaviour mkdir'd immediately with a fabricated root inode as the
   * parent pin, which bypassed the approval workflow entirely.
   */
  proposeFolder(
    parentSegments: readonly string[],
    segment: string,
    batchId: Id,
    label: string,
  ): Promise<Result<{ candidateId: Id; parentId: Id; parentSegments: string[]; segment: string; reviewState: 'draft' }>> {
    return this.withWriterLock(async () => {
      const parent = this.destinationForSegments([...parentSegments]);
      if (parent === undefined) {
        return err(
          'OUT_OF_SCOPE',
          `parent ${parentSegments.join('/') || '.'} is not in the discovery catalogue; scan before proposing a folder`,
        );
      }
      if (segment === '' || segment.includes('/') || segment === '.' || segment === '..') {
        return err('INVALID_DECISION', `segment ${JSON.stringify(segment)} is not a single path component`);
      }
      const candidateId = `folder-candidate-${createHash('sha256')
        .update(`${batchId}|${parent.id}|${segment}`)
        .digest('hex')
        .slice(0, 40)}`;
      this.repositories.folderCandidates.insert({
        id: candidateId,
        batchId,
        label,
        membersJson: JSON.stringify([]),
        destinationParentId: parent.id,
        reviewState: 'draft',
      });
      return ok({ candidateId, parentId: parent.id, parentSegments: [...parentSegments], segment, reviewState: 'draft' as const });
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
