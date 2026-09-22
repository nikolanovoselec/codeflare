import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX = 8 * 1024 * 1024;

export function restoreOperatorAttachments(input, options) {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
    || !ID.test(value.activityId) || !Array.isArray(value.files) || value.files.length > 16
    || !path.isAbsolute(options.root) || !path.isAbsolute(options.rcloneConfig)
    || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(options.bucket)) throw new Error('Invalid Operator attachments');
  const root = path.join(options.root, 'input');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let total = 0;
  const names = new Set();
  const locators = new Set();
  for (const file of value.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).length !== 5
      || !NAME.test(file.name) || !ID.test(file.locator) || names.has(file.name) || locators.has(file.locator)
      || typeof file.mediaType !== 'string' || file.mediaType.length < 3 || file.mediaType.length > 129
      || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX || !DIGEST.test(file.sha256)) {
      throw new Error('Invalid Operator attachment');
    }
    total += file.size;
    if (total > MAX) throw new Error('Operator attachments exceed bound');
    names.add(file.name); locators.add(file.locator);
    const destination = path.join(root, file.name);
    const temporary = `${destination}.codeflare-${process.pid}`;
    const source = `r2:${options.bucket}/.codeflare/operator-inputs/${value.activityId}/${file.locator}`;
    try {
      (options.run ?? execFileSync)('rclone', ['copyto', source, temporary, '--config', options.rcloneConfig,
        '--max-size', String(file.size), '--immutable', '--no-traverse'], { stdio: 'ignore', timeout: 120_000 });
      const bytes = readFileSync(temporary);
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        throw new Error('Operator attachment integrity mismatch');
      }
      chmodSync(temporary, 0o600);
      renameSync(temporary, destination);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  restoreOperatorAttachments(process.env.CODEFLARE_OPERATOR_ATTACHMENTS, {
    root: process.env.CODEFLARE_OPERATOR_RESOURCE_ROOT,
    bucket: process.env.R2_BUCKET_NAME,
    rcloneConfig: process.env.RCLONE_CONFIG,
  });
}
