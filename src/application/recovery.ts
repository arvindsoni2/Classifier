/**
 * Reconcile interrupted actions and undo (LLD §6, plan Task 8).
 *
 * Reconciliation is a pure function over observations: given the journal
 * record, what can be seen at the source and target locations NOW, and
 * whether the approval is still valid, it decides retry / applied /
 * conflict / stale. Nothing here touches the filesystem; the orchestrator
 * (workflow.ts) supplies observations and performs the chosen step.
 */

import type { Revision, Snapshot } from '../domain/contracts.js';

export interface ReconcileRecord {
  actionId: string;
  proposalId: string;
  proposalVersion: Revision;
  mode: 'apply' | 'undo';
  approvalId: string;
  state: string;
  expected: Snapshot;
  sourceBasename: string;
  targetSegments: string[];
  /** Whether the bound approval still validates against current state. */
  approvalValid: boolean;
}

export interface LocationObservation {
  exists: boolean;
  snapshot: Snapshot | null;
}

export interface LocationObservations {
  source: LocationObservation;
  target: LocationObservation;
}

export type ReconcileOutcome =
  | { kind: 'retry'; reason: string }
  | { kind: 'applied'; after: Snapshot; reason: string }
  | { kind: 'conflict'; reason: string }
  | { kind: 'stale'; reason: string };

/** Identity + content must both match for "this is the expected file". */
export function matchesExpected(
  expected: Snapshot,
  actual: Snapshot | null,
): boolean {
  if (actual === null) return false;
  return (
    expected.device === actual.device &&
    expected.inode === actual.inode &&
    expected.size === actual.size &&
    expected.mtimeNs === actual.mtimeNs &&
    expected.sha256 === actual.sha256
  );
}

/**
 * Decides what an interrupted action means:
 * - expected file only at source, approval still valid → the move never
 *   took effect: retry (revalidate first).
 * - expected file only at source, approval stale/expired → back to review.
 * - expected file only at target → the move happened; record Applied even
 *   though the receipt was lost.
 * - both, neither, or identity/hash mismatch → conflict: preserve material.
 */
export function reconcileAction(
  record: ReconcileRecord,
  observations: LocationObservations,
): { ok: true; value: ReconcileOutcome } | { ok: false; code: 'CONFLICT'; detail: string } {
  const atSource = observations.source.exists && matchesExpected(record.expected, observations.source.snapshot);
  const atTarget = observations.target.exists && matchesExpected(record.expected, observations.target.snapshot);
  const expectedBytesAtSourceOnly = observations.source.exists && !observations.target.exists && atSource;
  const expectedBytesAtTargetOnly = !observations.source.exists && observations.target.exists && atTarget;

  if (expectedBytesAtSourceOnly && expectedBytesAtTargetOnly) {
    // Defensive: unreachable given the exists-conditions above.
    return { ok: false, code: 'CONFLICT', detail: 'observations are contradictory' };
  }

  if (expectedBytesAtSourceOnly) {
    if (!record.approvalValid) {
      return {
        ok: true,
        value: {
          kind: 'stale',
          reason:
            'the move never took effect and the approval is expired or stale; the action returns to review, not Approved',
        },
      };
    }
    return {
      ok: true,
      value: {
        kind: 'retry',
        reason: 'the expected file is only at the source: the move never took effect; revalidate and retry',
      },
    };
  }

  if (expectedBytesAtTargetOnly) {
    const after = observations.target.snapshot;
    if (after === null) {
      return { ok: false, code: 'CONFLICT', detail: 'target observation has no snapshot' };
    }
    return {
      ok: true,
      value: {
        kind: 'applied',
        after,
        reason: 'the expected file is only at the target: the move took effect; record Applied even if the receipt was lost',
      },
    };
  }

  const reasons: string[] = [];
  if (observations.source.exists && observations.target.exists) reasons.push('both locations hold a file');
  if (!observations.source.exists && !observations.target.exists) reasons.push('neither location holds the expected file');
  if (observations.source.exists && !atSource) reasons.push('the source file does not match the expected snapshot');
  if (observations.target.exists && !atTarget) reasons.push('the target file does not match the expected snapshot');
  return {
    ok: true,
    value: {
      kind: 'conflict',
      reason: `ambiguous or mismatched locations: ${reasons.join('; ')}; preserve material and review`,
    },
  };
}
