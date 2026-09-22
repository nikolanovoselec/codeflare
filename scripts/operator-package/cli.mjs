#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeOperatorPackage } from './compiler.mjs';

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv.includes('--help')) {
    throw new Error('usage: operator-package <configuration.json> <output-directory>');
  }
  const [configurationPath, outputDirectory] = argv.map(value => resolve(process.cwd(), value));
  let configuration;
  try {
    configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
  } catch {
    throw new Error('operator package configuration must be valid JSON');
  }
  const result = await writeOperatorPackage(configuration, outputDirectory);
  process.stdout.write(`${JSON.stringify({ manifestDigest: result.manifestDigest, bundleDigest: result.bundleDigest })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'operator package compilation failed'}\n`);
    process.exitCode = 1;
  });
}
