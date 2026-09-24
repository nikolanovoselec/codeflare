import { describe, expect, it } from 'vitest';
import { verifyBoundedBoundaryInput } from '../../operators/boundary-input';

const prior = 'a'.repeat(40);
const head = 'b'.repeat(40);
const context = { repositoryId: 138, pullRequest: 34, head };
const opaque = { range: `${prior}..${head}`, rejectedFindings: [{ id: 'finding-one',
  originalEvidenceRef: 'review-138-34-round-1:code-reviewer:finding-one',
  rejectionReason: 'The owner check guards the whole operation, not only the route.' }] };
const input = { repositoryId: 138, pullRequest: 34, acknowledgedHead: prior, targetHead: head, payload: opaque };

describe('REQ-OPERATOR-053: Codeflare treats boundary evidence as bounded data, not policy or principal', () => {
  it('preserves the entire package-owned input after independently verifying exact repository/PR/head and acknowledgement ancestry', async () => {
    const verified = await verifyBoundedBoundaryInput(input, context, async (from, to) => from === prior && to === head);
    expect(verified).toEqual(input);
    expect(verified.payload).toEqual(opaque);
  });
  it('allows an explicit first-review submission without inventing an acknowledged head', async () => {
    expect(await verifyBoundedBoundaryInput({ ...input, acknowledgedHead: null }, context, async () => false))
      .toMatchObject({ acknowledgedHead: null, payload: opaque });
  });
  it('denies different PR/head, nonancestor acknowledgement, oversized data and caller identity substitution', async () => {
    for (const value of [
      { ...input, repositoryId: 139 }, { ...input, pullRequest: 35 },
      { ...input, targetHead: 'd'.repeat(40) }, { ...input, accessJwt: 'forged' },
      { ...input, payload: { ...opaque, reasoning: 'x'.repeat(70_000) } },
    ]) await expect(verifyBoundedBoundaryInput(value, context, async () => true)).rejects.toThrow();
    await expect(verifyBoundedBoundaryInput(input, context, async () => false)).rejects.toThrow();
    await expect(verifyBoundedBoundaryInput({ ...input, acknowledgedHead: head }, context, async () => true)).rejects.toThrow();
  });
});
