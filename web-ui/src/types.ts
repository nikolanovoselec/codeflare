import { z } from 'zod';
import { AgentTypeSchema } from './lib/schemas';

/** Supported agent types for multi-agent sessions */
export type AgentType = z.infer<typeof AgentTypeSchema>;

/** Configuration for a single terminal tab */
export interface TabConfig {
  id: string;        // "1" through "6"
  command: string;   // Shell command or empty for bash
  label: string;     // Display label
}

/** Saved preset for quick session creation */
export interface TabPreset {
  id: string;
  name: string;
  tabs: TabConfig[];
  createdAt: string;
}

/** User preferences persisted across sessions */
export interface UserPreferences {
  lastAgentType?: AgentType;
  lastPresetId?: string;
  workspaceSyncEnabled?: boolean;
}

/** Mirrors backend Session type (see src/types.ts). Keep in sync manually. */
export interface Session {
  id: string;
  name: string;
  createdAt: string;
  lastAccessedAt: string;
  /** Backend only sends 'stopped' | 'running'. 'stopping' is a client-only ephemeral state managed by SessionStatus, never returned by the API. */
  status?: 'stopped' | 'running' | 'stopping';
  agentType?: AgentType;
  tabConfig?: TabConfig[];
}

/** 'initializing' and 'error' are frontend-only ephemeral states, never persisted to KV. Backend uses only 'stopped' | 'running'. */
export type SessionStatus = 'stopped' | 'initializing' | 'running' | 'stopping' | 'error';

export interface SessionWithStatus extends Omit<Session, 'status'> {
  status: SessionStatus;
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
    // System metrics from health server
    cpu?: string;
    mem?: string;
    hdd?: string;
  };
  error?: string;
}

// Note: Backend Session includes `userId` which is not exposed to the frontend
export interface UserInfo {
  email: string;
  authenticated: boolean;
  bucketName: string;
  workerName?: string;
  role?: 'admin' | 'user';
  onboardingActive?: boolean;
}

// Terminal connection state
export type TerminalConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

// Terminal tab within a session (multiple terminals per container)
export interface TerminalTab {
  id: string;        // "1", "2", "3", "4"
  createdAt: string;
  processName?: string;  // Live process name from server (e.g., "claude", "htop")
  manual?: boolean;      // true when tab was created by user clicking "+", skips .bashrc autostart
}

// Tiling layout types
export type TileLayout = 'tabbed' | '2-split' | '3-split' | '4-grid';

export interface TilingState {
  enabled: boolean;
  layout: TileLayout;
}

// Track terminals per session
export interface SessionTerminals {
  tabs: TerminalTab[];
  activeTabId: string | null;
  tabOrder: string[];     // Display order (tab "1" always first)
  tiling: TilingState;    // Tiling configuration
}
