import type { Env } from '../types';

export type ReviewEnrollment = 'local' | 'remote-candidate' | 'unavailable';
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Read enrollment only; this never grants remote execution or review clearance. */
export async function selectReviewEnrollment(
  env: Pick<Env, 'OPERATOR_REGISTRY'>,
  repository: string,
): Promise<ReviewEnrollment> {
  if (!repositoryName.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) {
    return 'unavailable';
  }
  if (!env.OPERATOR_REGISTRY) return 'local';
  try {
    const controls = await env.OPERATOR_REGISTRY.getByName('registry').getManagementControls();
    const actions = controls.boundaryActions ?? [];
    if (!Array.isArray(actions)) return 'unavailable';
    let candidate = false;
    for (const action of actions) {
      if (!action || typeof action !== 'object') return 'unavailable';
      if (action.enabled === false) continue;
      if (action.enabled !== undefined && action.enabled !== true) return 'unavailable';
      // Older enrolled records lack a name: absence cannot be inferred from them.
      if (action.repository === undefined) candidate = true;
      else if (!repositoryName.test(action.repository)) return 'unavailable';
      else if (action.repository.toLowerCase() === repository.toLowerCase()) candidate = true;
    }
    return candidate ? 'remote-candidate' : 'local';
  } catch { return 'unavailable'; }
}
