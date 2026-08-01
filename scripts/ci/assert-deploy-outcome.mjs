#!/usr/bin/env node

const VALID_RESULTS = new Set(['success', 'skipped', 'failure', 'cancelled']);

export function deployOutcome(result) {
  if (result === 'success') return { ok: true, message: 'Worker deployed.' };
  if (result === 'skipped') {
    return {
      ok: false,
      message: 'Nothing was deployed — the gate was not satisfied (see the job results above). Failing so this run is not mistaken for a successful deploy.',
    };
  }
  return { ok: false, message: `The deploy job ended '${result}'.` };
}

function main() {
  const [result] = process.argv.slice(2);
  if (!VALID_RESULTS.has(result)) {
    throw new Error('Usage: assert-deploy-outcome.mjs <success|skipped|failure|cancelled>');
  }

  const outcome = deployOutcome(result);
  process.stdout.write(outcome.ok ? `${outcome.message}\n` : `::error::${outcome.message}\n`);
  if (!outcome.ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
