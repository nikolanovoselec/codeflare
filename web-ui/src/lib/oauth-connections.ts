import { createSignal, type Accessor } from 'solid-js';
import { getGithubStatus, disconnectGithub as apiDisconnectGithub } from '../api/github';
import {
  getCloudflareStatus,
  disconnectCloudflare as apiDisconnectCloudflare,
  selectCloudflareAccount as apiSelectCloudflareAccount,
} from '../api/cloudflare';
import type { OAuthConnectStatus } from '../components/connect/OAuthConnectCard';

export interface GithubConnectionState {
  status: OAuthConnectStatus;
  identity?: string;
}

export interface CloudflareConnectionState {
  status: OAuthConnectStatus;
  identity?: string;
  accounts?: { id: string; name: string }[];
  accountId?: string;
}

export interface Connections {
  github: Accessor<GithubConnectionState>;
  cloudflare: Accessor<CloudflareConnectionState>;
  refresh: () => Promise<void>;
  refreshGithub: () => Promise<void>;
  refreshCloudflare: () => Promise<void>;
  disconnectGithub: () => Promise<void>;
  disconnectCloudflare: () => Promise<void>;
  selectCloudflareAccount: (accountId: string) => Promise<void>;
}

/**
 * Composable connection state for the GitHub + Cloudflare OAuth connect surfaces,
 * shared by the Guided Setup onboarding and the Settings accordion. Owns status
 * fetching + disconnect + account selection so each surface is pure composition of
 * two <OAuthConnectCard> instances. Status reads fail soft (a failed/disabled
 * status leaves the provider disconnected) so the connect affordance still renders.
 */
export function createConnections(): Connections {
  const [github, setGithub] = createSignal<GithubConnectionState>({ status: 'disconnected' });
  const [cloudflare, setCloudflare] = createSignal<CloudflareConnectionState>({ status: 'disconnected' });

  async function refreshGithub(): Promise<void> {
    try {
      const s = await getGithubStatus();
      setGithub(s.connected ? { status: 'connected', identity: s.login } : { status: 'disconnected' });
    } catch {
      setGithub({ status: 'disconnected' });
    }
  }

  async function refreshCloudflare(): Promise<void> {
    try {
      const s = await getCloudflareStatus();
      setCloudflare(
        s.connected
          ? { status: 'connected', identity: s.accountId, accounts: s.accounts, accountId: s.accountId }
          : { status: 'disconnected' },
      );
    } catch {
      setCloudflare({ status: 'disconnected' });
    }
  }

  async function refresh(): Promise<void> {
    await Promise.all([refreshGithub(), refreshCloudflare()]);
  }

  async function disconnectGithub(): Promise<void> {
    await apiDisconnectGithub();
    await refreshGithub();
  }

  async function disconnectCloudflare(): Promise<void> {
    await apiDisconnectCloudflare();
    await refreshCloudflare();
  }

  async function selectCloudflareAccount(accountId: string): Promise<void> {
    await apiSelectCloudflareAccount(accountId);
    await refreshCloudflare();
  }

  return {
    github,
    cloudflare,
    refresh,
    refreshGithub,
    refreshCloudflare,
    disconnectGithub,
    disconnectCloudflare,
    selectCloudflareAccount,
  };
}
