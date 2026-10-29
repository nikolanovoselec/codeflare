/** @jsxImportSource react */
import { act, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountChat } from '../ChatMount';

// Present the public ChatView callback without exercising its untouched virtual
// list. The real socket hook, reducer, action hook and answer encoder stay live.
vi.mock('../upstream/client/src/chat-embed', async importOriginal => {
  const actual = await importOriginal<typeof import('../upstream/client/src/chat-embed')>();
  const { createElement } = await import('react');
  return { ...actual, ChatView: ({ state, onRespondToUi }: ComponentProps<typeof actual.ChatView>) =>
    createElement('section', null, state.interactiveRequests.map(request =>
      createElement('div', { key: request.requestId, 'data-status': request.status },
        createElement('button', { onClick: () => onRespondToUi?.(request.requestId,
          request.method === 'batch' ? { answers: [{ value: '0', codeflare: { optionIndexes: [0] }, notes: 'Keep this note', globalNote: 'Keep all context' }] } : 'yes') }, 'Answer'),
        createElement('button', { onClick: () => onRespondToUi?.(request.requestId, undefined, true) }, 'Cancel'),
      ))) };
});

let mounted: ReturnType<typeof mountChat> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (mounted) await act(() => mounted!.dispose());
  mounted = undefined; host?.remove(); vi.unstubAllGlobals();
});

describe('REQ-AGENT-224: live inline response protocol boundary', () => {
  for (const protocol of ['prompt', 'dialog'] as const) {
    for (const cancelled of [false, true]) {
      it(`${protocol} ${cancelled ? 'cancellation' : 'submission'} emits exactly its authorized wire response and settles the visible card`, async () => {
        let socket!: Wire;
        class Wire {
          static OPEN = 1;
          readyState = 1;
          onopen: (() => void) | null = null;
          onclose: (() => void) | null = null;
          onmessage: ((event: { data: string }) => void) | null = null;
          frames: unknown[] = [];
          constructor(_url: string) { socket = this; }
          send(data: string) { this.frames.push(JSON.parse(data)); }
          addEventListener() {} removeEventListener() {} close() {}
        }
        vi.stubGlobal('WebSocket', Wire);
        host = document.createElement('div'); document.body.append(host);
        await act(() => { mounted = mountChat(host, { sessionId: 'cf-primary', generation: 7, boundSessionId: 'bound-primary' }); });
        await act(() => { socket.onopen?.(); });
        const requestId = 'live-request';
        const notice = protocol === 'prompt'
          ? { type: 'prompt_request', sessionId: 'bound-primary', promptId: requestId,
              component: 'dashboard-default', placement: 'chat', prompt: { type: 'batch', question: 'Choose', metadata: { questions: [] } } }
          : { type: 'extension_ui_request', sessionId: 'bound-primary', requestId, method: 'select', params: { title: 'Choose', options: ['yes', 'no'] } };
        await act(() => { socket.onmessage?.({ data: JSON.stringify(notice) }); });
        const button = Array.from(host.querySelectorAll('button')).find(item => item.textContent === (cancelled ? 'Cancel' : 'Answer'))!;
        expect(button).toBeTruthy();
        await act(() => { button.click(); });
        const response = protocol === 'prompt'
          ? { type: 'prompt_response', sessionId: 'bound-primary', promptId: requestId, source: 'dashboard-default',
              ...(cancelled ? { cancelled: true } : { answer: JSON.stringify([{ value: '0', codeflare: { optionIndexes: [0] }, notes: 'Keep this note', globalNote: 'Keep all context' }]) }) }
          : { type: 'extension_ui_response', sessionId: 'bound-primary', requestId,
              ...(cancelled ? { cancelled: true } : { result: 'yes' }) };
        expect(socket.frames).toEqual([{ type: 'subscribe', sessionId: 'bound-primary', lastSeq: 0 }, response]);
        expect(host.querySelector('[data-status]')?.getAttribute('data-status')).toBe(cancelled ? 'cancelled' : 'resolved');
      });
    }
  }
});
