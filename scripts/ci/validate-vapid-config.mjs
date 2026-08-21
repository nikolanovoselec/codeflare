import { createECDH, timingSafeEqual } from 'node:crypto';

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() !== value) {
    throw new Error(`${name} is missing or contains surrounding whitespace`);
  }
  return value;
}

function validateSubject(subject) {
  let url;
  try {
    url = new URL(subject);
  } catch {
    throw new Error('VAPID_SUBJECT must be a valid mailto: or https: URL');
  }

  if (url.protocol === 'mailto:') {
    let target;
    try {
      target = decodeURIComponent(url.pathname);
    } catch {
      throw new Error('VAPID_SUBJECT mailto: target is invalid');
    }
    if (!subject.startsWith('mailto:') || !target.trim()) {
      throw new Error('VAPID_SUBJECT mailto: target is missing');
    }
    return;
  }

  if (url.protocol === 'https:' && subject.startsWith('https://') && url.hostname) {
    return;
  }

  throw new Error('VAPID_SUBJECT must use mailto: or https: with a target');
}

function decodeKey(name, value, length) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${name} must be unpadded base64url`);
  }

  const key = Buffer.from(value, 'base64url');
  if (key.length !== length || key.toString('base64url') !== value) {
    throw new Error(`${name} has an invalid encoding or length`);
  }
  return key;
}

try {
  const subject = required('VAPID_SUBJECT');
  const publicKey = decodeKey('VAPID_PUBLIC_KEY', required('VAPID_PUBLIC_KEY'), 65);
  const privateKey = decodeKey('VAPID_PRIVATE_KEY', required('VAPID_PRIVATE_KEY'), 32);

  validateSubject(subject);
  if (publicKey[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be an uncompressed P-256 point');
  }

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  const derivedPublicKey = ecdh.getPublicKey(undefined, 'uncompressed');
  if (!timingSafeEqual(publicKey, derivedPublicKey)) {
    throw new Error('VAPID public and private keys do not match');
  }

  process.stdout.write('VAPID configuration is valid\n');
} catch (error) {
  const message = error instanceof Error ? error.message : 'invalid VAPID configuration';
  process.stderr.write(`VAPID configuration error: ${message}\n`);
  process.exitCode = 1;
}
