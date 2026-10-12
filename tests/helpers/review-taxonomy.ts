import type { Category, Id, Revision } from '../../src/domain/contracts.js';
import type { Organiser } from '../../src/application/organiser.js';

/**
 * Reviews the suggested taxonomy from discovery (spec review F2): discovery
 * no longer mutates the active tree, so the reviewed starting point is the
 * explicit suggestion, exactly as `taxonomy --review` and the UI approve it.
 */
export async function reviewScannedTaxonomy(organiser: Organiser): Promise<Revision> {
  const suggested = organiser.suggestTaxonomy();
  if (!suggested.ok) {
    throw new Error(`${suggested.code}: ${suggested.detail}`);
  }
  return reviewTree(organiser, suggested.value);
}

/** Reviews an explicit tree through the same service the UI uses. */
export async function reviewTree(organiser: Organiser, tree: Category[]): Promise<Revision> {
  const taxonomy = organiser.getTaxonomy();
  if (!taxonomy.ok) throw new Error(taxonomy.detail);
  const mappings: { categoryId: Id; destinationId: Id }[] = [];
  for (const node of tree) {
    const destinationId: string | null = node.destinationId;
    if (destinationId !== null) mappings.push({ categoryId: node.id, destinationId });
  }
  const replaced = await organiser.replaceTaxonomy({
    expectedRevision: taxonomy.value.revision,
    tree,
    mappings,
  });
  if (!replaced.ok) throw new Error(`${replaced.code}: ${replaced.detail}`);
  return replaced.value.revision;
}
