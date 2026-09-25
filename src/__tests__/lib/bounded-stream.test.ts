import { describe, expect, it } from 'vitest';
import { readBoundedResponse } from '../../lib/bounded-stream';

describe('bounded protected response reads', () => {
  it('rejects a stalled body on drive abort rather than accepting a late completion', async () => {
    const drive = new AbortController();
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }));
    const reading = readBoundedResponse(response, 1024, 'Protected input', drive.signal);
    drive.abort();
    const bounded = Promise.race([reading, new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Stalled read was not aborted')), 1_000);
    })]);
    await expect(bounded).rejects.toThrow('aborted');
    expect(cancelled).toBe(true);
  });
});
