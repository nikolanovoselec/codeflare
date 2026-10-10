import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Authorized one-run CI diagnostic, not a dependency upgrade or transport repair.
if (process.env.CI !== 'true') throw new Error('Native proxy trace is CI-only');
const directory = resolve('node_modules/wrangler');
const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
if (manifest.version !== '4.137.0') throw new Error('Native proxy trace version mismatch');
const path = resolve(directory, 'wrangler-dist/ProxyWorker.js');
let source = readFileSync(path, 'utf8');
const originalDigest = '703358e6194e2323d1c40cf7d35c954b480496d69bf9d23df72cfcab308c13d9';
if (createHash('sha256').update(source).digest('hex') !== originalDigest) {
  throw new Error('Native proxy trace source mismatch');
}
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw new Error('Native proxy trace anchor mismatch');
  source = source.replace(before, after);
}
replaceOnce('      const attemptUserWorkerFetch = (attempt = 0) => void fetch(userWorkerUrl, new Request(request, { headers })).then(', `      // Only existing synthetic observation requests enter this diagnostic.
      const observationId = request.headers.get("x-codeflare-fixture-observation-id");
      const harnessEpoch = request.headers.get("x-codeflare-fixture-runtime-epoch");
      const traceable = request.method === "POST" && new URL(request.url).pathname === "/dispatcher-composed"
        && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(observationId ?? "")
        && /^[0-2]:[1-9][0-9]{0,5}$/.test(harnessEpoch ?? "");
      const trace = (stage, error, status) => {
        if (!traceable) return;
        try {
          const errorClass = ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError"].includes(error?.name) ? error.name : error ? "other" : null;
          const failure = error ? String(error.message) : "";
          const failureClass = failure.includes("Network connection lost") ? "network-connection-lost"
            : failure.includes("Cannot perform I/O on behalf of a different request") ? "cross-request-io"
            : failure.includes("memory limit") ? "memory-limit"
            : failure.includes("CPU time limit") ? "cpu-limit" : error ? "other" : null;
          console.error("[native-flue] proxy-observe=" + JSON.stringify({ observationId, harnessEpoch, stage,
            at: Date.now(), destinationPort: userWorkerUrl.port || null, status: status ?? null, errorClass, failureClass }));
        } catch { /* Diagnostics cannot replace forwarding or its original error. */ }
      };
      let traceStage = "forwarding";
      trace("forward-start");
      const attemptUserWorkerFetch = (attempt = 0) => void fetch(userWorkerUrl, new Request(request, { headers })).then(`);
replaceOnce('        async (res) => {\n          if (attempt > 0)', `        async (res) => {
          traceStage = "response-processing";
          trace("response-received", undefined, res.status);
          if (attempt > 0)`);
replaceOnce('          deferredResponse.resolve(res);\n        },', `          trace("response-ready", undefined, res.status);
          deferredResponse.resolve(res);
        },`);
replaceOnce('      ).catch((error) => {\n        if (isSameUserWorkerOrigin(', `      ).catch((error) => {
        trace(traceStage === "forwarding" ? "forward-rejected" : "response-processing-rejected", error);
        if (isSameUserWorkerOrigin(`);
// Parse the generated module in CI without importing or executing vendor code.
const parsed = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });
if (parsed.status !== 0) throw new Error('Native proxy trace generated syntax invalid');
writeFileSync(path, source);
console.log(JSON.stringify({ diagnostic: 'native-observe-proxy', version: manifest.version, originalDigest,
  tracedDigest: createHash('sha256').update(source).digest('hex') }));
