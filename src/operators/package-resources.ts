import { z } from 'zod';
import { ValidationError } from '../lib/error-types';
import type { OperatorBundle } from './distribution';

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function canonical(value: string, absolute: boolean): boolean {
  if (value.length < 2 || value.length > 2048 || value.startsWith('/') !== absolute
    || /[\\%\x00-\x1f\x7f]/.test(value)) return false;
  const parts = (absolute ? value.slice(1) : value).split('/');
  return parts.every(part => part !== '' && part !== '.' && part !== '..'
    && part !== '__proto__' && part !== 'constructor' && part !== 'prototype');
}

export const packageResourceManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  files: z.array(z.strictObject({
    source: z.string().refine(value => canonical(value, false)),
    destination: z.string().refine(value => canonical(value, false)),
    sha256: z.string().regex(SHA256),
    size: z.number().int().min(0).max(MAX_FILE_BYTES),
  })).max(64).refine(files => new Set(files.map(file => file.destination)).size === files.length),
});

export type OperatorPackageResourceProjection = {
  schemaVersion: 1;
  artifactDigest: string;
  files: Array<{ destination: string; sha256: string; size: number; content: string }>;
};

async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Project only inert, digest-bound package bytes. No invocation or authority participates. */
export async function projectOperatorPackageResources(bundle: OperatorBundle,
  artifactDigest: string): Promise<OperatorPackageResourceProjection | null> {
  if (!bundle.resources) return null;
  if (!SHA256.test(artifactDigest)) throw new ValidationError('Invalid package resource projection');
  const manifest = packageResourceManifestSchema.parse(bundle.resources);
  let total = 0;
  const files = [] as OperatorPackageResourceProjection['files'];
  for (const declared of manifest.files) {
    const module = bundle.modules[declared.source];
    if (!module || !('text' in module)) throw new ValidationError('Invalid package resource projection');
    const bytes = new TextEncoder().encode(module.text);
    total += bytes.byteLength;
    if (bytes.byteLength !== declared.size || total > MAX_TOTAL_BYTES
      || await digest(bytes) !== declared.sha256) throw new ValidationError('Invalid package resource projection');
    files.push({ destination: declared.destination, sha256: declared.sha256,
      size: declared.size, content: module.text });
  }
  return { schemaVersion: 1, artifactDigest, files };
}

export function parseOperatorPackageResourceProjection(value: unknown): OperatorPackageResourceProjection {
  return z.strictObject({ schemaVersion: z.literal(1), artifactDigest: z.string().regex(SHA256),
    files: z.array(z.strictObject({ destination: z.string().refine(path => canonical(path, false)),
      sha256: z.string().regex(SHA256), size: z.number().int().min(0).max(MAX_FILE_BYTES), content: z.string() })).max(64)
      .refine(files => new Set(files.map(file => file.destination)).size === files.length),
  }).parse(value);
}

export async function verifyOperatorPackageResourceProjection(value: unknown): Promise<OperatorPackageResourceProjection> {
  const projection = parseOperatorPackageResourceProjection(value);
  let total = 0;
  for (const file of projection.files) {
    const bytes = new TextEncoder().encode(file.content);
    total += bytes.byteLength;
    if (bytes.byteLength !== file.size || total > MAX_TOTAL_BYTES || await digest(bytes) !== file.sha256) {
      throw new ValidationError('Invalid package resource projection');
    }
  }
  return projection;
}
