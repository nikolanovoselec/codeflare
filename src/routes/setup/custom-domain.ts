import { ValidationError, SetupError, toError, toErrorMessage } from '../../lib/error-types';
import { parseCfResponse } from '../../lib/cf-api';
import { cfApiCB } from '../../lib/circuit-breakers';
import { CF_API_BASE, logger, getWorkerNameFromHostname, detectCloudflareAuthError, addStep, withSetupRetry } from './shared';
import type { SetupStep } from './shared';

/**
 * Resolve the Cloudflare zone ID for a given domain.
 * Looks up the zone by the root domain (last two parts of the FQDN).
 */
async function resolveZone(
  token: string,
  domain: string,
  steps: SetupStep[],
  stepIndex: number
): Promise<string> {
  // Try progressively shorter domain suffixes to support ccTLDs (.co.uk, .com.au, etc.)
  // For "app.example.co.uk", try: "app.example.co.uk", "example.co.uk", "co.uk"
  const domainParts = domain.split('.');
  const candidates: string[] = [];
  for (let i = 0; i < domainParts.length - 1; i++) {
    candidates.push(domainParts.slice(i).join('.'));
  }

  for (const zoneName of candidates) {
    let zonesRes: Response;
    try {
      zonesRes = await cfApiCB.execute(() => fetch(
        `${CF_API_BASE}/zones?name=${zoneName}`,
        { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
      ));
    } catch (err) {
      logger.error('Failed to fetch zones API', toError(err));
      steps[stepIndex].status = 'error';
      steps[stepIndex].error = 'Failed to connect to Cloudflare Zones API';
      throw new SetupError('Failed to connect to Cloudflare Zones API', steps);
    }

    const zonesData = await parseCfResponse<Array<{ id: string }>>(zonesRes);

    if (!zonesData.success) {
      const cfErrors = zonesData.errors || [];
      const errorMessages = cfErrors.map(e => `${e.code}: ${e.message}`).join(', ');

      const authError = detectCloudflareAuthError(zonesRes.status, cfErrors);
      if (authError) {
        const permError = 'API token lacks Zone permissions required for custom domain configuration. '
          + 'Add "Zone > Zone > Read", "Zone > DNS > Edit", and "Zone > Workers Routes > Edit" permissions to your token, '
          + 'or skip custom domain setup.';
        steps[stepIndex].status = 'error';
        steps[stepIndex].error = permError;
        throw new SetupError(permError, steps);
      }

      // Log the error but continue trying shorter suffixes
      logger.warn('Cloudflare Zones API error for candidate', {
        zoneName,
        status: zonesRes.status,
        errors: cfErrors,
      });
      continue;
    }

    if (zonesData.result?.length) {
      return zonesData.result[0].id;
    }
  }

  // None of the candidates matched
  steps[stepIndex].status = 'error';
  steps[stepIndex].error = `Zone not found for domain: ${domain}`;
  throw new SetupError(`Zone not found for domain: ${domain}`, steps);
}

/**
 * Resolve the account subdomain for workers.dev DNS target.
 * First tries the Cloudflare API, then falls back to parsing the request hostname.
 */
async function resolveAccountSubdomain(
  token: string,
  accountId: string,
  requestUrl: string
): Promise<string> {
  const subdomainRes = await cfApiCB.execute(() => fetch(
    `${CF_API_BASE}/accounts/${accountId}/workers/subdomain`,
    { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
  ));
  const subdomainData = await parseCfResponse<{ subdomain: string }>(subdomainRes);

  if (subdomainData.success && subdomainData.result?.subdomain) {
    return subdomainData.result.subdomain;
  }

  // Fallback: parse from request hostname
  const hostname = new URL(requestUrl).hostname;
  if (hostname.endsWith('.workers.dev')) {
    const parts = hostname.split('.');
    if (parts.length >= 3) {
      logger.warn('Subdomain API failed, falling back to hostname parsing', {
        hostname,
        subdomain: parts[parts.length - 3],
      });
      return parts[parts.length - 3];
    }
  }

  throw new SetupError('Could not determine account subdomain from API or hostname', []);
}

/**
 * Create or update a DNS CNAME record pointing the custom domain to the workers.dev target.
 * Resolves the account subdomain, looks up existing records, and performs upsert.
 */
async function upsertDnsRecord(
  token: string,
  accountId: string,
  zoneId: string,
  domain: string,
  workerName: string,
  requestUrl: string,
  steps: SetupStep[],
  stepIndex: number
): Promise<void> {
  // Resolve account subdomain for workers.dev target
  let accountSubdomain: string;
  try {
    accountSubdomain = await resolveAccountSubdomain(token, accountId, requestUrl);
  } catch (err) {
    logger.error('Failed to get account subdomain', toError(err));
    steps[stepIndex].status = 'error';
    steps[stepIndex].error = 'Failed to determine workers.dev subdomain for DNS record';
    throw new SetupError('Failed to determine workers.dev subdomain for DNS record', steps);
  }

  const workersDevTarget = `${workerName}.${accountSubdomain}.workers.dev`;
  const domainParts = domain.split('.');
  const subdomain = domainParts.length > 2 ? domainParts.slice(0, -2).join('.') : '@';

  // Check if DNS record already exists
  let existingDnsRecordId: string | null = null;
  try {
    const dnsLookupRes = await withSetupRetry(
      () => cfApiCB.execute(() => fetch(
        `${CF_API_BASE}/zones/${zoneId}/dns_records?name=${domain}`,
        { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
      )),
      'dnsRecordLookup'
    );
    const dnsLookupData = await parseCfResponse<Array<{ id: string; type: string }>>(dnsLookupRes);
    if (dnsLookupData.success && dnsLookupData.result?.length) {
      const cnameRecord = dnsLookupData.result.find(r => r.type === 'CNAME');
      existingDnsRecordId = cnameRecord?.id || dnsLookupData.result[0]?.id || null;
      if (existingDnsRecordId) {
        logger.info('Found existing DNS record, will update', { domain, recordId: existingDnsRecordId });
      }
    }
  } catch (lookupError) {
    logger.warn('DNS record lookup failed, falling back to create', {
      domain,
      error: toErrorMessage(lookupError)
    });
  }

  // Use PUT to update existing record, or POST to create new one
  const dnsMethod = existingDnsRecordId ? 'PUT' : 'POST';
  const dnsUrl = existingDnsRecordId
    ? `${CF_API_BASE}/zones/${zoneId}/dns_records/${existingDnsRecordId}`
    : `${CF_API_BASE}/zones/${zoneId}/dns_records`;

  const dnsRecordRes = await withSetupRetry(
    () => cfApiCB.execute(() => fetch(
      dnsUrl,
      {
        method: dnsMethod,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'CNAME',
          name: subdomain,
          content: workersDevTarget,
          proxied: true
        }),
        signal: AbortSignal.timeout(10000),
      }
    )),
    'dnsRecordUpsert'
  );

  if (!dnsRecordRes.ok) {
    const dnsError = await parseCfResponse(dnsRecordRes);
    // Record might already exist - that's OK (code 81057) - only relevant for POST
    if (dnsMethod === 'POST' && dnsError.errors?.some(e => e.code === 81057)) {
      logger.info('DNS record already exists (detected via create error)', { domain, subdomain, target: workersDevTarget });
    } else {
      const dnsErrMsg = dnsError.errors?.[0]?.message || 'unknown';
      logger.error('DNS record configuration failed', new Error(dnsErrMsg), {
        domain,
        subdomain,
        target: workersDevTarget,
        zoneId,
        method: dnsMethod,
        status: dnsRecordRes.status,
        errors: dnsError.errors,
      });

      const authError = detectCloudflareAuthError(dnsRecordRes.status, dnsError.errors || []);
      if (authError) {
        const permError = 'API token lacks DNS permissions required for custom domain configuration. '
          + 'Add "Zone > DNS > Edit" permission to your token, or skip custom domain setup.';
        steps[stepIndex].status = 'error';
        steps[stepIndex].error = permError;
        throw new SetupError(permError, steps);
      }

      steps[stepIndex].status = 'error';
      steps[stepIndex].error = 'Failed to configure DNS record';
      throw new SetupError('Failed to configure DNS record', steps);
    }
  } else {
    logger.info(`DNS record ${existingDnsRecordId ? 'updated' : 'created'}`, { domain, subdomain, target: workersDevTarget });
  }
}

/**
 * Create a worker route mapping the custom domain pattern to the worker script.
 * Silently succeeds if the route already exists (error code 10020).
 */
async function createWorkerRoute(
  token: string,
  zoneId: string,
  domain: string,
  workerName: string,
  steps: SetupStep[],
  stepIndex: number
): Promise<void> {
  const desiredPattern = `${domain}/*`;
  const createRoutePayload = {
    pattern: desiredPattern,
    script: workerName
  };

  const tryUpdateExistingRoute = async (): Promise<boolean> => {
    try {
      const listRes = await cfApiCB.execute(() => fetch(
        `${CF_API_BASE}/zones/${zoneId}/workers/routes`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
          signal: AbortSignal.timeout(10000),
        }
      ));
      const listData = await parseCfResponse<Array<{ id: string; pattern: string; script?: string }>>(listRes);
      if (!listData.success || !listData.result?.length) {
        return false;
      }

      const exactMatch = listData.result.find((route) => route.pattern === desiredPattern);
      const domainMatches = listData.result.filter((route) =>
        route.pattern === domain || route.pattern.startsWith(`${domain}/`)
      );
      const sameScriptDomainMatch = domainMatches.find((route) => route.script === workerName);
      const fallbackDomainMatch = !sameScriptDomainMatch && domainMatches.length === 1
        ? domainMatches[0]
        : null;
      const existingRoute = exactMatch || sameScriptDomainMatch || fallbackDomainMatch;

      if (!existingRoute?.id) {
        if (domainMatches.length > 1 && !sameScriptDomainMatch) {
          logger.warn('Multiple domain-matching worker routes found and none match target script', {
            domain,
            workerName,
            routeCount: domainMatches.length,
          });
        }
        return false;
      }

      const updateRes = await cfApiCB.execute(() => fetch(
        `${CF_API_BASE}/zones/${zoneId}/workers/routes/${existingRoute.id}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(createRoutePayload),
          signal: AbortSignal.timeout(10000),
        }
      ));
      if (updateRes.ok) {
        logger.info('Worker route updated', { domain, routeId: existingRoute.id, script: workerName });
        return true;
      }
      const updateError = await parseCfResponse(updateRes);
      logger.warn('Worker route update failed after existing route detection', {
        domain,
        routeId: existingRoute.id,
        errors: updateError.errors,
      });
      return false;
    } catch (error) {
      logger.warn('Worker route lookup/update failed', { domain, error: toErrorMessage(error) });
      return false;
    }
  };

  const routeRes = await withSetupRetry(
    () => cfApiCB.execute(() => fetch(
      `${CF_API_BASE}/zones/${zoneId}/workers/routes`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(createRoutePayload),
        signal: AbortSignal.timeout(10000),
      }
    )),
    'workerRouteCreate'
  );

  if (routeRes.ok) {
    return;
  }

  const routeError = await parseCfResponse(routeRes);
  const routeAlreadyExists = routeError.errors?.some(e => e.code === 10020)
    || routeError.errors?.some(e => e.message?.toLowerCase().includes('already exists'));

  if (routeAlreadyExists) {
    const updated = await tryUpdateExistingRoute();
    if (updated) {
      return;
    }
    // If route exists but update path failed, don't hard-fail setup.
    // Existing route is still in place and will continue routing traffic.
    logger.warn('Worker route already exists and could not be updated, continuing setup', {
      domain,
      zoneId,
      script: workerName,
    });
    return;
  }

  const routeErrMsg = routeError.errors?.[0]?.message || 'unknown';
  logger.error('Worker route creation failed', new Error(routeErrMsg), {
    domain,
    zoneId,
    status: routeRes.status,
    errors: routeError.errors,
  });

  const authError = detectCloudflareAuthError(routeRes.status, routeError.errors || []);
  if (authError) {
    const permError = 'API token lacks Zone permissions required for worker route creation. '
      + 'Add "Zone > Workers Routes > Edit" permission to your token, or skip custom domain setup.';
    steps[stepIndex].status = 'error';
    steps[stepIndex].error = permError;
    throw new SetupError(permError, steps);
  }

  steps[stepIndex].status = 'error';
  steps[stepIndex].error = 'Failed to configure worker route';
  throw new SetupError('Failed to configure worker route', steps);
}

/**
 * Step 4: Configure custom domain with DNS CNAME record and worker route.
 * Orchestrates zone resolution, DNS upsert, and worker route creation.
 */
export async function handleConfigureCustomDomain(
  token: string,
  accountId: string,
  customDomain: string,
  requestUrl: string,
  steps: SetupStep[],
  envWorkerName?: string
): Promise<string> {
  const stepIndex = addStep(steps, 'configure_custom_domain');

  // Validate domain format before making any API calls
  const domainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
  if (!domainRegex.test(customDomain)) {
    steps[stepIndex].status = 'error';
    steps[stepIndex].error = 'Invalid domain format';
    throw new ValidationError('Invalid domain format');
  }

  // Resolve zone ID for the custom domain
  const zoneId = await resolveZone(token, customDomain, steps, stepIndex);

  // Extract worker name from request hostname
  const workerName = getWorkerNameFromHostname(requestUrl, envWorkerName);

  // Create or update DNS CNAME record pointing to workers.dev
  await upsertDnsRecord(token, accountId, zoneId, customDomain, workerName, requestUrl, steps, stepIndex);

  // Add worker route for custom domain
  await createWorkerRoute(token, zoneId, customDomain, workerName, steps, stepIndex);

  steps[stepIndex].status = 'success';
  return zoneId;
}
