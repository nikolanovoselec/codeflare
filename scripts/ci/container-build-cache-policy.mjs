import { pathToFileURL } from 'node:url';

export function sharedCacheEnabled(loginOutcome) {
  return loginOutcome === 'success';
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'availability') {
    const [loginOutcome] = args;
    if (!loginOutcome) {
      throw new Error('Usage: container-build-cache-policy.mjs availability <login-outcome>');
    }
    process.stdout.write(`enabled=${sharedCacheEnabled(loginOutcome)}\n`);
    return;
  }
  throw new Error('Usage: container-build-cache-policy.mjs availability <login-outcome>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
