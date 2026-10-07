import { randomUUID } from 'node:crypto';
import { err, type ActionReceipt, type ApprovedAction, type Id, type Item, type Result, type RootConfig, type Snapshot, type SourceAdapter, type SourceCapabilities } from '../../src/domain/contracts.js';

/**
 * FR-14: a mock second source. It lists normalised items and advertises
 * read-only capabilities. It never touches the filesystem adapter/helper;
 * `apply` and `inspect` are rejected as UNSUPPORTED. Catalogue and decision
 * services must consume these normalised items without filesystem access.
 */
export interface FixtureItemInput {
  externalId: string;
  displayName?: string;
}

export class CollectionFixtureSource implements SourceAdapter {
  private readonly items: Item[];

  constructor(inputs: readonly FixtureItemInput[]) {
    this.items = inputs.map((input) => ({
      id: `item-${randomUUID()}`,
      sourceId: 'source-fixture-collection',
      sourceKind: 'collection' as const,
      externalId: input.externalId,
      revision: '1',
      snapshot: null,
      evidenceId: `evidence-${randomUUID()}`,
    }));
  }

  capabilities(): SourceCapabilities {
    return { actions: [], recovery: 'none' };
  }

  async *discover(_config: RootConfig): AsyncIterable<Result<Item>> {
    for (const item of this.items) {
      yield { ok: true, value: item };
    }
  }

  async inspect(_itemId: Id): Promise<Result<Snapshot>> {
    return err('UNSUPPORTED', 'collection fixture source has no filesystem identity to inspect');
  }

  async apply(_action: ApprovedAction): Promise<Result<ActionReceipt>> {
    return err('UNSUPPORTED', 'collection fixture source is read-only; no actions are advertised');
  }
}
