import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createR2Client, getR2Url, parseListObjectsXml } from '../../lib/r2-client';
import { getR2Config } from '../../lib/r2-config';
import { createRateLimiter } from '../../middleware/rate-limit';
import { ContainerError } from '../../lib/error-types';
import { createLogger } from '../../lib/logger';
import { getTierConfig, getUserTier, getEffectiveTier } from '../../lib/subscription';
import { isSaasModeActive } from '../../lib/onboarding';

const logger = createLogger('storage-stats');

const storageStatsRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 10,
  keyPrefix: 'rl-storage-stats',
});

const CACHE_TTL_MS = 60_000; // 60 seconds
const EMPTY_STATS = { totalFiles: 0, totalFolders: 0, totalSizeBytes: 0 };

interface CachedStats {
  totalFiles: number;
  totalFolders: number;
  totalSizeBytes: number;
  maxStorageBytes?: number | null;
  cachedAt: number;
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', storageStatsRateLimiter);

app.get('/', async (c) => {
  const bucketName = c.get('bucketName');
  const cacheKey = `storage-stats:${bucketName}`;

  // Check KV cache first — includes maxStorageBytes from last computation
  const cached = await c.env.KV.get(cacheKey, 'json') as CachedStats | null;
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
    return c.json({
      totalFiles: cached.totalFiles,
      totalFolders: cached.totalFolders,
      totalSizeBytes: cached.totalSizeBytes,
      bucketName,
      maxStorageBytes: cached.maxStorageBytes ?? null,
    });
  }

  // Resolve storage quota from tier config (only on cache miss)
  let maxStorageBytes: number | null = null;
  if (isSaasModeActive(c.env.SAAS_MODE)) {
    const user = c.get('user');
    const tiers = await getTierConfig(c.env.KV);
    const effectiveTier = getEffectiveTier(user.subscriptionTier, user.accessTier, user.billingStatus, user.billingPeriodEnd, c.env);
    const tier = getUserTier(effectiveTier, tiers);
    maxStorageBytes = tier.maxStorageBytes ?? null;
  }

  const r2Client = createR2Client(c.env);
  const { endpoint } = await getR2Config(c.env);

  let totalFiles = 0;
  let totalSizeBytes = 0;
  const folderSet = new Set<string>();
  let continuationToken: string | undefined;
  const seenTokens = new Set<string>();

  // Paginate through all objects to compute stats
  do {
    const params = new URLSearchParams({
      'list-type': '2',
      'max-keys': '1000',
    });
    if (continuationToken) {
      params.set('continuation-token', continuationToken);
    }

    const url = `${getR2Url(endpoint, bucketName)}?${params.toString()}`;
    const response = await r2Client.fetch(url, { method: 'GET' });

    if (!response.ok) {
      // Only an initial 404 establishes the bucket is absent.
      if (response.status === 404 && continuationToken === undefined) {
        return c.json({ ...EMPTY_STATS, bucketName, maxStorageBytes });
      }
      logger.error('R2 ListObjects failed', undefined, { status: response.status, bucketName });
      throw new ContainerError('storage-stats', `R2 ListObjects failed: ${response.status}`);
    }

    const xml = await response.text();
    let result: ReturnType<typeof parseListObjectsXml>;
    try {
      result = parseListObjectsXml(xml, true);
    } catch {
      throw new ContainerError('storage-stats', 'Incomplete or malformed R2 listing');
    }
    continuationToken = result.isTruncated ? result.nextContinuationToken : undefined;
    if (continuationToken !== undefined) {
      if (seenTokens.has(continuationToken)) {
        throw new ContainerError('storage-stats', 'R2 repeated a listing continuation token');
      }
      seenTokens.add(continuationToken);
    }

    for (const obj of result.objects) {
      // Folder markers are zero-byte objects ending with '/' — count as folders, not files
      if (obj.key.endsWith('/') && obj.size === 0) {
        folderSet.add(obj.key);
      } else {
        totalFiles++;
        totalSizeBytes += obj.size;
      }
      // Derive implicit parent folders from the key path
      const parts = obj.key.split('/');
      for (let i = 1; i < parts.length; i++) {
        folderSet.add(parts.slice(0, i).join('/') + '/');
      }
    }
  } while (continuationToken);

  const totalFolders = folderSet.size;

  // Cache the result in KV
  const statsToCache: CachedStats = {
    totalFiles,
    totalFolders,
    totalSizeBytes,
    maxStorageBytes,
    cachedAt: Date.now(),
  };
  await c.env.KV.put(cacheKey, JSON.stringify(statsToCache));

  return c.json({ totalFiles, totalFolders, totalSizeBytes, bucketName, maxStorageBytes });
});

export default app;
