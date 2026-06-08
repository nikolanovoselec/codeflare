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
 * via the `generate:agent-seed` npm script (prebuild + pretest), using the
 * TypeScript parser to surface syntax errors and fail the build.
 *
 * It checks SYNTAX only (no isolatedModules / no type-checking / no module
 * resolution), so valid TypeScript never produces a false positive.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'preseed', 'agents', 'pi', 'extensions');

let ts;
try {
  ts = (await import('typescript')).default;
} catch {
  // typescript is a devDependency; it is present in CI (npm ci) but may be
  // absent in a bare local checkout. Skip rather than break seed generation.
  console.warn('[check:pi-extensions] typescript not installed — skipping Pi extension parse check');
  process.exit(0);
}

const files = readdirSync(EXT_DIR).filter((f) => f.endsWith('.ts'));
let failures = 0;

for (const file of files) {
  const source = readFileSync(join(EXT_DIR, file), 'utf8');
  const { diagnostics } = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
  });
  const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  for (const d of errors) {
    failures += 1;
    const where = d.file && d.start != null ? `:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : '';
    console.error(`[check:pi-extensions] PARSE ERROR ${file}${where}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
  }
}

if (failures > 0) {
  console.error(`\n[check:pi-extensions] ${failures} syntax error(s) across Pi extensions — fix before shipping`);
  process.exit(1);
}
console.log(`[check:pi-extensions] OK — ${files.length} Pi extensions parsed cleanly`);
