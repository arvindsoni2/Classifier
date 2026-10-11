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

/**
 * A location observation (spec review R5). `unobservable` is distinct from
 * `absent`: a permission failure, an unsupported operation or a symlink/type
 * error must never be read as "the file is not there" — reconciliation then
 * preserves material instead of acting on a false absent.
 */
export type LocationObservation =
  | { kind: 'present'; snapshot: Snapshot }
  | { kind: 'absent' }
  | { kind: 'unobservable'; detail: string };

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

/** Reads an observation as "the expected file is here". */
function holdsExpected(observation: LocationObservation, expected: Snapshot): boolean {
  return observation.kind === 'present' && matchesExpected(expected, observation.snapshot);
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
  // An unobservable location is a conflict on its own: no decision may be
  // made from a reading that failed (spec review R5).
  for (const [name, observation] of [
    ['source', observations.source],
    ['target', observations.target],
  ] as const) {
    if (observation.kind === 'unobservable') {
      return {
        ok: false,
        code: 'CONFLICT',
        detail: `the ${name} location is unobservable (${observation.detail}); reconciliation cannot decide the outcome`,
      };
    }
  }

  const atSource = holdsExpected(observations.source, record.expected);
  const atTarget = holdsExpected(observations.target, record.expected);
  const sourcePresent = observations.source.kind === 'present';
  const targetPresent = observations.target.kind === 'present';
  const expectedBytesAtSourceOnly = sourcePresent && !targetPresent && atSource;
  const expectedBytesAtTargetOnly = !sourcePresent && targetPresent && atTarget;

  if (expectedBytesAtSourceOnly && expectedBytesAtTargetOnly) {
    // Defensive: unreachable given the presence-conditions above.
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
    const observedTarget = observations.target;
    if (observedTarget.kind !== 'present') {
      return { ok: false, code: 'CONFLICT', detail: 'target observation has no snapshot' };
    }
    const after = observedTarget.snapshot;
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
  if (sourcePresent && targetPresent) reasons.push('both locations hold a file');
  if (!sourcePresent && !targetPresent) reasons.push('neither location holds the expected file');
  if (sourcePresent && !atSource) reasons.push('the source file does not match the expected snapshot');
  if (targetPresent && !atTarget) reasons.push('the target file does not match the expected snapshot');
  return {
    ok: true,
    value: {
      kind: 'conflict',
      reason: `ambiguous or mismatched locations: ${reasons.join('; ')}; preserve material and review`,
    },
  };
}
