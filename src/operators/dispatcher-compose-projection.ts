import { parseDocument } from 'yaml';

const imageTag = /^amir20\/dozzle:v[0-9]+\.[0-9]+\.[0-9]+$/;
const optionName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const serviceName = /^[A-Za-z0-9_.-]{1,128}$/;

type Blob = { sha: string; content: string };
type Identity = { repository: string; pullRequest: number; baseSha: string; headSha: string; path: string };

/** Raw GitHub patches can contain inline credentials. Only a complete image-only delta crosses into Flue. */
export function projectDispatcherFiles(input: unknown) {
  if (!Array.isArray(input) || input.length > 100) throw new Error('Diff listing unavailable');
  return input.map(file => {
    if (!record(file) || typeof file.filename !== 'string' || file.filename.length > 256) {
      throw new Error('Diff entry unavailable');
    }
    const compose = /(?:^|\/)compose[^/]*\.ya?ml$/.test(file.filename);
    const filename = compose ? file.filename : '[other-changed-file]';
    const lines = typeof file.patch === 'string' ? file.patch.split('\n') : [];
    const removed = lines.filter((line: string) => line.startsWith('-') && !line.startsWith('---'));
    const added = lines.filter((line: string) => line.startsWith('+') && !line.startsWith('+++'));
    const image = /^[-+]\s*image:\s*amir20\/dozzle:v[0-9]+\.[0-9]+\.[0-9]+\s*$/;
    const patch = compose && removed.length === 1 && added.length === 1
      && file.additions === 1 && file.deletions === 1 && image.test(removed[0]) && image.test(added[0])
      ? `${removed[0]}\n${added[0]}` : null;
    return { filename, status: file.status ?? null,
      sha: typeof file.sha === 'string' && /^[a-f0-9]{40}$/.test(file.sha) ? file.sha : null,
      additions: Number.isSafeInteger(file.additions) ? file.additions : null,
      deletions: Number.isSafeInteger(file.deletions) ? file.deletions : null, patch };
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function project(blob: Blob, identity: Identity, side: 'before' | 'after') {
  const document = parseDocument(blob.content, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error('Compose configuration unavailable');
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 0 }); }
  catch { throw new Error('Compose configuration unavailable'); }
  if (!record(value) || !record(value.services) || Object.keys(value.services).length > 50) {
    throw new Error('Compose configuration unavailable');
  }
  const services = [];
  for (const [name, service] of Object.entries(value.services)) {
    if (!serviceName.test(name) || !record(service)) throw new Error('Compose service unavailable');
    if (typeof service.image !== 'string' || !imageTag.test(service.image)) continue;
    const command = service.command;
    const mode = command === 'server' || (Array.isArray(command) && command.length === 1 && command[0] === 'server')
      ? 'server' : command === 'agent' || (Array.isArray(command) && command.length === 1 && command[0] === 'agent')
        ? 'agent' : null;
    const options = service.environment;
    const environmentKeys = options === undefined ? [] : Array.isArray(options)
      ? options.map(entry => typeof entry === 'string' ? entry.split('=')[0] : '')
      : record(options) ? Object.keys(options) : [''];
    if (environmentKeys.length > 64 || environmentKeys.some(key => !optionName.test(key))) {
      throw new Error('Compose options unavailable');
    }
    const refInput = JSON.stringify({ ...identity, side, blobSha: blob.sha, service: name, image: service.image, mode });
    const ref = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refInput))),
      b => b.toString(16).padStart(2, '0')).join('');
    services.push({ name, image: service.image, mode,
      environmentKeys: environmentKeys.filter(key => key.startsWith('DOZZLE_')).sort(),
      redacted: mode === null || Object.keys(service).some(key => key !== 'image' && key !== 'command')
        || Object.keys(value).some(key => key !== 'services'), ref });
  }
  if (!services.length) throw new Error('Dozzle Compose service unavailable');
  return { sha: blob.sha, services };
}

/** Only an inert projection crosses from authenticated GitHub bytes into the child/model. */
export async function projectChangedCompose(identity: Identity, before: Blob, after: Blob) {
  return { path: identity.path, before: await project(before, identity, 'before'),
    after: await project(after, identity, 'after') };
}
