/**
 * Live-batch export and retention (spec review R12).
 *
 * The fixture exporter only ever handled the repository's synthetic fixture.
 * A real batch is different material: its decisions carry provider provenance,
 * its actions carry receipts, and its exclusions carry reasons. Nothing
 * private leaves unless it is explicitly opted in, the active journals of an
 * unfinished batch are never purged by retention.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Repositories } from '../adapters/persistence/repositories.js';
import type { Id } from '../domain/contracts.js';

export interface LiveExportResult {
  outDir: string;
  batchId: Id;
  items: number;
  decisions: number;
  proposals: number;
  actions: number;
  exclusions: number;
  privateEvidenceIncluded: boolean;
}

/** Terminal states: a batch whose actions are all terminal can be retained. */
const TERMINAL_ACTION_STATES = new Set(['applied', 'conflict', 'stale', 'canceled', 'undone']);

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
  mkdirSync(outDir, { recursive: true });

  const rows = repositories.items.listByBatch(batchId);
  const items = rows.map((row) => row.item);
  const decisions = repositories.decisions
    .listByRoot(batch.rootId)
    .filter((row) => items.some((item) => item.id === row.decision.itemId))
    .map((row) => ({
      id: row.decision.id,
      itemId: row.decision.itemId,
      provider: row.decision.provider,
      modelRevision: row.decision.modelRevision,
      runtimeRevision: row.decision.runtimeRevision,
      evidenceHash: row.decision.evidenceHash,
      elapsedMs: row.decision.elapsedMs,
      tokenCounts: JSON.parse(row.decision.tokenCountsJson) as Record<string, number>,
      error: row.decision.error,
    }));
  const proposals = repositories.proposals.listByRoot(batch.rootId);
  const actions: unknown[] = [];
  for (const approval of repositories.approvals.listByBatch(batchId)) {
    for (const record of repositories.actions.listByApproval(approval.id)) {
      actions.push({
        id: record.id,
        proposalId: record.proposalId,
        proposalVersion: record.proposalVersion,
        mode: record.mode,
        state: record.state,
        events: record.events,
        receipt: record.receiptJson === null ? null : (JSON.parse(record.receiptJson) as unknown),
      });
    }
  }
  const exclusions = repositories.batches.exclusions(batchId);

  const manifest = {
    schemaVersion: '1.0.0',
    batchId,
    rootId: batch.rootId,
    generatedAt: new Date().toISOString(),
    counts: {
      items: items.length,
      decisions: decisions.length,
      proposals: proposals.length,
      actions: actions.length,
      exclusions: exclusions.length,
    },
    privateEvidenceIncluded: options.includePrivateEvidence ?? false,
    notes: [
      'Live batch export: decisions carry their persisted provider provenance.',
      'No private evidence is written unless explicitly opted in.',
    ],
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(outDir, 'items.jsonl'),
    `${items
      .map((item) =>
        JSON.stringify({
          id: item.id,
          basename: item.externalId,
          revision: item.revision,
          size: item.snapshot?.size ?? null,
          sha256: item.snapshot?.sha256 ?? null,
        }),
      )
      .join('\n')}\n`,
  );
  writeFileSync(join(outDir, 'decisions.jsonl'), `${decisions.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(join(outDir, 'proposals.jsonl'), `${proposals.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(join(outDir, 'actions.jsonl'), `${actions.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(join(outDir, 'exclusions.jsonl'), `${exclusions.map((row) => JSON.stringify(row)).join('\n')}\n`);
  if (options.includePrivateEvidence === true) {
    writeFileSync(
      join(outDir, 'private-evidence.jsonl'),
      `${items
        .map((item) => JSON.stringify({ id: item.id, basename: item.externalId, snapshot: item.snapshot }))
        .join('\n')}\n`,
    );
  }
  const digest = createHash('sha256')
    .update(JSON.stringify({ manifest, items, decisions, proposals, actions, exclusions }))
    .digest('hex');
  writeFileSync(join(outDir, 'export.json'), `${JSON.stringify({ exportHash: digest }, null, 2)}\n`);

  return {
    ok: true,
    value: {
      outDir,
      batchId,
      items: items.length,
      decisions: decisions.length,
      proposals: proposals.length,
      actions: actions.length,
      exclusions: exclusions.length,
      privateEvidenceIncluded: options.includePrivateEvidence ?? false,
    },
  };
}

/**
 * Retention (spec review R12): a batch is purged only when every action it
 * journalled is terminal. An unfinished batch keeps its evidence and its
 * journal so recovery can still reconcile it.
 */
export function retainBatches(repositories: Repositories, keepLatest: number): { purged: Id[]; kept: Id[] } {
  const purged: Id[] = [];
  const kept: Id[] = [];
  const batches = [...repositories.batches.listAll()].sort((left, right) =>
    left.createdAt < right.createdAt ? -1 : 1,
  );
  for (const batch of batches.slice(0, Math.max(0, batches.length - keepLatest))) {
    const active = repositories.actions.listByBatch(batch.id).some((record) => !TERMINAL_ACTION_STATES.has(record.state));
    if (active) {
      kept.push(batch.id);
      continue;
    }
    repositories.purgeBatch(batch.id);
    purged.push(batch.id);
  }
  for (const batch of batches.slice(Math.max(0, batches.length - keepLatest))) {
    kept.push(batch.id);
  }
  return { purged, kept };
}
