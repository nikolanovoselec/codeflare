import { z } from 'zod';
import { AgentTypeSchema, SessionModeSchema, SessionWorkspaceSchema, TerminalModeSchema } from './lib/schemas';

/** Supported agent types for multi-agent sessions */
export type AgentType = z.infer<typeof AgentTypeSchema>;

/** Configuration for a single terminal tab */
export interface TabConfig {
  id: string;        // internal outer terminal ID "1"
  command: string;   // Shell command or empty for bash
  label: string;     // Display label
}

/** User preferences persisted across sessions */
export type SessionMode = z.infer<typeof SessionModeSchema>;
export type SessionWorkspace = z.infer<typeof SessionWorkspaceSchema>;
export type TerminalMode = z.infer<typeof TerminalModeSchema>;

export type AdministrationMode = 'default' | 'onboarding' | 'saas' | 'enterprise';

export type ConfigurationSection =
  | 'access'
  | 'domain'
  | 'aiRouting'
  | 'codingAgents'
  | 'browserRendering'
  | 'securityEgress'
  | 'dataGovernance'
  | 'managedEnvironment'
  | 'github'
  | 'cloudflareConnection'
  | 'usageReports';

export interface AdminConfigurationResponse {
  mode: AdministrationMode;
  revision: number;
  applicableSections: ConfigurationSection[];
  sections: Partial<Record<ConfigurationSection, unknown>>;
  activeRunId: string | null;
  latest: Partial<Record<ConfigurationSection, Record<string, unknown>>>;
}

export type PiReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ReasoningScalar = string | number | boolean | null;

export interface ProfileRevisionRef {
  id: string;
  revision: number;
  hash: string;
}

export interface NormalizedReasoningMapping {
  removePaths: string[];
  writes: Array<{ path: string; value: ReasoningScalar }>;
}

export interface ReasoningProfileCatalogEntry extends ProfileRevisionRef {
  name: string;
  description?: string;
  family?: string;
  enabled?: boolean;
  assignable?: boolean;
  classification?: string;
  ingressContract?: string;
  supportedLevels: PiReasoningLevel[];
  unsupportedLevels?: PiReasoningLevel[];
  levels?: Partial<Record<PiReasoningLevel, Array<{ path: string; value: ReasoningScalar }>>>;
  aliases?: Partial<Record<PiReasoningLevel, PiReasoningLevel>>;
  removePaths?: string[];
  offSemantics?: string | { status?: string; path?: string; value?: ReasoningScalar };
  limitations?: string[];
  validatedTransports?: string[];
  toolCompatibility?: { status?: string; levels?: PiReasoningLevel[] };
  originallyCreatedAgainst?: Record<string, unknown>;
  validatedAgainst?: Array<Record<string, unknown>>;
}

export interface ReasoningCompatibilityNotice {
  id: string;
  name: string;
  title?: string;
  assignable: false;
  summary?: string;
  classification?: string;
  limitations?: string[];
}

export interface ReasoningCatalog {
  schemaVersion: 1;
  profiles: ReasoningProfileCatalogEntry[];
  notices: ReasoningCompatibilityNotice[];
  usage: Array<{ profileRef: ProfileRevisionRef; routes: string[] }>;
  routes: string[];
  routeCatalogStatus: 'ready' | 'unavailable';
}

export interface ReasoningEvidenceRef {
  id?: string;
  status?: string;
  current?: boolean;
  toolReplay?: boolean;
  observedAt?: string;
  [key: string]: unknown;
}

export interface ReasoningRouteLeg {
  nodeId: string;
  provider: string;
  declaredModel: string;
  customProviderBackend?: string;
  profileRef?: ProfileRevisionRef;
  evidence?: ReasoningEvidenceRef;
  paths?: string[];
}

export interface ReasoningRouteAssignment {
  activeProfile: ProfileRevisionRef;
  routeVersion?: string;
  legs?: ReasoningRouteLeg[];
  commonMapping?: {
    levels: Partial<Record<PiReasoningLevel, NormalizedReasoningMapping>>;
    digest: string;
  };
}

export interface ReasoningConfiguration {
  schemaVersion: 1;
  customProfileRevisions: Array<Record<string, unknown>>;
  routeAssignments: Record<string, ReasoningRouteAssignment>;
}

export interface ReasoningRouteInventory {
  route?: string;
  routeVersion?: string;
  versionId?: string;
  legs: ReasoningRouteLeg[];
  paths?: Array<Record<string, unknown>>;
  commonMapping?: ReasoningRouteAssignment['commonMapping'];
  commonLevels?: PiReasoningLevel[];
  warnings?: string[];
}

export interface ReasoningDiscoveryRequest {
  route: string;
  profileRef?: ProfileRevisionRef;
  maxCompletionTokens: number;
}

export interface ReasoningDiscoveryDiagnostic {
  levels: PiReasoningLevel[];
  stage: string;
  code: string;
  status?: number;
  transport?: string;
}

export interface ReasoningDiscoveryResult {
  route?: string;
  classification: string;
  assignable?: boolean;
  outcome?: 'existing-profile' | 'custom-profile' | 'ambiguous' | 'inconclusive' | 'unsupported';
  matchedProfiles?: Array<{ profileRef: ProfileRevisionRef; name: string; supportedLevels: PiReasoningLevel[] }>;
  diagnostics?: ReasoningDiscoveryDiagnostic[];
  requestedCompletionCeiling?: number;
  matchedCandidateProfileId?: string;
  compatibleLevels?: PiReasoningLevel[];
  piCompatibility?: { status: string; verifiedLevels: PiReasoningLevel[]; failedLevels: PiReasoningLevel[] };
  reasoningConfiguration?: { off?: string; graduatedEffort?: string; routeHealthVerified?: boolean };
  distinctMappings?: Array<{
    levels: PiReasoningLevel[];
    toolLifecycle?: { passed: boolean; stage: string };
  }>;
  profileDraft?: Record<string, unknown>;
  candidateResults?: Array<{
    profileId: string;
    classification: string;
    assignable: boolean;
    profileName?: string;
    verifiedLevels?: PiReasoningLevel[];
    diagnostics?: ReasoningDiscoveryDiagnostic[];
  }>;
  warnings?: string[];
  accounting?: { logicalProbes?: number; httpAttempts?: number };
  supportedLevels?: PiReasoningLevel[];
  evidence?: ReasoningEvidenceRef;
  normalizedDraft?: Record<string, unknown>;
}

export function resolveTerminalMode(value: unknown): TerminalMode {
  return value === 'herdr' ? 'herdr' : 'classic';
}

export type SleepAfterOption = '15m' | '30m' | '1h' | '2h' | '4h';

export interface UserPreferences {
  lastAgentType?: AgentType;
  herdrEnabled?: boolean;
  workspaceSyncEnabled?: boolean;
  fastStartEnabled?: boolean;
  sessionMode?: SessionMode;
  defaultWorkspace?: SessionWorkspace;
  sleepAfter?: SleepAfterOption;
  /** REQ-MEM-001 AC4: user's IANA timezone captured from the browser. */
  userTimezone?: string;
  /** Server-owned stamp for the last fully applied verified managed release. */
  managedEnvironmentApplied?: {
    digest: string;
    managedExtensionsDigest?: string;
    sequence: number;
    mode: SessionMode;
    appliedAt: string;
  };
}

/** Mirrors backend Session type (see src/types.ts). Keep in sync manually. */
export interface Session {
  id: string;
  name: string;
  createdAt: string;
  lastAccessedAt: string;
  /** Backend only sends 'stopped' | 'running'. 'stopping' is a client-only ephemeral state managed by SessionStatus, never returned by the API. */
  status?: 'stopped' | 'running';
  agentType?: AgentType;
  workspace?: SessionWorkspace;
  terminalMode?: TerminalMode;
  editorReady?: boolean;
  editorReadyError?: boolean;
  tabConfig?: TabConfig[];
  /** ISO timestamp of when the session was last started */
  lastStartedAt?: string;
  /** ISO timestamp of last activity (WebSocket data or PTY output) */
  lastActiveAt?: string;
}

/** 'initializing' and 'error' are frontend-only ephemeral states, never persisted to KV. Backend uses only 'stopped' | 'running'. */
export type SessionStatus = 'stopped' | 'initializing' | 'running' | 'stopping' | 'error';

export interface SessionWithStatus extends Omit<Session, 'status'> {
  status: SessionStatus;
  /** Whether the session PTY is currently active (derived from batch-status; frontend-only) */
  ptyActive?: boolean;
  /** Container init stage (derived from batch-status; 'ready' means daemons are up) */
  startupStage?: string;
}

/**
 * Progress stages for session initialization.
 * These stages are returned by the startup-status polling endpoint.
 * @see src/routes/container.ts GET /startup-status for backend implementation
 */
export type InitStage =
  | 'creating'
  | 'starting'
  | 'syncing'
  | 'mounting'
  | 'verifying'
  | 'ready'
  | 'error'
  | 'stopped';

interface InitProgressDetail {
  key: string;
  value: string;
  status?: 'ok' | 'error' | 'pending';
}

export interface InitProgress {
  stage: InitStage;
  progress: number;
  message: string;
  details?: InitProgressDetail[];
  startedAt?: number;
}

// Startup status response from polling endpoint
export interface StartupStatusResponse {
  stage: InitStage;
  progress: number;
  message: string;
  details: {
    bucketName: string;
    container: string;
    path: string;
    email?: string;
    containerStatus?: string;
    syncStatus?: string;
    syncError?: string | null;
    healthServerOk?: boolean;
    terminalServerOk?: boolean;
    editorReady?: boolean;
    // System metrics from health server
    cpu?: string;
    mem?: string;
    hdd?: string;
  };
  error?: string;
}

export type AccessTier = 'pending' | 'standard' | 'advanced' | 'blocked';
export type SubscriptionTier = 'blocked' | 'pending' | 'free' | 'trial' | 'standard' | 'advanced' | 'max' | 'unlimited';

export interface AuthStatus {
  email: string;
  accessTier: AccessTier;
  subscriptionTier?: SubscriptionTier;
  role: 'admin' | 'user';
  turnstileSiteKey?: string | null;
  requestedAt?: string | null;
  onboardingComplete?: boolean;
  hasSubscribed?: boolean;
  trialUsed?: boolean;
  sessionMode?: 'default' | 'advanced';
  subscribedMode?: 'default' | 'advanced';
  currency?: string;
  billingStatus?: string | null;
  userCapacityReached?: boolean;
  enterpriseMode?: boolean;
  saasMode?: boolean;
}

export interface AuthProvider {
  id: string;
  type: string;
  name: string;
  loginUrl?: string;
}

// Note: Backend Session includes `userId` which is not exposed to the frontend
export interface UserInfo {
  email: string;
  authenticated: boolean;
  bucketName: string;
  workerName?: string;
  role?: 'admin' | 'user';
  accessTier?: AccessTier;
  subscriptionTier?: SubscriptionTier;
  onboardingActive?: boolean;
  saasMode?: boolean;
  onboardingComplete?: boolean;
  hasSubscribed?: boolean;
  subscribedMode?: 'default' | 'advanced';
  enterpriseMode?: boolean;
  downloadsDisabled?: boolean;
  /** REQ-ENTERPRISE-003: creation-selectable agents (wizard-governed in enterprise). */
  allowedAgents?: AgentType[];
}

// Terminal connection state (no 'error' — infinite retries mean we never give up)
export type TerminalConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected';

// Terminal tab within a classic session
export interface TerminalTab {
  id: string;
  createdAt: string;
  processName?: string;
  manual?: boolean;
}

// Tiling layout types
export type TileLayout = 'tabbed' | '2-split' | '3-split' | '4-grid';

export type TerminalViewportClass = 'mobile' | 'tablet' | 'desktop';

export type ActiveWorkspace =
  | { kind: 'dashboard' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'multiview'; id: 'multiview:1' };

export interface VisibleTerminalPane {
  id: string;
  sessionId: string;
  terminalId: string;
  source: 'session' | 'multiview';
}

export interface TilingState {
  enabled: boolean;
  layout: TileLayout;
}

export interface SessionTerminals {
  tabs: TerminalTab[];
  activeTabId: string | null;
  tabOrder: string[];
  tiling: TilingState;
}

export interface MultiViewWorkspace {
  id: 'multiview:1';
  name: 'MultiView #1';
  memberSessionIds: string[];
  focusedSessionId: string | null;
  layout: Exclude<TileLayout, 'tabbed'>;
}

export type TerminalWorkspaceMode = 'dashboard' | 'single-session' | 'multiview';

export interface TerminalWorkspaceState {
  mode: TerminalWorkspaceMode;
  activeWorkspace: ActiveWorkspace;
  panes: VisibleTerminalPane[];
  focusedPaneId: string | null;
  layout: TileLayout;
  multiView: MultiViewWorkspace | null;
}
