import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { ActionRow } from './App.js';

/**
 * Run history (plan Task 9; spec review R13): the journalled actions with
 * their events and the conditional undo control — undo requires its own
 * approval, created here for exactly one action, and an applied action can be
 * returned to its original location through it.
 */
export function RunHistory({ batchId }: { batchId: string }): JSX.Element {
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    const response = await fetch(`/api/batches/${batchId}/history`, { credentials: 'same-origin' });
    const body = (await response.json().catch(() => null)) as { actions?: ActionRow[]; error?: { detail: string } } | null;
    if (response.ok && body?.actions !== undefined) setActions(body.actions);
    else setError(body?.error?.detail ?? `HTTP ${response.status}`);
  };

  useEffect(() => {
    void load();
  }, [batchId]);

  const undo = async (action: ActionRow): Promise<void> => {
    setBusy(action.actionId);
    setError(null);
    // A separate undo approval binds exactly this action at its version: the
    // apply approval can never authorise the reverse move.
    const approval = await fetch('/api/approvals', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        batchId,
        actions: [{ proposalId: action.proposalId, version: action.proposalVersion }],
        mode: 'undo',
      }),
    });
    const approvalBody = (await approval.json().catch(() => null)) as
      | { approval?: { id: string }; error?: { detail: string } }
      | null;
    if (!approval.ok || approvalBody?.approval === undefined) {
      setBusy(null);
      setError(approvalBody?.error?.detail ?? `HTTP ${approval.status}`);
      return;
    }
    const response = await fetch(`/api/actions/${action.actionId}/undo`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalId: approvalBody.approval.id }),
    });
    setBusy(null);
    if (response.ok) {
      setNotice(`${action.actionId} was returned to its original location`);
      await load();
    } else {
      const body = (await response.json().catch(() => null)) as { error?: { detail: string } } | null;
      setError(body?.error?.detail ?? `HTTP ${response.status}`);
    }
  };

  return (
    <section aria-labelledby="history-h">
      <h2 id="history-h">Run history</h2>
      <p>
        Every action and its journalled events. An applied action can be undone, but only through a separately approved
        undo — never through the approval that performed the move.
      </p>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice !== null && <p role="status">{notice}</p>}
      <table>
        <caption>Actions</caption>
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col">State</th>
            <th scope="col">Mode</th>
            <th scope="col">Events</th>
            <th scope="col">
              <span className="sr-only">Undo</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {actions.map((action) => {
            const undoable = action.mode === 'apply' && action.state === 'applied';
            return (
              <tr key={action.actionId}>
                <td className="mono">{action.actionId}</td>
                <td>{action.state}</td>
                <td>{action.mode}</td>
                <td>{action.events.map((event) => event.event).join(', ')}</td>
                <td>
                  <button
                    type="button"
                    disabled={!undoable || busy !== null}
                    onClick={() => void undo(action)}
                    aria-label={`undo ${action.actionId}`}
                  >
                    {busy === action.actionId ? 'Undoing…' : 'Undo'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
