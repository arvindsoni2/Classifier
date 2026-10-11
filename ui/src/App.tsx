import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { TaxonomyReview } from './TaxonomyReview.js';
import { PlacementReview } from './PlacementReview.js';
import { RunHistory } from './RunHistory.js';

export interface Proposal {
  id: string;
  basename: string;
  destinationId: string;
  categoryId: string;
  version: number;
  state: 'pending' | 'approved' | 'stale' | 'rejected';
}

export interface TaxonomyNode {
  id: string;
  label: string;
  description: string;
  destinationId: string | null;
  kind: string;
  parentId: string | null;
}

export interface DestinationRef {
  id: string;
  segments: string[];
}

export interface ActionRow {
  actionId: string;
  proposalId: string;
  proposalVersion: number;
  state: string;
  mode: string;
  events: { event: string; recordedAt: string }[];
}

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: true; value: T } | { ok: false; code: string; detail: string }> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = (await response.json().catch(() => null)) as (T & { error?: { code: string; detail: string } }) | null;
  if (response.status === 401) {
    window.location.href = '/';
    return { ok: false, code: 'UNAUTHORISED', detail: 'session required' };
  }
  if (!response.ok || body === null) {
    return { ok: false, code: body?.error?.code ?? 'UNSUPPORTED', detail: body?.error?.detail ?? `HTTP ${response.status}` };
  }
  return { ok: true, value: body };
}

export function App(): JSX.Element {
  const [view, setView] = useState<'taxonomy' | 'placements' | 'history'>('placements');
  useEffect(() => {
    void refreshCatalogue();
  }, [view]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<DestinationRef[]>([]);
  const [rootPath, setRootPath] = useState('~');

  const scan = async (): Promise<void> => {
    setScanError(null);
    const result = await api<{ batch: { batchId: string } }>('/api/batches', {
      method: 'POST',
      body: JSON.stringify({ rootId: '' }),
    });
    if (result.ok) {
      setBatchId(result.value.batch.batchId);
      void refreshCatalogue();
    } else setScanError(result.detail);
  };

  // The destination catalogue and root come from the taxonomy surface so the
  // placement view can show real target paths; they only exist after a scan.
  const refreshCatalogue = async (): Promise<void> => {
    const response = await fetch('/api/taxonomy', { credentials: 'same-origin' });
    if (!response.ok) return;
    const body = (await response.json().catch(() => null)) as {
      destinations?: DestinationRef[];
      reviewed?: boolean;
      root?: string;
    } | null;
    if (body === null) return;
    if (Array.isArray(body.destinations)) setDestinations(body.destinations);
    if (typeof body.root === 'string' && body.root.length > 0) setRootPath(body.root);
  };

  useEffect(() => {
    void api<{ providers: unknown }>('/api/providers').then(() => undefined);
    void refreshCatalogue();
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <h1>Fedora organiser</h1>
        <nav aria-label="Sections">
          <button type="button" onClick={() => void scan()}>
            Scan
          </button>
          <a href="#taxonomy" onClick={() => setView('taxonomy')}>
            Taxonomy
          </a>
          <a href="#placements" onClick={() => setView('placements')}>
            Placements
          </a>
          <a href="#history" onClick={() => setView('history')}>
            History
          </a>
        </nav>
      </header>
      {scanError !== null && (
        <p role="alert" className="error">
          {scanError}
        </p>
      )}
      {batchId !== null && <p className="batch">Batch {batchId}</p>}
      <main>
        {batchId === null ? (
          <section aria-labelledby="scan-hint">
            <h2 id="scan-hint">Start with a read-only scan</h2>
            <p>Discovery never changes files. The batch reviews candidates inside the selected Downloads root.</p>
          </section>
        ) : view === 'taxonomy' ? (
          <TaxonomyReview />
        ) : view === 'placements' ? (
          <PlacementReview batchId={batchId} destinations={destinations} rootPath={rootPath} />
        ) : (
          <RunHistory batchId={batchId} />
        )}
      </main>
    </div>
  );
}
