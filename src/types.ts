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

  // Resend API key used for waitlist notification emails (optional).
  RESEND_API_KEY?: string;

  // Optional sender identity for waitlist emails.
  WAITLIST_FROM_EMAIL?: string;

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

  // Optional AES-256 key (base64) for encrypting KV values at rest.
  // Set via wrangler secret. When absent, credentials stored as plaintext.
  ENCRYPTION_KEY?: string;
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
export const AgentTypeSchema = z.enum(['claude-code', 'codex', 'copilot', 'gemini', 'opencode', 'bash']);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const SessionModeSchema = z.enum(['default', 'advanced']);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const AccessTierSchema = z.enum(['pending', 'standard', 'advanced', 'blocked']);
export type AccessTier = z.infer<typeof AccessTierSchema>;

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
export interface UserPreferences {
  lastAgentType?: AgentType;
  lastPresetId?: string;
  workspaceSyncEnabled?: boolean;
  fastStartEnabled?: boolean;
  sessionMode?: SessionMode;
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
  githubToken?: string;
  cloudflareApiToken?: string;
  cloudflareAccountId?: string;
}

export interface StorageObject {
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
