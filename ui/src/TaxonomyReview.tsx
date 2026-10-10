import { useEffect, useState } from 'react';
import type { TaxonomyNode } from './App.js';

interface TaxonomyResponse {
  revision: number;
  tree: TaxonomyNode[];
}

export function TaxonomyReview(): JSX.Element {
  const [taxonomy, setTaxonomy] = useState<TaxonomyResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/taxonomy', { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<TaxonomyResponse>;
      })
      .then(setTaxonomy)
      .catch((cause: Error) => setError(cause.message));
  }, []);

  const approve = async (): Promise<void> => {
    if (taxonomy === null) return;
    const response = await fetch('/api/taxonomy', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: taxonomy.revision,
        tree: taxonomy.tree,
        mappings: taxonomy.tree
          .filter((node) => node.destinationId !== null)
          .map((node) => ({ categoryId: node.id, destinationId: node.destinationId })),
      }),
    });
    const body = (await response.json().catch(() => null)) as { taxonomy?: { revision: number }; error?: { detail: string } } | null;
    if (response.ok && body?.taxonomy !== undefined) {
      setTaxonomy({
        revision: body.taxonomy.revision,
        tree: taxonomy.tree,
        mappingHash: body.taxonomy.mappingHash,
      });
      setStatus(`Approved taxonomy revision ${body.taxonomy.revision}`);
      setError(null);
    } else {
      setError(body?.error?.detail ?? `HTTP ${response.status}`);
    }
  };

  return (
    <section aria-labelledby="taxonomy-h">
      <h2 id="taxonomy-h">Taxonomy</h2>
      <p>The approved category tree and its mappings. Editing marks affected proposals stale.</p>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {taxonomy === null ? (
        <p>Loading taxonomy…</p>
      ) : (
        <>
          <table>
            <caption>Categories (revision {taxonomy.revision})</caption>
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Description</th>
                <th scope="col">Destination</th>
              </tr>
            </thead>
            <tbody>
              {(taxonomy.tree ?? []).map((node) => (
                <tr key={node.id}>
                  <td>{node.label}</td>
                  <td>{node.description}</td>
                  <td>{node.destinationId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={() => void approve()}>
            Approve taxonomy
          </button>
          {status !== null && <p role="status">{status}</p>}
        </>
      )}
    </section>
  );
}
