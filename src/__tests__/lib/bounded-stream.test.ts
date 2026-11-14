import { describe, expect, it } from 'vitest';
import { readBoundedResponse, type BoundedStreamObservation } from '../../lib/bounded-stream';

describe('bounded protected response reads', () => {
  it('REQ-OPERATOR-090: captures exact delivered bytes through EOF without allowing observation to mutate the functional response', async () => {
    const source = new TextEncoder().encode('漢🦊SECRET_SHAPED_VALUE');
    const events: BoundedStreamObservation[] = [];
    const delivered: Uint8Array[] = [];
    const result = await readBoundedResponse(new Response(source), 1024, 'Protected input', undefined, event => {
      events.push(event);
      if (event.type === 'chunk') { delivered.push(event.bytes.slice()); event.bytes.fill(0); }
    });
    expect(delivered).toEqual([source]);
    expect(result).toEqual(source);
    expect(events.find(event => event.type === 'eof')).toEqual({ type: 'eof', bytes: source.length });
  });

  it('REQ-OPERATOR-090: retains the complete delivered oversize chunk before the unchanged refusal and cancellation', async () => {
    const source = new Uint8Array(2050).fill(73);
    const events: BoundedStreamObservation[] = [];
    const cancelled: unknown[] = [];
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(source); }, cancel(reason) { cancelled.push(reason); },
    }, { highWaterMark: 0 }));
    await expect(readBoundedResponse(response, 1024, 'Protected input', undefined, event => { events.push(event); }))
      .rejects.toThrow('Protected input exceeds 1024 bytes');
    expect(events.find(event => event.type === 'chunk')).toEqual({ type: 'chunk', offset: 0, bytes: source });
    expect(events.some(event => event.type === 'eof')).toBe(false);
    expect(cancelled).toEqual(['Protected input exceeds 1024 bytes']);
    expect(events.find(event => event.type === 'cancel')).toEqual({ type: 'cancel', reason: cancelled[0] });
  });

  it('REQ-OPERATOR-090/082: original stream rejection survives observer failure with its complete cause', async () => {
    const original = new Error('SYNTHETIC_READ_ERROR', { cause: new Error('SYNTHETIC_READ_CAUSE') });
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } }));
    const events: BoundedStreamObservation[] = [];
    await expect(readBoundedResponse(response, 1024, 'Protected input', undefined, event => {
      events.push(event); throw new Error('SYNTHETIC_OBSERVER_FAILURE');
    })).rejects.toBe(original);
    expect(events).toEqual([{ type: 'error', error: original }]);
  });

  it('rejects a stalled body on drive abort rather than accepting a late completion', async () => {
    const drive = new AbortController();
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }));
    const reading = readBoundedResponse(response, 1024, 'Protected input', drive.signal);
    drive.abort();
    const bounded = Promise.race([reading, new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Stalled read timed out')), 1_000);
    })]);
    await expect(bounded).rejects.toThrow('aborted');
    expect(cancelled).toBe(true);
  });
});
