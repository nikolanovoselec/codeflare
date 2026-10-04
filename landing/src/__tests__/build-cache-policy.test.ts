import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

type Policy = { storable(): boolean; timeToLive(): number };
type Request = { url: string; method: string; headers: Record<string, string> };
type Response = { status: number; headers: Record<string, string> };
let CachePolicy: new (request: Request, response: Response) => Policy;
let installedMetadata: { name: string; private?: boolean };

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const astroRequire = createRequire(require.resolve('astro'));
  const entrypoint = astroRequire.resolve('http-cache-semantics');
  installedMetadata = JSON.parse(readFileSync(join(dirname(entrypoint), 'package.json'), 'utf8'));
  CachePolicy = (await import(/* @vite-ignore */ pathToFileURL(entrypoint).href)).default;
});

// Public dependency contract: Astro's build-image policy never grants freshness.
describe('REQ-LANDING-016: build-image policy fails closed', () => {
  const cases: Array<[string, Record<string, string>, Record<string, string>]> = [
    ['empty headers', {}, {}],
    ['explicit no-cache', {}, { 'cache-control': 'no-cache' }],
    ['conditional GET', { 'if-none-match': '"prior-image"', 'if-modified-since': 'Thu, 01 Jan 1970 00:00:00 GMT', 'cache-control': 'no-cache' }, { 'cache-control': 'public, max-age=3600' }],
    ['public max-age', {}, { 'cache-control': 'public, max-age=3600' }],
    ['shared s-maxage', {}, { 'cache-control': 'public, s-maxage=3600' }],
    ['cookie-bearing response', { 'cache-control': 'max-stale=86400' }, { 'set-cookie': 'session=other-user', 'cache-control': 'max-age=3600' }],
    ['proxy revalidation', { 'cache-control': 'max-stale=86400' }, { 'cache-control': 'max-age=3600, proxy-revalidate' }],
    ['stale extensions', { 'cache-control': 'max-stale' }, { 'cache-control': 'max-age=3600, stale-while-revalidate=86400, stale-if-error=86400' }],
    ['private response', { authorization: 'Bearer test-user' }, { 'cache-control': 'private, max-age=3600' }],
    ['explicit no-store', {}, { 'cache-control': 'no-store' }],
    ['wildcard vary', {}, { vary: '*', 'cache-control': 'public, max-age=3600' }],
  ];

  it('REQ-LANDING-016: installed and locked dependency identities are the genuine private replacement', () => {
    // Intentional dependency-artifact security identity, not a release/version pin.
    expect(installedMetadata.name).toBe('@codeflare/astro-build-cache-policy');
    expect(installedMetadata.private).toBe(true);
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    const edge = lock.packages['node_modules/http-cache-semantics'];
    const actual = edge.link ? lock.packages[edge.resolved] : edge;
    expect(actual.name).toBe(installedMetadata.name);
  });

  it.each(cases)('REQ-LANDING-016: does not make %s reusable', (_, requestHeaders, responseHeaders) => {
    const policy = new CachePolicy(
      { url: 'https://images.example.test/image.png', method: 'GET', headers: requestHeaders },
      { status: 200, headers: responseHeaders },
    );
    expect(policy.storable()).toBe(false);
    expect(policy.timeToLive()).toBe(0);
  });
});
