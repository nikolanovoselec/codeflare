#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const [provenancePath, actualOutput] = process.argv.slice(2);
if (!provenancePath || actualOutput === undefined) throw new Error('usage: verify-herdr-version <provenance.json> <version-output>');

const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
if (typeof provenance.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(provenance.version)) {
  throw new Error('Herdr provenance version is invalid');
}
if (actualOutput !== `herdr ${provenance.version}`) {
  throw new Error('Packaged Herdr version does not match provenance');
}
process.stdout.write(provenance.version);
