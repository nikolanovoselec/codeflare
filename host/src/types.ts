/**
 * Shared type definitions for the codeflare host terminal server.
 */

import type { WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Log severity levels used by the structured logger. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured logger function signature. */
export type Logger = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => void;

/** WebSocket event logger function signature. */
export type WsEventLogger = (sessionId: string, type: string, details?: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// Tab / Pre-warm configuration
// ---------------------------------------------------------------------------

/** A single entry from the TAB_CONFIG environment variable. */
export interface TabConfigEntry {
  readonly id: string;
  readonly command: string;
  readonly label: string;
}

/** Result of getPrewarmConfig — the command extracted from tab 1. */
export interface PrewarmConfig {
  readonly command: string | null;
}

/** Map of terminal ID to configured command string. */
export type TabConfigMap = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// Activity Tracker
// ---------------------------------------------------------------------------

/** Snapshot returned by ActivityTracker.getActivityInfo(). */
export interface ActivityInfo {
  readonly hasActiveConnections: boolean;
  readonly connectedClients: number;
  readonly activeSessions: number;
  readonly disconnectedForMs: number | null;
  readonly lastInputAt: number | null;
  readonly lastHeartbeatAt: number | null;
}

/** Minimal SessionManager surface needed by the activity tracker. */
export interface ActivitySessionManager {
  readonly clients: ReadonlyMap<string, unknown>;
  readonly sessions?: ReadonlyMap<string, { ptyProcess: unknown | null }>;
}

/** Activity tracker instance returned by createActivityTracker(). */
export interface ActivityTracker {
  lastAllDisconnectedAt: number | null;
  recordClientConnected(): void;
  recordAllClientsDisconnected(): void;
  recordInput(): void;
  recordHeartbeat(): void;
  getActivityInfo(sessionManager: ActivitySessionManager | null | undefined): ActivityInfo;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Sync status written by the rclone daemon. */
export interface SyncStatus {
  readonly status: string;
  readonly error: string | null;
  readonly userPath: string | null;
}

/** System resource metrics (CPU, memory, disk). */
export interface SystemMetrics {
  readonly cpu: string;
  readonly mem: string;
  readonly hdd: string;
}

/** Cached disk metrics with TTL tracking. */
export interface CachedDiskMetrics {
  value: string;
  lastUpdated: number;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Options passed to Session and SessionManager constructors. */
export interface SessionOptions {
  readonly tabConfigMap?: TabConfigMap;
  readonly terminalCommand?: string;
  readonly terminalArgs?: string;
  readonly getWorkingDirectory?: () => string;
  readonly log?: Logger;
  readonly logWsEvent?: WsEventLogger;
  readonly activityTracker?: ActivityTracker | null;
  readonly ptyKeepaliveMs?: number;
  readonly maxSessions?: number;
  readonly ptyCleanupIntervalMs?: number;
}

/** JSON representation of a session (returned by Session.toJSON()). */
export interface SessionJSON {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly clients: number;
  readonly createdAt: string;
  readonly lastAccessedAt: string;
  readonly disconnectedAt: string | null;
  readonly ptyAlive: boolean;
}

// ---------------------------------------------------------------------------
// WebSocket event log
// ---------------------------------------------------------------------------

/** A single entry in the WebSocket event ring buffer. */
export interface WsEvent {
  readonly ts: string;
  readonly session: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Server / Health
// ---------------------------------------------------------------------------

/** Health check response payload. */
export interface HealthResponse {
  readonly status: string;
  readonly sessions: number;
  readonly uptime: number;
  readonly syncStatus: string;
  readonly syncError: string | null;
  readonly userPath: string | null;
  readonly prewarmReady: boolean;
  readonly cpu: string;
  readonly mem: string;
  readonly hdd: string;
  readonly timestamp: string;
}
