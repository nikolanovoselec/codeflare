import { SetupError, toError } from '../../lib/error-types';
import { parseCfResponse } from '../../lib/cf-api';
import { cfApiCB } from '../../lib/circuit-breakers';
import { CF_API_BASE, addStep, logger, withSetupRetry } from './shared';
import type { SetupStep } from './shared';

function buildTurnstileDomains(customDomain: string, requestUrl?: string): string[] {
  const domains = [customDomain];
  if (requestUrl) {
    try {
      const hostname = new URL(requestUrl).hostname;
      if (hostname.endsWith('.workers.dev') && hostname !== customDomain) {
        domains.push(hostname);
      }
    } catch { /* ignore invalid URL */ }
  }
  return domains;
}

interface TurnstileWidgetResult {
  sitekey: string;
  secret: string;
}

interface TurnstileWidgetSummary {
  sitekey: string;
  name?: string;
  domains?: string[];
}

function getManagedTurnstileWidgetName(workerName?: string): string {
  const trimmedWorkerName = workerName?.trim();
  return trimmedWorkerName && trimmedWorkerName.length > 0 ? trimmedWorkerName : 'codeflare';
}

function isDuplicateWidgetError(errors?: Array<{ code?: number; message?: string }>): boolean {
  if (!errors) return false;
  return errors.some((error) => {
    const message = error.message?.toLowerCase() || '';
    return message.includes('already exists') || message.includes('duplicate');
  });
}

async function listWidgets(token: string, accountId: string): Promise<TurnstileWidgetSummary[]> {
  const response = await withSetupRetry(
    () => cfApiCB.execute(() => fetch(
      `${CF_API_BASE}/accounts/${accountId}/challenges/widgets`,
      { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
    )),
    'listWidgets'
  );
  const data = await parseCfResponse<TurnstileWidgetSummary[]>(response);
  if (data.success && Array.isArray(data.result)) {
    return data.result;
  }
  return [];
}

async function rotateWidgetSecret(
  token: string,
  accountId: string,
  sitekey: string
): Promise<string | null> {
  try {
    const response = await cfApiCB.execute(() => fetch(
      `${CF_API_BASE}/accounts/${accountId}/challenges/widgets/${sitekey}/rotate_secret`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ invalidate_immediately: false }),
      }
    ));
    const data = await parseCfResponse<{ secret: string }>(response);
    if (data.success && data.result?.secret) {
      return data.result.secret;
    }
  } catch (error) {
    logger.warn('Turnstile secret rotation failed', { sitekey, error: String(error) });
  }
  return null;
}

async function updateExistingWidget(
  token: string,
  accountId: string,
  sitekey: string,
  domains: string[],
  widgetName: string
): Promise<{ sitekey: string; secret: string | null } | null> {
  const response = await withSetupRetry(
    () => cfApiCB.execute(() => fetch(
      `${CF_API_BASE}/accounts/${accountId}/challenges/widgets/${sitekey}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: widgetName,
          domains,
          mode: 'managed',
        }),
      }
    )),
    'updateWidget'
  );

  const data = await parseCfResponse<Partial<TurnstileWidgetResult>>(response);
  if (!data.success) {
    return null;
  }

  const secret = data.result?.secret || await rotateWidgetSecret(token, accountId, sitekey);
  return { sitekey, secret };
}

function findExistingWidget(
  widgets: TurnstileWidgetSummary[],
  widgetName: string,
  customDomain: string
): TurnstileWidgetSummary | null {
  const exactNameAndDomain = widgets.find((widget) =>
    widget.name === widgetName
    && Array.isArray(widget.domains)
    && widget.domains.includes(customDomain)
  );
  if (exactNameAndDomain) {
    return exactNameAndDomain;
  }

  const domainMatch = widgets.find((widget) =>
    Array.isArray(widget.domains)
    && widget.domains.includes(customDomain)
  );
  if (domainMatch) {
    return domainMatch;
  }

  const exactName = widgets.find((widget) => widget.name === widgetName);
  if (exactName) {
    return exactName;
  }

  return null;
}

/**
 * Configure a Turnstile widget for the onboarding landing page.
 * Stores the site key and secret in KV for runtime usage.
 *
 * Priority at runtime: c.env.TURNSTILE_SECRET_KEY (env var / wrangler secret)
 * is checked first; KV key `setup:turnstile_secret_key` is the fallback.
 * See src/routes/public/index.ts for the lookup logic.
 */
export async function handleConfigureTurnstile(
  token: string,
  accountId: string,
  customDomain: string,
  steps: SetupStep[],
  kv: KVNamespace,
  workerName?: string,
  requestUrl?: string
): Promise<void> {
  const stepIndex = addStep(steps, 'configure_turnstile');
  const widgetName = getManagedTurnstileWidgetName(workerName);
  const domains = buildTurnstileDomains(customDomain, requestUrl);

  try {
    const listedWidgets = await listWidgets(token, accountId);
    const existingWidget = findExistingWidget(listedWidgets, widgetName, customDomain);
    if (existingWidget?.sitekey) {
      const updated = await updateExistingWidget(
        token,
        accountId,
        existingWidget.sitekey,
        domains,
        widgetName
      );
      if (updated?.sitekey && updated.secret) {
        await kv.put('setup:turnstile_site_key', updated.sitekey);
        await kv.put('setup:turnstile_secret_key', updated.secret);
        steps[stepIndex].status = 'success';
        logger.info('Reused existing Turnstile widget', {
          domains,
          sitekey: updated.sitekey,
        });
        return;
      }
    }

    const createResponse = await withSetupRetry(
      () => cfApiCB.execute(() => fetch(
        `${CF_API_BASE}/accounts/${accountId}/challenges/widgets`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: widgetName,
            domains,
            mode: 'managed',
          }),
        }
      )),
      'createWidget'
    );

    const createData = await parseCfResponse<TurnstileWidgetResult>(createResponse);

    let resolvedSitekey: string | null = null;
    let resolvedSecret: string | null = null;

    if (createData.success && createData.result?.sitekey && createData.result?.secret) {
      resolvedSitekey = createData.result.sitekey;
      resolvedSecret = createData.result.secret;
    } else if (isDuplicateWidgetError(createData.errors)) {
      const existingWidgets = await listWidgets(token, accountId);
      const duplicateWidget = findExistingWidget(existingWidgets, widgetName, customDomain);
      if (duplicateWidget?.sitekey) {
        const updated = await updateExistingWidget(
          token,
          accountId,
          duplicateWidget.sitekey,
          domains,
          widgetName
        );
        if (updated) {
          resolvedSitekey = updated.sitekey;
          resolvedSecret = updated.secret;
        }
      }
    } else {
      const err = createData.errors?.[0]?.message || 'Failed to create Turnstile widget';
      steps[stepIndex].status = 'error';
      steps[stepIndex].error = err;
      throw new SetupError(err, steps);
    }

    if (!resolvedSitekey) {
      const err = 'Failed to resolve Turnstile widget';
      steps[stepIndex].status = 'error';
      steps[stepIndex].error = err;
      throw new SetupError(err, steps);
    }

    if (!resolvedSecret) {
      const secretFromKv = await kv.get('setup:turnstile_secret_key');
      if (secretFromKv) {
        resolvedSecret = secretFromKv;
      }
    }

    if (!resolvedSecret) {
      const err = 'Failed to resolve Turnstile widget secret';
      steps[stepIndex].status = 'error';
      steps[stepIndex].error = err;
      throw new SetupError(err, steps);
    }

    await kv.put('setup:turnstile_site_key', resolvedSitekey);
    await kv.put('setup:turnstile_secret_key', resolvedSecret);
    steps[stepIndex].status = 'success';
    logger.info('Configured Turnstile widget', {
      domains,
      sitekey: resolvedSitekey,
    });
  } catch (err) {
    if (err instanceof SetupError) {
      throw err;
    }
    logger.error('Failed to configure Turnstile', toError(err));
    steps[stepIndex].status = 'error';
    steps[stepIndex].error = 'Failed to configure Turnstile';
    throw new SetupError('Failed to configure Turnstile', steps);
  }
}
