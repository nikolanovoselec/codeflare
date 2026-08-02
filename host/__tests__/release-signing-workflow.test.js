import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflow = parseYaml(
  readFileSync(resolve(__dirname, '../../.github/workflows/sign-release.yml'), 'utf8'),
);
const job = workflow.jobs.sign;
const steps = Object.fromEntries(job.steps.map((step) => [step.name, step]));

describe('REQ-OPS-034: keyless GitHub release signing', () => {
  it('signs published releases and supports an explicit recovery dispatch', () => {
    assert.deepEqual(workflow.on.release.types, ['published']);
    assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
    assert.equal(workflow.on.workflow_dispatch.inputs.tag.type, 'string');
    assert.equal(workflow.permissions.contents, 'read');
    assert.deepEqual(job.permissions, {
      contents: 'write',
      'id-token': 'write',
      attestations: 'write',
    });
  });

  it('binds signing to a validated semantic-version tag reachable from main', () => {
    const validate = steps['Validate release source'];
    assert.equal(validate.env.RELEASE_TAG, "${{ github.event.release.tag_name || inputs.tag }}");
    assert.equal(validate.env.EVENT_NAME, '${{ github.event_name }}');
    assert.equal(validate.env.SOURCE_REF, '${{ github.ref }}');
    assert.doesNotMatch(validate.run, /\$\{\{/);
    assert.match(validate.run, /workflow_dispatch/);
    assert.match(validate.run, /refs\/heads\/main/);
    assert.match(validate.run, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
    assert.match(validate.run, /gh release view/);
    assert.match(validate.run, /git merge-base --is-ancestor/);
    assert.match(validate.run, /origin\/main/);
  });

  it('creates deterministic release assets and keyless signatures', () => {
    assert.equal(steps['Check out release tag'].with['persist-credentials'], false);
    assert.equal(steps['Check out release tag'].with.ref, '${{ env.RELEASE_TAG }}');
    assert.equal(
      steps['Install Cosign'].uses,
      'sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6',
    );
    assert.equal(steps['Install Cosign'].with['cosign-release'], 'v3.1.2');

    const build = steps['Build deterministic release archive'].run;
    assert.match(build, /git archive/);
    assert.match(build, /gzip -n/);
    assert.match(build, /sha256sum/);

    const sign = steps['Sign release assets'].run;
    assert.match(sign, /cosign sign-blob --yes --bundle/);
    assert.match(sign, /\.sigstore\.json/);
    assert.doesNotMatch(sign, /COSIGN_PASSWORD|PRIVATE_KEY/);

    assert.match(steps['Upload signed release assets'].run, /gh release upload/);
  });

  it('publishes GitHub provenance for the exact archive and checksum manifest', () => {
    const attest = steps['Attest release assets'];
    assert.equal(
      attest.uses,
      'actions/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373',
    );
    assert.match(attest.with['subject-path'], /codeflare-v\*\.tar\.gz/);
    assert.match(attest.with['subject-path'], /SHA256SUMS/);
  });
});
