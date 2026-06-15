import type { Container } from '@cloudflare/containers';
import { z } from 'zod';

/**
 * Cloudflare environment bindings
 */
export interface Env {
  // Static assets binding (auto-injected by Cloudflare when [assets] is configured)
  ASSETS: Fetcher;

  // KV namespace for session metadata
  KV: KVNamespace;

  // Container Durable Object
  CONTAINER: DurableObjectNamespace<Container<Env>>;

  // Environment variables
  // Only available inside containers (set via envVars)
  R2_BUCKET_NAME?: string;
  R2_ACCOUNT_ID?: string;
  R2_ENDPOINT?: string;

  // Secrets (injected via wrangler secret)
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;

  // Service token email - when using CF Access service tokens, this email is used
  // Default: service-{clientId}@codeflare.local
  SERVICE_TOKEN_EMAIL?: string;
  // Direct service token secret for E2E testing (bypasses CF Access JWT exchange)
  SERVICE_AUTH_SECRET?: string;

  // Cloudflare API token for R2 bucket management
  CLOUDFLARE_API_TOKEN: string;

  // Allowed CORS origins (comma-separated patterns, e.g., ".workers.dev,.example.com")
  ALLOWED_ORIGINS?: string;

  // Configurable log level (debug | info | warn | error)
  LOG_LEVEL?: string;

  // Optional onboarding mode flag: when set to "active",
  // root (/) serves a public waitlist landing page.
  ONBOARDING_LANDING_PAGE?: string;

  // Turnstile secret used to verify waitlist submissions (optional).
  TURNSTILE_SECRET_KEY?: string;

  // Resend API key for transactional emails: welcome, subscription, tier change, access requests (optional).
  RESEND_API_KEY?: string;

  // Optional sender identity for outgoing emails (e.g. "Codeflare <noreply@example.com>").
  RESEND_EMAIL?: string;

  // Optional worker name override for forks (set via wrangler.toml [vars] or GitHub Actions)
  CLOUDFLARE_WORKER_NAME?: string;

  // Maximum concurrent running sessions per user role
  MAX_SESSIONS_USER?: string;
  MAX_SESSIONS_ADMIN?: string;

  // Bypass all rate limits for stress testing (set to 'active' to enable)
  STRESS_TEST_MODE?: string;

  // SaaS mode: custom login page with JIT provisioning and admin approval gate.
  // When 'active', new users are auto-provisioned with 'pending' tier on first login.
  SAAS_MODE?: string;
  // Comma-separated CF Access IdP UUIDs to show on login page alongside social providers.
  // Use for custom OIDC/SAML providers (e.g., Authentik, Okta).
  SAAS_EXTRA_IDPS?: string;

  // Stripe secret key for payment processing (optional, SaaS mode only).
  // Set via wrangler secret. When absent, all plans are free (no billing).
  STRIPE_SECRET_KEY?: string;

  // Stripe webhook signing secret for verifying webhook payloads (optional, SaaS mode only).
  // Set via wrangler secret. Required when STRIPE_SECRET_KEY is set.
  STRIPE_WEBHOOK_SECRET?: string;

  // Optional AES-256 key (base64) for encrypting KV values at rest.
  // Set via wrangler secret. When absent, credentials stored as plaintext.
  ENCRYPTION_KEY?: string;

  // GitHub OAuth (SaaS mode only - replaces CF Access for authentication)
  // Create an OAuth App at github.com/settings/applications/new
  OAUTH_CLIENT_ID?: string;      // OAuth App client ID (wrangler.toml var, public)
  OAUTH_CLIENT_SECRET?: string;   // OAuth App client secret (wrangler secret)
  OAUTH_JWT_SECRET?: string;             // HMAC-SHA256 signing key for session JWTs (wrangler secret)

  // GitHub App (enterprise / EMU). When set, the GitHub integration uses the App
  // user-to-server provider (refreshable ~8h tokens, acts AS the user) instead of
  // the OAuth App. Register an INTERNAL GitHub App in the customer's enterprise and
  // install it on the org; we only need the client credentials (no private key —
  // user-to-server tokens only).
  GITHUB_APP_CLIENT_ID?: string;     // GitHub App client ID (wrangler.toml var, public)
  GITHUB_APP_CLIENT_SECRET?: string; // GitHub App client secret (wrangler secret)
  // Optional GitHub host overrides for data-residency (*.ghe.com) tenants.
  // Default to public github.com / api.github.com.
  GITHUB_HOST?: string;       // web host for OAuth authorize/token (default github.com)
  GITHUB_API_HOST?: string;   // REST API host (default api.github.com)

  // Timekeeper Durable Object for per-user usage tracking
  TIMEKEEPER?: DurableObjectNamespace;

  // Enterprise mode: when 'active', codeflare is deployed inside a customer's
  // own Cloudflare account. All users resolve to unlimited tier + advanced mode,
  // the agent set is restricted to the enterprise allowlist, and LLM traffic is
  // routed through the customer's AI Gateway. Off by default (undefined ⇒ all
  // existing code paths unchanged).
  ENTERPRISE_MODE?: string;
  // AI Gateway base URL the LlmInterceptor WorkerEntrypoint forwards to
  // (enterprise only). Set via wrangler secret. Held in the Worker/interceptor
  // env only — never injected into the container (the container reaches the
  // gateway via platform outbound-HTTPS interception, not a URL).
  AIG_GATEWAY_URL?: string;
  // AI Gateway token the interceptor sends as a standard `Authorization: Bearer`
  // header on the REST API (enterprise only; AD74). Set via wrangler secret.
  // Never exposed to the container.
  AIG_TOKEN?: string;

}

/**
 * Possible user roles within the application
 */
export type UserRole = 'admin' | 'user';

/**
 * User extracted from Cloudflare Access JWT
 */
export interface AccessUser {
  email: string;
  authenticated: boolean;
  role?: UserRole;
  accessTier?: AccessTier;
  subscriptionTier?: SubscriptionTier;
  subscribedMode?: 'default' | 'advanced';
  billingStatus?: BillingStatus;
  billingPeriodEnd?: string;
}

/**
 * Session metadata stored in KV
 */
export interface Session {
  id: string;
  name: string;
  userId: string;
  createdAt: string;
  lastAccessedAt: string;
  status?: 'stopped' | 'running';
  lastStatusCheck?: number;
  lastStartedAt?: string;
  lastActiveAt?: string;
  agentType?: AgentType;
  tabConfig?: TabConfig[];
  /** REQ-GITHUB-004: GitHub repo to clone into the workspace at container start. */
  clone?: { repo: string; ref?: string };
  metrics?: {
    cpu?: string;
    mem?: string;
    hdd?: string;
    syncStatus?: string;
    updatedAt?: string;
  };
}

/**
 * Supported agent types for multi-agent sessions
 */
export const AgentTypeSchema = z.enum(['claude-code', 'codex', 'copilot', 'antigravity', 'opencode', 'pi', 'bash']);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const SessionModeSchema = z.enum(['default', 'advanced']);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const AccessTierSchema = z.enum(['pending', 'standard', 'advanced', 'blocked']);
export type AccessTier = z.infer<typeof AccessTierSchema>;

const BillingStatusSchema = z.enum(['active', 'trialing', 'past_due', 'canceled']);
export type BillingStatus = z.infer<typeof BillingStatusSchema>;

export const BILLING_STATUS = {
  ACTIVE: 'active',
  TRIALING: 'trialing',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled',
} as const satisfies Record<string, BillingStatus>;

export const SubscriptionTierSchema = z.enum([
  'blocked', 'pending', 'free', 'trial', 'standard', 'advanced', 'max', 'unlimited',
]);
export type SubscriptionTier = z.infer<typeof SubscriptionTierSchema>;

/**
 * Configuration for a single subscription tier.
 * Stored as part of the tiers:config KV value.
 */
export interface SubscriptionTierConfig {
  id: SubscriptionTier | string;
  displayName: string;
  monthlySeconds: number | null; // null = unlimited
  maxSessions: number;
  sessionModes: SessionMode[];
  canLogin: boolean;
  order: number;
  isDefault: boolean;
  priceMonthly: number | null; // cents, null = not purchasable
  trialQuotaHours: number; // hours of free usage before billing, 0 = no trial
  maxStorageBytes?: number | null; // null/undefined = unlimited
  description: string;
  advancedPriceMonthly?: number | null; // cents, higher price for advanced mode
  stripePriceId?: string | null; // Stripe price ID for standard mode
  stripeAdvancedPriceId?: string | null; // Stripe price ID for advanced/pro mode
}

/**
 * Usage record stored at timekeeper:{bucketName} in KV.
 * Written by Timekeeper DO alarm handler.
 */
const UsageRecordSchema = z.object({
  today: z.object({ date: z.string(), seconds: z.number().min(0) }),
  thisWeek: z.object({ weekStart: z.string(), seconds: z.number().min(0) }),
  thisMonth: z.object({ month: z.string(), seconds: z.number().min(0) }),
  thisYear: z.object({ year: z.string(), seconds: z.number().min(0) }),
  allTime: z.object({ seconds: z.number().min(0) }),
  lastUpdatedAt: z.string(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;


/**
 * Configuration for a single terminal tab
 */
export interface TabConfig {
  id: string;        // "1" through "6"
  command: string;   // Shell command or empty for bash
  label: string;     // Display label
}

/**
 * Saved preset for quick session creation
 */
export interface Preset {
  id: string;
  name: string;
  tabs: TabConfig[];
  createdAt: string;
}

/**
 * User preferences persisted across sessions
 */
export type SleepAfterOption = '5m' | '15m' | '30m' | '1h' | '2h';
export const SleepAfterOptions: SleepAfterOption[] = ['5m', '15m', '30m', '1h', '2h'];

export interface UserPreferences {
  lastAgentType?: AgentType;
  lastPresetId?: string;
  workspaceSyncEnabled?: boolean;
  fastStartEnabled?: boolean;
  sessionMode?: SessionMode;
  sleepAfter?: SleepAfterOption;
  /** REQ-MEM-001 AC4: user's IANA timezone, captured from the browser. */
  userTimezone?: string;
  /** REQ-AGENT-049: hash of last applied preseed content, for auto-upgrade detection. */
  lastPreseedHash?: string;
  /**
   * REQ-STOR-009: set once getting-started docs have been confirmed seeded into
   * the bucket. Until it is true, every session start re-attempts the (idempotent)
   * seed, so a cold-bucket failure self-heals instead of leaving docs permanently
   * missing. Once set, user deletions of the starter docs are respected.
   */
  gettingStartedSeeded?: boolean;
}

/**
 * User-scoped LLM API keys stored in KV
 */
export interface LlmKeys {
  openaiApiKey?: string;
  geminiApiKey?: string;
}

/**
 * User-scoped deploy credentials stored in KV
 */
export interface DeployKeys {
  /**
   * GitHub token. `null` is an explicit clear that must propagate to the
   * container DO (REQ-AGENT-029 AC2) - a missing field is "no change", a
   * `null` field revokes the previously-injected value. Distinguish the two.
   */
  githubToken?: string | null;
  /**
   * How `githubToken` was obtained. `'pat'` = manually pasted fine-grained PAT;
   * `'oauth'` = OAuth App token (long-lived); `'app'` = GitHub App user-to-server
   * token (refreshable). Drives the refresh + revoke paths. `null`/absent ⇒ `'pat'`.
   */
  githubTokenSource?: 'app' | 'oauth' | 'pat' | null;
  /** GitHub App user-to-server refresh token (source `'app'` only). */
  githubRefreshToken?: string | null;
  /** Epoch ms when `githubToken` expires (source `'app'` only). */
  githubTokenExpiresAt?: number | null;
  /** Connected GitHub login (handle) for display. Never a secret. */
  githubLogin?: string | null;
  /** Cloudflare API token. `null` clears (see githubToken). */
  cloudflareApiToken?: string | null;
  /** Cloudflare account ID. `null` clears (see githubToken). */
  cloudflareAccountId?: string | null;
}

/**
 * R2 connection config (account ID + S3 endpoint) resolved from the Worker env.
 * Named to cut the repeated inline `{ accountId; endpoint }` shape across the
 * container-config payload and the R2 helpers.
 */
export interface R2ConnectionConfig {
  accountId: string;
  endpoint: string;
}

/**
 * Scoped R2 access credentials minted per user/bucket. Named to cut the
 * repeated inline `{ accessKeyId; secretAccessKey }` shape.
 */
interface ScopedR2Creds {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Grouped parameters for container DO initialization (buildSetBucketNameBody + configureContainerDO).
 */
export interface ContainerConfigPayload {
  bucketName: string;
  sessionId: string;
  userEmail: string;
  scopedCreds: ScopedR2Creds;
  r2Config: R2ConnectionConfig;
  tabConfig: TabConfig[];
  workspaceSyncEnabled: boolean;
  fastStartEnabled: boolean;
  sessionMode: string;
  sleepAfter?: string;
  encryptionKey?: string;
  llmKeys?: LlmKeys;
  deployKeys?: DeployKeys;
  /** REQ-ENTERPRISE-004: the user's matched Access groups, one cf-aig-metadata tag per group. */
  userGroups?: string[];
  /** REQ-ENTERPRISE-005 (revised): the full dynamic-route catalog (Pi models.json lists all). */
  routeCatalog?: string[];
  /** REQ-ENTERPRISE-005 (revised): the resolved default route (Copilot model + Pi default model). */
  defaultRoute?: string;
  /** REQ-ENTERPRISE-005 (revised): the default route's reasoning grade (Pi defaultThinkingLevel). */
  defaultReasoning?: string;
  /** REQ-MEM-001 AC4: user's IANA timezone forwarded to the container. */
  userTimezone?: string;
  /** REQ-GITHUB-004: one-shot GitHub clone directive forwarded to the container. */
  gitCloneRepo?: string;
  gitCloneRef?: string;
}

interface StorageObject {
  key: string;
  size: number;
  lastModified: string;
  etag?: string;
}

export interface StorageListResult {
  objects: StorageObject[];
  prefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}
