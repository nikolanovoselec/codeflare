import { sendNotification } from 'edgepush';
import type { Session } from '../types';

export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;
export const MAX_AGENT_EVENTS_PER_SEND = 8;

type AgentEventKind = 'input-required' | 'task-completed' | 'task-failed';

export interface AgentEventForPush {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly kind: AgentEventKind;
  readonly createdAt: number;
}

export interface PushSubscriptionRecord {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
  readonly createdAt: number;
}

interface VapidConfiguration {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface SendAgentEventPushesOptions {
  readonly kv: KVNamespace;
  readonly bucketName: string;
  readonly session: Session;
  readonly events: readonly AgentEventForPush[];
  readonly vapid: VapidConfiguration;
}

export interface SendAgentEventPushesResult {
  readonly sentEventIds: readonly string[];
}

/**
 * Compile-only Phase 1 seam. The sender remains inert until the red CI receipt
 * proves the behavioral contract before implementation.
 */
export async function sendAgentEventPushes(
  _options: SendAgentEventPushesOptions,
): Promise<SendAgentEventPushesResult> {
  // Keep the selected modern Web Push dependency in the compile seam while the
  // red checkpoint proves the sender contract before behavior is added.
  void sendNotification;
  return { sentEventIds: [] };
}
