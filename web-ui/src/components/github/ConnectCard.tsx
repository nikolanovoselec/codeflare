import { Component } from 'solid-js';
import { mdiGithub } from '@mdi/js';
import OAuthConnectCard from '../connect/OAuthConnectCard';
import { githubConnectUrl } from '../../api/github';

/**
 * Dashboard GitHub-panel connect affordance. Thin wrapper over the shared
 * OAuthConnectCard so the panel, Guided Setup, and Settings accordion all render
 * the same connect surface. The panel handles its own connected state (repo
 * browsing), so this only drives the disconnected → connect navigation.
 */
const ConnectCard: Component = () => (
  <OAuthConnectCard
    provider="github"
    icon={mdiGithub}
    name="GitHub"
    status="disconnected"
    connectUrl={githubConnectUrl()}
    onDisconnect={() => {}}
  />
);

export default ConnectCard;
