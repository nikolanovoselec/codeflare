/** @jsxImportSource react */
import React, { act, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, getByLabelText, getByRole, queryByRole, waitFor } from '@testing-library/dom';
import { mountChat, type ChatMountProps } from '../ChatMount';

const presentationProbe = vi.hoisted(() => ({ realComposer: false }));

// Public native component ports, not donor implementation tests. Small accessible
// probes expose only what OUR mount supplies. Real socket/reducer/actions remain
// live; no model selector, file picker keyboard, queue or SDK algorithm is tested.
vi.mock('../upstream/client/src/chat-embed', async importOriginal => {
  const actual = await importOriginal<typeof import('../upstream/client/src/chat-embed')>();
  const { useDisplayPrefs } = await import('../upstream/client/src/hooks/useDisplayPrefs');
  return {
    ...actual,
    CommandInput: (p: ComponentProps<typeof actual.CommandInput>) => <section aria-label="Composer wiring">
      {presentationProbe.realComposer && <actual.CommandInput {...p} />}
      <output aria-label="Current model">{p.model ?? 'unknown'}</output>
      <output aria-label="Reasoning level">{p.thinkingLevel ?? 'unknown'}</output>
      <output aria-label="Model catalog">{JSON.stringify(p.models ?? [])}</output>
      <output aria-label="Builtin command policy">{String(p.includeBuiltinCommands)}</output>
      <output aria-label="Advanced composer callbacks">{JSON.stringify([
        p.onRefreshModels && 'models', p.onSelectModel && 'select-model', p.onSelectThinkingLevel && 'reasoning',
        p.onListFiles && 'files', p.onForceKill && 'force-stop', p.onStopAfterTurn && 'stop-after-turn',
        p.onOpenProviderSettings && 'providers',
      ].filter(Boolean))}</output>
      <button disabled={p.disabled || !p.onAbort} onClick={p.onAbort}>Abort current turn</button>
      <output aria-label="Commands">{JSON.stringify(p.commands)}</output>
      <output aria-label="File results">{JSON.stringify(p.fileResults ?? null)}</output>
      <output aria-label="Context usage">{JSON.stringify(p.contextUsage ?? null)}</output>
      <output aria-label="Draft">{p.draft ?? ''}</output>
      <output aria-label="Pending delivery">{p.pendingPrompt ?? 'none'}</output>
      <button disabled={p.disabled || !p.onRefreshModels} onClick={p.onRefreshModels}>Refresh models</button>
      <button disabled={p.disabled || !p.onSelectModel} onClick={() => p.onSelectModel?.('codeflare-gateway/route-deep')}>Select deep model</button>
      <button disabled={p.disabled || !p.onSelectThinkingLevel} onClick={() => p.onSelectThinkingLevel?.('high')}>Select high reasoning</button>
      <button disabled={p.disabled || !p.onListFiles} onClick={() => p.onListFiles?.('src/chat')}>Search workspace files</button>
      <button disabled={p.disabled} onClick={() => p.onSend('/compact')}>Run discovered command</button>
      <button disabled={p.disabled} onClick={() => p.onSend('/not-supported')}>Run unsupported command</button>
      <button disabled={p.disabled} onClick={() => p.onSend('A possibly handed prompt')}>Send prompt</button>
      <button disabled={p.disabled} onClick={() => p.onSend('Prompt with attachments', [
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        { type: 'image', data: 'anBlZw==', mimeType: 'image/jpeg' },
      ], 'followUp')}>Send attached prompt</button>
      <button disabled={p.disabled || !p.onCancelPending} onClick={p.onCancelPending}>Cancel pending</button>
      <button disabled={p.disabled || !p.onForceKill} onClick={p.onForceKill}>Force stop Pi</button>
      <button disabled={p.disabled || !p.onStopAfterTurn} onClick={p.onStopAfterTurn}>Stop Pi after turn</button>
      <button disabled={!p.onOpenProviderSettings} onClick={p.onOpenProviderSettings}>Open providers</button>
    </section>,
    QueuePanel: (p: ComponentProps<typeof actual.QueuePanel>) => <section aria-label="Native buffered follow-ups">
      <output aria-label="Buffered entries">{JSON.stringify(p.followUp)}</output>
      <button disabled={!p.onEdit} onClick={() => p.onEdit?.(0, 'Revised follow-up')}>Edit buffered entry</button>
      <button disabled={!p.onRemove} onClick={() => p.onRemove?.(0)}>Remove buffered entry</button>
      <button disabled={!p.onPromote} onClick={() => p.onPromote?.(1)}>Promote buffered entry</button>
      <button disabled={!p.onClearAll} onClick={p.onClearAll}>Clear buffered entries</button>
    </section>,
    ChatView: (p: ComponentProps<typeof actual.ChatView>) => {
      const prefs = useDisplayPrefs(p.sessionId);
      return <section aria-label="Transcript wiring">
        <button onClick={() => {
          if (!p.sessionId) throw new Error('Expected the actual bound Chat session ID');
          p.toolContext?.send?.({ type: 'setSessionDisplayPrefs', sessionId: p.sessionId, override: { reasoning: true } });
        }}>Try advanced tool action</button>
        <output aria-label="Reasoning visible">{String(prefs.reasoning)}</output>
        <output aria-label="Context visible">{String(prefs.contextUsageBar)}</output>
        <button disabled={!p.onRetryPendingPrompt} onClick={p.onRetryPendingPrompt}>Recover pending prompt</button>
        <button disabled={!p.onForkFromMessage} onClick={() => p.onForkFromMessage?.('entry-user-1')}>Fork this message</button>
      </section>;
    },
  };
});

// Exercise only the new host's binding to the retained public auth component.
// Its input rendering, countdown and provider interaction algorithms are out of scope.
vi.mock('../upstream/client/src/components/settings/OAuthFlowView', () => ({
  OAuthFlowView: (p: ComponentProps<typeof import('../upstream/client/src/components/settings/OAuthFlowView').OAuthFlowView>) => <section aria-label="Native auth flow wiring">
    <output aria-label="Auth flow">{JSON.stringify(p.flow)}</output>
    <button onClick={() => {
      if (!p.flow.status) throw new Error('Expected the current auth flow status');
      return p.onSendInput(p.flow.status.flowId, 'public-code');
    }}>Submit native auth answer</button>
    <button onClick={() => {
      if (!p.flow.status) throw new Error('Expected the current auth flow status');
      return p.onCancel(p.flow.status.flowId);
    }}>Cancel native auth flow</button>
  </section>,
}));

const PRIMARY = 'bound-primary';
const model = { provider: 'codeflare-gateway', id: 'route-fast', name: 'Fast route', contextWindow: 128000 };
const deepModel = { ...model, id: 'route-deep', name: 'Deep route' };
const commands = [{ name: 'compact', description: 'Compact context' }];
let host: HTMLDivElement;
let mounted: ReturnType<typeof mountChat> | undefined;
let sockets: Wire[];
let requests: Request[];
let respond: (request: Request) => Promise<Response>;
class Wire {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  frames: Record<string, unknown>[] = [];
  failPrompt = false;
  constructor(readonly url: string) { sockets.push(this); }
  send(data: string) {
    const frame = JSON.parse(data);
    if (this.failPrompt && frame.type === 'send_prompt') throw new Error('Socket send refused before handoff');
    this.frames.push(frame);
  }
  addEventListener() {} removeEventListener() {}
  close() { this.readyState = 3; }
}
async function mount(extra: Partial<ChatMountProps> = {}) {
  sockets = []; requests = [];
  respond = async () => Response.json({ error: 'Not configured in this fixture' }, { status: 503 });
  vi.stubGlobal('WebSocket', Wire);
  vi.stubGlobal('confirm', (_message?: string) => true);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(input instanceof Request ? input.url : String(input), window.location.origin), init);
    requests.push(request); return respond(request);
  });
  host = document.createElement('div'); document.body.append(host);
  await act(() => { mounted = mountChat(host, { sessionId: 'cf-primary', generation: 7, boundSessionId: PRIMARY, controlsAvailable: true, ...extra }); });
  await act(() => { sockets[0].onopen?.(); });
  await receive({ type: 'sessions_snapshot', sessions: [{ id: PRIMARY, status: 'idle', cwd: '/workspace', model: 'codeflare-gateway/route-fast', thinkingLevel: 'low' }] });
  await receive({ type: 'event_replay', sessionId: PRIMARY, events: [] });
}
async function receive(message: Record<string, unknown>, socket = sockets.at(-1)!) {
  await act(() => { socket.onmessage?.({ data: JSON.stringify(message) }); });
}
async function click(name: string | RegExp) { await act(() => { getByRole(document.body, 'button', { name }).click(); }); }
function output(name: string) { return getByRole(host, 'status', { name }).textContent!; }
function frames(type: string) { return sockets.flatMap(socket => socket.frames.filter(frame => frame.type === type)); }
function scoped(path: string) { return requests.filter(request => new URL(request.url).pathname === `/api/chat/cf-primary${path}`); }
function expectScoped(request: Request, method = 'GET') {
  expect(new URL(request.url).searchParams.get('generation')).toBe('7');
  expect(request.method).toBe(method); expect(request.credentials).toBe('same-origin');
}
afterEach(async () => {
  if (mounted) await act(() => mounted!.dispose());
  mounted = undefined; host?.remove(); vi.unstubAllGlobals(); presentationProbe.realComposer = false;
});

describe('REQ-AGENT-224 AC10–12: first-party model and reasoning wiring', () => {
  it('preserves basic Chat on an older runtime without sending unsupported control frames', async () => {
    await mount({ controlsAvailable: false });
    expect(frames('request_models')).toEqual([]);
    expect(frames('request_commands')).toEqual([]);
    expect(host.textContent).toMatch(/controls.*unavailable|update.*runtime|updated.*session/i);
    await click('Send prompt');
    expect(frames('send_prompt')).toContainEqual(expect.objectContaining({ sessionId: PRIMARY, text: 'A possibly handed prompt' }));
  });
  it.each([false, undefined])('defaults/fences legacy controls=%s while retaining base prompt and abort', async controlsAvailable => {
    await mount({ controlsAvailable });
    expect(output('Builtin command policy')).toBe('false');
    expect(JSON.parse(output('Advanced composer callbacks'))).toEqual([]);
    expect(queryByRole(host, 'button', { name: /conversation history|new conversation|^view$/i })).toBeNull();
    expect(requests).toEqual([]);
    await click('Try advanced tool action');
    expect(frames('setSessionDisplayPrefs')).toEqual([]);
    await click('Send prompt'); await click('Abort current turn');
    expect(frames('send_prompt')).toContainEqual(expect.objectContaining({ sessionId: PRIMARY, text: 'A possibly handed prompt' }));
    expect(frames('abort')).toEqual([{ type: 'abort', sessionId: PRIMARY }]);
    expect(sockets.flatMap(socket => socket.frames).every(frame => ['subscribe', 'send_prompt', 'abort'].includes(String(frame.type)))).toBe(true);
    expect(requests).toEqual([]);
  });

  it('opts out of standalone builtin/local suggestions and keeps reserved command discovery fenced', async () => {
    await mount();
    expect(output('Builtin command policy')).toBe('false');
    await receive({ type: 'commands_list', sessionId: PRIMARY, commands: [
      ...commands, ...['new', 'reload', 'view', 'dashboard-connect', 'codeflare-conversation', 'flows:new'].map(name => ({ name })),
    ] });
    expect(JSON.parse(output('Commands'))).toEqual(commands);
  });

  it('discovers the permitted catalog and shows authoritative primary metadata, not optimistic selection', async () => {
    await mount();
    expect(frames('request_models')).toContainEqual({ type: 'request_models', sessionId: PRIMARY });
    await receive({ type: 'models_list', sessionId: PRIMARY, models: [model, deepModel] });
    expect(JSON.parse(output('Model catalog'))).toEqual([model, deepModel]);
    expect(output('Current model')).toBe('codeflare-gateway/route-fast');
    expect(output('Reasoning level')).toBe('low');
    const before = frames('request_models').length;
    await click('Refresh models');
    expect(frames('request_models').length).toBeGreaterThan(before);
    await click('Select deep model'); await click('Select high reasoning');
    expect(frames('set_model')).toEqual([{ type: 'set_model', sessionId: PRIMARY, provider: 'codeflare-gateway', modelId: 'route-deep' }]);
    expect(frames('set_thinking_level')).toEqual([{ type: 'set_thinking_level', sessionId: PRIMARY, level: 'high' }]);
    expect(output('Current model')).toBe('codeflare-gateway/route-fast');
    expect(output('Reasoning level')).toBe('low');
    await receive({ type: 'session_updated', sessionId: PRIMARY, updates: { model: 'codeflare-gateway/route-deep', thinkingLevel: 'high' } });
    expect(output('Current model')).toBe('codeflare-gateway/route-deep');
    expect(output('Reasoning level')).toBe('high');
    // A managed catalog is sufficient: do not demand personal-provider login.
    expect(requests.filter(request => request.url.includes('/provider-auth/'))).toEqual([]);
  });

  it('keeps the selection and exposes a rejected change rather than claiming success', async () => {
    await mount(); await click('Select deep model');
    await receive({ type: 'error', sessionId: PRIMARY, message: 'Model selection denied by policy' });
    expect(output('Current model')).toBe('codeflare-gateway/route-fast');
    expect(host.textContent).toMatch(/Model selection denied by policy/);
  });

  it('accepts only string Host errors for the actual bound primary', async () => {
    await mount();
    await receive({ type: 'error', sessionId: 'other-primary', message: 'Foreign error' });
    await receive({ type: 'error', message: 'Unscoped error' });
    await receive({ type: 'error', sessionId: PRIMARY, message: { text: 'Malformed error' } });
    expect(queryByRole(host, 'alert')).toBeNull();
    await receive({ type: 'error', sessionId: PRIMARY, message: 'Bound control rejected' });
    expect(getByRole(host, 'alert').textContent).toBe('Bound control rejected');
    expect(output('Current model')).toBe('codeflare-gateway/route-fast');
  });

  it('ignores another primary metadata/catalog and cannot mutate while offline', async () => {
    await mount();
    await receive({ type: 'session_updated', sessionId: 'other-primary', updates: { model: 'foreign/secret', thinkingLevel: 'high' } });
    await receive({ type: 'models_list', sessionId: 'other-primary', models: [{ ...model, id: 'foreign' }] });
    expect(output('Current model')).toBe('codeflare-gateway/route-fast');
    expect(output('Model catalog')).not.toContain('foreign');
    await act(() => { sockets[0].readyState = 3; sockets[0].onclose?.({ code: 1006 }); });
    const before = [...sockets[0].frames];
    await click('Select deep model'); await click('Select high reasoning'); await click('Refresh models');
    expect(sockets[0].frames).toEqual(before);
    expect(host.textContent).toMatch(/offline|reconnect/i);
  });
});

describe('REQ-AGENT-224 AC17–19: first-party command, file and context ports', () => {
  it.each([undefined, 'workspace/custom-flow.yaml', 'builtin'])('presents flow source %s as a Flow item, retaining raw-name dispatch and native command provenance', async source => {
    presentationProbe.realComposer = true;
    await mount({ draft: '' });
    const nativeCommands = [{ name: 'explain', description: 'Explain work', source: 'prompt', location: 'project', path: '/workspace/prompts/explain.md' }];
    await receive({ type: 'commands_list', sessionId: PRIMARY, commands: nativeCommands });
    await receive({ type: 'flows_list', sessionId: PRIMARY, flows: [
      { name: 'review-task', description: 'Review current work', taskRequired: false, ...(source === undefined ? {} : { source }) },
      { name: 'flows:new', description: 'Forbidden management alias', taskRequired: false },
    ] });
    expect(JSON.parse(output('Commands'))).toEqual([
      ...nativeCommands, { name: 'review-task', description: 'Review current work', source: 'flow' },
    ]);
    // Open completion through the real controlled input once discovery is ready;
    // the suggestion is rendered into the mount's presentation-layer portal.
    const input = getByRole(host, 'textbox') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    await act(() => { fireEvent.input(input, { target: { value: '/' } }); });
    expect(output('Draft')).toBe('/');
    const flow = await waitFor(() => getByRole(document.body, 'button', { name: /\/review-task Review current work flow/i }));
    expect(flow.textContent).toContain('Review current work');
    expect(flow.textContent).not.toMatch(/builtin|extension/i);
    expect(document.body.textContent).toContain('Flows');
    expect(queryByRole(document.body, 'button', { name: /Forbidden management alias/i })).toBeNull();
    await receive({ type: 'flows_list', sessionId: 'other-primary', flows: [{ name: 'foreign-flow', description: 'Foreign flow', taskRequired: false }] });
    expect(queryByRole(document.body, 'button', { name: /foreign-flow/i })).toBeNull();
    await act(() => { flow.click(); });
    expect(output('Draft')).toBe('/review-task ');
    await click('Send');
    expect(frames('send_prompt')).toEqual([expect.objectContaining({ sessionId: PRIMARY, text: '/review-task' })]);
    const sent = [...frames('send_prompt')];
    await click('Run unsupported command');
    expect(frames('send_prompt')).toEqual(sent);
  });

  it('discovers commands and sends an authorized slash command only through the bound native prompt road', async () => {
    await mount();
    expect(frames('request_commands')).toContainEqual({ type: 'request_commands', sessionId: PRIMARY });
    await receive({ type: 'commands_list', sessionId: PRIMARY, commands });
    expect(JSON.parse(output('Commands'))).toEqual(commands);
    await receive({ type: 'flows_list', sessionId: PRIMARY, flows: [{ name: 'review-task', description: 'Review current work' }] });
    expect(JSON.parse(output('Commands'))).toEqual(expect.arrayContaining([
      ...commands, expect.objectContaining({ name: 'review-task' }),
    ]));
    await click('Run discovered command');
    expect(frames('send_prompt')).toContainEqual(expect.objectContaining({ sessionId: PRIMARY, text: '/compact' }));
    const sent = [...frames('send_prompt')];
    await click('Run unsupported command');
    expect(frames('send_prompt')).toEqual(sent);
    expect(host.textContent).toMatch(/unsupported|not supported|unavailable/i);
  });

  it('routes @file queries and results without mixing another primary response', async () => {
    await mount(); await click('Search workspace files');
    expect(frames('list_files')).toEqual([{ type: 'list_files', sessionId: PRIMARY, query: 'src/chat' }]);
    const files = [{ path: 'src/chat/api.ts', type: 'file' }];
    await receive({ type: 'files_list', sessionId: PRIMARY, query: 'src/chat', files });
    expect(JSON.parse(output('File results'))).toEqual({ query: 'src/chat', files });
    await receive({ type: 'files_list', sessionId: 'other-primary', query: 'src/chat', files: [{ path: 'private.txt', type: 'file' }] });
    expect(output('File results')).not.toContain('private.txt');
  });

  it.each([null, 0, 42000])('forwards native context tokens %j without manufacturing unknown as zero', async tokens => {
    await mount();
    expect(JSON.parse(output('Context usage'))?.tokens ?? null).toBeNull();
    await receive({ type: 'event', sessionId: PRIMARY, seq: 1, event: { eventType: 'stats_update', timestamp: Date.now(), data: { contextUsage: { tokens, contextWindow: 128000 } } } });
    expect(JSON.parse(output('Context usage'))).toEqual({ tokens, contextWindow: 128000 });
  });
});

describe('REQ-AGENT-224 AC20–23: first-party native queue and recovery wiring', () => {
  it('wires all buffered follow-up actions without optimistic deletion or resending image bytes', async () => {
    await mount();
    const followUp = [{ text: 'Buffered one', imageCount: 1 }, { text: 'Buffered two', imageCount: 0 }];
    await receive({ type: 'queue_update', sessionId: PRIMARY, steering: [], followUp });
    expect(JSON.parse(output('Buffered entries'))).toEqual(followUp);
    await click('Edit buffered entry'); await click('Remove buffered entry');
    await click('Promote buffered entry'); await click('Clear buffered entries');
    for (const expected of [
      { type: 'edit_followup_entry', index: 0, text: 'Revised follow-up' },
      { type: 'remove_followup_entry', index: 0 },
      { type: 'promote_followup_entry', index: 1 },
      { type: 'clear_followup_entries', indices: 'all' },
    ]) expect(frames(expected.type)).toEqual([{ ...expected, sessionId: PRIMARY }]);
    expect(JSON.parse(output('Buffered entries'))).toEqual(followUp);
    await receive({ type: 'queue_update', sessionId: PRIMARY, steering: [], followUp: [] });
    expect(JSON.parse(output('Buffered entries'))).toEqual([]);
    expect(frames('send_prompt')).toEqual([]);
  });

  it('does not queue buffer mutations while offline for surprise replay on reconnect', async () => {
    await mount();
    await receive({ type: 'queue_update', sessionId: PRIMARY, steering: [], followUp: [{ text: 'Buffered', imageCount: 0 }] });
    await act(() => { sockets[0].readyState = 3; sockets[0].onclose?.({ code: 1006 }); });
    await click('Edit buffered entry'); await click('Remove buffered entry');
    await click('Promote buffered entry'); await click('Clear buffered entries');
    await act(() => { sockets[0].readyState = 1; sockets[0].onopen?.(); });
    for (const type of ['edit_followup_entry', 'remove_followup_entry', 'promote_followup_entry', 'clear_followup_entries']) expect(frames(type)).toEqual([]);
  });

  it.each(['Force stop Pi', 'Stop Pi after turn'])('%s discloses shared Pi termination and cancellation emits no shutdown', async action => {
    await mount();
    const confirm = vi.fn((_message?: string) => false); vi.stubGlobal('confirm', confirm);
    await click(action);
    expect(confirm.mock.calls[0]?.[0]).toMatch(/shared.*Pi|Pi.*shared/i);
    expect(confirm.mock.calls[0]?.[0]).toMatch(/terminat|shut down|stop.*primary/i);
    expect(frames('force_kill')).toEqual([]); expect(frames('stop_after_turn')).toEqual([]);
    confirm.mockReturnValue(true); await click(action);
    const type = action === 'Force stop Pi' ? 'force_kill' : 'stop_after_turn';
    expect(frames(type)).toEqual([{ type, sessionId: PRIMARY }]);
    expect(frames('send_prompt')).toEqual([]);
    await receive({ type: 'session_removed', sessionId: PRIMARY });
    expect(host.textContent).toMatch(/re.enter|open Chat again|restart Pi/i);
    expect((getByRole(host, 'button', { name: 'Send prompt' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('treats primary-unavailable close as explicit reentry, not expired account authentication', async () => {
    let authenticationError = '';
    await mount({ onAuthError: message => { authenticationError = message; } });
    await act(() => { sockets[0].readyState = 3; sockets[0].onclose?.({ code: 4002 }); });
    expect(host.textContent).toMatch(/re.enter|open Chat again|restart Pi/i);
    expect(authenticationError).toBe('');
    expect((getByRole(host, 'button', { name: 'Send prompt' }) as HTMLButtonElement).disabled).toBe(true);
    expect(frames('send_prompt')).toEqual([]);
  });

  it('binds settled native error recovery to retry_session, never a fabricated user prompt', async () => {
    await mount();
    await receive({ type: 'event', sessionId: PRIMARY, seq: 1, event: { eventType: 'agent_end', timestamp: Date.now(),
      data: { messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'Provider temporarily unavailable', content: [] }] } } });
    await receive({ type: 'event', sessionId: PRIMARY, seq: 2, event: { eventType: 'agent_settled', timestamp: Date.now(), data: {} } });
    await click(/^retry$/i);
    expect(frames('retry_session')).toEqual([{ type: 'retry_session', sessionId: PRIMARY }]);
    expect(frames('send_prompt')).toEqual([]);
  });

  it('wires explicit retry only for a prompt that the native transport knows never left the browser', async () => {
    await mount(); sockets[0].failPrompt = true;
    await click('Send prompt');
    expect(frames('send_prompt')).toEqual([]);
    expect(output('Pending delivery')).toBe('failed');
    sockets[0].failPrompt = false;
    await click('Recover pending prompt');
    expect(frames('send_prompt')).toEqual([expect.objectContaining({ sessionId: PRIMARY, text: 'A possibly handed prompt' })]);
    expect(output('Pending delivery')).toBe('sending');
  });

  it('preserves image bytes, MIME types and delivery on explicit known-unsent recovery', async () => {
    await mount(); sockets[0].failPrompt = true;
    await click('Send attached prompt');
    expect(frames('send_prompt')).toEqual([]);
    expect(output('Pending delivery')).toBe('failed');
    sockets[0].failPrompt = false;
    await click('Recover pending prompt');
    expect(frames('send_prompt')).toEqual([expect.objectContaining({
      sessionId: PRIMARY, text: 'Prompt with attachments', delivery: 'followUp',
      images: [
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        { type: 'image', data: 'anBlZw==', mimeType: 'image/jpeg' },
      ],
    })]);
    expect(output('Pending delivery')).toBe('sending');
  });

  it('does not replay uncertain handed text on reconnect or explicit recovery', async () => {
    await mount(); await click('Send prompt');
    expect(frames('send_prompt')).toHaveLength(1);
    await act(() => { sockets[0].readyState = 3; sockets[0].onclose?.({ code: 1006 }); });
    await act(() => { sockets[0].readyState = 1; sockets[0].onopen?.(); });
    expect(frames('send_prompt')).toHaveLength(1);
    await click('Recover pending prompt');
    expect(frames('send_prompt')).toHaveLength(1);
    expect(sockets[0].frames).not.toContainEqual(expect.objectContaining({ type: 'send_prompt', text: '/__dashboard_retry' }));
  });

  it('pending cancellation targets only the bound native primary', async () => {
    await mount(); await click('Send prompt'); await click('Cancel pending');
    expect(frames('abort')).toEqual([{ type: 'abort', sessionId: PRIMARY }]);
    expect(requests.filter(request => request.method !== 'GET')).toEqual([]);
  });
});

describe('REQ-AGENT-224 AC24: first-party display preference binding', () => {
  it('keeps Set as global on an authenticated scoped road and preserves the override on save failure', async () => {
    await mount();
    await receive({ type: 'session_updated', sessionId: PRIMARY, updates: { displayPrefsOverride: { reasoning: true } } });
    respond = async () => Response.json({ error: 'Display preferences could not be saved' }, { status: 503 });
    await click(/view/i); await click(/set as global/i);
    await waitFor(() => expect(requests.some(request => request.method === 'PATCH')).toBe(true));
    for (const request of requests.filter(request => request.method === 'PATCH')) {
      expect(new URL(request.url).pathname).toBe('/api/chat/cf-primary/api/preferences/display');
      expectScoped(request, 'PATCH');
    }
    expect(requests.some(request => new URL(request.url).pathname === '/api/preferences/display')).toBe(false);
    await waitFor(() => expect(document.body.textContent).toMatch(/could not save|could not be saved|failed/i));
    expect(output('Reasoning visible')).toBe('true');
    expect(frames('setSessionDisplayPrefs')).not.toContainEqual(expect.objectContaining({ override: null }));
  });

  it('offers native View controls and applies only the acknowledged bound override to the rendered display context', async () => {
    await mount();
    expect(output('Reasoning visible')).toBe('false');
    expect(output('Context visible')).toBe('false');
    expect(getByRole(host, 'button', { name: 'View options' })).toBeTruthy();
    expect(queryByRole(host, 'button', { name: 'View' })).toBeNull();
    // This is intentionally the actual mounted native menu, not a preference
    // mock or assertions on its internal toggle/keyboard implementation.
    await click(/view/i);
    const toggle = getByRole(host, 'checkbox', { name: /^reasoning blocks$/i });
    await act(() => { toggle.click(); });
    expect(frames('setSessionDisplayPrefs')).toContainEqual(expect.objectContaining({ sessionId: PRIMARY, override: expect.objectContaining({ reasoning: true }) }));
    await receive({ type: 'session_updated', sessionId: PRIMARY, updates: { displayPrefsOverride: { reasoning: true, contextUsageBar: true } } });
    expect(output('Reasoning visible')).toBe('true'); expect(output('Context visible')).toBe('true');
    await receive({ type: 'session_updated', sessionId: 'other-primary', updates: { displayPrefsOverride: { reasoning: false } } });
    expect(output('Reasoning visible')).toBe('true');
    expect(requests.some(request => new URL(request.url).pathname === '/api/preferences/display')).toBe(false);
  });
});

const providerCatalog = { credentialScope: 'primary-agent-store', personalAuthAllowed: true,
  providers: [{ id: 'example', name: 'Example', authTypes: ['oauth'] }] };
const providerStatus = { credentialScope: 'primary-agent-store',
  providers: [{ providerId: 'example', configured: false }], credentials: [] };
const pendingFlow = { flowId: 'flow-1', provider: 'example', status: 'pending', stepId: 'step-1',
  authUrl: 'https://login.example/authorize', pending: { kind: 'manual_code', message: 'Paste code' } };
async function providerFixture() {
  await mount();
  respond = async request => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/providers')) return Response.json({ success: true, data: providerCatalog });
    if (path.endsWith('/status')) return Response.json({ success: true, data: providerStatus });
    if (path.endsWith('/flow/flow-1') && request.method === 'DELETE') return Response.json({ success: true,
      data: { flowId: 'flow-1', provider: 'example', status: 'expired', error: 'auth_cancelled' } });
    if (path.endsWith('/start') || path.endsWith('/flow/flow-1')) return Response.json({ success: true, data: pendingFlow });
    return Response.json({ success: true, data: {} });
  };
  await click('Open providers');
  await waitFor(() => expect(document.body.textContent).toContain('Example'));
}

describe('REQ-AGENT-224 AC8–9: first-party provider entry and truthful failure', () => {
  it('binds provider discovery/status and the native answer callback to this primary auth scope', async () => {
    await providerFixture();
    expectScoped(scoped('/api/provider-auth/providers')[0]);
    expectScoped(scoped('/api/provider-auth/status')[0]);
    await click(/sign in/i);
    await waitFor(() => expect(scoped('/api/provider-auth/start')).toHaveLength(1));
    const start = scoped('/api/provider-auth/start')[0]; expectScoped(start, 'POST');
    expect(await start.json()).toEqual({ providerId: 'example', type: 'oauth' });
    await waitFor(() => expect(getByRole(document.body, 'status', { name: 'Auth flow' }).textContent).toContain('Paste code'));
    expect(getByRole(document.body, 'status', { name: 'Auth flow' }).textContent).toContain('https://login.example/authorize');
    await click('Submit native auth answer');
    await waitFor(() => expect(scoped('/api/provider-auth/flow/flow-1/input')).toHaveLength(1));
    const input = scoped('/api/provider-auth/flow/flow-1/input')[0]; expectScoped(input, 'POST');
    expect(await input.json()).toEqual({ stepId: 'step-1', value: 'public-code' });
    // Request acceptance is not login completion; status remains authoritative.
    expect(document.body.textContent).not.toMatch(/signed in successfully|successfully connected/i);
    expect(frames('send_prompt')).toEqual([]);
  });

  it('cancels only the active native auth flow, not stored credentials or the primary', async () => {
    await providerFixture(); await click(/sign in/i);
    await waitFor(() => expect(getByRole(document.body, 'button', { name: 'Cancel native auth flow' })).toBeTruthy());
    await click('Cancel native auth flow');
    await waitFor(() => expect(scoped('/api/provider-auth/flow/flow-1').some(request => request.method === 'DELETE')).toBe(true));
    expect(scoped('/api/provider-auth/logout')).toEqual([]);
    expect(frames('force_kill')).toEqual([]); expect(frames('abort')).toEqual([]);
    await waitFor(() => expect(document.body.textContent).not.toContain('Paste code'));
    expect(document.body.textContent).not.toContain('https://login.example/authorize');
    expect(document.body.textContent).not.toMatch(/logged out successfully|successfully connected/i);
  });

  it('uses canonical api_key login with an owned masked secret field and fenced native input, never a prompt', async () => {
    await mount();
    const secretFlow = { flowId: 'key-flow', provider: 'example', status: 'pending', stepId: 'key-step', inputSecret: true,
      pending: { kind: 'text', message: 'API key', placeholder: 'Paste key' } };
    respond = async request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/providers')) return Response.json({ success: true, data: { ...providerCatalog,
        providers: [{ id: 'example', name: 'Example', authTypes: ['api_key'] }] } });
      if (path.endsWith('/status')) return Response.json({ success: true, data: providerStatus });
      if (path.endsWith('/start') || path.endsWith('/flow/key-flow')) return Response.json({ success: true, data: secretFlow });
      return Response.json({ success: true, data: {} });
    };
    await click('Open providers');
    await waitFor(() => expect(document.body.textContent).toContain('Example'));
    await click(/sign in|add api key|configure api key/i);
    const start = scoped('/api/provider-auth/start')[0]; expectScoped(start, 'POST');
    expect(await start.json()).toEqual({ providerId: 'example', type: 'api_key' });
    const input = await waitFor(() => getByLabelText(document.body, /^api key$/i) as HTMLInputElement);
    expect(input.type).toBe('password');
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'fixture-key-not-for-transcript');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(/submit|continue|save.*key/i);
    await waitFor(() => expect(scoped('/api/provider-auth/flow/key-flow/input')).toHaveLength(1));
    const request = scoped('/api/provider-auth/flow/key-flow/input')[0]; expectScoped(request, 'POST');
    expect(await request.json()).toEqual({ stepId: 'key-step', value: 'fixture-key-not-for-transcript' });
    expect(frames('send_prompt')).toEqual([]);
    expect(output('Draft')).not.toContain('fixture-key-not-for-transcript');
    expect(document.body.textContent).not.toContain('fixture-key-not-for-transcript');
  });

  it('logs out through the scoped credential road and waits for authoritative status rather than claiming disconnection', async () => {
    await mount();
    let loggedOut = false;
    respond = async request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/providers')) return Response.json({ success: true, data: providerCatalog });
      if (path.endsWith('/status')) return Response.json({ success: true, data: { credentialScope: 'primary-agent-store',
        providers: [{ providerId: 'example', configured: true, source: loggedOut ? 'environment' : 'stored' }],
        credentials: loggedOut ? [] : [{ providerId: 'example', type: 'oauth' }] } });
      if (path.endsWith('/logout') && request.method === 'POST') { loggedOut = true; return Response.json({ success: true, data: {} }); }
      return Response.json({ error: 'Unexpected road' }, { status: 404 });
    };
    await click('Open providers');
    await waitFor(() => expect(document.body.textContent).toContain('Example'));
    await click(/log out|logout|sign out/i);
    await waitFor(() => expect(scoped('/api/provider-auth/logout')).toHaveLength(1));
    const request = scoped('/api/provider-auth/logout')[0]; expectScoped(request, 'POST');
    expect(await request.json()).toEqual({ providerId: 'example' });
    await waitFor(() => expect(scoped('/api/provider-auth/status').length).toBeGreaterThan(1));
    expect(document.body.textContent).not.toMatch(/disconnected|not configured/i);
    expect(document.body.textContent).toMatch(/environment|configured|connected/i);
  });

  it('opens the native provider surface through scoped authenticated roads and reports unavailable authority', async () => {
    await mount();
    respond = async () => Response.json({ error: 'Primary credential authority unavailable' }, { status: 503 });
    await click('Open providers');
    await waitFor(() => expect(requests.some(request => request.url.includes('/api/provider-auth/'))).toBe(true));
    const authRequests = requests.filter(request => request.url.includes('/api/provider-auth/'));
    for (const request of authRequests) {
      expect(request.url).toContain('/api/chat/cf-primary/api/provider-auth/'); expectScoped(request);
    }
    await waitFor(() => expect(document.body.textContent).toMatch(/unavailable|could not|failed/i));
    expect(document.body.textContent).not.toMatch(/successfully connected|signed in successfully/i);
  });
});

// Host owns the redacted metadata and authoritative adoption response contract.
// These tests assert OUR callback/API/binding outcomes, not SDK history methods.
const conversation = { id: 'saved-1', name: 'Earlier work', created: '2026-10-30T00:00:00.000Z', modified: '2026-10-31T00:00:00.000Z', messageCount: 3 };
async function openHistory() { await click(/conversation history|browse conversations|history/i); }
async function historyFixture(extra: Partial<ChatMountProps> = {}) {
  await mount(extra);
  respond = async request => new URL(request.url).pathname.endsWith('/api/conversations')
    ? Response.json({ success: true, data: [conversation] })
    : Response.json({ sessionId: 'native-adopted', generation: 7 });
}

describe('REQ-AGENT-224 AC13–16/23: first-party conversation actions and binding adoption', () => {
  it('lists workspace conversation metadata without replacing Codeflare navigation or selecting a metadata-derived target', async () => {
    await historyFixture(); await openHistory();
    await waitFor(() => expect(document.body.textContent).toContain('Earlier work'));
    expectScoped(scoped('/api/conversations')[0]);
    expect(sockets).toHaveLength(1);
    expect(new URL(sockets[0].url).pathname).toBe('/api/chat/cf-primary/ws');
    expect(frames('subscribe').every(frame => frame.sessionId === PRIMARY)).toBe(true);
  });

  it.each(['new', 'resume', 'fork'] as const)('%s adopts only the actual returned native binding and clears the old in-memory draft', async op => {
    const drafts: string[] = [];
    await historyFixture({ draft: 'old conversation draft', onDraftChange: draft => drafts.push(draft) });
    if (op === 'resume') { await openHistory(); await waitFor(() => expect(document.body.textContent).toContain('Earlier work')); }
    if (op === 'new') await click(/new conversation/i);
    else if (op === 'resume') await click(/Earlier work|resume/i);
    else await click('Fork this message');
    await waitFor(() => expect(scoped(`/api/conversations/${op}`)).toHaveLength(1));
    const request = scoped(`/api/conversations/${op}`)[0]; expectScoped(request, 'POST');
    expect(await request.json()).toEqual({ sessionId: PRIMARY, ...(op === 'resume' ? { conversationId: 'saved-1' } : op === 'fork' ? { entryId: 'entry-user-1' } : {}) });
    await waitFor(() => expect(sockets).toHaveLength(2));
    await act(() => { sockets[1].onopen?.(); });
    expect(frames('subscribe')).toContainEqual({ type: 'subscribe', sessionId: 'native-adopted', lastSeq: 0 });
    expect(sockets[0].readyState).toBe(3);
    expect(drafts).toContain(''); expect(output('Draft')).not.toContain('old conversation draft');
    expect(frames('send_prompt')).toEqual([]);
  });

  it('does not discard active work when conversation replacement is cancelled', async () => {
    await historyFixture({ draft: 'Keep draft' });
    await receive({ type: 'session_updated', sessionId: PRIMARY, updates: { status: 'streaming' } });
    vi.stubGlobal('confirm', (_message?: string) => false);
    await click(/new conversation/i);
    expect(scoped('/api/conversations/new')).toEqual([]);
    expect(sockets).toHaveLength(1); expect(output('Draft')).toBe('Keep draft');
  });

  it.each([{ sessionId: '', generation: 7 }, { sessionId: 'wrong-generation', generation: 8 }])('rejects an invalid adoption response %j without changing the primary', async binding => {
    await historyFixture({ draft: 'Keep draft' });
    respond = async () => Response.json(binding);
    await click(/new conversation/i);
    await waitFor(() => expect(document.body.textContent).toMatch(/binding|generation|invalid|re.enter/i));
    expect(sockets).toHaveLength(1); expect(output('Draft')).toBe('Keep draft');
  });

  it('keeps the original target and draft on rejected adoption', async () => {
    await historyFixture({ draft: 'Keep my unsent text' });
    respond = async () => Response.json({ error: 'Conversation adoption refused' }, { status: 409 });
    await click(/new conversation/i);
    await waitFor(() => expect(document.body.textContent).toMatch(/Conversation adoption refused/));
    expect(sockets).toHaveLength(1); expect(sockets[0].readyState).toBe(1);
    expect(output('Draft')).toBe('Keep my unsent text');
  });

  it('does not adopt on request handoff and makes a generation-stale response inert', async () => {
    await historyFixture();
    let resolve!: (response: Response) => void;
    respond = () => new Promise<Response>(done => { resolve = done; });
    await click(/new conversation/i);
    expect(sockets).toHaveLength(1);
    await act(() => { mounted!.update({ sessionId: 'cf-primary', generation: 8, boundSessionId: 'new-generation-primary' }); });
    await act(async () => { resolve(Response.json({ sessionId: 'stale-adopted', generation: 7 })); await Promise.resolve(); });
    expect(sockets).toHaveLength(2);
    await act(() => { sockets[1].onopen?.(); });
    expect(frames('subscribe')).not.toContainEqual(expect.objectContaining({ sessionId: 'stale-adopted' }));
    expect(frames('subscribe')).toContainEqual(expect.objectContaining({ sessionId: 'new-generation-primary' }));
  });

  it('does not create a socket or change drafts from a late adoption after unmount', async () => {
    const drafts: string[] = [];
    await historyFixture({ onDraftChange: draft => drafts.push(draft) });
    let resolve!: (response: Response) => void;
    respond = () => new Promise<Response>(done => { resolve = done; });
    await click('Fork this message');
    await act(() => { mounted!.dispose(); mounted = undefined; });
    await act(async () => { resolve(Response.json({ sessionId: 'too-late', generation: 7 })); await Promise.resolve(); });
    expect(sockets).toHaveLength(1); expect(drafts).toEqual([]);
  });
});
