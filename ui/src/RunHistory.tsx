import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { ActionRow } from './App.js';

export function RunHistory({ batchId }: { batchId: string }): JSX.Element {
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async (): Promise<void> => {
      const response = await fetch(`/api/batches/${batchId}/history`, { credentials: 'same-origin' });
      const body = (await response.json().catch(() => null)) as { actions?: ActionRow[]; error?: { detail: string } } | null;
      if (response.ok && body?.actions !== undefined) setActions(body.actions);
      else setError(body?.error?.detail ?? `HTTP ${response.status}`);
    };
    void load();
  }, [batchId]);

  return (
    <section aria-labelledby="history-h">
      <h2 id="history-h">Run history</h2>
      <p>Every action and its journalled events. Rows persist until their action is verified or reconciled.</p>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <table>
        <caption>Actions</caption>
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col">State</th>
            <th scope="col">Mode</th>
            <th scope="col">Events</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((action) => (
            <tr key={action.actionId}>
              <td>{action.actionId}</td>
              <td>{action.state}</td>
              <td>{action.mode}</td>
              <td>{action.events.map((event) => event.event).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
