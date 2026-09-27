import { describe, expect, it } from 'vitest';
import { parseOperatorPiInitialization } from '../../operators/session-initialization';

const attachments = { schemaVersion: 1 as const, activityId: 'activity-one', files: [
  { name: 'packet-code.json', locator: 'packet-one', mediaType: 'application/json',
    size: 12, sha256: 'a'.repeat(64) },
] };
const resources = { schemaVersion: 1 as const, artifactDigest: 'b'.repeat(64), files: [
  { destination: 'review/parent.md', content: 'parent', size: 6, sha256: 'c'.repeat(64) },
  { destination: 'review/code.md', content: 'child', size: 5, sha256: 'd'.repeat(64) },
] };
const owner = { profileId: 'approved-profile', attachments, resources };
const initialization = { schemaVersion: 1, profileId: 'approved-profile', contextPath: 'review/input.json',
  context: JSON.stringify({ packetDigest: 'e'.repeat(64), head: 'f'.repeat(40) }),
  inputs: [
    { kind: 'attachment', reference: 'packet-code.json', target: 'review/packets/code.json' },
    { kind: 'resource', reference: 'review/parent.md', target: 'review/resources/parent.md' },
    { kind: 'resource', reference: 'review/code.md', target: 'review/resources/code.md' },
  ],
  tasks: [{ id: 'code', instruction: 'review/resources/code.md',
    reads: ['review/input.json', 'review/packets/code.json', 'review/resources/parent.md', 'review/resources/code.md'],
    output: 'reports/code.json' }],
};

describe('REQ-OPERATOR-021: finite parent-approved Pi initialization', () => {
  it('accepts a complete installed profile and immutable attachment/resource references', () => {
    expect(parseOperatorPiInitialization(initialization, owner)).toEqual(initialization);
  });
  it('denies substituted profiles, undeclared sources and omitted approved attachments', () => {
    for (const candidate of [
      { ...initialization, profileId: 'other-profile' },
      { ...initialization, inputs: [{ ...initialization.inputs[0], reference: 'unapproved.json' },
        ...initialization.inputs.slice(1)] },
      { ...initialization, inputs: initialization.inputs.slice(1) },
      { ...initialization, inputs: [...initialization.inputs, { kind: 'resource',
        reference: 'review/unapproved.md', target: 'review/resources/unapproved.md' }] },
    ]) expect(() => parseOperatorPiInitialization(candidate, owner)).toThrow();
    expect(() => parseOperatorPiInitialization(initialization, { ...owner, attachments: {
      ...attachments, files: [...attachments.files, { ...attachments.files[0], name: 'packet-extra.json', locator: 'packet-two' }],
    } })).toThrow();
  });
  it('denies traversal, absolute paths, overlapping writes, duplicate task IDs and unreferenced reads', () => {
    for (const candidate of [
      { ...initialization, inputs: [{ ...initialization.inputs[0], target: 'review/../auth.json' },
        ...initialization.inputs.slice(1)] },
      { ...initialization, inputs: [{ ...initialization.inputs[0], target: '/home/user/secret' },
        ...initialization.inputs.slice(1)] },
      { ...initialization, inputs: [{ ...initialization.inputs[0], target: initialization.contextPath },
        ...initialization.inputs.slice(1)] },
      { ...initialization, tasks: [{ ...initialization.tasks[0], reads: ['review/hidden.json'] }] },
      { ...initialization, tasks: [{ ...initialization.tasks[0], output: 'review/resources/code.md' }] },
      { ...initialization, tasks: [initialization.tasks[0], initialization.tasks[0]] },
      { ...initialization, tasks: [{ ...initialization.tasks[0], instruction: 'review/packets/code.json' }] },
    ]) expect(() => parseOperatorPiInitialization(candidate, owner)).toThrow();
  });
  it('bounds context, task and source count and rejects extra authority fields', () => {
    for (const candidate of [
      { ...initialization, context: 'x'.repeat(4097) },
      { ...initialization, tasks: Array.from({ length: 9 }, (_, index) => ({
        ...initialization.tasks[0], id: `lane-${index}`, output: `reports/${index}.json`,
      })) },
      { ...initialization, githubToken: 'unauthorized' },
    ]) expect(() => parseOperatorPiInitialization(candidate, owner)).toThrow();
  });
});
