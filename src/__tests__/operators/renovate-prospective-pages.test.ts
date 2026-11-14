import { describe, expect, it, vi } from 'vitest';
import { listProspectiveRenovatePrs, resolveProspectiveRenovateRepository } from '../../operators/renovate-prospective';
import { createLogger, setLogLevel } from '../../lib/logger';
import { toError } from '../../lib/error-types';
import type { CurrentProspectiveRegistration } from '../../operators/registry';
import type { Env } from '../../types';
import type { RawCapture } from '../../operators/raw-capture-storage';
import type { RetainedRenovateRetryTarget } from '../../operators/renovate-retry-proof';

const root = 'https://api.github.com/repos/acme/updates';
const row = (number: number) => ({ number, state: 'open', created_at: '2026-09-28T00:00:00Z',
  user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' },
  draft: false, head: { sha: 'a'.repeat(40) }, base: { ref: 'trunk', sha: 'b'.repeat(40), repo: { id: 424242, full_name: 'acme/updates' } } });
const next = `${root}/pulls?state=open&per_page=100&page=2`;
type Page = { rows: unknown[]; link?: string } | Response;
function scanExports(pages: Page[], metadata: unknown = { id: 424242, full_name: 'acme/updates', default_branch: 'trunk' },
  onResponse: (request: Request) => void = () => {}) {
  return { GitHubInterceptor: () => ({ fetch: async (request: Request) => {
    const url = new URL(request.url);
    if (url.href === root) {
      const response = metadata instanceof Response ? metadata : Response.json(metadata);
      onResponse(request);
      return response;
    }
    const page = pages[Number(url.searchParams.get('page')) - 1];
    if (!page) throw Error('Unprovided external GitHub page');
    const response = page instanceof Response ? page : Response.json(page.rows, { headers: page.link ? { link: page.link } : {} });
    onResponse(request);
    return response;
  }, connect: () => { throw Error('Prospective GitHub reads do not open sockets'); } }) };
}
function scan(pages: Page[], metadata?: unknown, current: () => Promise<boolean> = async () => true,
  onResponse: (request: Request) => void = () => {}, retainedRetryTargets: RetainedRenovateRetryTarget[] = [], capture?: RawCapture) {
  return listProspectiveRenovatePrs({ env: {} as Env,
    registration: { bucket: 'owner', human: { email: 'owner@example.test' },
      activatedAt: '2026-09-27T00:00:00.000Z', repository: 'acme/updates', repositoryId: 424242, baseBranch: 'trunk',
      repetitionIntervalSeconds: 900 } as unknown as CurrentProspectiveRegistration,
    current, retainedRetryTargets, capture, exports: scanExports(pages, metadata, onResponse),
  });
}

describe('REQ-OPERATOR-061 AC2: prospective GitHub page completeness', () => {
  it('returns candidates from a complete terminal short page', async () => {
    expect(await scan([{ rows: [row(1)] }])).toMatchObject([{ repository: 'acme/updates', repositoryId: 424242, baseBranch: 'trunk',
      pullRequest: 1, head: 'a'.repeat(40), createdAt: '2026-09-28T00:00:00.000Z' }]);
  });
  it('reads all candidates through a valid fixed-origin continuation', async () => {
    const found = await scan([{ rows: Array.from({ length: 100 }, (_, index) => row(index + 1)),
      link: `<${next}>; rel="next"` }, { rows: [row(101)] }]);
    expect(found.map(item => item.pullRequest)).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
  });
  it('rejects a short page advertising more data instead of returning an incomplete candidate set', async () => {
    await expect(scan([{ rows: [row(1)], link: `<${next}>; rel="next"` }])).rejects.toThrow();
  });
  it.each([
    `<https://attacker.example/collect>; rel="next"`,
    `<${root}/pulls?state=open&per_page=100&page=1>; rel="next"`,
    `<${next}&page=3>; rel="next"`,
    `<${next}>; rel="next", <${next}>; rel="next"`,
    'malformed continuation',
  ])('rejects inconsistent continuation %s without admitting candidates', async link => {
    await expect(scan([{ rows: Array.from({ length: 100 }, (_, index) => row(index + 1)), link },
      { rows: [row(101)] }])).rejects.toThrow();
  });
});


describe('REQ-OPERATOR-061: configured Renovate run settings', () => {
  it.each([{ id: 1, full_name: 'acme/updates', default_branch: 'trunk' },
    { id: 424242, full_name: 'acme/renamed', default_branch: 'trunk' },
    { id: 424242, full_name: 'acme/updates', default_branch: 'main' },
    { id: '424242', full_name: 'acme/updates', default_branch: 'trunk' },
    new Response(null, { status: 302, headers: { location: 'https://attacker.example' } })])
    ('rejects changed or redirected registered metadata %j without returning partial observations', async metadata => {
      await expect(scan([{ rows: [row(1)] }], metadata)).rejects.toThrow();
    });
  it('observes only the exact bot, registered base repository and default branch after cutoff including offline arrivals', async () => {
    const valid = row(1);
    const rows = [valid, { ...row(2), created_at: '2026-09-27T00:00:00Z' },
      { ...row(3), created_at: '2026-09-26T00:00:00Z' }, { ...row(4), draft: true },
      { ...row(5), user: { ...valid.user, id: 1 } },
      { ...row(6), base: { ...valid.base, ref: 'main' } },
      { ...row(7), base: { ...valid.base, repo: { id: 1, full_name: 'acme/updates' } } },
      { ...row(8), base: { ...valid.base, repo: { id: 424242, full_name: 'other/repo' } } }];
    expect((await scan([{ rows }])).map(value => value.pullRequest)).toEqual([1]);
  });
  it('denies an entire observation when current authority changes after protected I/O', async () => {
    let authorized = true;
    await expect(scan([{ rows: [row(1)] }], undefined, async () => authorized, request => {
      if (new URL(request.url).pathname.endsWith('/pulls')) authorized = false;
    })).rejects.toThrow();
  });
  it('preserves the ten-page bound rather than accepting an incomplete large scan', async () => {
    await expect(scan(Array.from({ length: 10 }, () => ({ rows: Array.from({ length: 100 }, (_, i) => row(i + 1)) }))))
      .rejects.toThrow();
  });
});

describe('REQ-OPERATOR-061 AC2: retained failures never bypass the original cutoff', () => {
  const retained = { repositoryId: 424242, pullRequest: 2, head: 'a'.repeat(40), createdAt: '2026-09-26T00:00:00.000Z' };
  const old = { ...row(2), created_at: retained.createdAt };
  it('refuses a retained pre-cutoff head alongside ordinary stale or foreign candidates', async () => {
    const candidates = await scan([{ rows: [row(1), old,
      { ...old, number: 3 }, { ...old, head: { sha: 'b'.repeat(40) } },
      { ...old, draft: true }, { ...old, user: { ...old.user, id: 1 } },
      { ...old, base: { ...old.base, ref: 'main' } },
      { ...old, base: { ...old.base, repo: { id: 1, full_name: 'acme/updates' } } }] }],
      undefined, undefined, undefined, [retained]);
    expect(candidates.map(value => [value.pullRequest, value.head])).toEqual([[1, 'a'.repeat(40)]]);
  });
  it('does not admit a retained target absent from the complete authenticated open-PR observation', async () => {
    expect(await scan([{ rows: [] }], undefined, undefined, undefined, [retained])).toEqual([]);
  });
  it('refuses retained failures in an incomplete observation', async () => {
    await expect(scan([{ rows: [old], link: `<${next}>; rel="next"` }],
      undefined, undefined, undefined, [retained])).rejects.toThrow();
  });
});

describe('REQ-OPERATOR-063 AC1/5/6: discovery cause retention', () => {
  const resolve = (response: Response) => resolveProspectiveRenovateRepository({ env: {} as Env,
    exports: scanExports([], response), repository: 'acme/updates', human: { email: 'owner@example.test' },
    bucket: 'owner', current: async () => true });
  const bodyResponse = (body: string | Uint8Array) => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(typeof body === 'string' ? new TextEncoder().encode(body) : body); controller.close(); },
  }));
  // Rejection, not an empty/partial candidate set or repository identity, is the public outcome.
  async function unavailable(result: Promise<unknown>): Promise<Error> {
    await expect(result).rejects.toBeInstanceOf(Error);
    const failure: unknown = await result.catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'Error', message: 'Renovate page unavailable' });
    return failure as Error;
  }

  it.each(['repository metadata', 'later PR page'] as const)(
    'retains the identical stream rejection behind the generic error for %s without partial results', async path => {
      const original = Error('SYNTHETIC_STREAM_SECRET Authorization=synthetic-token owner@synthetic.test');
      const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } }));
      const result = path === 'repository metadata' ? resolve(response)
        : scan([{ rows: Array.from({ length: 100 }, (_, index) => row(index + 1)), link: `<${next}>; rel="next"` }, response]);
      expect((await unavailable(result)).cause).toBe(original);
    });

  it('retains the fatal UTF-8 decoder TypeError without returning PR candidates', async () => {
    const failure = await unavailable(scan([bodyResponse(new Uint8Array([0x5b, 0xff, 0x5d]))]));
    expect(failure.cause).toBeInstanceOf(TypeError);
  });

  it.each([
    ['metadata', '{"secret":"SYNTHETIC_JSON_SECRET Authorization=synthetic-token owner@synthetic.test",!}'],
    ['PR page', '[{"secret":"SYNTHETIC_JSON_SECRET Authorization=synthetic-token owner@synthetic.test"'],
  ] as const)('retains a SyntaxError for malformed or truncated %s JSON without partial observations', async (path, body) => {
    const response = bodyResponse(body);
    const failure = await unavailable(path === 'metadata' ? scan([{ rows: [row(1)] }], response) : scan([response]));
    expect(failure.cause).toBeInstanceOf(SyntaxError);
  });

  it('retains the byte-bound cause above 2 MiB without returning candidates', async () => {
    const body = JSON.stringify([row(1)]).padEnd(2 * 1024 * 1024 + 1, ' ');
    const failure = await unavailable(scan([bodyResponse(body)]));
    expect(failure.cause).toBeInstanceOf(Error);
    expect(failure.cause).toMatchObject({ message: 'Renovate page exceeds byte bound' });
  });

  it('still accepts valid JSON padded to exactly 2 MiB', async () => {
    const body = JSON.stringify([row(1)]).padEnd(2 * 1024 * 1024, ' ');
    expect(await scan([bodyResponse(body)])).toEqual([{ repository: 'acme/updates', repositoryId: 424242, baseBranch: 'trunk',
      pullRequest: 1, head: 'a'.repeat(40), createdAt: '2026-09-28T00:00:00.000Z' }]);
  });

  it.each(['malformed JSON', 'secret-bearing stream Error'] as const)(
    'the production error formatter omits retained %s and its cause from unexpected-error logs', async fault => {
      const privateValues = ['SYNTHETIC_FORMATTER_SECRET', 'Authorization', 'synthetic-token', 'owner@synthetic.test'];
      const original = Error(privateValues.join(' '));
      const response = fault === 'malformed JSON' ? bodyResponse(`{"secret":"${privateValues.join(' ')}",!}`)
        : new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } }));
      const failure = await unavailable(resolve(response));
      if (fault === 'malformed JSON') expect(failure.cause).toBeInstanceOf(SyntaxError);
      else expect(failure.cause).toBe(original);
      expect(toError(failure)).toBe(failure);
      const outputs: string[] = [];
      const output = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { outputs.push(String(line)); });
      setLogLevel('error');
      try {
        // Exercise index.ts's actual formatter components, not Hono's default console inspection.
        createLogger('index').error('Unexpected error', toError(failure), { requestId: 'synthetic-request-id' });
        expect(outputs.map(line => JSON.parse(line))).toEqual([expect.objectContaining({
          message: 'Unexpected error', data: { requestId: 'synthetic-request-id' },
          error: { name: 'Error', message: 'Renovate page unavailable', stack: expect.any(String) },
        })]);
        for (const value of privateValues) expect(outputs.join('\n')).not.toContain(value);
      } finally { output.mockRestore(); setLogLevel('silent'); }
    });
});

describe('REQ-OPERATOR-090 AC4/5: parent-owned discovery raw capture', () => {
  type Event = { stage: string; value: Record<string, unknown> };
  const pageUrl = `${root}/pulls?state=open&per_page=100&page=1`;
  const encode = (text: string) => new TextEncoder().encode(text);
  function collector() {
    const events: Event[] = [];
    let finished = false;
    const capture: RawCapture = {
      record(stage, value) { events.push({ stage, value: value() as Record<string, unknown> }); },
      async finish(termination) {
        finished = true;
        return { status: 'complete', captureId: 'test-observation', records: events.length, segments: 0, bytes: 0, termination };
      },
    };
    return { capture, events, get finished() { return finished; } };
  }
  const capturedScan = (pages: Page[], capture?: RawCapture, metadata?: unknown) =>
    scan(pages, metadata, undefined, undefined, undefined, capture);
  const resolve = (response: Response, capture?: RawCapture) => resolveProspectiveRenovateRepository({
    env: {} as Env, exports: scanExports([], response), repository: 'acme/updates',
    human: { email: 'owner@example.test' }, bucket: 'owner', current: async () => true, capture,
  });
  function responseBytes(bytes: Uint8Array, width = 8191): Response {
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) { controller.close(); return; }
        const end = Math.min(bytes.length, offset + width);
        controller.enqueue(bytes.slice(offset, end)); offset = end;
      },
    }, { highWaterMark: 0 }));
  }
  function reassemble(events: Event[], url: string): Uint8Array {
    const chunks = events.filter(event => event.stage === 'discovery-response-chunk' && event.value.url === url);
    const length = chunks.reduce((size, event) => size + (event.value.bytes as number[]).length, 0);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const event of chunks) {
      expect(event.value).toMatchObject({ method: 'GET', url, path: new URL(url).href.slice(root.length), offset });
      const chunk = event.value.bytes as number[];
      bytes.set(chunk, offset); offset += chunk.length;
    }
    return bytes;
  }
  async function failure(result: Promise<unknown>, message = 'Renovate page unavailable'): Promise<Error> {
    await expect(result).rejects.toMatchObject({ name: 'Error', message });
    return await result.catch((error: unknown) => error) as Error;
  }
  const errors = (events: Event[], url: string) => events.filter(event =>
    event.stage === 'discovery-response-error' && event.value.url === url).map(event => event.value.error);

  it('retains more than 256 KiB of multi-chunk Unicode bytes through EOF without changing candidates or finishing the session', async () => {
    const bytes = encode(JSON.stringify([{ ...row(1), evidence: '漢🎉☃'.repeat(40000) }]));
    expect(bytes.byteLength).toBeGreaterThan(256 * 1024);
    const recorded = collector();
    expect((await capturedScan([responseBytes(bytes)], recorded.capture)).map(candidate => candidate.pullRequest)).toEqual([1]);
    expect(reassemble(recorded.events, pageUrl)).toEqual(bytes);
    expect(recorded.events.filter(event => event.stage === 'discovery-response-eof').map(event => event.value))
      .toEqual([expect.objectContaining({ url: root }), expect.objectContaining({ url: pageUrl, offset: bytes.length })]);
    expect(recorded.events.some(event => event.stage === 'discovery-response-cancel' || event.stage === 'discovery-response-error')).toBe(false);
    expect(recorded.finished).toBe(false);
  });

  it('retains distinct original URLs, headers and contiguous byte coverage for metadata and every PR page', async () => {
    const recorded = collector();
    const metadata = encode(JSON.stringify({ id: 424242, full_name: 'acme/updates', default_branch: 'trunk' }));
    const first = encode(JSON.stringify(Array.from({ length: 100 }, (_, index) => row(index + 1))));
    const second = encode(JSON.stringify([row(101)]));
    const metadataResponse = responseBytes(metadata), firstResponse = responseBytes(first), secondResponse = responseBytes(second);
    firstResponse.headers.set('link', `<${next}>; rel="next"`);
    firstResponse.headers.set('x-synthetic-evidence', 'literal-placeholder');
    const candidates = await capturedScan([firstResponse, secondResponse], recorded.capture, metadataResponse);
    expect(candidates.map(candidate => candidate.pullRequest)).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
    expect(recorded.events.filter(event => event.stage === 'discovery-request').map(event => event.value))
      .toEqual([root, pageUrl, next].map(url => expect.objectContaining({ method: 'GET', url,
        path: url.slice(root.length), redirect: 'manual', headers: expect.arrayContaining([
          ['accept', 'application/vnd.github+json'], ['user-agent', 'Codeflare-Operator-Renovate'],
        ]) })));
    expect(recorded.events.filter(event => event.stage === 'discovery-response').map(event => event.value))
      .toEqual(([[root, metadataResponse], [pageUrl, firstResponse], [next, secondResponse]] as const).map(([url, response]) =>
        expect.objectContaining({ method: 'GET', url, status: response.status, statusText: response.statusText,
          ok: response.ok, redirected: response.redirected, type: response.type, responseUrl: response.url, bodyUsed: false })));
    expect(recorded.events.find(event => event.stage === 'discovery-response' && event.value.url === pageUrl)?.value.headers)
      .toEqual(expect.arrayContaining([['link', `<${next}>; rel="next"`], ['x-synthetic-evidence', 'literal-placeholder']]));
    for (const [url, bytes] of [[root, metadata], [pageUrl, first], [next, second]] as const) {
      expect(reassemble(recorded.events, url)).toEqual(bytes);
      expect(recorded.events.filter(event => event.stage === 'discovery-response-eof' && event.value.url === url)
        .map(event => event.value.offset)).toEqual([bytes.length]);
    }
    expect(recorded.finished).toBe(false);
  });

  it.each(['UTF-8', 'JSON', 'oversize'] as const)(
    'captures the exact delivered %s failure bytes and original error before refusing all candidates', async fault => {
      const bytes = fault === 'UTF-8' ? new Uint8Array([0x5b, 0xff, 0x00, 0x5d])
        : fault === 'JSON' ? encode('[{"synthetic":"漢🎉",!}')
        : encode(JSON.stringify([row(1)]).padEnd(2 * 1024 * 1024 + 1, ' '));
      const recorded = collector();
      // One delivered oversize chunk must be captured in full, including bytes above the functional bound.
      const error = await failure(capturedScan([responseBytes(bytes, bytes.length)], recorded.capture));
      expect(reassemble(recorded.events, pageUrl)).toEqual(bytes);
      expect(errors(recorded.events, pageUrl)).toEqual([error.cause]);
      expect(errors(recorded.events, pageUrl)[0]).toBe(error.cause);
      if (fault === 'UTF-8') expect(error.cause).toBeInstanceOf(TypeError);
      else if (fault === 'JSON') expect(error.cause).toBeInstanceOf(SyntaxError);
      else expect(error.cause).toMatchObject({ message: 'Renovate page exceeds byte bound' });
      const eof = recorded.events.filter(event => event.stage === 'discovery-response-eof' && event.value.url === pageUrl);
      expect(eof.map(event => event.value.offset)).toEqual(fault === 'JSON' ? [bytes.length] : []);
      const cancellations = recorded.events.filter(event => event.stage === 'discovery-response-cancel' && event.value.url === pageUrl);
      expect(cancellations.map(event => event.value)).toEqual(fault === 'JSON' ? [] : [expect.objectContaining({
        offset: bytes.length, eof: false, reason: undefined, observedError: error.cause,
      })]);
    });

  it('retains the identical rejection, nested cause and preceding binary bytes without claiming EOF', async () => {
    const recorded = collector();
    const original = Error('synthetic private stream error', { cause: Error('synthetic nested cause') });
    const bytes = encode('[{"evidence":"漢🎉');
    let delivered = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (delivered) controller.error(original);
        else { controller.enqueue(bytes); delivered = true; }
      },
    }, { highWaterMark: 0 }));
    const error = await failure(capturedScan([response], recorded.capture));
    expect(error.cause).toBe(original);
    expect(errors(recorded.events, pageUrl)).toEqual([original]);
    expect((errors(recorded.events, pageUrl)[0] as Error).cause).toBe(original.cause);
    expect(reassemble(recorded.events, pageUrl)).toEqual(bytes);
    expect(recorded.events.some(event => event.stage === 'discovery-response-eof' && event.value.url === pageUrl)).toBe(false);
    expect(recorded.finished).toBe(false);
  });

  it('retains pre-header fetch failures unchanged and does not fabricate a response or EOF', async () => {
    const recorded = collector();
    const original = Error('synthetic fetch failure', { cause: Error('synthetic transport cause') });
    const exports = { GitHubInterceptor: () => ({
      fetch: async () => { throw original; }, connect: () => { throw Error('No sockets'); },
    }) };
    const result = resolveProspectiveRenovateRepository({ env: {} as Env, exports,
      repository: 'acme/updates', human: { email: 'owner@example.test' }, bucket: 'owner',
      current: async () => true, capture: recorded.capture });
    await expect(result).rejects.toBe(original);
    expect(errors(recorded.events, root)).toEqual([original]);
    expect(recorded.events.map(event => event.stage)).toEqual(['discovery-request', 'discovery-response-error']);
    expect(recorded.events[0].value).toMatchObject({ method: 'GET', url: root, path: '', redirect: 'manual' });
  });

  it('captures manual redirect metadata while refusing to read or follow its body', async () => {
    const recorded = collector();
    let cancelled = false, consumed = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { consumed = true; controller.enqueue(encode('unread redirect')); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status: 302, statusText: 'Found', headers: {
      location: 'https://attacker.example/collect', 'x-synthetic-evidence': 'literal-placeholder',
    } });
    const error = await failure(resolve(response, recorded.capture), 'Incomplete Renovate scan');
    expect(recorded.events.find(event => event.stage === 'discovery-response')?.value).toMatchObject({
      method: 'GET', url: root, path: '', status: 302, statusText: 'Found', ok: false,
      headers: expect.arrayContaining([['location', 'https://attacker.example/collect'], ['x-synthetic-evidence', 'literal-placeholder']]),
    });
    expect(errors(recorded.events, root)).toEqual([error]);
    expect(recorded.events.some(event => ['discovery-response-chunk', 'discovery-response-eof', 'discovery-response-cancel'].includes(event.stage))).toBe(false);
    expect({ consumed, cancelled, locked: response.body!.locked }).toEqual({ consumed: false, cancelled: false, locked: false });
  });

  it.each(['UTF-8', 'oversize'] as const)(
    'preserves early %s cancellation reason, releases the reader and never reads ahead into an unobserved tail', async fault => {
      const recorded = collector();
      const prefix = fault === 'UTF-8' ? new Uint8Array([0xff, 0x00]) : new Uint8Array(2 * 1024 * 1024 + 1);
      const cancellations: unknown[] = [];
      const cancellation: { settle?: () => void } = {};
      let prefixDelivered = false, tailConsumed = false;
      const response = new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (prefixDelivered) { tailConsumed = true; controller.enqueue(encode('unobserved tail')); }
          else { prefixDelivered = true; controller.enqueue(prefix); }
        },
        cancel(reason) {
          cancellations.push(reason);
          return new Promise<void>(resolve => { cancellation.settle = resolve; });
        },
      }, { highWaterMark: 0 }));
      // The original refusal and lock release must not wait for upstream cancellation to settle.
      const error = await failure(capturedScan([response], recorded.capture));
      cancellation.settle?.();
      expect(tailConsumed).toBe(false);
      expect(cancellations).toEqual([undefined]);
      expect(response.body!.locked).toBe(false);
      expect(reassemble(recorded.events, pageUrl)).toEqual(prefix);
      expect(recorded.events.filter(event => event.stage === 'discovery-response-cancel' && event.value.url === pageUrl)
        .map(event => event.value)).toEqual([expect.objectContaining({ reason: cancellations[0], observedError: error.cause,
        offset: prefix.length, eof: false })]);
    });

  it.each(['null body', 'locked body'] as const)('captures %s failure with its unchanged outward semantics', async fault => {
    const recorded = collector();
    const response = fault === 'null body' ? new Response(null) : responseBytes(encode('{}'));
    const lock = fault === 'locked body' ? response.body!.getReader() : undefined;
    try {
      const result = resolve(response, recorded.capture);
      await expect(result).rejects.toBeInstanceOf(fault === 'null body' ? Error : TypeError);
      const error = await result.catch((value: unknown) => value);
      expect(errors(recorded.events, root)).toEqual([error]);
      if (fault === 'null body') {
        expect(error).toMatchObject({ message: 'Renovate page unavailable' });
        expect((error as Error).cause).toBeUndefined();
      }
      expect(recorded.events.some(event => event.stage === 'discovery-response-chunk' || event.stage === 'discovery-response-eof')).toBe(false);
    } finally { lock?.releaseLock(); }
  });

  it.each(['metadata schema', 'PR schema', 'link'] as const)('retains the original %s refusal after complete observed bytes', async fault => {
    const recorded = collector();
    const result = fault === 'metadata schema'
      ? resolve(responseBytes(encode('{"id":"wrong"}')), recorded.capture)
      : capturedScan(fault === 'PR schema' ? [{ rows: [{ ...row(1), number: 'wrong' }] }]
        : [{ rows: [row(1)], link: 'malformed continuation' }], recorded.capture);
    const error = await failure(result, fault === 'metadata schema' ? 'Renovate repository identity changed' : 'Incomplete Renovate scan');
    const url = fault === 'metadata schema' ? root : pageUrl;
    expect(errors(recorded.events, url)).toEqual([error]);
    expect(reassemble(recorded.events, url).length).toBeGreaterThan(0);
    expect(recorded.events.some(event => event.stage === 'discovery-response-eof' && event.value.url === url)).toBe(true);
  });

  it('never executes application metadata accessors or discards body evidence because a field is inaccessible', async () => {
    for (const enabled of [false, true]) {
      let observed = false;
      const recorded = collector();
      const bytes = encode(JSON.stringify([row(1)]));
      const response = new Response(bytes);
      Object.defineProperty(response, 'statusText', {
        get() { observed = true; throw Error('synthetic metadata inspection failure'); },
      });
      expect((await capturedScan([response], enabled ? recorded.capture : undefined)).map(candidate => candidate.pullRequest)).toEqual([1]);
      expect(observed).toBe(false);
      if (enabled) {
        expect(recorded.events.find(event => event.stage === 'discovery-response' && event.value.url === pageUrl)?.value.statusText)
          .toEqual({ captureUnavailable: 'application-accessor' });
        expect(reassemble(recorded.events, pageUrl)).toEqual(bytes);
      } else expect(recorded.events).toEqual([]);
      expect(response.body!.locked).toBe(false);
    }
  });

  it('does not add a functional status read through an application-owned response accessor', async () => {
    const recorded = collector();
    const response = new Response(JSON.stringify([row(1)]));
    let nextStatus = 200;
    Object.defineProperty(response, 'status', { get() { const status = nextStatus; nextStatus = 503; return status; } });
    expect((await capturedScan([response], recorded.capture)).map(candidate => candidate.pullRequest)).toEqual([1]);
    expect(recorded.events.find(event => event.stage === 'discovery-response' && event.value.url === pageUrl)?.value.status)
      .toEqual({ captureUnavailable: 'application-accessor' });
  });

  it('leaves capture absent by default and preserves success and original failures even when record throws', async () => {
    const broken: RawCapture = { record() { throw Error('synthetic capture failure'); },
      async finish() { throw Error('Only the parent may finish capture'); } };
    const bytes = encode(JSON.stringify([row(1)]));
    const ordinary = await capturedScan([responseBytes(bytes)]);
    expect(await capturedScan([responseBytes(bytes)], broken)).toEqual(ordinary);
    const original = Error('synthetic original stream failure');
    const rejecting = () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } }));
    for (const capture of [undefined, broken]) {
      const error = await failure(capturedScan([rejecting()], capture));
      expect(error.cause).toBe(original);
    }
  });
});
