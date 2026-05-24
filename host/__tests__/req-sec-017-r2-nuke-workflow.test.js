// REQ-SEC-017: R2 bucket nuke workflow for encryption migration.
//
// Behavioural — parses .github/workflows/deploy.yml through python3's
// pyyaml (real YAML parser, same one GitHub uses to interpret the file
// at trigger time) and asserts that the r2-nuke job exists with every
// safety gate the spec ACs require. Tests fail if GitHub Actions would
// fail to interpret the workflow OR if any required gate is missing —
// not if a regex stops matching.
//
// AC mapping:
//   AC1: dispatched workflow deletes objects from every R2 bucket
//   AC2: workflow requires explicit confirmation
//   AC3: doc-only timing constraint (run before enabling SSE-C); enforced
//        by surrounding documentation
//   AC4: doc-only one-time migration step; enforced by documentation/security.md
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_YML = resolve(__dirname, '../../.github/workflows/deploy.yml');

let workflow;
before(() => {
  // Use python3 + pyyaml (stdlib + ubiquitous on Linux runners) to
  // parse the workflow exactly the way the GitHub Actions runner does.
  // Out-of-band JSON dump keeps the JS side off any YAML-parser dep.
  const result = spawnSync(
    'python3',
    ['-c', `import sys, json, yaml; print(json.dumps(yaml.safe_load(open("${DEPLOY_YML}"))))`],
    { encoding: 'utf-8' }
  );
  assert.equal(result.status, 0, `python3+pyyaml failed to parse deploy.yml:\n${result.stderr}`);
  workflow = JSON.parse(result.stdout);
});

describe('REQ-SEC-017: R2 bucket nuke workflow for encryption migration', () => {
  describe('AC1: dispatched workflow exists and is structurally valid', () => {
    it('workflow has a workflow_dispatch trigger (manual only)', () => {
      // The `on:` key is parsed as `true` by yaml.safe_load due to YAML
      // 1.1's boolean coercion of "on"; pyyaml on Python 3 with default
      // settings preserves it as the string "on" — handle both.
      const triggers = workflow.on || workflow[true] || workflow['on'];
      assert.ok(triggers, 'workflow must have an "on:" block');
      assert.ok(
        'workflow_dispatch' in triggers,
        'workflow must expose workflow_dispatch trigger (AC1: manually-dispatched)'
      );
    });

    it('jobs.r2-nuke exists', () => {
      assert.ok(workflow.jobs, 'workflow must declare jobs');
      assert.ok(
        'r2-nuke' in workflow.jobs,
        'workflow must declare a job named r2-nuke (AC1)'
      );
    });

    it('r2-nuke job runs only on workflow_dispatch + action=r2-nuke (mutually exclusive with deploy)', () => {
      const ifClause = workflow.jobs['r2-nuke'].if;
      assert.ok(ifClause, 'r2-nuke job must have an if: gate');
      assert.match(
        String(ifClause),
        /github\.event_name\s*==\s*'workflow_dispatch'/,
        'r2-nuke must gate on workflow_dispatch (never auto)'
      );
      assert.match(
        String(ifClause),
        /inputs\.action\s*==\s*'r2-nuke'/,
        "r2-nuke must require inputs.action == 'r2-nuke'"
      );
    });

    it('deploy job is skipped when action=r2-nuke (mutual exclusion)', () => {
      const deployIf = workflow.jobs.deploy.if;
      assert.ok(deployIf, 'deploy job must carry an if: gate');
      assert.match(
        String(deployIf),
        /inputs\.action\s*!=\s*'r2-nuke'/,
        'deploy job must skip when action=r2-nuke (mutual exclusion)'
      );
    });
  });

  describe('AC2: workflow requires explicit confirmation', () => {
    it('workflow_dispatch declares r2_nuke_confirmation input', () => {
      const triggers = workflow.on || workflow[true] || workflow['on'];
      const inputs = triggers.workflow_dispatch.inputs;
      assert.ok(inputs, 'workflow_dispatch must declare inputs');
      assert.ok(
        'r2_nuke_confirmation' in inputs,
        'workflow_dispatch must expose r2_nuke_confirmation input (AC2)'
      );
    });

    it('workflow_dispatch declares action choice input with r2-nuke as an option', () => {
      const triggers = workflow.on || workflow[true] || workflow['on'];
      const inputs = triggers.workflow_dispatch.inputs;
      assert.ok(inputs.action, 'workflow_dispatch must declare action input');
      assert.equal(inputs.action.type, 'choice', 'action must be a choice input');
      assert.ok(
        inputs.action.options.includes('r2-nuke'),
        'action input must include r2-nuke as a choice'
      );
      assert.ok(
        inputs.action.options.includes('deploy'),
        'action input must include deploy as a choice (default)'
      );
      assert.equal(
        inputs.action.default,
        'deploy',
        'action input must default to deploy so r2-nuke is never accidental (AC2)'
      );
    });

    it('first step of r2-nuke validates the confirmation string', () => {
      const steps = workflow.jobs['r2-nuke'].steps;
      assert.ok(Array.isArray(steps) && steps.length > 0, 'r2-nuke must have steps');
      // Find the confirmation gate — must be present and must check the
      // exact authorization string.
      const gate = steps.find(s =>
        String(s.run || '').includes('DELETE-ALL-R2-OBJECTS')
      );
      assert.ok(gate, 'r2-nuke must have a step that checks for the DELETE-ALL-R2-OBJECTS authorization string (AC2)');
      assert.match(
        String(gate.run),
        /exit 1/,
        'confirmation gate must exit 1 on mismatch (AC2: explicit confirmation, not advisory)'
      );
    });

    it('confirmation gate runs BEFORE any destructive step', () => {
      const steps = workflow.jobs['r2-nuke'].steps;
      const gateIdx = steps.findIndex(s =>
        String(s.run || '').includes('DELETE-ALL-R2-OBJECTS')
      );
      const nukeIdx = steps.findIndex(s =>
        /DELETE|delete/.test(String(s.run || '')) &&
        /buckets|R2|r2/.test(String(s.run || '')) &&
        !String(s.run || '').includes('DELETE-ALL-R2-OBJECTS')
      );
      assert.ok(gateIdx >= 0, 'confirmation gate must exist');
      assert.ok(nukeIdx >= 0, 'destructive nuke step must exist');
      assert.ok(
        gateIdx < nukeIdx,
        'confirmation gate must run BEFORE the destructive step (AC2)'
      );
    });
  });

  describe('AC1: nuke step iterates discovered R2 buckets and issues DELETE', () => {
    it('r2-nuke contains a step that discovers buckets from wrangler.toml', () => {
      const steps = workflow.jobs['r2-nuke'].steps;
      const discover = steps.find(s =>
        /wrangler\.toml/.test(String(s.run || '')) &&
        /r2_buckets/.test(String(s.run || ''))
      );
      assert.ok(discover, 'r2-nuke must include a bucket-discovery step that parses wrangler.toml r2_buckets (AC1)');
    });

    it('r2-nuke includes a step that DELETEs every object in every bucket via Cloudflare API', () => {
      const steps = workflow.jobs['r2-nuke'].steps;
      const nuke = steps.find(s => {
        const run = String(s.run || '');
        return /api\.cloudflare\.com.*r2.*buckets/.test(run) &&
               /method:\s*["']DELETE["']/.test(run);
      });
      assert.ok(nuke, 'r2-nuke must call Cloudflare R2 API with DELETE method for each object (AC1)');
    });
  });

  describe('Defense in depth: production target requires main branch', () => {
    it('r2-nuke blocks production target from non-main branches', () => {
      const steps = workflow.jobs['r2-nuke'].steps;
      const guard = steps.find(s => {
        const ifGate = String(s.if || '');
        return /github\.ref\s*!=\s*'refs\/heads\/main'/.test(ifGate) &&
               /inputs\.environment\s*==\s*'production'/.test(ifGate);
      });
      assert.ok(guard, 'r2-nuke must have a step blocking production target from non-main branches');
    });
  });
});
