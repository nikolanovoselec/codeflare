import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync,
  writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIGEST = /^[0-9a-f]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => typeof value === 'string' && value.length > 1 && value.length <= 1024
  && !value.startsWith('/') && !/[\\%\x00-\x1f\x7f]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');

function checkedBytes(file, descriptor, maximum) {
  if (!descriptor || !DIGEST.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.size)
    || descriptor.size < 1 || descriptor.size > maximum) throw new Error('Approved operator input unavailable');
  let handle;
  try {
    handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(handle);
    if (!info.isFile() || info.size !== descriptor.size) throw new Error('Approved operator input unavailable');
    const bytes = readFileSync(handle);
    if (bytes.length !== descriptor.size || hash(bytes) !== descriptor.sha256) throw new Error('Approved operator input unavailable');
    return bytes;
  } catch { throw new Error('Approved operator input unavailable'); }
  finally { if (handle !== undefined) closeSync(handle); }
}

/** Only parent-validated approved references, never child-supplied filesystem sources. */
export function materializeOperatorInputs({ config, work, resourceRoot, resources, attachments }) {
  const init = config?.initialization;
  if (config?.schemaVersion !== 1 || config.mode !== 'isolated'
    || !Number.isSafeInteger(config.deadline) || config.deadline <= Date.now()
    || !init || init.schemaVersion !== 1 || !canonical(init.contextPath)
    || typeof init.context !== 'string' || Buffer.byteLength(init.context) > 4096
    || !Array.isArray(init.inputs) || init.inputs.length < 1 || init.inputs.length > 20
    || resources?.schemaVersion !== 1 || !DIGEST.test(resources.artifactDigest)
    || !Array.isArray(resources.files) || attachments?.schemaVersion !== 1
    || attachments.activityId !== config.activityId || !Array.isArray(attachments.files)
    || !path.isAbsolute(work) || !path.isAbsolute(resourceRoot)) throw new Error('Approved operator input unavailable');
  const prefix = init.contextPath.split('/')[0];
  if (!prefix || prefix === 'reports' || !init.contextPath.includes('/')) throw new Error('Approved operator input unavailable');
  const mapped = new Map([[init.contextPath, Buffer.from(init.context, 'utf8')]]);
  for (const item of init.inputs) {
    if (!item || !canonical(item.reference) || !canonical(item.target)
      || !item.target.startsWith(`${prefix}/`) || mapped.has(item.target)) {
      throw new Error('Approved operator input unavailable');
    }
    const declared = item.kind === 'attachment'
      ? attachments.files.filter(file => file?.name === item.reference)
      : item.kind === 'resource'
        ? resources.files.filter(file => file?.destination === item.reference) : [];
    if (declared.length !== 1) throw new Error('Approved operator input unavailable');
    const source = item.kind === 'attachment'
      ? path.join(resourceRoot, 'input', item.reference)
      : path.join(resourceRoot, resources.artifactDigest, item.reference);
    const bytes = checkedBytes(source, declared[0], item.kind === 'attachment' ? 8 * 1024 * 1024 : 1024 * 1024);
    if (item.kind === 'resource' && !bytes.equals(Buffer.from(declared[0].content, 'utf8'))) {
      throw new Error('Approved operator input unavailable');
    }
    mapped.set(item.target, bytes);
  }
  const target = path.join(work, prefix);
  const temporary = path.join(work, `.approved-inputs-${randomUUID()}`);
  try {
    mkdirSync(temporary, { mode: 0o700 });
    for (const [relative, bytes] of mapped) {
      const destination = path.join(temporary, relative.slice(prefix.length + 1));
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
    }
    rmSync(target, { recursive: true, force: true });
    renameSync(temporary, target);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(process.env.CODEFLARE_OPERATOR_PI_CONFIG || '{}');
  if (config.mode === 'isolated') {
    materializeOperatorInputs({ config, work: path.join(config.root, 'work'),
      resourceRoot: process.env.CODEFLARE_OPERATOR_RESOURCE_ROOT,
      resources: JSON.parse(process.env.CODEFLARE_OPERATOR_PACKAGE_RESOURCES || '{}'),
      attachments: JSON.parse(process.env.CODEFLARE_OPERATOR_ATTACHMENTS || '{}') });
  }
}
