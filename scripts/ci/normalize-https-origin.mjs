#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { isIP } from 'node:net';

const [raw, outputName, ...extra] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`Invalid target origin: ${message}\n`);
  process.exit(1);
}

if (extra.length > 0 || typeof raw !== 'string' || raw.length === 0) fail('provide a target and optional output name');
if (outputName !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(outputName)) fail('output name is malformed');
if (raw.trim() !== raw || /[\u0000-\u001f\u007f]/.test(raw)) fail('whitespace and control characters are not allowed');

const explicitScheme = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//)?.[1]?.toLowerCase();
if (explicitScheme && explicitScheme !== 'http' && explicitScheme !== 'https') fail('only HTTP or HTTPS input is accepted');

let url;
try {
  url = new URL(explicitScheme ? raw : `https://${raw}`);
} catch {
  fail('value is not a URL');
}

if (url.username || url.password) fail('credentials are not allowed');
if (url.pathname !== '/' || url.search || url.hash) fail('paths, queries, and fragments are not allowed');
if (url.port === '0') fail('port must be between 1 and 65535');
if (isIP(url.hostname) || !url.hostname.includes('.')) fail('a public DNS hostname is required');
if (url.hostname.length > 253 || !url.hostname.split('.').every((label) => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(label))) {
  fail('hostname is malformed');
}

url.protocol = 'https:';
if (outputName === undefined) {
  process.stdout.write(`${url.origin}\n`);
} else {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) fail('GITHUB_OUTPUT is required when an output name is provided');
  appendFileSync(outputPath, `${outputName}=${url.origin}\n`, { encoding: 'utf8' });
}
