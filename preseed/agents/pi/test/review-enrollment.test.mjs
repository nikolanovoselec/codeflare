import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectReviewEnrollment } from '../../../../src/operators/review-enrollment.ts';

const action = { repositoryId: 138, repository: 'owner/repo', protectedRef: 'refs/heads/main', enabled: true };
const environment = actions => ({ OPERATOR_REGISTRY: { getByName: () => ({
  getManagementControls: async () => ({ boundaryActions: actions }),
}) } });

for (const [name, actions] of [
  ['absent', undefined], ['empty', []], ['disabled', [{ ...action, enabled: false }]],
  ['another repository', [{ ...action, repository: 'someone/else' }]],
]) {
  test(`REQ-OPERATOR-053: ${name} enrollment is local without GitHub or Conductor`, async () => {
    assert.equal(await selectReviewEnrollment(environment(actions), 'owner/repo'), 'local');
  });
}

test('REQ-OPERATOR-053: absent Registry preserves ordinary local Review', async () => {
  assert.equal(await selectReviewEnrollment({}, 'owner/repo'), 'local');
});

test('REQ-OPERATOR-053: enabled matching enrollment is only a remote candidate', async () => {
  assert.equal(await selectReviewEnrollment(environment([action]), 'OWNER/Repo'), 'remote-candidate');
});

test('REQ-OPERATOR-053: legacy enabled enrollment without repository identity remains uncertain', async () => {
  const { repository, ...legacy } = action;
  assert.equal(await selectReviewEnrollment(environment([legacy]), 'owner/repo'), 'remote-candidate');
});

test('REQ-OPERATOR-053: Registry failure cannot prove absent enrollment', async () => {
  const env = { OPERATOR_REGISTRY: { getByName: () => ({
    getManagementControls: async () => { throw new Error('Unavailable'); },
  }) } };
  assert.equal(await selectReviewEnrollment(env, 'owner/repo'), 'unavailable');
});

test('REQ-OPERATOR-053: malformed enrollment cannot prove absence', async () => {
  assert.equal(await selectReviewEnrollment(environment('invalid'), 'owner/repo'), 'unavailable');
  assert.equal(await selectReviewEnrollment(environment([null]), 'owner/repo'), 'unavailable');
});

for (const repository of ['', '../repo', 'https://github.com/owner/repo', 'owner/repo/extra']) {
  test(`REQ-OPERATOR-053: invalid repository ${JSON.stringify(repository)} is unavailable`, async () => {
    assert.equal(await selectReviewEnrollment(environment([]), repository), 'unavailable');
  });
}
