import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Gate 1 fixture deployment', () => {
  it('defines one stateless enterprise-integration Worker with no data bindings', () => {
    const config = read('fixtures/operator-gate1/wrangler.toml');
    assert.match(config, /main\s*=\s*"src\/index\.ts"/);
    assert.match(config, /workers_dev\s*=\s*true/);
    assert.doesNotMatch(config, /\[\[(kv_namespaces|durable_objects|r2_buckets|services)\]\]|\[assets\]/);
  });

  it('deploys only by explicit dispatch and provisions the independent connection secret before deploy', () => {
    const workflow = read('.github/workflows/deploy-operator-gate1.yml');
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /environment:\s*enterprise integration/);
    assert.match(workflow, /GATE1_OPERATOR_CONNECTION_SECRET/);
    assert.match(workflow, /wrangler secret put GATE1_OPERATOR_CONNECTION_SECRET/);
    assert.match(workflow, /wrangler deploy --config fixtures\/operator-gate1\/wrangler\.toml/);
    assert.doesNotMatch(workflow, /pull_request:|workflow_run:|push:/);
  });
});
