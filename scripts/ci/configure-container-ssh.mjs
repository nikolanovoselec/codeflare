#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SSH_BLOCK = '[containers.ssh]\nenabled = false';
const AUTHORIZED_KEYS_HEADER = '[[containers.authorized_keys]]';

function readUint32(buffer, offset) {
  if (offset + 4 > buffer.length) return undefined;
  return buffer.readUInt32BE(offset);
}

export function normalizeEd25519PublicKey(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.includes('\n') || value.includes('\r')) {
    throw new Error('CONTAINER_SSH_PUBLIC_KEY must be one whitespace-trimmed line');
  }

  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\s]+)?$/.exec(value);
  if (!match) throw new Error('CONTAINER_SSH_PUBLIC_KEY must be an ssh-ed25519 public key');

  const encoded = match[1];
  const blob = Buffer.from(encoded, 'base64');
  if (blob.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('CONTAINER_SSH_PUBLIC_KEY has invalid base64 encoding');
  }

  const algorithmLength = readUint32(blob, 0);
  const algorithmEnd = algorithmLength === undefined ? 0 : 4 + algorithmLength;
  const keyLength = readUint32(blob, algorithmEnd);
  const keyStart = algorithmEnd + 4;
  if (
    algorithmLength !== 11 ||
    blob.subarray(4, algorithmEnd).toString('ascii') !== 'ssh-ed25519' ||
    keyLength !== 32 ||
    keyStart + keyLength !== blob.length
  ) {
    throw new Error('CONTAINER_SSH_PUBLIC_KEY has invalid Ed25519 key material');
  }

  return `ssh-ed25519 ${encoded}`;
}

export function configureContainerSsh(configPath, publicKey = process.env.CONTAINER_SSH_PUBLIC_KEY) {
  const source = readFileSync(configPath, 'utf8');
  const blockCount = source.split(SSH_BLOCK).length - 1;
  if (blockCount !== 1 || source.includes(AUTHORIZED_KEYS_HEADER)) {
    throw new Error('Wrangler SSH baseline must contain one disabled block and no committed authorized keys');
  }

  if (!publicKey) {
    console.log('Container SSH: disabled (CONTAINER_SSH_PUBLIC_KEY is absent)');
    return;
  }

  const normalizedKey = normalizeEd25519PublicKey(publicKey);
  const enabledBlock = `[containers.ssh]\nenabled = true\n\n${AUTHORIZED_KEYS_HEADER}\nname = "codeflare-operator"\npublic_key = "${normalizedKey}"`;
  writeFileSync(configPath, source.replace(SSH_BLOCK, enabledBlock));
  console.log('Container SSH: enabled for repository operator key');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const configPath = process.argv[2];
  if (!configPath || process.argv.length !== 3) {
    console.error('Usage: configure-container-ssh.mjs <wrangler-config>');
    process.exit(2);
  }
  try {
    configureContainerSsh(configPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Container SSH configuration failed');
    process.exit(1);
  }
}
