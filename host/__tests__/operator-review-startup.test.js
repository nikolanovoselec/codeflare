import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { materializeOperatorInputs } from '../../scripts/materialize-operator-inputs.mjs';

const lanes = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'review-startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactDigest = 'a'.repeat(64);
  const resourceRoot = path.join(root, 'operator-resources');
  const work = path.join(root, 'work');
  mkdirSync(path.join(resourceRoot, artifactDigest, 'review'), { recursive: true });
  mkdirSync(path.join(resourceRoot, 'input'), { recursive: true });
  mkdirSync(work);
  const files = [];
  for (const name of ['parent', ...lanes]) {
    const content = `Approved ${name} instructions`;
    const destination = `review/${name}.md`;
    files.push({ destination, content, size: Buffer.byteLength(content), sha256: sha(content) });
    writeFileSync(path.join(resourceRoot, artifactDigest, destination), content);
  }
  const attachments = [];
  for (const lane of lanes) {
    const name = `packet-${lane}.json`;
    const content = JSON.stringify({ lane, evidence: 'prepared' });
    writeFileSync(path.join(resourceRoot, 'input', name), content);
    attachments.push({ name, locator: `packet-${lane}`, mediaType: 'application/json', size: Buffer.byteLength(content), sha256: sha(content) });
  }
  const context = { packetDigest: 'b'.repeat(64), head: 'c'.repeat(40), generation: 2 };
  const config = { schemaVersion: 1, activityId: 'activity-1', sessionId: 'session-1',
    root: path.join(root, 'operator'), mode: 'isolated', deadline: Date.now() + 60_000,
    initialization: { schemaVersion: 1, profileId: 'approved-profile',
      contextPath: 'review/input.json', context: JSON.stringify(context),
      inputs: [
        ...attachments.map(file => ({ kind: 'attachment', reference: file.name,
          target: `review/packets/${file.name.slice('packet-'.length)}` })),
        ...files.map(file => ({ kind: 'resource', reference: file.destination,
          target: `review/resources/${path.basename(file.destination)}` })),
      ],
      tasks: lanes.map(lane => ({ id: lane, instruction: `review/resources/${lane}.md`,
        reads: ['review/input.json', `review/packets/${lane}.json`, `review/resources/${lane}.md`],
        output: `reports/${lane}.json` })),
    } };
  return { config, work, resourceRoot, resources: { schemaVersion: 1, artifactDigest, files },
    attachments: { schemaVersion: 1, activityId: config.activityId, files: attachments } };
}

test('REQ-OPERATOR-021: stages the approved packets/resources at the actual restricted Pi paths before readiness', t => {
  const f = fixture(t);
  materializeOperatorInputs(f);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.work, 'review/input.json'), 'utf8')),
    JSON.parse(f.config.initialization.context));
  for (const lane of lanes) {
    assert.equal(readFileSync(path.join(f.work, `review/packets/${lane}.json`), 'utf8'),
      readFileSync(path.join(f.resourceRoot, 'input', `packet-${lane}.json`), 'utf8'));
    assert.equal(readFileSync(path.join(f.work, `review/resources/${lane}.md`), 'utf8'),
      `Approved ${lane} instructions`);
  }
  assert.equal(readFileSync(path.join(f.work, 'review/resources/parent.md'), 'utf8'), 'Approved parent instructions');
});

test('REQ-OPERATOR-021: corrupt/missing/linked restored evidence prevents any staged reviewer input', t => {
  for (const kind of ['corrupt', 'missing', 'linked']) {
    const f = fixture(t);
    const target = path.join(f.resourceRoot, 'input/packet-code-reviewer.json');
    if (kind === 'corrupt') writeFileSync(target, 'tampered');
    if (kind === 'missing') rmSync(target);
    if (kind === 'linked') {
      rmSync(target);
      symlinkSync(path.join(f.resourceRoot, 'input/packet-spec-reviewer.json'), target);
    }
    assert.throws(() => materializeOperatorInputs(f));
    assert.throws(() => readFileSync(path.join(f.work, 'review/input.json')));
  }
});

test('REQ-OPERATOR-021: forged package resources cannot replace the approved reviewer instructions', t => {
  const f = fixture(t);
  f.resources.files[1].content = 'unapproved';
  assert.throws(() => materializeOperatorInputs(f));
  assert.throws(() => readFileSync(path.join(f.work, 'review/input.json')));
});
