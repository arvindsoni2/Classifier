/**
 * Convert decisions into logical proposals (LLD §1, plan Task 6).
 *
 * A proposal is a logical placement: item + exact category + mapped
 * destination + expected snapshot, at version 1. Nothing here touches the
 * filesystem. A route that defers, selects nothing, or ends anywhere other
 * than an existing category yields NO proposal (FR-05/FR-06).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  err,
  ok,
  stableStringify,
  UNKNOWN_OPTION_ID,
  type Approval,
  type ApprovalContext,
  type Category,
  type Decision,
  type DecisionPath,
  type FolderCandidate,
  type Id,
  type Item,
  type Proposal,
  type Result,
  type Revision,
  type Vocabulary,
} from './contracts.js';
import type { Taxonomy } from './taxonomy.js';

/** Approvals expire 24 hours after issue (LLD §4). */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Plans one placement for an item along a decision route. The expected
 * Snapshot is the item's verified snapshot: any later change invalidates the
 * proposal at execution time, not here.
 */
export function planPlacement(
  item: Item,
  path: DecisionPath,
  taxonomy: Taxonomy,
  policyRevision: Revision,
): Result<Proposal> {
  if (item.snapshot === null) {
    return err('UNSTABLE', `item ${JSON.stringify(item.externalId)} has no verified snapshot; discovery must verify it first`);
  }

  const childrenByParent = new Map<string | null, Category[]>();
  for (const category of taxonomy.tree) {
    const siblings = childrenByParent.get(category.parentId) ?? [];
    siblings.push(category);
    childrenByParent.set(category.parentId, siblings);
  }

  const roots = childrenByParent.get(null) ?? [];
  let node: Category | undefined = roots[0];
  for (const answer of path.answers) {
    if (node === undefined) break;
    if (answer.selectedId === UNKNOWN_OPTION_ID) {
      return err('INVALID_DECISION', 'route defers to the unknown option; an unknown output cannot be planned (FR-05)');
    }
    const child = (childrenByParent.get(node.id) ?? []).find((candidate) => candidate.id === answer.selectedId);
    if (child === undefined) {
      return err('INVALID_DECISION', `route selected ${JSON.stringify(answer.selectedId)}, which is not a child of ${node.id}`);
    }
    node = child;
  }

  if (node === undefined || node.kind !== 'existing' || node.destinationId === null) {
    return err('INVALID_DECISION', 'route must end at an existing category with a mapped destination; groups and candidates cannot be planned');
  }

  const id = `proposal-${sha256(
    `${item.id}|${taxonomy.revision}|${policyRevision}|${node.id}|${item.snapshot.sha256}`,
  ).slice(0, 40)}`;

  return ok({
    id,
    version: 1,
    itemId: item.id,
    categoryId: node.id,
    destinationId: node.destinationId,
    basename: item.externalId,
    expected: item.snapshot,
    taxonomyRevision: taxonomy.revision,
    policyRevision,
    decisionIds: [],
    state: 'pending',
  });
}

/** Controlled labels for deferral groups, keyed by detected format. */
const UNCLASSIFIED_LABELS: Record<string, string> = {
  text: 'Unsorted Documents',
  markdown: 'Unsorted Documents',
  pdf: 'Unsorted Documents',
  docx: 'Unsorted Documents',
  image: 'Unsorted Media',
  archive: 'Unsorted Archives',
  installer: 'Unsorted Software',
  other: 'Unsorted Files',
};

function detectFormatFromName(basename: string): string {
  const lower = basename.toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.text')) return 'text';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (/\.(png|jpg|jpeg|gif|webp|bmp|svg|heic|tiff?)$/.test(lower)) return 'image';
  if (/\.(zip|tar|gz|tgz|bz2|xz|7z|rar|zst)$/.test(lower)) return 'archive';
  if (/\.(rpm|deb|exe|msi|appimage|dmg|iso|bin)$/.test(lower)) return 'installer';
  return 'other';
}

/**
 * Suggests new-folder groups from items whose decisions deferred to unknown
 * (FR-06): at least three members, controlled names, and NO physical folder
 * until accepted execution. A user-requested group may be smaller; the
 * provenance is recorded as createdBy.
 */
export function suggestFolderGroups(
  items: readonly Item[],
  decisions: readonly Decision[],
  vocabulary: Vocabulary,
  options: { userRequested?: boolean } = {},
): FolderCandidate[] {
  const userRequested = options.userRequested === true;
  const minMembers = userRequested ? 1 : 3;
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const groups = new Map<string, { label: string; members: Set<string> }>();

  for (const decision of decisions) {
    const answer = decision.answers[decision.answers.length - 1];
    if (answer === undefined || answer.selectedId !== UNKNOWN_OPTION_ID) continue;
    const item = itemsById.get(decision.itemId);
    if (item === undefined) continue;
    const label = UNCLASSIFIED_LABELS[detectFormatFromName(item.externalId)] ?? 'Unsorted Files';
    const controlled = controlledLabel(label, vocabulary);
    if (!controlled.ok) continue;
    const group = groups.get(label) ?? { label, members: new Set<string>() };
    group.members.add(item.id);
    groups.set(label, group);
  }

  const candidates: FolderCandidate[] = [];
  for (const group of groups.values()) {
    if (group.members.size < minMembers) continue;
    const members = [...group.members].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    candidates.push({
      id: `folder-candidate-${sha256(group.label).slice(0, 40)}`,
      label: group.label,
      members,
      destinationParentId: null,
      reviewState: 'draft',
      createdBy: userRequested ? 'user' : 'suggestion',
    });
  }
  return candidates.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/**
 * Creates an approval binding the exact selected action versions and the
 * taxonomy/policy revisions of the moment (FR-07). The action-set hash is
 * deterministic: the same selection always hashes the same.
 */
export function createApproval(
  batch: { id: Id },
  selected: readonly Proposal[],
  mode: 'apply' | 'undo',
  now: Date,
): Result<Approval> {
  if (selected.length === 0) {
    return err('INVALID_DECISION', 'an approval requires at least one selected proposal');
  }
  const taxonomyRevision = selected[0]!.taxonomyRevision;
  const policyRevision = selected[0]!.policyRevision;
  if (selected.some((proposal) => proposal.taxonomyRevision !== taxonomyRevision || proposal.policyRevision !== policyRevision)) {
    return err(
      'INVALID_DECISION',
      'selection spans multiple taxonomy/policy revisions; bind one coherent revision set per approval',
    );
  }
  const actions = selected.map((proposal) => ({ proposalId: proposal.id, version: proposal.version }));
  const actionSetHash = sha256(stableStringify(actions));
  const approvedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
  return ok({
    id: `approval-${randomUUID()}`,
    batchId: batch.id,
    actions,
    actionSetHash,
    taxonomyRevision,
    policyRevision,
    approvedAt,
    expiresAt,
    mode,
  });
}

/**
 * Validates an approval against the CURRENT bound state (FR-07): expiry,
 * taxonomy/policy revisions and the exact action versions must all still
 * match. Any difference is STALE — execution returns to review.
 */
export function validateApproval(
  approval: Approval,
  current: ApprovalContext,
  now: Date,
): Result<void> {
  if (now.getTime() > Date.parse(approval.expiresAt)) {
    return err('STALE', `approval ${approval.id} expired at ${approval.expiresAt}; re-approve the current versions`);
  }
  if (approval.taxonomyRevision !== current.taxonomyRevision) {
    return err('STALE', `taxonomy revision changed from ${approval.taxonomyRevision} to ${current.taxonomyRevision}`);
  }
  if (approval.policyRevision !== current.policyRevision) {
    return err('STALE', `policy revision changed from ${approval.policyRevision} to ${current.policyRevision}`);
  }
  const currentHash = sha256(stableStringify(current.actions));
  if (currentHash !== approval.actionSetHash) {
    return err('STALE', 'bound action versions changed since approval; re-approve the current selection');
  }
  return ok(undefined);
}

/** Validates a suggested label against the controlled vocabulary. */
export function controlledLabel(label: string, vocabulary: Vocabulary): Result<string> {
  if (label.length === 0 || label.length > vocabulary.maxLabelLength) {
    return err('INVALID_DECISION', `label ${JSON.stringify(label)} violates the ${vocabulary.maxLabelLength}-character limit`);
  }
  if (!new RegExp(vocabulary.labelPattern).test(label)) {
    return err('INVALID_DECISION', `label ${JSON.stringify(label)} violates the controlled-name pattern`);
  }
  if (vocabulary.reservedNames.includes(label)) {
    return err('INVALID_DECISION', `label ${JSON.stringify(label)} is reserved`);
  }
  return ok(label);
}
