import { SetupError, toError } from '../../lib/error-types';
import { parseCfResponse } from '../../lib/cf-api';
import { cfApiCB } from '../../lib/circuit-breakers';
import { CF_API_BASE, logger, addStep, withSetupRetry } from './shared';
import type { SetupStep } from './shared';

/**
 * Step 1: Get account ID from Cloudflare API
 */
export async function handleGetAccount(
  token: string,
  steps: SetupStep[]
): Promise<string> {
  const stepIndex = addStep(steps, 'get_account');

  try {
    const accountsRes = await withSetupRetry(
      () => cfApiCB.execute(() => fetch(`${CF_API_BASE}/accounts`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      })),
      'getAccount'
    );
    const accountsData = await parseCfResponse<Array<{ id: string }>>(accountsRes);

    if (!accountsData.success || !accountsData.result?.length) {
      steps[stepIndex].status = 'error';
      steps[stepIndex].error = 'Failed to get account';
      throw new SetupError('Failed to get account', steps);
    }

    steps[stepIndex].status = 'success';
    return accountsData.result[0].id;
  } catch (err) {
    if (err instanceof SetupError) {
      throw err;
    }
    logger.error('Failed to get account', toError(err));
    steps[stepIndex].status = 'error';
    steps[stepIndex].error = 'Failed to connect to Cloudflare API';
    throw new SetupError('Failed to connect to Cloudflare API', steps);
  }
}
