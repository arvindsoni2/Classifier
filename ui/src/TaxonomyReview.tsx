import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { TaxonomyNode } from './App.js';

interface DestinationRef {
  id: string;
  segments: string[];
}

interface TaxonomyResponse {
  revision: number;
  tree: TaxonomyNode[];
  mappingHash: string;
  status: { state: 'ok' } | { state: 'curation_required'; reason?: string };
  reviewed: boolean;
  destinations: DestinationRef[];
  unmapped: DestinationRef[];
  missing: { categoryId: string; destinationId: string }[];
  suggested: TaxonomyNode[];
  root: string;
}

const MAX_CHILDREN_PER_NODE = 7;

type NodeKind = 'existing' | 'group';

/**
 * Taxonomy curation (spec review F2/F3): the discovered catalogue is shown
 * as destinations to map FROM, never merged into the tree; the active tree
 * changes only through explicit saves that return the full authoritative
 * taxonomy. Categories may nest under groups, existing labels and
 * descriptions are editable, and unmapped/missing drift is surfaced.
 */
export function TaxonomyReview(): JSX.Element {
  const [taxonomy, setTaxonomy] = useState<TaxonomyResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<NodeKind>('existing');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [parentId, setParentId] = useState('root');
  /** When set, the form edits this existing node instead of adding. */
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    void loadTaxonomy();
  }, []);

  async function loadTaxonomy(): Promise<void> {
    const response = await fetch('/api/taxonomy', { credentials: 'same-origin' });
    if (!response.ok) {
      setError(`HTTP ${response.status}`);
      return;
    }
    setTaxonomy((await response.json()) as TaxonomyResponse);
  }

  /** A save answers with the full authoritative taxonomy (F3 contract). */
  const submit = async (tree: TaxonomyNode[], message: string): Promise<boolean> => {
    if (taxonomy === null) return false;
    const mappings = tree
      .filter((node) => node.destinationId !== null)
      .map((node) => ({ categoryId: node.id, destinationId: node.destinationId as string }));
    const response = await fetch('/api/taxonomy', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: taxonomy.revision, tree, mappings }),
    });
    const body = (await response.json().catch(() => null)) as TaxonomyResponse & {
      error?: { detail: string };
    } | null;
    if (response.ok && body !== null && typeof body.revision === 'number' && Array.isArray(body.tree)) {
      setTaxonomy(body);
      setStatus(message);
      setError(null);
      return true;
    }
    setError(body?.error?.detail ?? `HTTP ${response.status}`);
    return false;
  };

  const childrenUnder = (tree: TaxonomyNode[], id: string): number =>
    tree.filter((node) => node.parentId === id).length;

  const startFromSuggestion = async (): Promise<void> => {
    if (taxonomy === null || taxonomy.suggested.length === 0) return;
    await submit(
      taxonomy.suggested,
      `Reviewed the suggested taxonomy at revision ${taxonomy.revision + 1}; classify is now unlocked`,
    );
  };

  const saveForm = async (): Promise<void> => {
    if (taxonomy === null || label.trim() === '') return;
    const tree = [...taxonomy.tree];
    if (kind === 'existing' && destinationId === '') {
      setError('a category must map to a discovered destination; pick one');
      return;
    }
    if (editingId !== null) {
      const index = tree.findIndex((node) => node.id === editingId);
      if (index < 0) return;
      const current = tree[index];
      if (current === undefined) return;
      if (current.id === 'root') return;
      const parent = tree.find((node) => node.id === parentId);
      if (parent === undefined) return;
      if (parentId !== current.parentId && childrenUnder(tree, parentId) >= MAX_CHILDREN_PER_NODE) {
        setError(`moving ${editingId} into ${parentId} would exceed ${MAX_CHILDREN_PER_NODE} children`);
        return;
      }
      tree[index] = {
        ...current,
        parentId,
        label: label.trim(),
        description: description.trim() === '' ? `${label.trim()} documents` : description.trim(),
        destinationId: kind === 'existing' ? destinationId : null,
        kind,
      };
      const ok = await submit(tree, `Updated ${label.trim()} (revision ${taxonomy.revision + 1})`);
      if (ok) resetForm();
      return;
    }
    if (childrenUnder(tree, parentId) >= MAX_CHILDREN_PER_NODE) {
      setError(`${parentId} already holds ${MAX_CHILDREN_PER_NODE} children; remove one or nest deeper`);
      return;
    }
    const id = `${kind === 'group' ? 'group' : 'cat'}-${Date.now().toString(36)}`;
    tree.push({
      id,
      parentId,
      label: label.trim(),
      description: description.trim() === '' ? `${label.trim()} documents` : description.trim(),
      destinationId: kind === 'existing' ? destinationId : null,
      kind,
    });
    const ok = await submit(tree, `Added ${label.trim()} under ${parentId} (revision ${taxonomy.revision + 1})`);
    if (ok) resetForm();
  };

  const resetForm = (): void => {
    setEditingId(null);
    setLabel('');
    setDescription('');
    setKind('existing');
    setParentId('root');
  };

  const beginEdit = (node: TaxonomyNode): void => {
    setEditingId(node.id);
    setKind(node.kind === 'group' ? 'group' : 'existing');
    setLabel(node.label);
    setDescription(node.description);
    setParentId(node.parentId ?? 'root');
    if (node.destinationId !== null) setDestinationId(node.destinationId);
  };

  const removeCategory = async (id: string): Promise<void> => {
    if (taxonomy === null) return;
    // Removing a group takes its subtree with it; the service re-validates.
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of taxonomy.tree) {
        if (node.parentId !== null && doomed.has(node.parentId) && !doomed.has(node.id)) {
          doomed.add(node.id);
          grew = true;
        }
      }
    }
    await submit(
      taxonomy.tree.filter((node) => !doomed.has(node.id)),
      `Removed ${id}${doomed.size > 1 ? ` and ${doomed.size - 1} nested node(s)` : ''} (revision ${taxonomy.revision + 1})`,
    );
  };

  const approve = async (): Promise<void> => {
    if (taxonomy === null) return;
    // Approving an UN-reviewed tree reviews the suggestion (the active tree
    // would otherwise be the root-only seed with nothing to route into).
    const tree =
      taxonomy.reviewed === false && taxonomy.suggested.length > 1 ? taxonomy.suggested : taxonomy.tree;
    await submit(tree, `Approved taxonomy revision ${taxonomy.revision + 1}`);
  };

  const curated = taxonomy !== null && taxonomy.status.state === 'ok' && taxonomy.reviewed === true;
  const nothingToRoute =
    taxonomy !== null &&
    taxonomy.reviewed === false &&
    taxonomy.suggested.length <= 1 &&
    taxonomy.tree.filter((node) => node.destinationId !== null).length === 0;
  const groups = taxonomy?.tree.filter((node) => node.kind === 'group') ?? [];
  const segmentsOf = (id: string): string =>
    taxonomy?.destinations.find((destination) => destination.id === id)?.segments.join('/') ?? id;

  return (
    <section aria-labelledby="taxonomy-h">
      <h2 id="taxonomy-h">Taxonomy</h2>
      <p>
        The approved category tree and its mappings. Discovered folders are a
        catalogue to map from — they never join the tree on their own. Every
        category maps to a discovered destination or is a plain group.
      </p>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {taxonomy === null ? (
        <p>Loading taxonomy…</p>
      ) : (
        <>
          {taxonomy.status.state === 'curation_required' && (
            <p role="status" className="error">
              Curation required: {taxonomy.status.reason ?? 'the taxonomy needs review'}.
            </p>
          )}
          {taxonomy.reviewed ? (
            <p role="status">Taxonomy revision {taxonomy.revision} is reviewed and active.</p>
          ) : (
            <p role="status">This taxonomy has not been reviewed yet; classification waits for an approved tree.</p>
          )}
          {!taxonomy.reviewed && taxonomy.suggested.length > 0 && (
            <>
              <p>
                {taxonomy.suggested.length - 1} folder(s) discovered can map
                directly under the root.
              </p>
              <button type="button" onClick={() => void startFromSuggestion()}>
                Use suggested taxonomy
              </button>
            </>
          )}

          <table>
            <caption>Categories (revision {taxonomy.revision})</caption>
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Description</th>
                <th scope="col">Destination</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {taxonomy.tree
                .slice()
                .sort((left, right) => (left.parentId ?? '') < (right.parentId ?? '') ? -1 : 1)
                .map((node) => (
                  <tr key={node.id}>
                    <td>
                      {node.parentId !== null && node.parentId !== 'root' ? `↳ ${node.label}` : node.label}
                    </td>
                    <td>{node.description}</td>
                    <td>{node.destinationId === null ? '—' : segmentsOf(node.destinationId)}</td>
                    <td>
                      {node.id === 'root' ? null : (
                        <>
                          <button type="button" onClick={() => beginEdit(node)}>
                            Edit
                          </button>{' '}
                          <button type="button" onClick={() => void removeCategory(node.id)}>
                            Remove
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>

          {taxonomy.missing.length > 0 && (
            <p role="alert" className="error">
              {taxonomy.missing.length} mapped destination(s) are no longer discovered (
              {taxonomy.missing.map((entry) => entry.categoryId).join(', ')}); re-map or remove them before
              classifying.
            </p>
          )}

          <h3>{editingId === null ? 'Add a node' : `Edit ${editingId}`}</h3>
          <p className="hint">
            Discovered destinations: {taxonomy.destinations.length}; unmapped:{' '}
            {taxonomy.unmapped.length}. Curation is capped at {MAX_CHILDREN_PER_NODE} children per group.
          </p>
          <div className="taxonomy-form">
            <label htmlFor="node-kind">Kind</label>
            <select id="node-kind" value={kind} onChange={(event) => setKind(event.target.value as NodeKind)}>
              <option value="existing">Category (maps to a folder)</option>
              <option value="group">Group (nests categories)</option>
            </select>
            <label htmlFor="node-parent">Parent</label>
            <select id="node-parent" value={parentId} onChange={(event) => setParentId(event.target.value)}>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.label} ({group.id})
                </option>
              ))}
            </select>
            <label htmlFor="cat-label">Label</label>
            <input id="cat-label" value={label} onChange={(event) => setLabel(event.target.value)} />
            <label htmlFor="cat-description">Description</label>
            <input
              id="cat-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Keywords that decide this category"
            />
            {kind === 'existing' && (
              <>
                <label htmlFor="cat-destination">Destination folder</label>
                <select
                  id="cat-destination"
                  value={destinationId}
                  onChange={(event) => setDestinationId(event.target.value)}
                >
                  <option value="">Select a destination…</option>
                  {taxonomy.destinations.map((destination) => (
                    <option key={destination.id} value={destination.id}>
                      {destination.segments.join('/')}
                    </option>
                  ))}
                </select>
              </>
            )}
            <button type="button" onClick={() => void saveForm()}>
              {editingId === null ? 'Save node' : 'Update node'}
            </button>
            {editingId !== null && (
              <button type="button" onClick={resetForm}>
                Cancel edit
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => void approve()}
            disabled={curated === true || nothingToRoute === true}
          >
            {curated ? 'Approved' : 'Approve taxonomy'}
          </button>
          {status !== null && <p role="status" data-testid="taxonomy-status">{status}</p>}
        </>
      )}
    </section>
  );
}
