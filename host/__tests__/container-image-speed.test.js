import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
const workflow = parseYaml(readFileSync(join(root, '.github/workflows/container-image.yml'), 'utf8'));
const steps = workflow.jobs.image.steps;

function stepIndex(name) {
  const index = steps.findIndex((step) => step.name === name);
  assert.notEqual(index, -1, `missing workflow step: ${name}`);
  return index;
}

describe('REQ-OPS-050: hosted image-build speed', () => {
  it('keeps extension-only edits behind the expensive Pi dependency layer', () => {
    const manifestCopy = dockerfile.indexOf('COPY preseed/agents/pi/package.json preseed/agents/pi/package-lock.json');
    const dependencyInstall = dockerfile.indexOf('RUN cd /opt/codeflare/pi-agent/npm');
    const extensionCopy = dockerfile.indexOf('COPY preseed/agents/pi/extensions/ /opt/codeflare/pi-agent/extensions/');
    const prewarm = dockerfile.indexOf('RUN mkdir -p /opt/codeflare/jiti-warm-tmp');

    for (const [name, offset] of Object.entries({ manifestCopy, dependencyInstall, extensionCopy, prewarm })) {
      assert.notEqual(offset, -1, `missing Dockerfile boundary: ${name}`);
    }
    assert.ok(manifestCopy < dependencyInstall);
    assert.ok(dependencyInstall < extensionCopy, 'extension edits must retain the Pi npm-install layer');
    assert.ok(extensionCopy < prewarm, 'extension bytes must still be present before Jiti prewarm');
  });

  it('assembles IDE and seed artifacts after expensive runtime dependency layers', () => {
    const cacheBust = dockerfile.indexOf('COPY .cache-bust /tmp/.cache-bust');
    const sharedTools = dockerfile.indexOf('RUN cd /opt/codeflare/npm-tools');
    const piDependencies = dockerfile.indexOf('RUN cd /opt/codeflare/pi-agent/npm');
    const browserRun = dockerfile.indexOf('RUN cd /opt/codeflare/browser-run-mcp');
    const welcomeAssembly = dockerfile.indexOf('COPY --from=openvscode-agent-sidebar-builder /out/welcome');
    const inventoryAssembly = dockerfile.indexOf('COPY --from=openvscode-agent-inventories /out/openvscode');
    const seedAssembly = dockerfile.indexOf('COPY src/lib/agent-seed.generated.ts /opt/codeflare/seed-src/agent-seed.generated.ts');

    for (const [name, offset] of Object.entries({
      cacheBust,
      sharedTools,
      piDependencies,
      browserRun,
      welcomeAssembly,
      inventoryAssembly,
      seedAssembly,
    })) assert.notEqual(offset, -1, `missing Dockerfile boundary: ${name}`);
    assert.ok(cacheBust < sharedTools, 'explicit cache bust must still invalidate dependency installation');
    const lastDependency = Math.max(sharedTools, piDependencies, browserRun);
    assert.ok(lastDependency < welcomeAssembly);
    assert.ok(lastDependency < inventoryAssembly);
    assert.ok(lastDependency < seedAssembly);
  });

  it('publishes plain BuildKit timing evidence', () => {
    const buildIndex = stepIndex('Build container image');
    const evidenceIndex = stepIndex('Upload BuildKit timing evidence');
    assert.ok(buildIndex < evidenceIndex);
    assert.match(steps[buildIndex].run, /--progress=plain/);
    assert.match(steps[buildIndex].run, /tee \/tmp\/buildkit\.log/);
    assert.equal(steps[evidenceIndex].with.path, '/tmp/buildkit.log');
  });

  it('makes Trivy cache metadata restorable by the runner account', () => {
    const provisionIndex = stepIndex('Provision scan scratch space and free disk');
    const restoreIndex = stepIndex('Restore Trivy vulnerability DB cache');
    const body = steps[provisionIndex].run;

    assert.ok(provisionIndex < restoreIndex);
    assert.match(body, /sudo chown "\$\(id -u\):\$\(id -g\)" \/mnt\/trivy-tmp \/mnt\/trivy-cache \/mnt\/trivy-sbom-cache/);
    assert.match(body, /chmod 0700 \/mnt\/trivy-tmp \/mnt\/trivy-cache \/mnt\/trivy-sbom-cache/);
  });

  it('blocks publication when any concurrent image prerequisite fails', () => {
    const parallelIndex = stepIndex('Scan image, generate SBOM, and prepare push tooling');
    const body = steps[parallelIndex].run;
    const gateOffset = body.indexOf('status=0');
    assert.notEqual(gateOffset, -1, 'missing concurrent prerequisite status gate');
    const gate = body.slice(gateOffset);

    const runGate = (scanStatus, sbomStatus, wranglerStatus) => spawnSync('bash', ['-c', `
      (exit ${scanStatus}) & scan_pid=$!
      (exit ${sbomStatus}) & sbom_pid=$!
      (exit ${wranglerStatus}) & wrangler_pid=$!
      ${gate}
    `], { encoding: 'utf8' });

    assert.equal(runGate(0, 0, 0).status, 0);
    assert.notEqual(runGate(17, 0, 0).status, 0);
    assert.notEqual(runGate(0, 19, 0).status, 0);
    assert.notEqual(runGate(0, 0, 23).status, 0);
  });

  it('runs scan, SBOM, and Wrangler preparation concurrently before enforcement and push', () => {
    const setupIndex = stepIndex('Install locked Trivy');
    const parallelIndex = stepIndex('Scan image, generate SBOM, and prepare push tooling');
    const enforceIndex = stepIndex('Enforce vulnerability scan and bounded exceptions');
    const uploadIndex = stepIndex('Upload the SBOM');
    const pushIndex = stepIndex('Push image');
    const body = steps[parallelIndex].run;

    assert.ok(setupIndex < parallelIndex && parallelIndex < enforceIndex);
    assert.ok(enforceIndex < uploadIndex && uploadIndex < pushIndex);
    assert.equal(steps[setupIndex].uses, 'aquasecurity/setup-trivy@3fb12ec12f41e471780db15c232d5dd185dcb514');
    assert.equal(steps[setupIndex].with.version, 'v0.70.0');
    assert.match(body, /trivy image --download-db-only/);
    assert.match(body, /trivy image --download-java-db-only/);
    assert.match(body, /cp -a "\$TRIVY_CACHE_DIR\/\." "\$sbom_cache\/"/);
    assert.match(body, /TRIVY_CACHE_DIR="\$sbom_cache" trivy image/);
    assert.ok((body.match(/--skip-java-db-update/g) ?? []).length >= 2);
    assert.match(body, /--format json/);
    assert.match(body, /--format cyclonedx/);
    assert.match(body, /npm ci --prefix \.github\/npm-tools\/wrangler/);
    assert.ok((body.match(/&\n/g) ?? []).length >= 3, 'three independent operations must launch in parallel');
    assert.match(body, /wait "\$scan_pid"/);
    assert.match(body, /wait "\$sbom_pid"/);
    assert.match(body, /wait "\$wrangler_pid"/);
  });
});
