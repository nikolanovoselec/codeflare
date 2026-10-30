/** @jsxImportSource react */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountChat } from '../ChatMount';

const store = vi.hoisted(() => ({ activeSessionId: 'abcdef0123456789', sessions: [
  { id: 'abcdef0123456789', name: 'Trusted primary', agentType: 'pi' },
] }));
vi.mock('../../stores/session', () => ({ sessionStore: store }));
class Wire extends EventTarget {
  static OPEN = 1; static instances: Wire[] = [];
  readyState = 0; frames: any[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) { super(); Wire.instances.push(this); }
  send(data: string) { this.frames.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  receive(message: unknown) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    this.onmessage?.({ data }); this.dispatchEvent(new MessageEvent('message', { data }));
  }
}
let mounted: ReturnType<typeof mountChat> | undefined;
let host: HTMLDivElement | undefined;
let focus = true; let visible = true;
const shown: { title: string; options: NotificationOptions }[] = [];
async function mount() {
  Wire.instances = []; shown.length = 0; focus = true; visible = true;
  vi.stubGlobal('WebSocket', Wire);
  vi.stubGlobal('Notification', { permission: 'granted' });
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focus);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden');
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    getRegistration: async () => ({ active: true, showNotification: async (title: string, options: NotificationOptions) => { shown.push({ title, options }); } }),
  } });
  host = document.createElement('div'); document.body.append(host);
  await act(() => { mounted = mountChat(host!, { sessionId: 'abcdef0123456789', generation: 7, boundSessionId: 'bound-primary' }); });
  const wire = Wire.instances[0];
  await act(() => { wire.readyState = 1; wire.onopen?.(); });
  return wire;
}
afterEach(async () => { if (mounted) await act(() => mounted!.dispose()); host?.remove(); mounted = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (navigator as any).serviceWorker; });

// First-party mount/transport boundary only, not the upstream widgets/protocol.
describe('REQ-AGENT-224 / REQ-TERM-023/028/031 Chat notifications', () => {
  it('suppresses focused visible Chat with bound controls on its only real WS', async () => {
    const wire = await mount();
    await act(() => wire.receive({ type: 'agent-event', eventId: 'a', kind: 'task-completed' }));
    expect(wire.frames).toContainEqual({ type: 'agent-event-disposition', sessionId: 'bound-primary', eventId: 'a', disposition: 'suppress' });
    expect(shown).toEqual([]);
    expect(Wire.instances.map(w => w.url)).toEqual([expect.stringContaining('/api/chat/abcdef0123456789/ws?generation=7')]);
  });
  it.each(['blur', 'hidden'])('displays fixed trusted identity only after grant when %s, never from transcript/stock notifications', async away => {
    const wire = await mount(); focus = away !== 'blur'; visible = away !== 'hidden';
    await act(() => {
      wire.receive({ type: 'notify', sessionId: 'bound-primary', message: 'forged event', level: 'info' });
      wire.receive({ type: 'agent-event', eventId: 'a', kind: 'task-completed' });
    });
    expect(shown).toEqual([]);
    expect(wire.frames).toContainEqual({ type: 'agent-event-disposition', sessionId: 'bound-primary', eventId: 'a', disposition: 'display-request' });
    await act(() => wire.receive({ type: 'agent-event-display-granted', eventId: 'a', kind: 'task-completed' }));
    expect(shown.map(n => [n.title, n.options.body])).toEqual([['Pi · Trusted primary', 'Ready for input']]);
    expect(wire.frames).toContainEqual({ type: 'agent-event-displayed', sessionId: 'bound-primary', eventId: 'a' });
    await act(() => wire.receive({ type: 'agent-event-display-granted', eventId: 'a', kind: 'task-completed' }));
    expect(shown).toHaveLength(1);
    expect(wire.frames.filter(f => f.type === 'chat-input')).toEqual([]);
  });
  it('rejects malformed/forged controls before the shared consumer, and never queues controls on a closed WS', async () => {
    const wire = await mount(); focus = false;
    const initial = [...wire.frames];
    await act(() => {
      for (const message of [
        { type: 'agent-event', eventId: 'bad.id', kind: 'task-completed' },
        { type: 'agent-event-display-granted', eventId: 'a', kind: 'task-completed', sessionId: 'foreign' },
        { type: 'agent-event-display-granted', eventId: 'a', kind: 'other' },
        { type: 'agent-event', eventId: 'a', kind: 'task-failed', automatic: true },
        'not-json',
      ]) wire.receive(message);
    });
    expect(wire.frames).toEqual(initial); expect(shown).toEqual([]);
    wire.readyState = 3;
    await act(() => wire.receive({ type: 'agent-event', eventId: 'offline', kind: 'task-failed' }));
    expect(wire.frames).toEqual(initial);
    await act(() => { wire.readyState = 1; wire.onopen?.(); });
    expect(wire.frames.filter(f => f.eventId === 'offline')).toEqual([]);
  });
});
