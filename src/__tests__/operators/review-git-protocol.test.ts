import { describe, expect, it } from 'vitest';
import { createReviewPushObserver } from '../../operators/review-git-protocol';

const oldHead = 'a'.repeat(40);
const newHead = 'b'.repeat(40);
const branch = 'refs/heads/develop';
const encoder = new TextEncoder();
const packet = (text: string) => `${(encoder.encode(text).length + 4).toString(16).padStart(4, '0')}${text}`;
const request = (capabilities = 'report-status side-band-64k') => packet(`${oldHead} ${newHead} ${branch}\0${capabilities}\n`) + '0000';
const status = (ref = branch) => packet('unpack ok\n') + packet(`ok ${ref}\n`) + '0000';
const sideband = (channel: number, text: string) => packet(`${String.fromCharCode(channel)}${text}`) + '0000';
const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({
  start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
});
const collect = async (source: ReadableStream<Uint8Array>) => {
  const reader = source.getReader(); const chunks: Uint8Array[] = [];
  for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); }
  return chunks.map(chunk => new TextDecoder().decode(chunk)).join('');
};
async function exchange(upload: string, reply: string) {
  const observer = createReviewPushObserver();
  expect(await collect(observer.wrapUpload(stream([upload.slice(0, 3), upload.slice(3)])))).toBe(upload);
  expect(await collect(observer.wrapDownload(stream([reply.slice(0, 7), reply.slice(7)])))).toBe(reply);
  return observer.result;
}

describe('REQ-OPERATOR-053: inline Git receive-pack evidence without replaying the packfile', () => {
  it('confirms only a complete requested ref/new-SHA acknowledgement with matching sideband negotiation', async () => {
    expect(await exchange(request(), sideband(1, status()))).toEqual({ ref: branch, head: newHead });
    expect(await exchange(request('report-status'), status())).toEqual({ ref: branch, head: newHead });
    expect(await exchange(request('report-status-v2 side-band-64k'), sideband(1, status())))
      .toEqual({ ref: branch, head: newHead });
  });
  it('never treats HTTP success, unpack-only, ref rejection, wrong ref, fatal channel or truncated status as an update', async () => {
    for (const reply of [packet('unpack ok\n') + '0000',
      packet('unpack ok\n') + packet(`ng ${branch} protected\n`) + '0000',
      sideband(1, status('refs/heads/main')), sideband(3, 'remote: rejected\n'),
      sideband(1, status()).slice(0, -3)]) {
      expect(await exchange(request(), reply)).toBeNull();
    }
  });
  it('rejects unnegotiated framing, missing report status and ambiguous multi-ref commands', async () => {
    expect(await exchange(request('report-status'), sideband(1, status()))).toBeNull();
    expect(await exchange(request('side-band-64k'), sideband(1, status()))).toBeNull();
    const multiple = packet(`${oldHead} ${newHead} ${branch}\0report-status side-band-64k\n`)
      + packet(`${oldHead} ${'c'.repeat(40)} refs/heads/main\n`) + '0000';
    expect(await exchange(multiple, sideband(1, status()))).toBeNull();
  });
  it('forwards a large opaque packfile intact after bounded command parsing and does not read the response early', async () => {
    const observer = createReviewPushObserver();
    const pack = 'PACK' + 'z'.repeat(256_000);
    const upload = request() + pack;
    expect(await collect(observer.wrapUpload(stream([request().slice(0, 2), upload.slice(2)])))).toBe(upload);
    const reply = sideband(1, status());
    expect(await collect(observer.wrapDownload(stream([reply])))).toBe(reply);
    expect(await observer.result).toEqual({ ref: branch, head: newHead });
  });
  it('treats a cancelled response as unknown, without blocking the forwarded stream', async () => {
    const observer = createReviewPushObserver();
    await collect(observer.wrapUpload(stream([request()])));
    const response = observer.wrapDownload(new ReadableStream<Uint8Array>({ pull(controller) {
      controller.enqueue(encoder.encode(sideband(1, status()).slice(0, 8)));
    } }));
    const reader = response.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    expect(await observer.result).toBeNull();
  });
});
