#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export function deploymentCredentialBoundary(deployToken, runtimeToken) {
  if (!deployToken) throw new Error('CLOUDFLARE_DEPLOY_API_TOKEN is required');
  if (!runtimeToken) throw new Error('CLOUDFLARE_API_TOKEN is required as the runtime Worker secret');
  if (deployToken === runtimeToken) throw new Error('Deployment and runtime API tokens must be separate credentials');
  return {
    wranglerEnvironment: { CLOUDFLARE_API_TOKEN: deployToken },
    workerSecrets: { CLOUDFLARE_API_TOKEN: runtimeToken },
  };
}

function main() {
  const boundary = deploymentCredentialBoundary(
    process.env.CLOUDFLARE_API_TOKEN,
    process.env.RUNTIME_CLOUDFLARE_API_TOKEN,
  );
  if (process.argv[2] === 'worker-secrets') process.stdout.write(JSON.stringify(boundary.workerSecrets));
  else if (process.argv[2] !== 'validate') throw new Error('Expected validate or worker-secrets');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
