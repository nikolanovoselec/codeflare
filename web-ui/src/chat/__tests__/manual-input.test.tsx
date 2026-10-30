/** @jsxImportSource react */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getByRole } from '@testing-library/dom';
import { mountChat } from '../ChatMount';

let mounted: ReturnType<typeof mountChat> | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => { if (mounted) await act(() => mounted!.dispose()); host?.remove(); mounted = undefined; vi.unstubAllGlobals(); });

// Codeflare-owned activity/draft wiring only: no upstream widget assertions.
describe('REQ-AGENT-224 manual Chat activity boundary', () => {
  it('reports human edits/send but not subscription/replay traffic to the shell', async () => {
    const manual: string[] = [];
    let draft = '';
    let socket!: Wire;
    class Wire {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor(_url: string) { socket = this; }
      frames: unknown[] = [];
      send(data: string) { this.frames.push(JSON.parse(data)); }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', Wire);
    host = document.createElement('div'); host.className = 'codeflare-chat'; document.body.append(host);
    const props = { sessionId: 'cf-primary', generation: 7, boundSessionId: 'bound-primary', draft,
      onManualInput: () => { manual.push('human'); }, onDraftChange: (next: string) => { draft = next; mounted?.update({ ...props, draft }); } };
    await act(() => { mounted = mountChat(host!, props); });
    await act(() => { socket.onopen?.(); socket.onmessage?.({ data: JSON.stringify({ type: 'event_replay', sessionId: 'bound-primary', events: [] }) }); });
    expect(manual).toEqual([]);
    expect(socket.frames).toEqual([{ type: 'subscribe', sessionId: 'bound-primary', lastSeq: 0 }]);
    const input = host.querySelector('textarea')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Continue');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(socket.frames).toContainEqual({ type: 'chat-input', sessionId: 'bound-primary' });
    expect(socket.frames.filter((frame: any) => frame.type === 'chat-input')).toEqual([{ type: 'chat-input', sessionId: 'bound-primary' }]);
    expect(draft).toBe('Continue');
    expect(manual.length).toBeGreaterThan(0);
    const beforeSend = manual.length;
    const send = getByRole(host, 'button', { name: 'Send' });
    await act(() => { send.click(); });
    expect(manual.length).toBeGreaterThan(beforeSend);
    expect(draft).toBe('');
    const beforeOfflineEdit = [...socket.frames];
    socket.readyState = 3;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Offline draft');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(draft).toBe('Offline draft');
    expect(socket.frames).toEqual(beforeOfflineEdit);
    await act(() => { socket.readyState = 1; socket.onopen?.(); });
    expect(socket.frames).toEqual(beforeOfflineEdit);
  });
});
