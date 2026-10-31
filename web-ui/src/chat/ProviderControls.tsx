/** @jsxImportSource react */
import React, { useEffect, useRef, useState } from 'react';
import { OAuthFlowView } from './upstream/client/src/components/settings/OAuthFlowView';
import type { ChatControlApi } from './api';

type NativeFlow = NonNullable<React.ComponentProps<typeof OAuthFlowView>['flow']['status']>;
type Flow = NativeFlow & { stepId?: string; inputSecret?: boolean };
interface Catalog { personalAuthAllowed: boolean; providers: { id: string; name: string; authTypes: ('api_key' | 'oauth')[] }[] }
interface ProviderStatus { providers: { providerId: string; configured: boolean; source?: string }[]; credentials: { providerId: string; type: string }[] }

/** The primary SDK owns credentials and steps; this surface owns only their view. */
export function ProviderControls({ api, onClose }: { api: ChatControlApi; onClose: () => void }) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [status, setStatus] = useState<ProviderStatus>();
  const [flow, setFlow] = useState<Flow>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const activeFlow = useRef<Flow | undefined>(undefined);
  const answeredStep = useRef<string | undefined>(undefined);
  const controller = useRef(new AbortController());
  const live = (r: number) => !controller.current.signal.aborted && revision.current === r;
  const refresh = async (r: number) => {
    const [catalog, status] = await Promise.all([
      api.envelope<Catalog>('/api/provider-auth/providers', undefined, controller.current.signal),
      api.envelope<ProviderStatus>('/api/provider-auth/status', undefined, controller.current.signal),
    ]);
    if (!catalog || !Array.isArray(catalog.providers) || typeof catalog.personalAuthAllowed !== 'boolean'
      || catalog.providers.some(provider => !provider || typeof provider.id !== 'string' || typeof provider.name !== 'string' || !Array.isArray(provider.authTypes))
      || !status || !Array.isArray(status.providers) || !Array.isArray(status.credentials)) throw new Error('Invalid provider metadata.');
    if (live(r)) { setCatalog(catalog); setStatus(status); }
  };
  const showFlow = (next: Flow) => {
    if (!next || typeof next.flowId !== 'string' || !next.flowId || !['pending', 'complete', 'error', 'expired'].includes(next.status)
      || (next.pending && next.pending.kind !== 'device_code' && (!next.stepId || typeof next.stepId !== 'string'))) throw new Error('Invalid provider flow.');
    activeFlow.current = next;
    setFlow(next);
  };
  useEffect(() => {
    const r = revision.current;
    void refresh(r).catch(() => { if (live(r)) setError('Provider authority unavailable. Close and try again.'); });
    return () => {
      controller.current.abort(); revision.current++;
      const current = activeFlow.current;
      if (current?.status === 'pending') void api.envelope(`/api/provider-auth/flow/${encodeURIComponent(current.flowId)}`, { method: 'DELETE' }).catch(() => {});
    };
  }, [api]);
  useEffect(() => {
    if (!flow || flow.status !== 'pending') return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const r = revision.current;
    const poll = async () => {
      try {
        const next = await api.envelope<Flow>(`/api/provider-auth/flow/${encodeURIComponent(flow.flowId)}`, undefined, controller.current.signal);
        if (disposed || !live(r)) return;
        showFlow(next);
        if (next.status !== 'pending') await refresh(r);
      } catch { if (!disposed && live(r)) setError('Could not refresh authorization. Cancel or try again.'); }
      if (!disposed && live(r)) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 1500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [api, flow?.flowId, flow?.status]);
  const start = async (providerId: string, type: 'api_key' | 'oauth') => {
    if (busy || activeFlow.current?.status === 'pending') return;
    const r = ++revision.current;
    setBusy(true); setError(''); answeredStep.current = undefined;
    try {
      const next = await api.envelope<Flow>('/api/provider-auth/start', { method: 'POST', body: JSON.stringify({ providerId, type }) }, controller.current.signal);
      if (live(r)) { showFlow(next); if (next.status !== 'pending') await refresh(r); }
    } catch { if (live(r)) setError('Could not start provider sign-in. Try again.'); }
    finally { if (live(r)) setBusy(false); }
  };
  const answer = async (flowId: string, value: string) => {
    const current = activeFlow.current;
    if (controller.current.signal.aborted || !current || current.flowId !== flowId || current.status !== 'pending'
      || flow?.flowId !== current.flowId || flow?.stepId !== current.stepId || !current.stepId || answeredStep.current === current.stepId) return;
    const stepId = current.stepId;
    answeredStep.current = stepId;
    const r = revision.current;
    try {
      await api.envelope(`/api/provider-auth/flow/${encodeURIComponent(flowId)}/input`, { method: 'POST', body: JSON.stringify({ stepId, value }) }, controller.current.signal);
    } catch {
      if (live(r)) { answeredStep.current = undefined; setError('Could not submit authorization answer. Try again.'); }
      throw new Error('Authorization answer refused');
    }
  };
  const cancel = async () => {
    const current = activeFlow.current;
    if (!current) return;
    const r = ++revision.current;
    activeFlow.current = undefined; setFlow(undefined); setError(''); setBusy(true);
    try { await api.envelope(`/api/provider-auth/flow/${encodeURIComponent(current.flowId)}`, { method: 'DELETE' }, controller.current.signal); }
    catch { if (live(r)) setError('Could not confirm cancellation. Close and check provider status before trying again.'); }
    finally { if (live(r)) setBusy(false); }
  };
  const logout = async (providerId: string) => {
    const r = revision.current;
    setBusy(true); setError('');
    try {
      await api.envelope('/api/provider-auth/logout', { method: 'POST', body: JSON.stringify({ providerId }) }, controller.current.signal);
      await refresh(r);
    } catch { if (live(r)) setError('Could not update provider credentials. Try again.'); }
    finally { if (live(r)) setBusy(false); }
  };
  return <section className="cf-chat-panel cf-chat-providers" aria-label="Provider authentication">
    <div className="cf-chat-panel-heading"><h2>Providers</h2><button type="button" onClick={onClose}>Close providers</button></div>
    {error && <p role="alert">{error}</p>}
    {!catalog && !error && <p role="status">Loading provider status…</p>}
    {catalog?.personalAuthAllowed === false && <p>Personal providers are disabled by workspace policy. Use the managed model catalog.</p>}
    {catalog?.providers.map(provider => {
      const configured = status?.providers.find(item => item.providerId === provider.id);
      const stored = status?.credentials?.some(item => item.providerId === provider.id);
      return <div className="cf-chat-provider" key={provider.id}>
        <h3>{provider.name}</h3><p>{configured ? configured.configured ? `Configured${configured.source ? ` · ${configured.source}` : ''}` : 'Not configured' : 'Status unavailable'}</p>
        {catalog.personalAuthAllowed && provider.authTypes.map(type => <button type="button" key={type} disabled={busy || flow?.status === 'pending'} onClick={() => void start(provider.id, type)}>{type === 'api_key' ? 'Add API key' : 'Sign in'}</button>)}
        {stored && <button type="button" disabled={busy || flow?.status === 'pending'} onClick={() => void logout(provider.id)}>Log out</button>}
      </div>;
    })}
    {flow?.status === 'pending' && (flow.inputSecret
      ? <SecretStep key={`${flow.flowId}:${flow.stepId}`} flow={flow} onAnswer={answer} onCancel={() => void cancel()} />
      : <OAuthFlowView key={`${flow.flowId}:${flow.stepId ?? 'waiting'}`} flow={{ phase: 'waiting', status: flow }} onSendInput={answer} onCancel={() => void cancel()} />)}
    {flow && flow.status !== 'pending' && <p role="status">{flow.status === 'complete' ? 'Authorization finished. Check configured provider status above.' : flow.status === 'expired' ? 'Authorization cancelled or expired.' : 'Authorization ended. Check provider status or try again.'}</p>}
  </section>;
}

function SecretStep({ flow, onAnswer, onCancel }: { flow: Flow; onAnswer: (id: string, value: string) => Promise<void>; onCancel: () => void }) {
  const secret = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const label = flow.pending && 'message' in flow.pending ? flow.pending.message : 'API key';
  return <form onSubmit={event => {
    event.preventDefault();
    if (busy || !secret.current?.value) return;
    const value = secret.current.value; secret.current.value = ''; setBusy(true);
    void onAnswer(flow.flowId, value).catch(() => setBusy(false));
  }}>
    <label>{label || 'API key'}<input ref={secret} type="password" autoComplete="off" disabled={busy} /></label>
    <button type="submit" disabled={busy}>Submit</button><button type="button" onClick={onCancel}>Cancel authorization</button>
  </form>;
}
