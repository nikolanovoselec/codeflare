import { SetupError, toError } from '../../lib/error-types';
import { parseCfResponse } from '../../lib/cf-api';
import { cfApiCB } from '../../lib/circuit-breakers';
import { CF_API_BASE, logger, getWorkerNameFromHostname, addStep } from './shared';
import type { SetupStep } from './shared';

/**
 * Deploy the latest worker version so that the standard secrets API can be used.
 * This is needed when `wrangler versions upload` (code-only) was used instead of
 * `wrangler deploy`, leaving the latest version in a non-deployed state.
 * Endpoint: POST /accounts/{accountId}/workers/scripts/{scriptName}/deployments
 */
async function deployLatestVersion(
  token: string,
  accountId: string,
  workerName: string
): Promise<boolean> {
  try {
    // 1. List versions to get the latest version ID
    const versionsRes = await cfApiCB.execute(() => fetch(
      `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}/versions`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    ));
    const versionsData = await parseCfResponse<{ items?: Array<{ id: string }> }>(versionsRes);

    if (!versionsData.success || !versionsData.result?.items?.length) {
      logger.error('Failed to list worker versions', new Error(JSON.stringify(versionsData)));
      return false;
    }

    const latestVersionId = versionsData.result.items[0].id;

    // 2. Create a deployment with the latest version at 100% traffic
    const deployRes = await cfApiCB.execute(() => fetch(
      `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}/deployments`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          strategy: 'percentage',
          versions: [{ version_id: latestVersionId, percentage: 100 }]
        })
      }
    ));

    if (!deployRes.ok) {
      const errBody = await deployRes.text();
      logger.error('Failed to deploy latest version', new Error(`${deployRes.status}: ${errBody}`));
      return false;
    }

    return true;
  } catch (err) {
    logger.error('Error deploying latest version', toError(err));
    return false;
  }
}

/**
 * Set a single worker secret via the standard API.
 * Returns the response and parsed error codes (if any).
 */
async function putSecret(
  token: string,
  accountId: string,
  workerName: string,
  name: string,
  value: string
): Promise<{ ok: boolean; errorCode?: number; status: number }> {
  const res = await cfApiCB.execute(() => fetch(
    `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}/secrets`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, text: value, type: 'secret_text' })
    }
  ));

  if (res.ok) {
    return { ok: true, status: res.status };
  }

  // Parse error body to extract Cloudflare error code
  try {
    const errData = await res.json() as {
      errors?: Array<{ code: number; message: string }>;
    };
    const cfErrorCode = errData.errors?.[0]?.code;
    return { ok: false, errorCode: cfErrorCode, status: res.status };
  } catch {
    return { ok: false, status: res.status };
  }
}

// Error code returned when the latest worker version is not deployed
const VERSION_NOT_DEPLOYED_ERR_CODE = 10215;

/**
 * Step 3: Set worker secrets (R2 credentials)
 *
 * Uses the standard secrets API (PUT .../secrets). If Cloudflare returns
 * error 10215 (latest version not deployed — common after `wrangler versions upload`),
 * falls back by deploying the latest version first, then retrying.
 *
 * Note: CLOUDFLARE_API_TOKEN is NOT set here — it's already set by GitHub Actions.
 */
export async function handleSetSecrets(
  token: string,
  accountId: string,
  r2AccessKeyId: string,
  r2SecretAccessKey: string,
  requestUrl: string,
  steps: SetupStep[],
  envWorkerName?: string
): Promise<void> {
  const stepIndex = addStep(steps, 'set_secrets');
  // Extract worker name from the request hostname
  const workerName = getWorkerNameFromHostname(requestUrl, envWorkerName);

  const secrets = {
    R2_ACCESS_KEY_ID: r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: r2SecretAccessKey,
  };

  try {
    let deployedLatestVersion = false;

    for (const [name, value] of Object.entries(secrets)) {
      let result = await putSecret(token, accountId, workerName, name, value);

      // If error 10215 (version not deployed), deploy the latest version and retry
      if (!result.ok && result.errorCode === VERSION_NOT_DEPLOYED_ERR_CODE && !deployedLatestVersion) {
        logger.info(`Secret API returned error ${VERSION_NOT_DEPLOYED_ERR_CODE}, deploying latest version first`);
        const deployed = await deployLatestVersion(token, accountId, workerName);
        deployedLatestVersion = true;

        if (deployed) {
          // Retry the secret after deploying
          result = await putSecret(token, accountId, workerName, name, value);
        }
      }

      if (!result.ok) {
        logger.error('Failed to set worker secret', new Error(`status: ${result.status}, errorCode: ${result.errorCode}`), {
          secretName: name,
          workerName,
          status: result.status,
          errorCode: result.errorCode,
        });
        steps[stepIndex].status = 'error';
        steps[stepIndex].error = 'Failed to configure worker secrets';
        throw new SetupError('Failed to configure worker secrets', steps);
      }
    }
    steps[stepIndex].status = 'success';
  } catch (err) {
    if (err instanceof SetupError) {
      throw err;
    }
    logger.error('Failed to set secrets', toError(err));
    steps[stepIndex].status = 'error';
    steps[stepIndex].error = 'Failed to configure worker secrets';
    throw new SetupError('Failed to configure worker secrets', steps);
  }
}
