import type { Category, Id, Revision } from '../../src/domain/contracts.js';
import type { Organiser } from '../../src/application/organiser.js';

/**
 * Marks the organiser's current taxonomy as reviewed, exactly as the review
 * UI does (spec review R9): the same tree is submitted back through the
 * application service. Classification requires this step.
 */
export async function reviewScannedTaxonomy(organiser: Organiser): Promise<Revision> {
  const taxonomy = organiser.getTaxonomy();
  if (!taxonomy.ok) throw new Error(taxonomy.detail);
  const mappings: { categoryId: Id; destinationId: Id }[] = [];
  for (const node of taxonomy.value.tree) {
    const destinationId: string | null = node.destinationId;
    if (destinationId !== null) mappings.push({ categoryId: node.id, destinationId });
  }
  const tree: Category[] = taxonomy.value.tree;
  const replaced = await organiser.replaceTaxonomy({
    expectedRevision: taxonomy.value.revision,
    tree,
    mappings,
  });
  if (!replaced.ok) throw new Error(`${replaced.code}: ${replaced.detail}`);
  return replaced.value.revision;
}
