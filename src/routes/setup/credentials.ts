import { SetupError, toError } from '../../lib/error-types';
import { parseCfResponse } from '../../lib/cf-api';
import { cfApiCB } from '../../lib/circuit-breakers';
import { CF_API_BASE, logger, addStep } from './shared';
import type { SetupStep } from './shared';

/**
 * Step 2: Derive R2 S3-compatible credentials from the user's API token.
 *
 * Cloudflare R2 S3 API credentials are derived from regular API tokens:
 *   - S3 Access Key ID = API token ID (from /user/tokens/verify)
 *   - S3 Secret Access Key = SHA-256 hash of the API token value
 *
 * This avoids needing "API Tokens Edit" permission to create a separate R2 token.
 */
export async function handleDeriveR2Credentials(
  token: string,
  steps: SetupStep[]
): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const stepIndex = addStep(steps, 'derive_r2_credentials');

  try {
    // Get the token ID from the verify endpoint
    const verifyRes = await cfApiCB.execute(() => fetch(`${CF_API_BASE}/user/tokens/verify`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    }));
    const verifyData = await parseCfResponse<{ id: string; status: string }>(verifyRes);

    if (!verifyData.success || !verifyData.result?.id) {
      const rawError = verifyData.errors?.map(e => e.message).join(', ') || 'Token verification failed';
      logger.error('Failed to derive R2 credentials', new Error(rawError));
      steps[stepIndex].status = 'error';
      steps[stepIndex].error = 'Failed to derive R2 credentials';
      throw new SetupError('Failed to derive R2 credentials', steps);
    }

    const tokenId = verifyData.result.id;

    // Derive S3 Secret Access Key = SHA-256(token value)
    const encoder = new TextEncoder();
    const data = encoder.encode(token);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const secretAccessKey = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    steps[stepIndex].status = 'success';
    return {
      accessKeyId: tokenId,
      secretAccessKey
    };
  } catch (err) {
    if (err instanceof SetupError) {
      throw err;
    }
    logger.error('Failed to derive R2 credentials', toError(err));
    steps[stepIndex].status = 'error';
    steps[stepIndex].error = 'Failed to derive R2 credentials';
    throw new SetupError('Failed to derive R2 credentials', steps);
  }
}
