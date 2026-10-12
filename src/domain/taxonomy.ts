/**
 * Category validation and versioned mappings (LLD §1, plan Task 4).
 *
 * The taxonomy is revision/tree/mappingHash. Category IDs are immutable
 * opaque identifiers: they pass through unchanged and the mapping hash binds
 * the current labels/descriptions/destinations to those IDs (FR-02: editing
 * content must be detectable). The reserved ID `unknown` is the deferral
 * option of every routing question and can never be a category.
 */
import { createHash } from 'node:crypto';
import {
  err,
  ok,
  stableStringify,
  UNKNOWN_OPTION_ID,
  type Category,
  type ChoiceQuestion,
  type DecisionRequest,
  type Destination,
  type Evidence,
  type ProviderManifest,
  type Result,
  type Revision,
} from './contracts.js';

export interface Taxonomy {
  revision: Revision;
  tree: Category[];
  mappingHash: string;
}

/** A routing node: the category whose children (plus unknown) form options. */
export interface TaxonomyNode {
  category: Category;
  children: Category[];
}

export const MAX_CHILDREN_PER_NODE = 7;
export const MAX_ROUTE_LEVELS = 4;
/** LLD §3: option descriptions are capped at twelve tokenizer tokens. */
export const OPTION_DESCRIPTION_TOKEN_LIMIT = 12;
/** Initial compact-text cap inside a matched request (LLD §3). */
export const COMPACT_TEXT_CHAR_CAP = 1200;

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Validates a category tree against the destination catalogue. Enforces:
 * unique non-empty IDs, the reserved `unknown` ID, existing parent references,
 * no cycles, route depth <= 4, <= 7 children per node, existing-kind
 * categories mapped to a known destination, and no destination on
 * groups/candidates. Returns the taxonomy with a content-bound mapping hash.
 */
export function validateTaxonomy(tree: Category[], destinations: Destination[]): Result<Taxonomy> {
  if (tree.length === 0) {
    return err('INVALID_DECISION', 'taxonomy tree is empty');
  }
  const destinationIds = new Set(destinations.map((destination) => destination.id));
  const byId = new Map<string, Category>();

  for (const category of tree) {
    if (typeof category.id !== 'string' || category.id.length === 0) {
      return err('INVALID_DECISION', 'category ID must be a non-empty string');
    }
    if (category.id === UNKNOWN_OPTION_ID) {
      return err('INVALID_DECISION', `category ID ${UNKNOWN_OPTION_ID} is reserved for deferral`);
    }
    if (byId.has(category.id)) {
      return err('INVALID_DECISION', `duplicate category ID ${category.id}`);
    }
    if (typeof category.label !== 'string' || category.label.length === 0) {
      return err('INVALID_DECISION', `category ${category.id} has an empty label`);
    }
    if (category.parentId !== null && estimateTokens(category.description) > OPTION_DESCRIPTION_TOKEN_LIMIT) {
      // Categories become provider options: a description beyond the 12-token
      // option budget makes EVERY classification fail at request-build time
      // (the pilot's 72/72 finding). Refuse it at review, naming the category.
      return err(
        'INVALID_DECISION',
        `category ${category.id} description exceeds the ${OPTION_DESCRIPTION_TOKEN_LIMIT}-token option-description limit ` +
          `(${estimateTokens(category.description)} tokens); shorten it`,
      );
    }
    if (!['group', 'existing', 'candidate'].includes(category.kind)) {
      return err('INVALID_DECISION', `category ${category.id} has invalid kind ${category.kind}`);
    }
    byId.set(category.id, category);
  }

  const childCounts = new Map<string, number>();
  for (const category of tree) {
    if (category.parentId !== null) {
      if (!byId.has(category.parentId)) {
        return err('INVALID_DECISION', `category ${category.id} references unknown parent ${category.parentId}`);
      }
      const count = (childCounts.get(category.parentId) ?? 0) + 1;
      if (count > MAX_CHILDREN_PER_NODE) {
        return err(
          'INVALID_DECISION',
          `category ${category.parentId} has more than ${MAX_CHILDREN_PER_NODE} children`,
        );
      }
      childCounts.set(category.parentId, count);
    }
  }

  for (const category of tree) {
    // Cycle detection and depth check along the parent chain.
    const seen = new Set<string>([category.id]);
    let depth = 1;
    let parentId = category.parentId;
    while (parentId !== null) {
      if (seen.has(parentId)) {
        return err('INVALID_DECISION', `parent cycle detected at category ${category.id}`);
      }
      seen.add(parentId);
      depth += 1;
      if (depth > MAX_ROUTE_LEVELS) {
        return err(
          'INVALID_DECISION',
          `route to category ${category.id} is deeper than ${MAX_ROUTE_LEVELS} levels`,
        );
      }
      parentId = byId.get(parentId)?.parentId ?? null;
    }

    if (category.kind === 'existing') {
      if (category.destinationId === null || !destinationIds.has(category.destinationId)) {
        return err(
          'INVALID_DECISION',
          `existing category ${category.id} is not mapped to a known destination`,
        );
      }
    } else if (category.destinationId !== null) {
      return err(
        'INVALID_DECISION',
        `${category.kind} category ${category.id} must not map to a destination (groups and candidates have none)`,
      );
    }
  }

  const hasRoot = tree.some((category) => category.parentId === null);
  if (!hasRoot) {
    return err('INVALID_DECISION', 'taxonomy has no root category');
  }

  const mappingHash = sha256(
    stableStringify({
      categories: tree
        .map((category) => ({
          id: category.id,
          parentId: category.parentId,
          kind: category.kind,
          label: category.label,
          description: category.description,
          destinationId: category.destinationId,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      destinations: destinations
        .map((destination) => destination.id)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    }),
  );

  return ok({ revision: 1, tree, mappingHash });
}

/**
 * Conservative token estimate used while a provider's exact tokenizer is
 * unavailable (Laya checkpoint blocked on this machine). It deliberately
 * over-estimates (utf-8 bytes / 3) so a fitted request stays inside real
 * limits; the exact-token requirement is re-verified provider-side or with
 * the pinned tokenizer once available.
 */
/** Byte budget implied by the option-description token limit (ceil(bytes/3)). */
export const OPTION_DESCRIPTION_BYTE_BUDGET = OPTION_DESCRIPTION_TOKEN_LIMIT * 3;

/**
 * Trims generated option descriptions to the provider contract's option
 * budget at a word boundary (never mid-word), so discovery-built suggestions
 * are always reviewable.
 */
export function fitOptionDescription(description: string): string {
  if (Buffer.byteLength(description, 'utf8') <= OPTION_DESCRIPTION_BYTE_BUDGET) {
    return description;
  }
  const words = description.split(' ');
  let out = '';
  for (const word of words) {
    const candidate = out === '' ? word : `${out} ${word}`;
    if (Buffer.byteLength(candidate, 'utf8') > OPTION_DESCRIPTION_BYTE_BUDGET) break;
    out = candidate;
  }
  // A single over-budget word: keep its budget-safe prefix.
  return out === '' ? description.slice(0, OPTION_DESCRIPTION_BYTE_BUDGET) : out;
}

export function estimateTokens(text: string): number {
  const bytes = Buffer.byteLength(text, 'utf8');
  return Math.max(1, Math.ceil(bytes / 3));
}

function evidenceTokens(state: Record<string, unknown>): number {
  let tokens = 0;
  for (const [key, value] of Object.entries(state)) {
    if (key === 'compactText') continue;
    tokens += estimateTokens(key) + estimateTokens(stableStringify(value));
  }
  return tokens;
}

function buildQuestion(node: TaxonomyNode): ChoiceQuestion {
  const options = [...node.children]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((child) => ({ id: child.id, description: child.description }));
  options.push({ id: UNKNOWN_OPTION_ID, description: 'Unknown or insufficient evidence' });
  return {
    id: `q-${node.category.id}`,
    instruction: `Select the destination folder for this file within ${node.category.label}.`,
    options,
  };
}

function headerTokens(question: ChoiceQuestion): number {
  return (
    estimateTokens(question.instruction) +
    question.options.reduce(
      (sum, option) => sum + estimateTokens(option.id) + estimateTokens(option.description),
      0,
    )
  );
}

/**
 * Builds the matched decision request for one routing node: the question is
 * the node's children plus the reserved unknown option, and the evidence is
 * the same semantic state for every provider in the comparison. Compact text
 * is capped at 1200 characters and shortened further until the encoded
 * request fits EVERY provider's budget in the comparison (LLD §3). If even
 * metadata cannot fit, the result is INPUT_TOO_LONG — never silent truncation.
 */
export function buildMatchedRequest(
  evidence: Evidence,
  node: TaxonomyNode,
  manifests: ProviderManifest[],
): Result<DecisionRequest> {
  const question = buildQuestion(node);

  // Header budgets first: a header that cannot fit is a hard failure.
  for (const manifest of manifests) {
    if (manifest.questionTokenLimit !== null && headerTokens(question) > manifest.questionTokenLimit) {
      return err(
        'INPUT_TOO_LONG',
        `question header exceeds ${manifest.provider}'s ${manifest.questionTokenLimit}-token header limit`,
      );
    }
  }
  // LLD §3: option descriptions are capped at twelve tokenizer tokens.
  for (const option of question.options) {
    if (estimateTokens(option.description) > OPTION_DESCRIPTION_TOKEN_LIMIT) {
      return err(
        'INPUT_TOO_LONG',
        `option ${JSON.stringify(option.id)} description exceeds the ${OPTION_DESCRIPTION_TOKEN_LIMIT}-token option-description limit`,
      );
    }
  }

  // Copy the state; compact text starts at the 1200-character cap.
  const state: Record<string, unknown> = { ...evidence.state };
  let compactText: string | undefined;
  if (typeof state.compactText === 'string') {
    compactText = state.compactText.slice(0, COMPACT_TEXT_CHAR_CAP);
  }

  const limited = manifests.filter(
    (manifest) => manifest.inputTokenLimit !== null,
  ) as (ProviderManifest & { inputTokenLimit: number })[];
  const tightest = limited.length > 0 ? Math.min(...limited.map((m) => m.inputTokenLimit)) : null;

  const metadataTokens = evidenceTokens(state);

  if (tightest !== null && metadataTokens > tightest) {
    return err(
      'INPUT_TOO_LONG',
      `evidence metadata (${metadataTokens} estimated tokens) does not fit the tightest ${tightest}-token input budget`,
    );
  }

  let clipped = false;
  if (compactText !== undefined && tightest !== null) {
    const textBudget = tightest - metadataTokens;
    let fitted = compactText;
    if (estimateTokens(fitted) > textBudget) {
      // Shorten by characters until the estimate fits every provider budget.
      let high = fitted.length;
      let low = 0;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (estimateTokens(fitted.slice(0, mid)) <= textBudget) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      fitted = fitted.slice(0, Math.max(0, low - 1));
    }
    if (fitted.length < String(state.compactText).length) clipped = true;
    compactText = fitted;
  } else if (compactText !== undefined && compactText.length < String(state.compactText).length) {
    clipped = true;
  }

  if (compactText !== undefined) {
    state.compactText = compactText;
    if (clipped) state.requestClipped = true;
  }

  const clippedStateHash = sha256(stableStringify(state));
  // The id is derived from the CLIPPED state so the original and the clipped
  // request evidence are distinct records (no primary-key collision when
  // tasks later persist them).
  const clippedId = `evidence-${sha256(`${evidence.itemId}|${clippedStateHash}`).slice(0, 40)}`;
  const clippedEvidence: Evidence = {
    ...evidence,
    id: clippedId,
    profile: compactText === undefined ? 'metadata' : 'compact_text',
    state,
    stateHash: clippedStateHash,
  };

  const schemaHash = sha256(
    stableStringify({
      instruction: question.instruction,
      options: question.options.map((option) => ({ id: option.id, description: option.description })),
    }),
  );

  return ok({
    evidence: clippedEvidence,
    questions: [question],
    schemaHash,
    taxonomyRevision: 1,
  });
}
