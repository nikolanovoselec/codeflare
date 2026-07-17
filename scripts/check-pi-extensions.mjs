#!/usr/bin/env node
/**
 * Parse-check every Pi extension before it is baked into the seed.
 *
 * Pi loads each extension by stripping types and parsing it as a module. A
 * syntax error (e.g. an unclosed `pi.on(...)` call) aborts the load and
 * crashes interactive Pi at startup — but the Worker test suite never parses
 * these files (they are stored as strings in the generated seed and the
 * entry extensions import node builtins, so the Workers vitest pool cannot
 * import them). `pi -p` is also resilient to load failures, so a broken
 * extension can ship undetected. This check closes that gap: it runs in CI
 * via the `generate:agent-seed` npm script (prebuild + pretest), using
 * esbuild's TypeScript loader — the same type-strip-and-parse semantics Pi
 * itself applies — to surface syntax errors and fail the build.
 *
 * It checks SYNTAX only (type stripping, no type-checking / no module
 * resolution), so valid TypeScript never produces a false positive.
 * (Previously used the TypeScript compiler API; typescript@7's native
 * compiler no longer ships ts.transpileModule/ScriptTarget, so the check
 * now rides esbuild, which the root tree already pins via overrides.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'preseed', 'agents', 'pi', 'extensions');

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  // esbuild is a devDependency; it is present in CI (npm ci) but may be
  // absent in a bare local checkout. Skip rather than break seed generation.
  console.warn('[check:pi-extensions] esbuild not installed — skipping Pi extension parse check');
  process.exit(0);
}

const files = readdirSync(EXT_DIR).filter((f) => f.endsWith('.ts'));
let failures = 0;

for (const file of files) {
  const source = readFileSync(join(EXT_DIR, file), 'utf8');
  try {
    esbuild.transformSync(source, { loader: 'ts', sourcefile: file, logLevel: 'silent' });
  } catch (error) {
    const messages = Array.isArray(error?.errors) && error.errors.length > 0
      ? error.errors.map((e) => {
        const where = e.location ? `:${e.location.line}` : '';
        return `[check:pi-extensions] PARSE ERROR ${file}${where}: ${e.text}`;
      })
      : [`[check:pi-extensions] PARSE ERROR ${file}: ${error?.message ?? error}`];
    failures += messages.length;
    for (const message of messages) console.error(message);
  }
}

if (failures > 0) {
  console.error(`\n[check:pi-extensions] ${failures} syntax error(s) across Pi extensions — fix before shipping`);
  process.exit(1);
}
console.log(`[check:pi-extensions] OK — ${files.length} Pi extensions parsed cleanly`);
