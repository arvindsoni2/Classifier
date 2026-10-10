import { useEffect, useRef, useState } from 'react';
import type { Proposal } from './App.js';

interface ClassifyResponse {
  proposals: number;
  deferred: number;
  failed: number;
}

interface ApprovalResponse {
  id: string;
  actionSetHash: string;
  expiresAt: string;
}

interface ApplyResult {
  batchId: string;
  results: { actionId: string; proposalId: string; outcome: string; detail: string }[];
}

export function PlacementReview({ batchId }: { batchId: string }): JSX.Element {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [deferred, setDeferred] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Proposal | null>(null);
  const [summary, setSummary] = useState<{ approvalId: string; actionSetHash: string; basenames: string[] } | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const response = await fetch(`/api/batches/${batchId}/proposals`, { credentials: 'same-origin' });
    const body = (await response.json().catch(() => null)) as { proposals?: Proposal[]; error?: { detail: string } } | null;
    if (response.ok && body?.proposals !== undefined) setProposals(body.proposals);
    else setError(body?.error?.detail ?? `HTTP ${response.status}`);
  };

  useEffect(() => {
    void load();
  }, [batchId]);

  const classify = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/batches/${batchId}/classify`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'rules', profile: 'compact_text' }),
    });
    const body = (await response.json().catch(() => null)) as (ClassifyResponse & { deferredItems?: string[] }) | null;
    setBusy(false);
    if (response.ok && body !== null) {
      setDeferred(body.deferredItems ?? []);
      await load();
    } else {
      setError(`classification failed`);
    }
  };

  const toggle = (id: string, checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const patch = async (proposal: Proposal, patch: { categoryId?: string; destinationId?: string; reject?: boolean }): Promise<void> => {
    const response = await fetch(`/api/proposals/${proposal.id}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: proposal.version, ...patch }),
    });
    if (response.ok) {
      await load();
      setEditing(null);
    } else {
      const body = (await response.json().catch(() => null)) as { error?: { detail: string } } | null;
      setError(body?.error?.detail ?? `HTTP ${response.status}`);
    }
  };

  const approve = async (): Promise<void> => {
    const chosen = proposals.filter((proposal) => selected.has(proposal.id) && proposal.state === 'pending');
    if (chosen.length === 0) return;
    const response = await fetch('/api/approvals', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        batchId,
        actions: chosen.map((proposal) => ({ proposalId: proposal.id, version: proposal.version })),
        mode: 'apply',
      }),
    });
    const body = (await response.json().catch(() => null)) as { approval?: ApprovalResponse; error?: { detail: string } } | null;
    if (response.ok && body?.approval !== undefined) {
      setSummary({
        approvalId: body.approval.id,
        actionSetHash: body.approval.actionSetHash,
        basenames: chosen.map((proposal) => proposal.basename),
      });
      setError(null);
    } else {
      setError(body?.error?.detail ?? `HTTP ${response.status}`);
    }
  };

  const apply = async (): Promise<void> => {
    if (summary === null) return;
    setBusy(true);
    const response = await fetch(`/api/batches/${batchId}/apply`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalId: summary.approvalId, actionSetHash: summary.actionSetHash }),
    });
    const body = (await response.json().catch(() => null)) as ApplyResult | null;
    setBusy(false);
    if (response.ok && body !== null) {
      setApplyResult(body);
      setSummary(null);
      setSelected(new Set());
      await load();
    } else {
      const failure = (await response.json().catch(() => null)) as { error?: { detail: string } } | null;
      setError(failure?.error?.detail ?? `HTTP ${response.status}`);
    }
  };

  // Keyboard behaviour: focus moves into a dialog when it opens and Escape
  // cancels it (plan Task 9 keyboard/dialog-focus checks).
  const summaryRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (summary !== null) summaryRef.current?.querySelector<HTMLElement>('button, input, select')?.focus();
  }, [summary]);
  useEffect(() => {
    if (editing !== null) editRef.current?.querySelector<HTMLElement>('button, input, select')?.focus();
  }, [editing]);
  const onDialogKeyDown = (close: () => void) => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') close();
  };

  return (
    <section aria-labelledby="placements-h">
      <h2 id="placements-h">Placements</h2>
      <button type="button" onClick={() => void classify()} disabled={busy}>
        Regenerate placements
      </button>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <table>
        <caption>Placement proposals</caption>
        <thead>
          <tr>
            <th scope="col">Select</th>
            <th scope="col">File</th>
            <th scope="col">Version</th>
            <th scope="col">Destination</th>
            <th scope="col">State</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {deferred.map((basename) => (
            <tr key={`deferred-${basename}`}>
              <td>
                <input type="checkbox" checked={false} disabled aria-label={`${basename} deferred`} />
              </td>
              <td>{basename}</td>
              <td data-testid={`version-${basename}`}>—</td>
              <td>unknown</td>
              <td>deferred</td>
              <td>
                <span className="sr-only">Deferred</span>
              </td>
            </tr>
          ))}
          {proposals.map((proposal) => {
            const selectable = proposal.state === 'pending';
            return (
              <tr key={proposal.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(proposal.id)}
                    disabled={!selectable}
                    onChange={(event) => toggle(proposal.id, event.target.checked)}
                  />
                </td>
                <td>{proposal.basename}</td>
                <td data-testid={`version-${proposal.basename}`}>{proposal.version}</td>
                <td>{proposal.destinationId}</td>
                <td>{proposal.state}</td>
                <td>
                  <button type="button" onClick={() => setEditing(proposal)} disabled={!selectable}>
                    Edit
                  </button>
                  <button type="button" onClick={() => void patch(proposal, { reject: true })} disabled={!selectable}>
                    Reject
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p role="status">
        {selected.size} selected
        {applyResult !== null && ` · ${applyResult.results.filter((row) => row.outcome === 'applied').length} applied and verified`}
      </p>
      <button type="button" onClick={() => void approve()} disabled={selected.size === 0}>
        Review exact summary
      </button>
      {summary !== null && (
        <div
          ref={summaryRef}
          role="dialog"
          aria-modal="true"
          aria-label="Approval summary"
          tabIndex={-1}
          onKeyDown={onDialogKeyDown(() => setSummary(null))}
        >
          <h3>Exact approval summary</h3>
          <ul>
            {summary.basenames.map((basename) => (
              <li key={basename}>{basename}</li>
            ))}
          </ul>
          <p>
            Approval {summary.approvalId} · hash {summary.actionSetHash.slice(0, 12)}…
          </p>
          <button type="button" onClick={() => setSummary(null)}>
            Cancel
          </button>
          <button type="button" onClick={() => void apply()} disabled={busy}>
            Confirm and approve
          </button>
        </div>
      )}
      {editing !== null && (
        <div
          ref={editRef}
          role="dialog"
          aria-modal="true"
          aria-label="Edit placement"
          tabIndex={-1}
          onKeyDown={onDialogKeyDown(() => setEditing(null))}
        >
          <h3>Edit {editing.basename}</h3>
          <label htmlFor="destination">
            Destination
            <select
              id="destination"
              value={editing.destinationId}
              onChange={(event) => setEditing({ ...editing, destinationId: event.target.value })}
            >
              {[...new Set(proposals.map((row) => row.destinationId))].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void patch(editing, { categoryId: editing.destinationId, destinationId: editing.destinationId })}
          >
            Save
          </button>
        </div>
      )}
      {applyResult !== null && (
        <table>
          <caption>Verified outcomes</caption>
          <tbody>
            {applyResult.results.map((row) => (
              <tr key={row.actionId}>
                <td>{row.proposalId}</td>
                <td>{row.outcome}</td>
                <td>{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
