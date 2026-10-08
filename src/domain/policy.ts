/**
 * Eligibility, approval and action rules (LLD §1, plan Task 6).
 *
 * Manual corrections apply to an exact item at an exact version: a patch
 * with a stale expectedVersion is refused rather than replayed, and every
 * accepted edit increments the version so approvals bound to the old version
 * expire (FR-07/FR-12).
 */
import {
  err,
  ok,
  type Id,
  type Proposal,
  type Result,
  type Revision,
} from './contracts.js';

export interface ProposalPatch {
  expectedVersion: Revision;
  categoryId?: Id;
  destinationId?: Id;
}

/** Applies a manual destination/category correction with optimistic locking. */
export function patchProposal(proposal: Proposal, patch: ProposalPatch): Result<Proposal> {
  if (patch.expectedVersion !== proposal.version) {
    return err(
      'STALE',
      `proposal ${proposal.id} is at version ${proposal.version}, expected ${patch.expectedVersion}`,
    );
  }
  if (proposal.state === 'rejected') {
    return err('STALE', `proposal ${proposal.id} is rejected and cannot be edited`);
  }
  const categoryId = patch.categoryId ?? proposal.categoryId;
  const destinationId = patch.destinationId ?? proposal.destinationId;
  if (categoryId === '' || destinationId === '') {
    return err('INVALID_DECISION', 'a manual destination requires both a category and a destination');
  }
  return ok({
    ...proposal,
    categoryId,
    destinationId,
    version: proposal.version + 1,
    state: 'pending',
  });
}

/** Rejects a proposal at an exact version; the rejection is inspectable. */
export function rejectProposal(proposal: Proposal, expectedVersion: Revision): Result<Proposal> {
  if (expectedVersion !== proposal.version) {
    return err(
      'STALE',
      `proposal ${proposal.id} is at version ${proposal.version}, expected ${expectedVersion}`,
    );
  }
  return ok({ ...proposal, state: 'rejected', version: proposal.version + 1 });
}
