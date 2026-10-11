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
  status: { state: 'ok' } | { state: 'curation_required'; reason: string };
  reviewed: boolean;
  destinations: DestinationRef[];
}

interface Mapping {
  categoryId: string;
  destinationId: string;
}

const MAX_CHILDREN_PER_NODE = 7;

/**
 * Taxonomy curation (spec review R9): the discovered folders are shown as a
 * catalogue to map from, the automatic tree's refusal is surfaced with its
 * reason, and the user adds/removes categories before approving. Inspection
 * never invents destinations: every category maps to a real destination or is
 * a plain group.
 */
export function TaxonomyReview(): JSX.Element {
  const [taxonomy, setTaxonomy] = useState<TaxonomyResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [destinationId, setDestinationId] = useState('');

  useEffect(() => {
    void fetch('/api/taxonomy', { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<TaxonomyResponse>;
      })
      .then((body) => {
        setTaxonomy(body);
        // Default the mapping selector to the first unmapped destination.
        const mapped = new Set(body.tree.filter((node) => node.destinationId !== null).map((node) => node.destinationId));
        const first = body.destinations.find((destination) => !mapped.has(destination.id));
        if (first !== undefined) setDestinationId(first.id);
      })
      .catch((cause: Error) => setError(cause.message));
  }, []);

  const submit = async (tree: TaxonomyNode[], message: string): Promise<void> => {
    if (taxonomy === null) return;
    const mappings: Mapping[] = tree
      .filter((node) => node.destinationId !== null)
      .map((node) => ({ categoryId: node.id, destinationId: node.destinationId as string }));
    const response = await fetch('/api/taxonomy', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: taxonomy.revision, tree, mappings }),
    });
    // The service answers with the reviewed taxonomy at the top level.
    const body = (await response.json().catch(() => null)) as
      | (TaxonomyResponse & { error?: { detail: string } })
      | null;
    if (response.ok && body !== null && typeof body.revision === 'number') {
      setTaxonomy({
        revision: body.revision,
        tree: body.tree,
        mappingHash: body.mappingHash,
        status: body.status,
        reviewed: body.reviewed,
        destinations: body.destinations,
      });
      setStatus(message);
      setError(null);
    } else {
      setError(body?.error?.detail ?? `HTTP ${response.status}`);
    }
  };

  const addCategory = async (): Promise<void> => {
    if (taxonomy === null || label.trim() === '') return;
    const children = taxonomy.tree.filter((node) => node.parentId === 'root');
    if (children.length >= MAX_CHILDREN_PER_NODE) {
      setError(`a group may hold at most ${MAX_CHILDREN_PER_NODE} categories; remove one first`);
      return;
    }
    if (destinationId === '') {
      setError('a category must map to a discovered destination; pick one');
      return;
    }
    const category: TaxonomyNode = {
      id: `cat-user-${Date.now().toString(36)}`,
      parentId: 'root',
      label: label.trim(),
      description: description.trim() === '' ? `${label.trim()} documents` : description.trim(),
      destinationId,
      kind: 'existing',
    };
    await submit([...taxonomy.tree, category], `Added ${category.label}; approve to bind revision ${taxonomy.revision + 1}`);
    setLabel('');
    setDescription('');
  };

  const removeCategory = async (id: string): Promise<void> => {
    if (taxonomy === null) return;
    await submit(
      taxonomy.tree.filter((node) => node.id !== id),
      'Removed the category; approve to bind the new revision',
    );
  };

  const approve = async (): Promise<void> => {
    if (taxonomy === null) return;
    await submit(taxonomy.tree, `Approved taxonomy revision ${taxonomy.revision + 1}`);
  };

  const curated = taxonomy?.status.state === 'ok' && taxonomy.reviewed === true;

  return (
    <section aria-labelledby="taxonomy-h">
      <h2 id="taxonomy-h">Taxonomy</h2>
      <p>
        The approved category tree and its mappings. Editing marks affected proposals stale. Every category maps to a
        destination discovered under the root — the tool never invents one.
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
              Curation required: {taxonomy.status.reason}. Map a handful of destinations below, then approve.
            </p>
          )}
          {taxonomy.reviewed ? (
            <p role="status">Taxonomy revision {taxonomy.revision} is reviewed and active.</p>
          ) : (
            <p role="status">This taxonomy has not been reviewed yet; classification waits for an approved tree.</p>
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
              {taxonomy.tree.map((node) => (
                <tr key={node.id}>
                  <td>{node.label}</td>
                  <td>{node.description}</td>
                  <td>
                    {node.destinationId === null
                      ? '—'
                      : (taxonomy.destinations.find((destination) => destination.id === node.destinationId)?.segments.join('/') ??
                        node.destinationId)}
                  </td>
                  <td>
                    {node.id === 'root' ? null : (
                      <button type="button" onClick={() => void removeCategory(node.id)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Add a category</h3>
          <p className="hint">
            Discovered destinations under the root: {taxonomy.destinations.length}. Curation is capped at{' '}
            {MAX_CHILDREN_PER_NODE} categories per group.
          </p>
          <div className="taxonomy-form">
            <label htmlFor="cat-label">Label</label>
            <input id="cat-label" value={label} onChange={(event) => setLabel(event.target.value)} />
            <label htmlFor="cat-description">Description</label>
            <input id="cat-description" value={description} onChange={(event) => setDescription(event.target.value)} />
            <label htmlFor="cat-destination">Destination folder</label>
            <select id="cat-destination" value={destinationId} onChange={(event) => setDestinationId(event.target.value)}>
              <option value="">Select a destination…</option>
              {taxonomy.destinations.map((destination) => (
                <option key={destination.id} value={destination.id}>
                  {destination.segments.join('/')}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void addCategory()}>
              Add category
            </button>
          </div>

          <button type="button" onClick={() => void approve()} disabled={curated === true}>
            {curated ? 'Approved' : 'Approve taxonomy'}
          </button>
          {status !== null && <p role="status">{status}</p>}
        </>
      )}
    </section>
  );
}
