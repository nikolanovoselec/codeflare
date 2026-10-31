/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import type { ChatControlApi } from './api';

interface Conversation { id: string; name?: string; created: string; modified: string; messageCount: number }
export function ConversationControls({ api, disabled, onNew, onResume }: {
  api: ChatControlApi; disabled: boolean; onNew: () => void; onResume: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Conversation[]>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setRows(undefined); setError('');
    void api.envelope<Conversation[]>('/api/conversations', undefined, controller.signal).then(rows => {
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || !row.id)) throw new Error('Invalid conversation metadata.');
      if (!controller.signal.aborted) setRows(rows);
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load conversation history. Try again.'); });
    return () => controller.abort();
  }, [api, open, attempt]);
  return <div className="cf-chat-conversations">
    <button type="button" disabled={disabled} onClick={onNew}>New conversation</button>
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>Conversation history</button>
    {open && <section className="cf-chat-panel cf-chat-history" aria-label="Conversation history">
      <div className="cf-chat-panel-heading"><h2>Conversation history</h2><button type="button" onClick={() => setOpen(false)}>Close history</button></div>
      {error ? <><p role="alert">{error}</p><button type="button" onClick={() => setAttempt(attempt + 1)}>Reload history</button></> : !rows ? <p role="status">Loading conversations…</p> : rows.length === 0 ? <p>No saved conversations yet. Start a new conversation to begin.</p> :
        <ul>{rows.map(row => <li key={row.id}><button type="button" disabled={disabled} onClick={() => onResume(row.id)}>{row.name || 'Untitled conversation'}</button><span>{row.messageCount} messages</span></li>)}</ul>}
    </section>}
  </div>;
}
