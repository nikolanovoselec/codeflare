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

  // Development mode - set to 'true' to bypass Cloudflare Access
  DEV_MODE?: string;

  // Service token email - when using CF Access service tokens, this email is used
  // Default: service-{clientId}@codeflare.local
  SERVICE_TOKEN_EMAIL?: string;

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

  // Enable protected path deletions for storage delete route (set to 'true' to enforce)
  PROTECTED_PATHS_ENABLED?: string;

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
  agentType?: AgentType;
  tabConfig?: TabConfig[];
}

/**
 * Supported agent types for multi-agent sessions
 */
export const AgentTypeSchema = z.enum(['claude-unleashed', 'claude-code', 'codex', 'gemini', 'bash']);
export type AgentType = z.infer<typeof AgentTypeSchema>;

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
