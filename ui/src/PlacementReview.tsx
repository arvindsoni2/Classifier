import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { Proposal } from './App.js';

export interface DecisionDigest {
  id: string;
  provider: string;
  modelRevision: string;
  selectedId: string;
  probability: number | null;
  elapsedMs: number;
  tokenCounts: { input?: number; output?: number };
}

export interface DestinationRef {
  id: string;
  segments: string[];
}

export interface ProviderHealth {
  provider: string;
  status: 'ok' | 'blocked';
  detail: string;
}

interface ClassifyResponse {
  proposals: number;
  deferred: number;
  failed: number;
  deferredItems: string[];
  conflicts?: { basename: string; reason: string }[];
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

interface ProposalsResponse {
  proposals: Proposal[];
  decisions: Record<string, DecisionDigest>;
}

/**
 * Placement review (plan Task 9; spec review R13): selection, editing and the
 * exact summary show the real source and target paths, the root, conflicts and
 * the expiry — and the approval is created only when the user confirms, so
 * cancelling the dialog leaves nothing behind.
 */
export function PlacementReview({
  batchId,
  destinations,
  rootPath,
}: {
  batchId: string;
  destinations: DestinationRef[];
  rootPath: string;
}): JSX.Element {
  const [listed, setListed] = useState<ProposalsResponse>({ proposals: [], decisions: {} });
  const [deferred, setDeferred] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<{ basename: string; reason: string }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Proposal | null>(null);
  const [categories, setCategories] = useState<{ id: string; label: string; destinationId: string }[]>([]);
  const [summary, setSummary] = useState<{
    rows: { proposal: Proposal; targetPath: string }[];
    expiresAt: string;
  } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState('rules');
  const [providers, setProviders] = useState<ProviderHealth[]>([]);

  const load = async (): Promise<void> => {
    const response = await fetch(`/api/batches/${batchId}/proposals`, { credentials: 'same-origin' });
    const body = (await response.json().catch(() => null)) as
      | (ProposalsResponse & { error?: { detail: string } })
      | null;
    if (response.ok && body !== null && Array.isArray(body.proposals)) {
      setListed({ proposals: body.proposals, decisions: body.decisions ?? {} });
    } else {
      setError(body?.error?.detail ?? `HTTP ${response.status}`);
    }
  };

  useEffect(() => {
    void load();
    void fetch('/api/providers', { credentials: 'same-origin' })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as { providers?: ProviderHealth[] } | null;
        if (response.ok && body?.providers !== undefined) setProviders(body.providers);
      })
      .catch(() => undefined);
    // The reviewed taxonomy's mapped categories drive edits: a category
    // implies its destination, so no edit can bind an unmapped pair (R13).
    void fetch('/api/taxonomy', { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json().catch(() => null)) as {
          tree?: { id: string; label: string; destinationId: string | null }[];
        } | null;
        const categories = (body?.tree ?? [])
          .filter(
            (node): node is { id: string; label: string; destinationId: string } =>
              typeof node.destinationId === 'string' && node.destinationId.length > 0,
          );
        setCategories(categories);
      })
      .catch(() => undefined);
  }, [batchId]);

  const proposals = listed.proposals;
  const pathOf = (destinationId: string): string =>
    destinations.find((destination) => destination.id === destinationId)?.segments.join('/') ?? destinationId;

  const classify = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/batches/${batchId}/classify`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, profile: 'compact_text' }),
    });
    const body = (await response.json().catch(() => null)) as
      | (ClassifyResponse & { error?: { detail: string } })
      | null;
    setBusy(false);
    if (response.ok && body !== null) {
      setDeferred(body.deferredItems ?? []);
      setConflicts(body.conflicts ?? []);
      await load();
    } else {
      setError(body?.error?.detail ?? 'classification failed');
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

  const patch = async (
    proposal: Proposal,
    body: { categoryId?: string; destinationId?: string; reject?: boolean },
  ): Promise<void> => {
    const response = await fetch(`/api/proposals/${proposal.id}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: proposal.version, ...body }),
    });
    if (response.ok) {
      await load();
      setEditing(null);
    } else {
      const failure = (await response.json().catch(() => null)) as { error?: { detail: string } } | null;
      setError(failure?.error?.detail ?? `HTTP ${response.status}`);
    }
  };

  /**
   * The exact summary is built from the selected rows first. No approval
   * exists until the user confirms (spec review R13): cancelling leaves
   * nothing behind.
   */
  const openSummary = (): void => {
    const chosen = proposals.filter((proposal) => selected.has(proposal.id) && proposal.state === 'pending');
    if (chosen.length === 0) return;
    setSummary({
      rows: chosen.map((proposal) => ({
        proposal,
        targetPath: `${rootPath}/${pathOf(proposal.destinationId)}/${proposal.basename}`,
      })),
      expiresAt: '',
    });
    setError(null);
  };

  const confirm = async (): Promise<void> => {
    if (summary === null) return;
    setApplying(true);
    setError(null);
    const response = await fetch('/api/approvals', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        batchId,
        actions: summary.rows.map((row) => ({ proposalId: row.proposal.id, version: row.proposal.version })),
        mode: 'apply',
      }),
    });
    const body = (await response.json().catch(() => null)) as
      | { approval?: ApprovalResponse; error?: { detail: string } }
      | null;
    if (response.ok && body?.approval !== undefined) {
      const applyResponse = await fetch(`/api/batches/${batchId}/apply`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approvalId: body.approval.id, actionSetHash: body.approval.actionSetHash }),
      });
      const applied = (await applyResponse.json().catch(() => null)) as
        | (ApplyResult & { error?: { detail: string } })
        | null;
      setApplying(false);
      if (applyResponse.ok && applied !== null) {
        setApplyResult(applied);
        setSummary(null);
        setSelected(new Set());
        await load();
      } else {
        setError(applied?.error?.detail ?? `HTTP ${applyResponse.status}`);
      }
    } else {
      setApplying(false);
      setError(body?.error?.detail ?? `HTTP ${response.status}`);
    }
  };

  // Dialog focus: move focus in, trap Tab inside, restore on close (R13).
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const dialogOpen = summary !== null || editing !== null;
  useEffect(() => {
    if (dialogOpen && restoreFocusRef.current === null) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      dialogRef.current?.querySelector<HTMLElement>('button, input, select')?.focus();
    }
    if (!dialogOpen && restoreFocusRef.current !== null) {
      restoreFocusRef.current.focus();
      restoreFocusRef.current = null;
    }
  }, [dialogOpen]);
  const onDialogKeyDown = (close: () => void) => (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (event.key !== 'Tab' || dialogRef.current === null) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button, input, select, [href]')].filter(
      (element) => !element.hasAttribute('disabled'),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const closeDialog = (): void => {
    // Cancelling never leaves an approval behind: none was created yet.
    setSummary(null);
    setEditing(null);
  };

  const appliedCount = applyResult?.results.filter((row) => row.outcome === 'applied').length ?? 0;

  /** The reviewed category bound to a proposal's destination, for the dialog. */
  const editingCategoryId = (
    proposal: Proposal,
    available: { id: string; destinationId: string }[],
  ): string =>
    available.find((category) => category.destinationId === proposal.destinationId)?.id ??
    available[0]?.id ??
    proposal.categoryId;

  return (
    <section aria-labelledby="placements-h">
      <h2 id="placements-h">Placements</h2>
      <div className="toolbar">
        <label htmlFor="provider">Provider</label>
        <select
          id="provider"
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          {providers.length === 0 ? <option value="rules">rules</option> : null}
          {providers.map((entry) => (
            <option key={entry.provider} value={entry.provider} disabled={entry.status !== 'ok'}>
              {entry.provider}
              {entry.status === 'ok' ? '' : ' (unavailable)'}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void classify()} disabled={busy}>
          Regenerate placements
        </button>
      </div>
      <p className="hint">
        Root {rootPath}. No provider ran against live files yet unless you ask for it; nothing here can move a file.
      </p>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {conflicts.length > 0 && (
        <table>
          <caption>Conflicts — these items were not classified</caption>
          <tbody>
            {conflicts.map((conflict) => (
              <tr key={conflict.basename}>
                <td>{conflict.basename}</td>
                <td>{conflict.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table>
        <caption>Placement proposals</caption>
        <thead>
          <tr>
            <th scope="col">Select</th>
            <th scope="col">File</th>
            <th scope="col">Version</th>
            <th scope="col">Target</th>
            <th scope="col">Evidence</th>
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
              <td>unknown — deferred</td>
              <td>—</td>
              <td>deferred</td>
              <td>
                <span className="sr-only">Deferred</span>
              </td>
            </tr>
          ))}
          {proposals.map((proposal) => {
            const selectable = proposal.state === 'pending';
            const digest = listed.decisions[proposal.id];
            return (
              <tr key={proposal.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(proposal.id)}
                    disabled={!selectable}
                    onChange={(event) => toggle(proposal.id, event.target.checked)}
                    aria-label={`select ${proposal.basename}`}
                  />
                </td>
                <td>{proposal.basename}</td>
                <td data-testid={`version-${proposal.basename}`}>{proposal.version}</td>
                <td>
                  <span className="mono">{pathOf(proposal.destinationId)}</span>
                </td>
                <td>
                  {digest === undefined
                    ? '—'
                    : `${digest.provider} ${digest.modelRevision}${
                        digest.probability === null ? '' : ` p=${digest.probability.toFixed(3)}`
                      }`}
                </td>
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
        {appliedCount > 0 && ` · ${appliedCount} applied and verified`}
      </p>
      <button type="button" onClick={openSummary} disabled={selected.size === 0}>
        Review exact summary
      </button>
      {summary !== null && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Approval summary"
          tabIndex={-1}
          onKeyDown={onDialogKeyDown(closeDialog)}
        >
          <h3>Exact approval summary</h3>
          <p>
            {summary.rows.length} action{summary.rows.length === 1 ? '' : 's'} under root {rootPath}
          </p>
          <table>
            <caption>Moves to approve</caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Target</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((row) => (
                <tr key={row.proposal.id}>
                  <td className="mono">
                    {rootPath}/{row.proposal.basename}
                  </td>
                  <td className="mono">{row.targetPath}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Basenames and bytes are preserved; an occupied target aborts that action without a partial run.</p>
          <button type="button" onClick={closeDialog}>
            Cancel
          </button>
          <button type="button" onClick={() => void confirm()} disabled={applying}>
            {applying ? 'Approving and applying…' : 'Confirm and approve'}
          </button>
        </div>
      )}
      {editing !== null && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Edit placement"
          tabIndex={-1}
          onKeyDown={onDialogKeyDown(closeDialog)}
        >
          <h3>Edit {editing.basename}</h3>
          <label htmlFor="category">
            Category
            <select
              id="category"
              value={editingCategoryId(editing, categories)}
              onChange={(event) => {
                const category = categories.find((entry) => entry.id === event.target.value);
                if (category !== undefined) {
                  setEditing({ ...editing, categoryId: category.id, destinationId: category.destinationId });
                }
              }}
            >
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.label} → {pathOf(category.destinationId)}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">
            The destination follows the category mapping in the reviewed taxonomy; the service refuses an unmapped pair.
          </p>
          <button type="button" onClick={closeDialog}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              const categoryId = editing.categoryId ?? editingCategoryId(editing, categories);
              const destinationId =
                editing.destinationId ??
                categories.find((entry) => entry.id === categoryId)?.destinationId ??
                editing.destinationId;
              void patch(editing, { categoryId, destinationId });
            }}
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
                <td className="mono">{row.proposalId}</td>
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
