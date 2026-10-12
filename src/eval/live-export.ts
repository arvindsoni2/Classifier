/**
 * Live-batch export and retention (spec review R12/F10).
 *
 * A real batch's export is batch-EXACT (only the items that batch scanned,
 * their persisted evidence, complete immutable decisions with probability
 * vectors, the action journal and observed exclusions) and it carries a
 * documented REDACTION contract: basenames and journalled payload text are
 * withheld by default; the full model-facing evidence state — the thing a
 * treatment must be replayable FROM — is released only on explicit opt-in.
 *
 * Retention expires classification PAYLOADS of out-of-window batches while
 * the execution journal remains: an applied action must stay auditable and
 * undoable after its evidence retention window closed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Repositories } from '../adapters/persistence/repositories.js';
import type { Decision, Id } from '../domain/contracts.js';

export interface LiveExportResult {
  outDir: string;
  batchId: Id;
  items: number;
  decisions: number;
  proposals: number;
  actions: number;
  exclusions: number;
  privateEvidenceIncluded: boolean;
  redaction: string;
}

/** Terminal states: a batch whose actions are all terminal can be retained. */
const TERMINAL_ACTION_STATES = new Set(['applied', 'conflict', 'stale', 'canceled', 'undone']);

/** Redaction: names become stable opaque tokens, payload text is withheld. */
function redactedName(basename: string): string {
  return `name-${createHash('sha256').update(basename).digest('hex').slice(0, 16)}`;
}

export function exportLiveBatch(
  repositories: Repositories,
  batchId: Id,
  outDir: string,
  options: { includePrivateEvidence?: boolean } = {},
): { ok: true; value: LiveExportResult } | { ok: false; code: 'OUT_OF_SCOPE'; detail: string } {
  const batch = repositories.batches.get(batchId);
  if (batch === null) {
    return { ok: false, code: 'OUT_OF_SCOPE', detail: `unknown batch ${batchId}` };
  }
  const includePrivate = options.includePrivateEvidence ?? false;
  mkdirSync(outDir, { recursive: true });

  // Batch-exact membership (spec review F10): an empty batch exports nothing
  // from earlier batches. Legacy databases without ANY membership records
  // keep the root view so pre-membership audits remain exportable.
  const membershipExists = repositories.items.hasMembership();
  const itemRows = membershipExists
    ? repositories.items.listByBatch(batchId)
    : repositories.items.listByRoot(batch.rootId);
  const items = itemRows.map((row) => row.item);
  const itemIds = new Set(items.map((item) => item.id));

  const proposalsAll = membershipExists
    ? repositories.proposals.listByBatch(batchId)
    : repositories.proposals.listByRoot(batch.rootId);
  const proposals = proposalsAll.filter((proposal) => itemIds.has(proposal.itemId));

  const decisionRows = repositories.decisions
    .listByRoot(batch.rootId)
    .filter((row) => itemIds.has(row.decision.itemId));
  const exportedDecisions = decisionRows.map((row) => ({
    id: row.decision.id,
    itemId: row.decision.itemId,
    provider: row.decision.provider,
    modelRevision: row.decision.modelRevision,
    runtimeRevision: row.decision.runtimeRevision,
    evidenceHash: row.decision.evidenceHash,
    schemaHash: row.decision.schemaHash,
    answers: includePrivate
      ? (JSON.parse(row.decision.answersJson) as unknown)
      // Probability vectors are model output, not user content: kept in the
      // default export so scores stay auditable without the raw text.
      : (JSON.parse(row.decision.answersJson) as Decision['answers']).map((answer) => ({
          questionId: answer.questionId,
          selectedId: answer.selectedId,
          probabilities: answer.probabilities,
        })),
    elapsedMs: row.decision.elapsedMs,
    tokenCounts: JSON.parse(row.decision.tokenCountsJson) as Record<string, number>,
    error: row.decision.error,
  }));

  const evidenceRows = repositories.evidence
    .listByRoot(batch.rootId)
    .filter((row) => itemIds.has(row.itemId));

  const actions: unknown[] = [];
  for (const approval of repositories.approvals.listByBatch(batchId)) {
    for (const record of repositories.actions.listByApproval(approval.id)) {
      const full = repositories.actions.get(record.id) ?? record;
      actions.push({
        id: full.id,
        proposalId: full.proposalId,
        proposalVersion: full.proposalVersion,
        mode: full.mode,
        state: full.state,
        sourceBasename: includePrivate ? (full.sourceBasename ?? null) : (full.sourceBasename === null || full.sourceBasename === undefined ? null : redactedName(full.sourceBasename)),
        targetSegments:
          includePrivate || full.targetSegments === null
            ? full.targetSegments
            : full.targetSegments.map((segment, index) =>
                index === full.targetSegments!.length - 1 ? redactedName(segment) : segment,
              ),
        receipt: full.receiptJson === null ? null : (JSON.parse(full.receiptJson) as unknown),
        events: full.events.map((event) => ({
          event: event.event,
          recordedAt: event.recordedAt,
          ...(includePrivate && event.payloadJson !== undefined ? { payloadJson: event.payloadJson } : {}),
        })),
      });
    }
  }
  // Exclusion reasons quote private basenames ("2000PR video.mp4: exceeds
  // the ceiling..."): the default export publishes only a digest of each.
  const exclusionReasons = repositories.batches.exclusions(batchId);
  const exclusions = exclusionReasons.map((reason) =>
    includePrivate ? reason : `withheld:${createHash('sha256').update(reason).digest('hex').slice(0, 16)}`,
  );

  const nameOf = (basename: string): string => (includePrivate ? basename : redactedName(basename));
  const manifest = {
    schemaVersion: '2.0.0',
    batchId,
    rootId: batch.rootId,
    generatedAt: new Date().toISOString(),
    provenance: 'live-batch',
    synthetic: false,
    redaction: includePrivate
      ? 'none: private evidence explicitly requested'
      : 'basenames hashed, destination folder segments hashed, evidence states, journalled payload text and exclusion reason text withheld',
    privateEvidenceIncluded: includePrivate,
    counts: {
      items: items.length,
      decisions: exportedDecisions.length,
      proposals: proposals.length,
      actions: actions.length,
      exclusions: exclusions.length,
      evidence: evidenceRows.length,
    },
    notes: [
      'Live batch export: decisions carry probability vectors, hashes and timing.',
      'Retention expires these payloads for out-of-window batches while the',
      'execution journal remains so applied actions stay auditable and undoable.',
    ].join(' '),
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(outDir, 'items.jsonl'),
    `${items
      .map((item) =>
        JSON.stringify({
          id: item.id,
          basename: nameOf(item.externalId),
          revision: item.revision,
          size: item.snapshot?.size ?? null,
          sha256: item.snapshot?.sha256 ?? null,
        }),
      )
      .join('\n')}\n`,
  );
  writeFileSync(join(outDir, 'decisions.jsonl'), `${exportedDecisions.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(
    join(outDir, 'proposals.jsonl'),
    `${proposals
      .map((proposal) =>
        JSON.stringify({
          id: proposal.id,
          itemId: proposal.itemId,
          basename: nameOf(proposal.basename),
          destinationId: proposal.destinationId,
          categoryId: proposal.categoryId,
          version: proposal.version,
          state: proposal.state,
          decisionIds: proposal.decisionIds,
        }),
      )
      .join('\n')}\n`,
  );
  writeFileSync(join(outDir, 'actions.jsonl'), `${actions.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(join(outDir, 'exclusions.jsonl'), `${exclusions.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(
    join(outDir, 'evidence.jsonl'),
    `${evidenceRows
      .map((row) => JSON.stringify({ id: row.id, itemId: row.itemId, stateHash: row.stateHash, profile: row.profile, manifest: JSON.parse(row.manifestJson) }))
      .join('\n')}\n`,
  );
  if (includePrivate) {
    // The replayable path: exact model-facing states, raw names.
    writeFileSync(
      join(outDir, 'private-evidence.jsonl'),
      `${evidenceRows
        .map((row) =>
          JSON.stringify({
            id: row.id,
            itemId: row.itemId,
            profile: row.profile,
            stateHash: row.stateHash,
            state: JSON.parse(row.stateJson ?? 'null'),
          }),
        )
        .join('\n')}\n`,
    );
  }
  const digest = createHash('sha256')
    .update(JSON.stringify({ manifest, items: items.length, decisions: decisionRows.length }))
    .digest('hex');
  writeFileSync(join(outDir, 'export.json'), `${JSON.stringify({ exportHash: digest }, null, 2)}\n`);

  return {
    ok: true,
    value: {
      outDir,
      batchId,
      items: items.length,
      decisions: exportedDecisions.length,
      proposals: proposals.length,
      actions: actions.length,
      exclusions: exclusions.length,
      privateEvidenceIncluded: includePrivate,
      redaction: manifest.redaction,
    },
  };
}

/**
 * Retention (spec review F10): out-of-window batches have their classification
 * PAYLOADS (evidence states, probability-bearing decisions, membership and
 * exclusion bookkeeping) expired; a batch whose journalled actions are not all
 * terminal keeps EVERYTHING — recovery and undo must never lose to retention.
 */
export function retainBatches(repositories: Repositories, keepLatest: number): { purged: Id[]; kept: Id[] } {
  const purged: Id[] = [];
  const kept: Id[] = [];
  const batches = [...repositories.batches.listAll()].sort((left, right) =>
    left.createdAt < right.createdAt ? -1 : 1,
  );
  const boundary = Math.max(0, batches.length - keepLatest);
  for (const [index, batch] of batches.entries()) {
    const active = repositories.actions
      .listByBatch(batch.id)
      .some((record) => !TERMINAL_ACTION_STATES.has(record.state));
    if (index >= boundary || active) {
      kept.push(batch.id);
      continue;
    }
    repositories.purgeBatch(batch.id);
    purged.push(batch.id);
  }
  return { purged, kept };
}
