/** Deterministic GitHub REST/release/Actions wire fixtures; no acquisition implementation is mocked. */
const encoder = new TextEncoder();
const sourceCommit = 'a'.repeat(40);
const repositoryId = 417;
const workflowId = 9;
const runId = 701;
const artifactId = 801;

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** ZIP's stored-file wire format, with CRC32 and central directory (no compression dependency). */
function archive(files: Array<{ name: string; bytes: Uint8Array }>): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    let crc = 0xffffffff;
    for (const byte of file.bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const entry = new Uint8Array(30 + name.length + file.bytes.length);
    const header = new DataView(entry.buffer);
    header.setUint32(0, 0x04034b50, true); header.setUint16(4, 20, true);
    header.setUint32(14, crc, true); header.setUint32(18, file.bytes.length, true);
    header.setUint32(22, file.bytes.length, true); header.setUint16(26, name.length, true);
    entry.set(name, 30); entry.set(file.bytes, 30 + name.length);
    const index = new Uint8Array(46 + name.length);
    const directory = new DataView(index.buffer);
    directory.setUint32(0, 0x02014b50, true); directory.setUint16(4, 20, true); directory.setUint16(6, 20, true);
    directory.setUint32(16, crc, true); directory.setUint32(20, file.bytes.length, true);
    directory.setUint32(24, file.bytes.length, true); directory.setUint16(28, name.length, true);
    directory.setUint32(42, offset, true); index.set(name, 46);
    local.push(entry); central.push(index); offset += entry.length;
  }
  const directorySize = central.reduce((size, entry) => size + entry.length, 0);
  const end = new Uint8Array(22);
  const ending = new DataView(end.buffer);
  ending.setUint32(0, 0x06054b50, true); ending.setUint16(8, files.length, true);
  ending.setUint16(10, files.length, true); ending.setUint32(12, directorySize, true); ending.setUint32(16, offset, true);
  const output = new Uint8Array(offset + directorySize + end.length);
  let position = 0;
  for (const part of [...local, ...central, end]) { output.set(part, position); position += part.length; }
  return output;
}

export type GitHubFixtureFault = 'provenance-repository' | 'provenance-compiler' | 'mutable-release' | 'failed-run' | 'build-bytes' | 'unsafe-redirect';

export async function createOperatorGitHubFixture(options: {
  fault?: GitHubFixtureFault; repositoryName?: string; useCdn?: boolean;
  artifactCdnHost?: 'productionresultssa1.blob.core.windows.net' | 'productionresultssa3.blob.core.windows.net'
    | 'productionresultssa8.blob.core.windows.net' | 'productionresultssa16.blob.core.windows.net';
  profile?: 'conductor' | 'dispatcher'; dispatcherSourceMismatch?: boolean; requiredCapabilities?: string[];
  omitCompilerCommit?: boolean;
} = {}) {
  const repositoryName = options.repositoryName ?? 'review-operator';
  const repository = { id: repositoryId, full_name: `acme/${repositoryName}`,
    html_url: `https://github.com/acme/${repositoryName}`, default_branch: 'main' };
  const bundle = encoder.encode(JSON.stringify(options.profile === 'dispatcher' ? {
    schemaVersion: 1, sourceCommit: options.dispatcherSourceMismatch ? 'b'.repeat(40) : sourceCommit,
    versions: { runtime: '2.1.0', vitePlugin: '2.1.0', agents: '0.20.1' },
    className: 'FlueDispatcherAgent', compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'],
    mainModule: 'index.js', modules: { 'index.js': { js: 'export class FlueDispatcherAgent {}' } },
  } : { schemaVersion: 1, interfaceVersion: 1,
    compatibilityDate: '2026-02-05', compatibilityFlags: ['nodejs_compat'], mainModule: 'index.js',
    modules: { 'index.js': { js: 'export default { fetch() { return new Response("fixture") } }' } } }));
  const bundleDigest = await sha256(bundle);
  const manifest = encoder.encode(JSON.stringify({ schemaVersion: 1, interfaceVersion: 1,
    id: repositoryName, name: 'Review operator', description: 'Review fixture', coreVersion: '1', intentVersion: '1',
    profile: options.profile ?? 'conductor', inputSchema: { type: 'object' },
    requiredCapabilities: options.requiredCapabilities ?? [],
    artifact: { path: '/operator-bundle.json', sha256: bundleDigest } }));
  const manifestDigest = await sha256(manifest);
  const provenance = encoder.encode(JSON.stringify({ repositoryId: options.fault === 'provenance-repository' ? 418 : repositoryId,
    sourceCommit, ...(options.omitCompilerCommit ? {} : {
      compilerCommit: options.fault === 'provenance-compiler' ? 'invalid' : 'c'.repeat(40),
    }), manifestDigest, bundleDigest,
    workflow: { id: workflowId, ref: '.github/workflows/release.yml@refs/heads/main', runId, runAttempt: 1 } }));
  const files = [
    { id: 91, name: 'operator-manifest.json', bytes: manifest },
    { id: 92, name: 'operator-bundle.json', bytes: bundle },
    { id: 93, name: 'operator-provenance.json', bytes: provenance },
  ];
  const assets = await Promise.all(files.map(async file => ({ id: file.id, name: file.name, state: 'uploaded',
    size: file.bytes.length, digest: `sha256:${await sha256(file.bytes)}` })));
  const archiveBytes = archive(files.map(file => ({ ...file,
    bytes: options.fault === 'build-bytes' && file.id === 92 ? encoder.encode('{}') : file.bytes })));
  const artifactDigest = await sha256(archiveBytes);
  const requests: Array<{ origin: string; path: string; authorization: string | null }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ origin: url.origin, path: url.pathname, authorization: request.headers.get('authorization') });
    if (url.origin === 'https://release-assets.githubusercontent.com' && options.useCdn) {
      const file = files.find(candidate => url.pathname === `/fixture/${candidate.id}`);
      return file ? new Response(file.bytes) : new Response('Unknown asset', { status: 404 });
    }
    if (url.origin === `https://${options.artifactCdnHost ?? 'productionresultssa3.blob.core.windows.net'}` && options.useCdn)
      return url.pathname === '/fixture/operator-package' ? new Response(archiveBytes) : new Response('Unknown artifact', { status: 404 });
    if (url.origin !== 'https://api.github.com') return new Response('Unapproved host', { status: 403 });
    const path = url.pathname;
    if (path === `/repos/acme/${repositoryName}` || path === `/repositories/${repositoryId}`) return Response.json(repository);
    if (path === `/repositories/${repositoryId}/actions/workflows/release.yml`) return Response.json({ id: workflowId,
      path: '.github/workflows/release.yml', state: 'active' });
    if (path === `/repositories/${repositoryId}/releases`) return Response.json([{ id: 81, draft: false,
      immutable: options.fault !== 'mutable-release', published_at: '2026-09-21T12:00:00Z', tag_name: 'v1', assets }]);
    const asset = files.find(file => path === `/repositories/${repositoryId}/releases/assets/${file.id}`);
    if (asset) {
      if (options.fault === 'unsafe-redirect') return new Response(null, { status: 302, headers: { location: 'https://untrusted.example.test/asset' } });
      if (options.useCdn) return new Response(null, { status: 302,
        headers: { location: `https://release-assets.githubusercontent.com/fixture/${asset.id}` } });
      return new Response(asset.bytes, { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (path === `/repositories/${repositoryId}/actions/runs/${runId}`) return Response.json({ id: runId, run_attempt: 1,
      workflow_id: workflowId, head_sha: sourceCommit, head_branch: 'main', path: '.github/workflows/release.yml', event: 'push',
      status: 'completed', conclusion: options.fault === 'failed-run' ? 'failure' : 'success', repository: { id: repositoryId },
      head_repository: { id: repositoryId } });
    if (path === `/repositories/${repositoryId}/git/ref/tags/v1`) return Response.json({ object: { type: 'commit', sha: sourceCommit } });
    if (path === `/repositories/${repositoryId}/actions/runs/${runId}/artifacts`) return Response.json({ total_count: 1,
      artifacts: [{ id: artifactId, name: 'operator-package', expired: false, size_in_bytes: archiveBytes.length,
        digest: `sha256:${artifactDigest}`, workflow_run: { id: runId, repository_id: repositoryId,
          head_repository_id: repositoryId, head_sha: sourceCommit } }] });
    if (path === `/repositories/${repositoryId}/actions/artifacts/${artifactId}/zip`) {
      if (request.headers.get('accept') !== 'application/vnd.github+json')
        return Response.json({ message: 'Artifact download requires JSON Accept' }, { status: 415 });
      if (options.useCdn) return new Response(null, { status: 302,
        headers: { location: `https://${options.artifactCdnHost ?? 'productionresultssa3.blob.core.windows.net'}/fixture/operator-package` } });
      return new Response(archiveBytes);
    }
    return new Response('Unknown GitHub fixture endpoint', { status: 404 });
  };
  return { fetcher, requests, bundleDigest, manifestDigest, sourceCommit, assets,
    artifactDigest };
}
