/**
 * Normalised value types and result/error envelopes (LLD §2).
 *
 * Model output selects category IDs only: it has no path, shell, executable
 * or filesystem-write authority (AGENTS.md rule 3). All integer stat values
 * use decimal strings to avoid JavaScript precision loss; `validateSnapshot`
 * enforces that at every boundary where untrusted values enter.
 */

export type Id = string;
export type Sha256 = string;
export type Revision = number;
export type ProviderId = 'rules' | 'laya' | 'clef' | 'jev';

export type ErrorCode =
  | 'OUT_OF_SCOPE'
  | 'UNSTABLE'
  | 'OVERSIZE'
  | 'UNSUPPORTED'
  | 'EXTRACTION_FAILED'
  | 'INPUT_TOO_LONG'
  | 'PROVIDER_FAILED'
  | 'INVALID_DECISION'
  | 'STALE'
  | 'COLLISION'
  | 'CROSS_MOUNT'
  | 'UNSUPPORTED_KERNEL'
  | 'CONFLICT'
  | 'UNAUTHORISED';

export type Result<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; detail: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(code: ErrorCode, detail: string): Result<T> => ({
  ok: false,
  code,
  detail,
});

/**
 * Stable canonical JSON (sorted keys, arrays preserved) so identical state
 * always hashes identically across extraction, taxonomy and providers.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Reserved deferral option ID used by every routing question. */
export const UNKNOWN_OPTION_ID = 'unknown';

export interface Snapshot {
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  sha256: Sha256;
}

export interface Item {
  id: Id;
  sourceId: Id;
  sourceKind: 'filesystem' | 'collection';
  externalId: string;
  /** Human-facing label derived from the source (basename for files). */
  displayName: string;
  revision: string;
  snapshot: Snapshot | null;
  /**
   * Discovery lists items before any evidence is extracted; null means no
   * evidence record exists yet. Filled by the extraction stage.
   */
  evidenceId: Id | null;
}

export interface Evidence {
  id: Id;
  itemId: Id;
  profile: 'metadata' | 'compact_text';
  state: Record<string, unknown>;
  stateHash: Sha256;
  status: 'ready' | 'metadata_only' | 'failed';
  truncated: boolean;
  extractorRevision: string;
  inputTokenCounts: Record<string, number>;
}

export interface Category {
  id: Id;
  parentId: Id | null;
  label: string;
  description: string;
  destinationId: Id | null;
  kind: 'group' | 'existing' | 'candidate';
}

export interface ChoiceQuestion {
  id: Id;
  instruction: string;
  options: { id: Id; description: string }[];
}

export interface DecisionRequest {
  evidence: Evidence;
  questions: ChoiceQuestion[];
  schemaHash: Sha256;
  taxonomyRevision: Revision;
}

export interface ChoiceAnswer {
  questionId: Id;
  selectedId: Id;
  probabilities: Record<Id, number>;
  providerConfidence: number | null;
}

export interface Decision {
  id: Id;
  itemId: Id;
  provider: ProviderId;
  modelRevision: string;
  runtimeRevision: string;
  evidenceHash: Sha256;
  schemaHash: Sha256;
  answers: ChoiceAnswer[];
  elapsedMs: number;
  tokenCounts: Record<string, number>;
  error: ErrorCode | null;
}

export interface Proposal {
  id: Id;
  version: Revision;
  itemId: Id;
  categoryId: Id;
  destinationId: Id;
  basename: string;
  expected: Snapshot;
  taxonomyRevision: Revision;
  policyRevision: Revision;
  decisionIds: Id[];
  state: 'pending' | 'approved' | 'stale' | 'rejected';
}

export interface Approval {
  id: Id;
  batchId: Id;
  actions: { proposalId: Id; version: Revision }[];
  actionSetHash: Sha256;
  taxonomyRevision: Revision;
  policyRevision: Revision;
  approvedAt: string;
  expiresAt: string;
  mode: 'apply' | 'undo';
}

/**
 * Ordered node answers of a taxonomy route: one per level, at most four.
 * A path ending at the unknown option or any non-existing node cannot be
 * planned into a proposal (FR-05).
 */
export interface DecisionPath {
  answers: { nodeId: Id; questionId: Id; selectedId: Id }[];
}

/** Current bound state an approval is validated against (FR-07). */
export interface ApprovalContext {
  taxonomyRevision: Revision;
  policyRevision: Revision;
  actions: { proposalId: Id; version: Revision }[];
}

/**
 * A suggested new folder group (FR-06): members are examples, the label is
 * controlled by the vocabulary, and NO physical folder exists until accepted
 * execution. reviewState tracks the reviewed group-level decision.
 */
export interface FolderCandidate {
  id: Id;
  label: string;
  members: Id[];
  destinationParentId: Id | null;
  reviewState: 'draft' | 'accepted' | 'rejected';
  createdBy: 'suggestion' | 'user';
}

/** Controlled naming vocabulary for suggested folders. */
export interface Vocabulary {
  maxLabelLength: number;
  labelPattern: string;
  reservedNames: string[];
}

export interface MoveReceipt {
  kind: 'move_file';
  actionId: Id;
  requestId: Id;
  outcome: 'moved' | 'conflict' | 'unchanged';
  before: Snapshot;
  after: Snapshot | null;
  createdDirectoryIds: Id[];
  verified: boolean;
}

export interface SourceCapabilities {
  actions: ('move_file' | 'tag_item')[];
  recovery: 'reconcile_and_reverse' | 'compensate' | 'none';
}

export interface ApprovedTag {
  kind: 'tag_item';
  actionId: Id;
  sourceId: Id;
  itemId: Id;
  expectedRevision: string;
  tags: string[];
  approvalId: Id;
}

export interface TagReceipt {
  kind: 'tag_item';
  actionId: Id;
  outcome: 'tagged' | 'conflict' | 'unchanged';
  revision: string;
}

/**
 * `RootConfig` is the opaque, resolved root identity: rootId, resolved
 * absolute root, recorded device/inode, discovery depth 0 (inbox), directory
 * depth 3 (destinations) and the policy revision the scan was bound to.
 */
export interface RootConfig {
  rootId: Id;
  absolutePath: string;
  device: string;
  inode: string;
  inboxDepth: 0;
  directoryDepth: 3;
  policyRevision: Revision;
}

export interface ApprovedMove {
  kind: 'move_file';
  actionId: Id;
  rootId: Id;
  /** Direct-child basename of the source inside the root. */
  sourceBasename: string;
  /** Approved destination relative segments beneath the root. */
  destinationSegments: string[];
  expected: Snapshot;
  approvalId: Id;
}

export type ApprovedAction = ApprovedMove | ApprovedTag;
export type ActionReceipt = MoveReceipt | TagReceipt;

/**
 * A destination folder beneath the organisation root. `segments` are the
 * relative path components (depth 1..3); `device`/`inode` pin the directory
 * identity. `status` distinguishes observed existing folders from reviewed
 * additions; a `candidate` folder has no physical directory until accepted
 * execution (FR-06).
 */
export interface Destination {
  id: Id;
  segments: string[];
  device: string;
  inode: string;
  status: 'observed' | 'approved';
}

export interface SourceAdapter {
  capabilities(): SourceCapabilities;
  discover(config: RootConfig): AsyncIterable<Result<Item>>;
  inspect(itemId: Id): Promise<Result<Snapshot>>;
  apply(action: ApprovedAction): Promise<Result<ActionReceipt>>;
}

/**
 * ProviderManifest records provider ID, pinned model/runtime/tokenizer
 * revisions, question/input limits and the actual endpoint in use.
 */
export interface ProviderManifest {
  provider: ProviderId;
  modelRevision: string;
  runtimeRevision: string;
  tokenizerRevision: string;
  /** Maximum question header length in exact tokenizer tokens. */
  questionTokenLimit: number | null;
  /** Maximum encoded input length in exact tokenizer tokens. */
  inputTokenLimit: number | null;
  /** Actual endpoint for remote-style providers; null for in-process ones. */
  endpoint: string | null;
}

export interface DecisionProvider {
  /** Stable provider identity; never guessed from constructor names. */
  readonly providerId: ProviderId;
  health(): Promise<Result<ProviderManifest>>;
  decide(request: DecisionRequest): Promise<Result<Decision>>;
  close(): Promise<void>;
}

/** Matches non-negative decimal integers only: no signs, fractions, exponents. */
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Validates a snapshot at an untrusted boundary. Integer stat values must be
 * decimal strings; numbers are rejected because JavaScript loses precision
 * above 2^53 and JSON round-trips would silently corrupt identities.
 */
export function validateSnapshot(snapshot: Snapshot): Result<void> {
  const decimalFields = ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs'] as const;
  for (const field of decimalFields) {
    const raw: unknown = snapshot[field];
    if (typeof raw !== 'string' || !DECIMAL_PATTERN.test(raw)) {
      return err(
        'INVALID_DECISION',
        `snapshot.${field} must be a decimal string; received ${
          typeof raw === 'number'
            ? `number ${raw} (precision-loss risk above 2^53)`
            : JSON.stringify(raw)
        }`,
      );
    }
  }
  if (typeof snapshot.sha256 !== 'string' || !SHA256_PATTERN.test(snapshot.sha256)) {
    return err('INVALID_DECISION', 'snapshot.sha256 must be 64 lowercase hex characters');
  }
  return ok(undefined);
}

/**
 * Validates a provider answer against the canonical question (LLD §3):
 * exact question ID, probability keys exactly equal to the option ID set,
 * finite values in [0,1], sum within 0.001 of one, and selected ID equal to
 * a maximum-probability option. Ties may select any maximal option; lexical
 * category ID order is applied downstream when canonicalising.
 * Unexpected probability fields are rejected rather than ignored.
 */
export function validateChoiceAnswer(answer: ChoiceAnswer, question: ChoiceQuestion): Result<void> {
  if (answer.questionId !== question.id) {
    return err(
      'INVALID_DECISION',
      `answer is for question ${JSON.stringify(answer.questionId)}, expected ${JSON.stringify(question.id)}`,
    );
  }

  const optionIds = new Set(question.options.map((option) => option.id));
  const probabilityIds = Object.keys(answer.probabilities);

  for (const id of probabilityIds) {
    if (!optionIds.has(id)) {
      return err(
        'INVALID_DECISION',
        `probability key ${JSON.stringify(id)} is not an option of question ${JSON.stringify(question.id)}`,
      );
    }
  }
  for (const id of optionIds) {
    if (!(id in answer.probabilities)) {
      return err(
        'INVALID_DECISION',
        `distribution is missing option ${JSON.stringify(id)} of question ${JSON.stringify(question.id)}`,
      );
    }
  }

  let sum = 0;
  let maxProbability = -Infinity;
  for (const id of probabilityIds) {
    const probability = answer.probabilities[id];
    if (typeof probability !== 'number' || !Number.isFinite(probability)) {
      return err(
        'INVALID_DECISION',
        `probability for ${JSON.stringify(id)} must be a finite number; received ${String(probability)}`,
      );
    }
    if (probability < 0 || probability > 1) {
      return err(
        'INVALID_DECISION',
        `probability ${probability} for ${JSON.stringify(id)} is outside [0, 1]`,
      );
    }
    sum += probability;
    if (probability > maxProbability) maxProbability = probability;
  }

  if (Math.abs(sum - 1) > 0.001) {
    return err('INVALID_DECISION', `probabilities sum to ${sum}, which is not within 0.001 of 1`);
  }

  if (!optionIds.has(answer.selectedId)) {
    return err(
      'INVALID_DECISION',
      `selected ID ${JSON.stringify(answer.selectedId)} is not an option of question ${JSON.stringify(question.id)}`,
    );
  }
  const selectedProbability = answer.probabilities[answer.selectedId];
  if (selectedProbability !== undefined && selectedProbability < maxProbability) {
    return err(
      'INVALID_DECISION',
      `selected ID ${JSON.stringify(answer.selectedId)} has probability ${selectedProbability}, which is not a maximum (${maxProbability})`,
    );
  }

  if (
    answer.providerConfidence !== null &&
    (typeof answer.providerConfidence !== 'number' ||
      !Number.isFinite(answer.providerConfidence) ||
      answer.providerConfidence < 0 ||
      answer.providerConfidence > 1)
  ) {
    return err('INVALID_DECISION', 'providerConfidence must be null or a finite value in [0, 1]');
  }

  return ok(undefined);
}
