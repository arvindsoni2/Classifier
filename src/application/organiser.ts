/**
 * The organiser application service (plan Task 9): one wiring of the real
 * domain — scoped discovery, bounded extraction, typed providers, the
 * planner and the journalled executor — used identically by the CLI and the
 * HTTP surface. Factories and clock are injected; nothing here opens a path
 * the helper has not anchored.
 */
import { createHash } from 'node:crypto';
import {
  ok,
  type Category,
  type Decision,
  type DecisionProvider,
  type ErrorCode,
  type Evidence,
  type FolderCandidate,
  type Id,
  type Item,
  type ProviderId,
  type Proposal,
  type Result,
  type Revision,
  type RootConfig,
} from '../domain/contracts.js';
import { planPlacement, suggestFolderGroups, validateApproval } from '../domain/planner.js';
import { UNKNOWN_OPTION_ID } from '../domain/contracts.js';
import { patchProposal, rejectProposal } from '../domain/policy.js';
import { validateTaxonomy, buildMatchedRequest, type Taxonomy } from '../domain/taxonomy.js';
import { createRepositories, type Repositories } from '../adapters/persistence/repositories.js';
import { resolveRoot } from '../adapters/filesystem/root.js';
import { FilesystemSource } from '../adapters/filesystem/source.js';
import { createExtractor, defaultExtractionLimits, type ExtractionLimits } from '../adapters/extraction/extract.js';
import { RulesProvider } from '../adapters/providers/rules.js';
import { ClefProvider } from '../adapters/providers/clef.js';
import { LayaProvider } from '../adapters/providers/laya.js';
import { JevProvider } from '../adapters/providers/jev.js';
import { probeProviders, loadProviderConfig, type ProviderConfig } from '../cli/doctor.js';
import { ApplicationService, type ActionResult, type FaultPoint, type HelperPort } from './workflow.js';

export interface OrganiserOptions {
  dbPath: string;
  /** Configured Downloads path; when absent the XDG default resolves. */
  rootPath?: string;
  helperBinary?: string;
  providerConfig?: ProviderConfig;
  extractionLimits?: ExtractionLimits;
  faultHook?: (point: FaultPoint, context: { actionId: string; proposalId: string }) => void;
  stabilityWindowMs?: number;
}

export interface ScanResult {
  batchId: Id;
  rootId: Id;
  candidates: number;
  deferred: number;
  directories: number;
}

/** A persisted decision's provenance, for the review surface (R13). */
export interface DecisionDigest {
  id: Id;
  provider: string;
  modelRevision: string;
  selectedId: string;
  probability: number | null;
  elapsedMs: number;
  tokenCounts: Decision['tokenCounts'];
}

export interface ClassifyResult {
  batchId: Id;
  proposals: number;
  deferred: number;
  failed: number;
  provider: string;
  /** Basenames the provider deferred (unknown/insufficient evidence). */
  deferredItems: string[];
  /** Scope/identity refusals: symlinks, foreign devices, changed bytes (R3). */
  conflicts?: { basename: string; reason: string }[];
}

const DEFAULT_VOCABULARY = {
  maxLabelLength: 40,
  labelPattern: '^[A-Za-z][A-Za-z0-9 -]*$',
  reservedNames: ['System', 'Downloads', 'tmp'],
};

/** Crude singularisation so 'Invoices' matches 'invoice' in basenames. */
function singular(word: string): string {
  return word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word;
}

/** Builds the default provider set: rules (deterministic) + the typed
 * cloud/local adapters at their configured state (blocked honestly). */
export function createProviders(config: ProviderConfig = {}, helperBinary?: string): DecisionProvider[] {
  const providers: DecisionProvider[] = [new RulesProvider()];
  if (config.clef?.endpoint !== undefined) {
    providers.push(new ClefProvider({ endpoint: config.clef.endpoint }));
  }
  if (config.laya !== undefined) {
    providers.push(new LayaProvider(config.laya));
  }
  if (config.jev !== undefined) {
    // Jev stays deferred without a verified contract (spec review R14): the
    // configuration carries a dataset-scoped consent boundary and an explicit
    // verified-contract record, never a bare reference string.
    providers.push(new JevProvider(config.jev));
  }
  void helperBinary;
  return providers;
}

export class Organiser {
  private readonly repositories: Repositories;
  private readonly source: FilesystemSource;
  private readonly providers: DecisionProvider[];
  private readonly extractionLimits: ExtractionLimits;
  private readonly helper: HelperPort;
  private readonly stabilityWindowMs: number;
  private readonly clock: () => Date;
  private readonly destinations = new Map<Id, { id: Id; segments: string[]; device: string; inode: string; status: 'observed' | 'approved' }>();
  private readonly taxonomy: Taxonomy;
  /** Why the automatic suggestion cannot be used, when it cannot (F2). */
  private suggestionStatus: { state: 'ok' } | { state: 'curation_required'; reason: string } = { state: 'ok' };
  /** A valid auto-suggestion from discovery, never the active tree (F2). */
  private suggestedTree: Category[] = [];
  private readonly configuredRootPath: string | undefined;
  private root: RootConfig | null = null;
  readonly service: ApplicationService;

  constructor(options: OrganiserOptions) {
    this.repositories = createRepositories(options.dbPath);
    this.stabilityWindowMs = options.stabilityWindowMs ?? 5_000;
    this.clock = () => new Date();
    this.extractionLimits = options.extractionLimits ?? defaultExtractionLimits();
    this.source = new FilesystemSource({
      // The configured window reaches discovery: tests shrink it, production
      // keeps the PRD §3 spacing.
      stabilityWindowMs: this.stabilityWindowMs,
      clock: {
        now: () => this.clock().getTime(),
        sleep: (ms: number) =>
          new Promise((resolve) => {
            const started = this.clock().getTime();
            const wait = () => {
              if (this.clock().getTime() - started >= ms) resolve();
              else setTimeout(wait, 5);
            };
            wait();
          }),
      },
    });
    const config = options.providerConfig ?? loadProviderConfig();
    this.providers = createProviders(config, options.helperBinary);
    this.helper = createHelperPort(options.helperBinary);
    const workflowDeps: import('./workflow.js').WorkflowDeps = {
      repositories: this.repositories,
      helper: this.helper,
      clock: this.clock,
      destinations: this.destinations,
      // Durable current revisions (spec review R1): approvals validate against
      // what is stored, never against the approval's own bound values.
      currentTaxonomyRevision: () => this.repositories.taxonomies.latest()?.revision ?? this.taxonomy.revision,
      currentPolicyRevision: () => {
        const root = this.root === null ? null : this.repositories.roots.get(this.root.rootId);
        return root?.policyRevision ?? this.root?.policyRevision ?? 1;
      },
    };
    if (options.faultHook !== undefined) workflowDeps.faultHook = options.faultHook;
    this.service = new ApplicationService(workflowDeps);
    // The in-memory taxonomy is rebuilt from discovered directories at scan
    // time; start from an empty placeholder so the service has a revision.
    this.taxonomy = {
      revision: 1,
      tree: [{ id: 'root', parentId: null, label: 'Inbox', description: 'Root grouping', destinationId: null, kind: 'group' }],
      mappingHash: createHash('sha256').update('empty').digest('hex'),
    };
    // Durable current taxonomy (spec review R1/R9): a restarted process must
    // see the reviewed revision, not reset to the seed.
    const storedTaxonomy = this.repositories.taxonomies.latest();
    if (storedTaxonomy !== null) {
      // Resume AT the persisted revision: an in-memory revision that was
      // never persisted would bind approvals to a revision the durable state
      // cannot confirm (spec review R1).
      this.taxonomy.revision = storedTaxonomy.revision;
      this.taxonomy.mappingHash = storedTaxonomy.mappingHash;
      try {
        const parsed = JSON.parse(storedTaxonomy.treeJson) as Category[];
        if (Array.isArray(parsed) && parsed.length > 0) this.taxonomy.tree = parsed;
      } catch {
        // A corrupt stored tree keeps the seed tree; the next review replaces it.
      }
    }
    this.configuredRootPath = options.rootPath;
    if (options.rootPath !== undefined) {
      // Root resolution failures must surface, never fall back silently to
      // the real ~/Downloads during automated runs. A fresh process primes
      // the physical catalogue so display and suggestions work before a scan.
      void this.ensureRoot(options.rootPath)
        .then(() => this.refreshCatalogue())
        .catch(() => undefined);
    }
  }

  /** Resolves (and caches) the root config; read-only. */
  async ensureRoot(configuredPath?: string): Promise<RootConfig> {
    const raw =
      configuredPath ??
      this.configuredRootPath ??
      this.root?.absolutePath;
    if (raw === undefined) {
      throw new Error(
        'OUT_OF_SCOPE: no root configured; pass --root <path> or set ORGANISER_ROOT (no implicit home fallback)',
      );
    }
    const resolved = await resolveRoot(raw, {
      policyRevision: this.taxonomy.revision,
    });
    if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.detail}`);
    this.repositories.roots.insert({
      id: resolved.value.rootId,
      canonicalPath: resolved.value.absolutePath,
      device: resolved.value.device,
      inode: resolved.value.inode,
      policyRevision: resolved.value.policyRevision,
    });
    // The durable root record is authoritative: re-resolution keeps the
    // recorded policy revision instead of re-pinning it from the current
    // in-memory taxonomy (spec review R1/R2).
    const stored = this.repositories.roots.get(resolved.value.rootId);
    this.root =
      stored === null
        ? resolved.value
        : { ...resolved.value, policyRevision: stored.policyRevision };
    return this.root;
  }


  /** Re-discovers the destination catalogue; the semantic tree is never touched (F2). */
  async refreshCatalogue(): Promise<void> {
    const root = await this.ensureRoot();
    const directories = await this.source.discoverDirectories(root);
    if (!directories.ok) throw new Error(`${directories.code}: ${directories.detail}`);
    this.destinations.clear();
    for (const destination of directories.value) {
      this.destinations.set(destination.id, destination);
    }
    this.refreshSuggestion();
  }

  /** Read-only scan: discovery + directory catalogue + item persistence. */
  async scan(configuredPath?: string): Promise<ScanResult> {
    const root = await this.ensureRoot(configuredPath);
    const directories = await this.source.discoverDirectories(root);
    if (!directories.ok) throw new Error(`${directories.code}: ${directories.detail}`);
    this.destinations.clear();
    for (const destination of directories.value) {
      this.destinations.set(destination.id, destination);
    }

    const batch = this.repositories.batches.create(root.rootId);
    let candidates = 0;
    let deferred = 0;
    const scannedItemIds: Id[] = [];
    for await (const result of this.source.discover(root)) {
      if (result.ok) {
        candidates += 1;
        this.repositories.items.save(result.value, root.rootId);
        scannedItemIds.push(result.value.id);
      } else {
        deferred += 1;
        // Every exclusion is persisted with its reason (spec review R12).
        this.repositories.batches.addExclusion(batch.id, result.detail);
      }
    }
    // Per-batch membership: a later classification run classifies what THIS
    // scan observed, not every historic revision under the root. Old
    // databases were already reconstructed once at open (repositories).
    this.repositories.items.addToBatch(batch.id, scannedItemIds);
    this.refreshSuggestion();
    return { batchId: batch.id, rootId: root.rootId, candidates, deferred, directories: directories.value.length };
  }

  /**
   * Computes the SUGGESTED tree from the discovery catalogue (spec review
   * F2). Discovery must never mutate the approved semantic tree: the active
   * tree changes only through an explicit, revisioned, persisted review.
   * A suggestion that cannot be valid (e.g. more than seven folders beneath
   * one group) is reported as a status, not swallowed and not adopted.
   */
  private refreshSuggestion(): void {
    const tree: Category[] = [
      { id: 'root', parentId: null, label: 'Inbox', description: 'Root grouping', destinationId: null, kind: 'group' },
    ];
    for (const destination of this.destinations.values()) {
      tree.push({
        id: `cat-${destination.id}`,
        parentId: 'root',
        label: destination.segments[destination.segments.length - 1] ?? destination.id,
        description: `${destination.segments.at(-1) ?? ''} ${singular(destination.segments.at(-1) ?? '')} documents`,
        destinationId: destination.id,
        kind: 'existing',
      });
    }
    const destinations = [...this.destinations.values()];
    const validated = validateTaxonomy(tree, destinations);
    if (validated.ok) {
      this.suggestedTree = validated.value.tree;
      this.suggestionStatus = { state: 'ok' };
      return;
    }
    this.suggestedTree = [];
    this.suggestionStatus = { state: 'curation_required', reason: validated.detail };
  }

  /** The active tree's own curation status, based on its mapped destinations. */
  private activeTreeStatus(): { state: 'ok' } | { state: 'curation_required'; reason: string } {
    if (this.suggestionStatus.state !== 'ok') return this.suggestionStatus;
    if (this.repositories.taxonomies.latest() === null) {
      return { state: 'curation_required', reason: 'the taxonomy has not been reviewed yet' };
    }
    return { state: 'ok' };
  }

  /** Extraction + typed decisions + planning for every scanned item. */
  async classify(batchId?: Id, providerId: 'rules' | 'clef' | 'laya' | 'jev' = 'rules', profile: 'metadata' | 'compact_text' = 'compact_text'): Promise<ClassifyResult> {
    const root = await this.ensureRoot();
    // The destination catalogue and taxonomy are rebuilt from read-only
    // discovery so every verb starts from the same catalogue.
    await this.refreshCatalogue();
    const batch = batchId ?? this.repositories.batches.listByRoot(root.rootId).at(-1)?.id;
    if (batch === undefined) throw new Error('no batch to classify; run scan first');
    // A reviewed taxonomy is a precondition (spec review R9): routing into an
    // unreviewed or refused tree would invent destinations. The message says
    // exactly what to do instead of failing per item.
    const activeStatus = this.activeTreeStatus();
    if (activeStatus.state !== 'ok') {
      throw new Error(
        `OUT_OF_SCOPE: taxonomy curation required (${activeStatus.reason}); ` +
          'review the taxonomy in the UI before classifying',
      );
    }
    if (this.repositories.taxonomies.latest() === null) {
      throw new Error(
        'OUT_OF_SCOPE: the taxonomy has not been reviewed yet; approve a curated taxonomy in the UI before classifying',
      );
    }
    const provider = this.providers.find((entry) => entry.providerId === providerId);
    if (provider === undefined) throw new Error(`provider ${providerId} is not configured`);

    const items = this.itemsForBatch(batch);
    let proposals = 0;
    const deferredItems: string[] = [];
    /** Scope/identity refusals surfaced as visible conflicts (spec review R3). */
    const conflicts: { basename: string; reason: string }[] = [];
    let failed = 0;
    const manifest = await provider.health();
    const manifests = manifest.ok ? [manifest.value] : [];

    const extractor = createExtractor();
    for (const item of items) {
      // Evidence: the adapter owns the opened handle through anchored,
      // no-symlink resolution and verifies the scanned snapshot (R3).
      const opened = await this.source.openCandidate(root, item.externalId, item.snapshot);
      if (!opened.ok) {
        conflicts.push({ basename: item.externalId, reason: opened.detail });
        continue;
      }
      try {
        const size = Number(opened.value.observed.size);
        const evidence = await extractor.extractEvidence(item, { handle: opened.value.handle, size }, this.extractionLimits);
        if (!evidence.ok) {
          failed += 1;
          continue;
        }
        const evidenceValue = evidence.value;
        if (evidenceValue.status === 'metadata_only' || evidenceValue.state.compactText === undefined) {
          // Metadata-only evidence: try the provider anyway; it defers if
          // it cannot place the item (FR-05).
        }
        const routed = await this.decideRoute(provider, evidenceValue, manifests, profile);
        if (!routed.ok) {
          failed += 1;
          if (process.env.ORGANISER_DEBUG === '1') console.error('decideRoute failed', routed.detail);
          continue;
        }
        // The provider's own decision is persisted with its real provenance
        // (spec review R12); the routing wrapper stays derived.
        const decisionId = routed.value.decision === null ? null : this.persistDecision(item, routed.value.decision);
        const decision = routed.value.route;
        if (decision.answers.at(-1)?.selectedId === 'unknown') {
          deferredItems.push(item.externalId);
          continue;
        }
        const planned = planPlacement(
          { ...item, evidenceId: evidenceValue.id },
          { answers: decision.answers.map((answer) => ({ nodeId: 'root', questionId: answer.questionId, selectedId: answer.selectedId })) },
          this.taxonomy,
          root.policyRevision,
        );
        if (!planned.ok) {
          deferredItems.push(item.externalId);
          if (process.env.ORGANISER_DEBUG === '1') console.error('planPlacement failed', planned.detail);
          continue;
        }
        this.repositories.proposals.save({
          ...planned.value,
          decisionIds: decisionId === null ? [] : [decisionId],
        });
        proposals += 1;
      } finally {
        await opened.value.handle.close();
      }
    }
    return {
      batchId: batch,
      proposals,
      deferred: deferredItems.length,
      failed,
      provider: provider.providerId,
      deferredItems,
      conflicts,
    };
  }

  /** Routes one question per taxonomy level through the provider. */
  private async decideRoute(
    provider: DecisionProvider,
    evidenceValue: Evidence,
    manifests: Parameters<typeof buildMatchedRequest>[2],
    profile: 'metadata' | 'compact_text',
  ): Promise<Result<{ route: Decision; decision: Decision | null }>> {
    let nodeId: Id = 'root';
    const answers: Decision['answers'] = [];
    const providerDecisions: Decision[] = [];
    for (let level = 0; level < 4; level++) {
      const children = this.taxonomy.tree.filter((category) => category.parentId === nodeId);
      const node = this.taxonomy.tree.find((category) => category.id === nodeId);
      if (children.length === 0 || node === undefined) break;
      const request = buildMatchedRequest(
        this.treatEvidence(evidenceValue, profile),
        { category: node, children },
        manifests,
      );
      if (!request.ok) return request;
      const result = await provider.decide(request.value);
      if (!result.ok) return result;
      providerDecisions.push(result.value);
      const answer = result.value.answers[0];
      if (answer === undefined) {
        return { ok: false, code: 'INVALID_DECISION', detail: 'provider returned no answer' };
      }
      answers.push(answer);
      if (answer.selectedId === 'unknown') break;
      nodeId = answer.selectedId;
      const child = this.taxonomy.tree.find((category) => category.id === nodeId);
      if (child?.kind === 'existing') break;
    }
    const first = answers[0];
    if (first === undefined) {
      return { ok: false, code: 'INVALID_DECISION', detail: 'no routing answers' };
    }
    // The routing wrapper is derived; provenance (model revision, evidence
    // hash, timing) stays the provider's own decision (spec review R12).
    return ok({
      route: {
        id: `decision-${first.questionId}-${answers.length}`,
        itemId: evidenceValue.itemId,
        provider: provider.providerId,
        modelRevision: 'route',
        runtimeRevision: process.version,
        evidenceHash: evidenceValue.stateHash,
        schemaHash: 'route',
        answers,
        elapsedMs: 0,
        tokenCounts: {},
        error: null,
      },
      decision: providerDecisions[providerDecisions.length - 1] ?? null,
    });
  }

  /** Persists the provider's own decision with real provenance (R12). */
  private persistDecision(item: Item, decision: Decision): Id {
    // The provider's decision id is per question; the persisted row must be
    // unique per item, so the item is part of the key.
    const id = `decision-${item.id}-${decision.id}`;
    this.repositories.decisions.save({
      id,
      itemId: item.id,
      provider: decision.provider,
      modelRevision: decision.modelRevision,
      runtimeRevision: decision.runtimeRevision,
      evidenceHash: decision.evidenceHash,
      schemaHash: decision.schemaHash,
      answersJson: JSON.stringify(decision.answers),
      elapsedMs: decision.elapsedMs,
      tokenCountsJson: JSON.stringify(decision.tokenCounts),
      error: decision.error,
    });
    return id;
  }

  private treatEvidence(evidence: Parameters<DecisionProvider['decide']>[0]['evidence'], profile: 'metadata' | 'compact_text') {
    if (profile === 'compact_text') return evidence;
    const state: Record<string, unknown> = { ...evidence.state };
    delete state.compactText;
    return {
      ...evidence,
      profile: 'metadata' as const,
      state,
      stateHash: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
    };
  }

  private itemsForRoot(rootId: Id): Item[] {
    return this.repositories.items
      .listByRoot(rootId)
      .map((entry) => ({ ...entry.item, sourceKind: 'filesystem' as const }));
  }

  private itemsForBatch(batch: Id): Item[] {
    const batchRow = this.repositories.batches.get(batch);
    if (batchRow === null) return [];
    // Databases that predate the membership tables (spec review F7) are
    // reconstructed once at scan time; after that, an empty batch stays
    // genuinely empty. No eternal root-wide ambiguity remains.
    return this.repositories.items
      .listByBatch(batch)
      .map((entry) => ({ ...entry.item, sourceKind: 'filesystem' as const }));
  }

  async listProposals(
    batchId?: Id,
  ): Promise<Result<{ proposals: Proposal[]; decisions: Record<Id, DecisionDigest> }>> {
    let rootId: Id | null = null;
    let batchForList: { id: Id } | null = null;
    if (batchId !== undefined) {
      const batch = this.repositories.batches.get(batchId);
      if (batch === null) {
        return { ok: false, code: 'OUT_OF_SCOPE', detail: `unknown batch ${batchId}` };
      }
      rootId = batch.rootId;
      batchForList = batch;
    } else {
      await this.ensureRoot();
      const batch = this.currentBatch();
      if (batch === null) {
        return { ok: false, code: 'OUT_OF_SCOPE', detail: 'no batch available; run scan first' };
      }
      rootId = batch.rootId;
      batchForList = batch;
    }
    // Batch-bound listing (spec review F7): proposals for the items THIS batch
    // scanned, never historic root-wide rows. Legacy databases (no membership
    // at all) keep the root view so pre-F7 approvals remain reviewable.
    const proposals = this.repositories.items.hasMembership() && batchForList !== null
      ? this.repositories.proposals.listByBatch(batchForList.id)
      : this.repositories.proposals.listByRoot(rootId);
    // The persisted provider decisions are surfaced with their real
    // provenance so the review can inspect evidence, not just a destination
    // (spec review R13/R12).
    const decisions: Record<Id, DecisionDigest> = {};
    const scopeItems =
      this.repositories.items.hasMembership() && batchForList !== null
        ? this.repositories.items.listByBatch(batchForList.id)
        : this.repositories.items.listByRoot(rootId);
    const itemsById = new Map(scopeItems.map((row) => [row.item.id, row.item.id]));
    const decisionRows = this.repositories.decisions
      .listByRoot(rootId)
      .map((row) => ({ id: row.decision.id, itemId: row.decision.itemId, record: row.decision }));
    for (const proposal of proposals) {
      if (!itemsById.has(proposal.itemId)) continue;
      for (const decisionId of proposal.decisionIds) {
        const row = decisionRows.find((entry) => entry.id === decisionId && entry.itemId === proposal.itemId);
        if (row === undefined) continue;
        const answers = JSON.parse(row.record.answersJson) as Decision['answers'];
        const answer = answers[answers.length - 1];
        const selectedId = answer?.selectedId ?? '';
        decisions[proposal.id] = {
          id: row.id,
          provider: row.record.provider,
          modelRevision: row.record.modelRevision,
          selectedId,
          probability: answer === undefined ? null : (answer.probabilities[selectedId] ?? null),
          elapsedMs: row.record.elapsedMs,
          tokenCounts: JSON.parse(row.record.tokenCountsJson) as Decision['tokenCounts'],
        };
      }
    }
    return ok({ proposals, decisions });
  }

  patchProposal(proposalId: Id, patch: { expectedVersion: Revision; categoryId?: Id; destinationId?: Id; reject?: boolean }): Promise<Result<Proposal>> {
    const proposal = this.repositories.proposals.get(proposalId);
    if (proposal === null) return Promise.resolve({ ok: false as const, code: 'OUT_OF_SCOPE' as const, detail: `unknown proposal ${proposalId}` });
    if (patch.reject === true) {
      // Spec review R4: a rejection is persisted, not just returned.
      const rejected = rejectProposal(proposal, patch.expectedVersion);
      if (rejected.ok) this.repositories.proposals.save(rejected.value);
      return Promise.resolve(rejected);
    }
    const patchInput: { expectedVersion: Revision; categoryId?: Id; destinationId?: Id } = {
      expectedVersion: patch.expectedVersion,
    };
    if (patch.categoryId !== undefined) patchInput.categoryId = patch.categoryId;
    if (patch.destinationId !== undefined) patchInput.destinationId = patch.destinationId;
    // The reviewed taxonomy owns the category → destination mapping: an edit
    // may not bind a category to a destination the taxonomy does not map
    // (spec review R13).
    const categoryId = patchInput.categoryId ?? proposal.categoryId;
    const destinationId = patchInput.destinationId ?? proposal.destinationId;
    const category = this.taxonomy.tree.find((entry) => entry.id === categoryId);
    if (category === undefined || category.destinationId !== destinationId) {
      return Promise.resolve({
        ok: false as const,
        code: 'INVALID_DECISION' as const,
        detail: `category ${categoryId} is not mapped to destination ${destinationId} by the reviewed taxonomy`,
      });
    }
    const updated = patchProposal(proposal, patchInput);
    if (updated.ok) this.repositories.proposals.save(updated.value);
    return Promise.resolve(updated);
  }

  async approveAll(batchId?: Id): Promise<Result<{ approvalId: string; actionSetHash: string; actions: { proposalId: Id; version: Revision }[] }>> {
    await this.refreshCatalogue();
    const batch = this.currentBatch(batchId);
    if (batch === null) return { ok: false, code: 'OUT_OF_SCOPE', detail: 'no batch' };
    const pending = [...this.destinations.keys()].length > 0 ? await this.pendingProposals(batch.id) : [];
    if (pending.length === 0) {
      return { ok: false, code: 'INVALID_DECISION', detail: 'there are no pending proposals to approve' };
    }
    const created = this.service.createApproval(batch.id, pending, 'apply', this.clock());
    if (!created.ok) return created;
    return ok({ approvalId: created.value.id, actionSetHash: created.value.actionSetHash, actions: pending });
  }

  private async pendingProposals(batchId: Id): Promise<{ proposalId: Id; version: Revision }[]> {
    const listed = await this.listProposals(batchId);
    const rows = listed.ok ? listed.value.proposals : [];
    return rows
      .filter((proposal) => proposal.state === 'pending')
      .map((proposal) => ({ proposalId: proposal.id, version: proposal.version }));
  }

  private currentBatch(batchId?: Id) {
    if (batchId !== undefined) return this.repositories.batches.get(batchId);
    const root = this.root;
    if (root === null) return null;
    return this.repositories.batches.listByRoot(root.rootId).at(-1) ?? null;
  }

  async apply(approvalId: Id, actionSetHash: string): Promise<{ batchId: Id; results: ActionResult[] }> {
    const batch = this.repositories.approvals.get(approvalId);
    if (batch === null) throw new Error(`unknown approval ${approvalId}`);
    // The destination catalogue is re-verified read-only before any move.
    await this.refreshCatalogue();
    return this.service.applyBatch(batch.batchId, approvalId, actionSetHash);
  }

  async resume(batchId?: Id): Promise<{ batchId: Id; results: ActionResult[] }> {
    await this.refreshCatalogue();
    const batch = this.currentBatch(batchId);
    if (batch === null) throw new Error('no batch');
    return this.service.resumeBatch(batch.id);
  }

  async undoAll(_applyApprovalId?: Id): Promise<{ results: ActionResult[] }> {
    await this.refreshCatalogue();
    const undone: ActionResult[] = [];
    const approvals = this.repositories.approvals.listByBatch(this.currentBatch()?.id ?? '');
    for (const approval of approvals) {
      if (approval.mode !== 'apply') continue;
      for (const record of this.repositories.actions.listByApproval(approval.id)) {
        if (record.state !== 'applied') continue;
        const undoApproval = this.service.createApproval(
          approval.batchId,
          [{ proposalId: record.proposalId, version: record.proposalVersion }],
          'undo',
          this.clock(),
        );
        if (!undoApproval.ok) continue;
        const result = await this.service.undoAction(record.id, undoApproval.value.id);
        undone.push(
          result.ok
            ? { actionId: record.id, proposalId: record.proposalId, outcome: 'undone', receipt: result.value, detail: 'undone' }
            : { actionId: record.id, proposalId: record.proposalId, outcome: 'conflict', detail: `${result.code}: ${result.detail}` },
        );
      }
    }
    return { results: undone };
  }

  /** HTTP surface: create (scan) a batch for a known root id. */
  async createBatch(rootId?: Id): Promise<Result<ScanResult>> {
    let configuredPath: string | undefined;
    if (rootId !== undefined && rootId !== '') {
      const record = this.repositories.roots.get(rootId);
      if (record === null) {
        return { ok: false, code: 'OUT_OF_SCOPE', detail: `unknown root ${rootId}` };
      }
      configuredPath = record.canonicalPath;
    }
    const result = await this.scan(configuredPath);
    return ok(result);
  }

  /** HTTP surface: batch lookup. */
  getBatch(batchId: Id): Promise<Result<unknown>> {
    const batch = this.repositories.batches.get(batchId);
    if (batch === null) {
      return Promise.resolve({ ok: false as const, code: 'OUT_OF_SCOPE' as const, detail: `unknown batch ${batchId}` });
    }
    return Promise.resolve(ok(batch));
  }

  /** HTTP surface: approval creation with the caller's action selection. */
  createApproval(body: { batchId: Id; actions: { proposalId: Id; version: Revision }[]; mode: 'apply' | 'undo' }): Promise<Result<unknown>> {
    return Promise.resolve(this.createApprovalSync(body));
  }

  private createApprovalSync(body: { batchId: Id; actions: { proposalId: Id; version: Revision }[]; mode: 'apply' | 'undo' }): Result<unknown> {
    const { batchId, actions, mode } = body;
    const batch = this.repositories.batches.get(batchId);
    if (batch === null) return { ok: false, code: 'OUT_OF_SCOPE', detail: `unknown batch ${batchId}` };
    const selected: Proposal[] = [];
    for (const action of actions) {
      const proposal = this.repositories.proposals.get(action.proposalId);
      if (proposal === null || proposal.version !== action.version) {
        return { ok: false, code: 'STALE', detail: `proposal ${action.proposalId} is not at version ${action.version}` };
      }
      selected.push(proposal);
    }
    const created = this.service.createApproval(batch.id, selected.map((proposal) => ({ proposalId: proposal.id, version: proposal.version })), mode, this.clock());
    if (!created.ok) return created;
    return ok({
      id: created.value.id,
      actions,
      actionSetHash: created.value.actionSetHash,
      taxonomyRevision: selected[0]?.taxonomyRevision ?? this.taxonomy.revision,
      policyRevision: selected[0]?.policyRevision ?? 1,
      expiresAt: created.value.expiresAt,
      mode,
    });
  }

  /** HTTP surface: the reviewed taxonomy replacing the current revision. */
  replaceTaxonomy(body: {
    expectedRevision: Revision;
    tree: Category[];
    mappings: { categoryId: Id; destinationId: Id }[];
  }): Promise<Result<{ revision: Revision; mappingHash: string }>> {
    return Promise.resolve(this.replaceTaxonomySync(body));
  }

  private replaceTaxonomySync(body: {
    expectedRevision: Revision;
    tree: Category[];
    mappings: { categoryId: Id; destinationId: Id }[];
  }): Result<{ revision: Revision; mappingHash: string }> {
    if (body.expectedRevision !== this.taxonomy.revision) {
      return {
        ok: false,
        code: 'STALE',
        detail: `expected revision ${body.expectedRevision}, current revision ${this.taxonomy.revision}`,
      };
    }
    const destinations = [...this.destinations.values()];
    const validated = validateTaxonomy(body.tree, destinations);
    if (!validated.ok) return validated;
    const previousRevision = this.taxonomy.revision;
    this.taxonomy.tree = validated.value.tree;
    this.taxonomy.mappingHash = validated.value.mappingHash;
    this.taxonomy.revision += 1;
    // Durable + invalidating (spec review R1): the reviewed revision persists
    // and every pending proposal bound to an older taxonomy revision becomes
    // stale, so no outstanding approval keeps authorising the old tree.
    this.repositories.taxonomies.save(
      this.taxonomy.revision,
      JSON.stringify(validated.value.tree),
      validated.value.mappingHash,
      this.clock().toISOString(),
    );
    this.repositories.proposals.markStaleBeforeRevision(previousRevision + 1);
    this.refreshSuggestion();
    return ok({ revision: this.taxonomy.revision, mappingHash: validated.value.mappingHash });
  }

  /** Provider health through the same doctor probe. */
  async providerHealth() {
    return probeProviders(loadProviderConfig());
  }

  /** HTTP surface: the current taxonomy with its expected revision. */
  getTaxonomy(): Result<{
    revision: Revision;
    tree: Category[];
    mappingHash: string;
    status: { state: 'ok' } | { state: 'curation_required'; reason: string };
    reviewed: boolean;
    destinations: { id: Id; segments: string[] }[];
    /** Discovered destinations NOT referenced by the active tree (F2). */
    unmapped: { id: Id; segments: string[] }[];
    /** Active-tree categories whose mapped destination is no longer discovered. */
    missing: { categoryId: Id; destinationId: Id }[];
    /** The auto-suggestion from discovery, empty when it cannot be valid. */
    suggested: Category[];
    /** The resolved organisation root, for readable target paths (R13). */
    root: string;
  }> {
    const mapped = new Set(
      this.taxonomy.tree.map((node) => node.destinationId).filter((id): id is Id => id !== null),
    );
    // Surface drifted mappings instead of silently dropping them (F2).
    const missing = this.taxonomy.tree
      .filter(
        (node): node is Category & { destinationId: Id } =>
          node.destinationId !== null && !this.destinations.has(node.destinationId),
      )
      .map((node) => ({ categoryId: node.id, destinationId: node.destinationId }));
    return ok({
      revision: this.taxonomy.revision,
      tree: this.taxonomy.tree,
      mappingHash: this.taxonomy.mappingHash,
      status: this.activeTreeStatus(),
      // An explicitly reviewed taxonomy is a persisted one; the seed tree is not.
      reviewed: this.repositories.taxonomies.latest() !== null,
      destinations: [...this.destinations.values()].map((destination) => ({
        id: destination.id,
        segments: destination.segments,
      })),
      unmapped: [...this.destinations.values()]
        .filter((destination) => !mapped.has(destination.id))
        .map((destination) => ({ id: destination.id, segments: destination.segments })),
      missing,
      suggested: this.suggestedTree,
      root: this.root?.absolutePath ?? '',
    });
  }

  /**
   * The suggested curated tree from discovery (spec review F2): a starting
   * point for review, never an active-tree mutation. Refused with the real
   * reason when more destinations exist than one group may hold.
   */
  suggestTaxonomy(): Result<Category[]> {
    if (this.suggestionStatus.state !== 'ok') {
      return { ok: false, code: 'INVALID_DECISION', detail: this.suggestionStatus.reason };
    }
    return ok(this.suggestedTree);
  }

  /** HTTP surface: classification for a batch (provider + profile). */
  classifyBatch(batchId: Id, body: { provider: string; profile: string }): Promise<Result<ClassifyResult>> {
    return this.classify(
      batchId,
      body.provider as 'rules' | 'clef' | 'laya' | 'jev',
      body.profile === 'metadata' ? 'metadata' : 'compact_text',
    ).then(ok);
  }

  /**
   * HTTP surface: apply with the exact approval and action-set hash. The
   * URL's batch id is PASSED THROUGH (spec review F7): the service refuses an
   * approval bound to a different batch instead of silently applying the
   * approval's own batch.
   */
  async applyBatch(batchId: Id, body: { approvalId: Id; actionSetHash: string }): Promise<Result<unknown>> {
    const approval = this.repositories.approvals.get(body.approvalId);
    if (approval === null) {
      return { ok: false, code: 'OUT_OF_SCOPE', detail: `unknown approval ${body.approvalId}` };
    }
    // A mismatched transport batch is refused here, hard, before any effect
    // (spec review F7): the URL cannot silently re-point the approval's own
    // batch, and the service's own check stays as the second line of defence.
    if (approval.batchId !== batchId) {
      return {
        ok: false,
        code: 'OUT_OF_SCOPE',
        detail: `approval ${body.approvalId} belongs to batch ${approval.batchId}, not ${batchId}`,
      };
    }
    // The destination catalogue is re-verified read-only before any move.
    await this.refreshCatalogue();
    const applied = await this.service.applyBatch(batchId, body.approvalId, body.actionSetHash);
    return ok(applied);
  }

  /** HTTP surface: reconcile a batch's unfinished work. */
  resumeBatch(batchId: Id): Promise<Result<unknown>> {
    return this.resume(batchId).then(ok);
  }

  /** HTTP surface: conditional undo under a separate undo approval. */
  async undoAction(actionId: Id, body: { approvalId: Id }): Promise<Result<unknown>> {
    const result = await this.service.undoAction(actionId, body.approvalId);
    return result;
  }

  /**
   * HTTP surface: propose one reviewed folder segment (FR-06, spec review R10).
   * The proposal is logical: the directory is created by approved execution,
   * never by this request.
   */
  mkdirFolder(batchId: Id, body: { parentSegments: string[]; segment: string; label: string }): Promise<Result<unknown>> {
    return this.service.proposeFolder(body.parentSegments, body.segment, batchId, body.label);
  }

  /** HTTP surface: reviewed folder groups. */
  listFolders(batchId: Id): Result<unknown> {
    return ok(this.service.listFolderCandidates(batchId));
  }

  /** HTTP surface: the batch's action journal for the history surface. */
  listActions(batchId: Id): Result<unknown> {
    const rows: unknown[] = [];
    const seen = new Set<string>();
    for (const approval of this.repositories.approvals.listByBatch(batchId)) {
      for (const record of this.repositories.actions.listByApproval(approval.id)) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        rows.push({
          actionId: record.id,
          proposalId: record.proposalId,
          proposalVersion: record.proposalVersion,
          state: record.state,
          mode: record.mode,
          events: record.events.length > 0 ? record.events : this.repositories.actions.get(record.id)?.events ?? [],
        });
      }
    }
    return ok({ actions: rows });
  }

  /** Suggests reviewed folder groups from deferred items (FR-06). */
  /**
   * Suggested new folders from items whose classification deferred to unknown
   * (spec review R10): the groups come from the persisted provider decisions,
   * so a suggestion is auditable evidence rather than a fresh guess.
   */
  folderGroups(batchId?: Id): FolderCandidate[] {
    const batch = this.currentBatch(batchId);
    if (batch === null) return [];
    const items = this.itemsForRoot(batch.rootId);
    const rows = this.repositories.decisions.listByRoot(batch.rootId);
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const decisions: Decision[] = [];
    for (const row of rows) {
      const item = itemsById.get(row.decision.itemId);
      if (item === undefined) continue;
      const answers = JSON.parse(row.decision.answersJson) as Decision['answers'];
      const last = answers[answers.length - 1];
      if (last === undefined || last.selectedId !== UNKNOWN_OPTION_ID) continue;
      decisions.push({
        id: row.decision.id,
        itemId: row.decision.itemId,
        provider: row.decision.provider as ProviderId,
        modelRevision: row.decision.modelRevision,
        runtimeRevision: row.decision.runtimeRevision,
        evidenceHash: row.decision.evidenceHash,
        schemaHash: row.decision.schemaHash,
        answers,
        elapsedMs: row.decision.elapsedMs,
        tokenCounts: JSON.parse(row.decision.tokenCountsJson) as Decision['tokenCounts'],
        error: row.decision.error as ErrorCode | null,
      });
    }
    return suggestFolderGroups(items, decisions, DEFAULT_VOCABULARY);
  }

  validateApprovalFor(approvalId: Id): boolean {
    const approval = this.repositories.approvals.get(approvalId);
    if (approval === null) return false;
    const selected = JSON.parse(approval.selectedActionsJson) as { proposalId: Id; version: Revision }[];
    const context = {
      taxonomyRevision: approval.taxonomyRevision,
      policyRevision: approval.policyRevision,
      actions: selected.map((entry) => {
        const proposal = this.repositories.proposals.get(entry.proposalId);
        return { proposalId: entry.proposalId, version: proposal?.version ?? -1 };
      }),
    };
    const approvalContract = {
      id: approval.id,
      batchId: approval.batchId,
      actions: selected,
      actionSetHash: approval.actionSetHash,
      taxonomyRevision: approval.taxonomyRevision,
      policyRevision: approval.policyRevision,
      approvedAt: '',
      expiresAt: approval.expiresAt,
      mode: approval.mode as 'apply' | 'undo',
    };
    return validateApproval(approvalContract, context, this.clock()).ok;
  }

  /** Read-only repository access for the export surface (R12). */
  repositoriesForExport(): Repositories {
    return this.repositories;
  }

  close(): void {
    // Provider sessions (e.g. the Laya ONNX runtime) are released with the
    // application, not leaked per verb (spec review R11).
    for (const provider of this.providers) void provider.close().catch(() => undefined);
    this.repositories.close();
  }
}

/** Real helper bridge as a HelperPort (lazy import keeps the module testable). */
function createHelperPort(binaryPath?: string): HelperPort {
  let cached: typeof import('../adapters/filesystem/helper.js') | null = null;
  const load = async () => {
    if (cached === null) cached = await import('../adapters/filesystem/helper.js');
    return cached;
  };
  return {
    async probe(root) {
      const { probeFilesystem } = await load();
      return probeFilesystem(root, binaryPath);
    },
    async inspectAt(root, segments) {
      const { inspectAt } = await load();
      return inspectAt(root, segments, binaryPath);
    },
    async moveAt(action, root, destination) {
      const { moveAt } = await load();
      return moveAt(action, root, destination, binaryPath);
    },
    async mkdirAt(root, parent, segment) {
      const { mkdirAt } = await load();
      return mkdirAt(root, parent, segment, binaryPath);
    },
    async undoAt(action, root) {
      const { undoAt } = await load();
      return undoAt(action, root, binaryPath);
    },
  };
}
