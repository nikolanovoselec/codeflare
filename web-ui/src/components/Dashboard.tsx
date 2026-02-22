import { Component, Show, For, onMount, createSignal, createMemo, createEffect } from 'solid-js';
import { Portal } from 'solid-js/web';
import { mdiXml, mdiCogOutline, mdiAccountCircle, mdiLogout } from '@mdi/js';
import Icon from './Icon';
import type { SessionWithStatus, AgentType, TabConfig } from '../types';
import { storageStore } from '../stores/storage';
import { getDownloadUrl } from '../api/storage';
import { md5 } from '../lib/md5';
import SessionStatCard from './SessionStatCard';
import SessionContextMenu from './SessionContextMenu';
import StatCards from './StatCards';
import StorageBrowser from './StorageBrowser';
import FilePreview from './FilePreview';
import CreateSessionDialog from './CreateSessionDialog';
import KittScanner from './KittScanner';
import DashboardCard from './TipsRotator';
import '../styles/dashboard.css';

function getGravatarUrl(email: string, size = 32): string {
  const hash = md5(email.trim().toLowerCase());
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=mp`;
}

interface DashboardProps {
  sessions: SessionWithStatus[];
  onCreateSession: (agentType?: AgentType, tabConfig?: TabConfig[]) => void;
  onStartSession: (id: string) => void;
  onOpenSessionById: (id: string) => void;
  onStopSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  viewState: 'dashboard' | 'expanding' | 'collapsing';
  userName?: string;
  onSettingsClick?: () => void;
  onLogout?: () => void;
}

const Dashboard: Component<DashboardProps> = (props) => {
  const [collapseReady, setCollapseReady] = createSignal(false);
  const [showCreateDialog, setShowCreateDialog] = createSignal(false);
  const [newSessionBtnRef, setNewSessionBtnRef] = createSignal<HTMLButtonElement>();
  const [menuState, setMenuState] = createSignal<{ isOpen: boolean; position: { x: number; y: number }; session: SessionWithStatus | null }>({
    isOpen: false,
    position: { x: 0, y: 0 },
    session: null,
  });

  onMount(() => {
    storageStore.fetchStats();
  });

  // Double requestAnimationFrame to ensure the browser has painted with --expanded
  // before removing the class, so the CSS transition actually fires.
  createEffect(() => {
    if (props.viewState === 'collapsing') {
      setCollapseReady(false);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setCollapseReady(true);
        });
      });
    }
  });

  const panelExpanded = createMemo(() => {
    if (props.viewState === 'expanding') return true;
    if (props.viewState === 'collapsing') return !collapseReady();
    return false;
  });

  const handleSessionSelect = (session: SessionWithStatus) => {
    props.onOpenSessionById(session.id);
  };

  const handlePreviewBack = () => {
    storageStore.closePreview();
  };

  const handlePreviewDownload = () => {
    const file = storageStore.previewFile;
    if (file) {
      const url = getDownloadUrl(file.key);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.key.split('/').pop() || 'download';
      a.click();
    }
  };

  const handleMenuClick = (e: MouseEvent, session: SessionWithStatus) => {
    setMenuState({ isOpen: true, position: { x: e.clientX, y: e.clientY }, session });
  };

  const handleMenuClose = () => {
    setMenuState({ isOpen: false, position: { x: 0, y: 0 }, session: null });
  };

  return (
    <div class="dashboard-container" data-testid="dashboard">
      <div class="dashboard-panel-wrapper">
        <KittScanner />
        <div class={`dashboard-panel ${panelExpanded() ? 'dashboard-panel--expanded' : ''}`} data-testid="dashboard-floating-panel">

        {/* Integrated Header */}
        <div class="dashboard-panel-header">
          <div class="header-logo">
            <Icon path={mdiXml} size={22} class="header-logo-icon" />
            <span class="header-logo-text">Codeflare</span>
          </div>
          <div class="header-spacer" />
          <div class="header-actions">
            <button type="button" class="header-user-menu" title="User menu">
              <Show when={props.userName} fallback={<Icon path={mdiAccountCircle} size={24} class="header-user-avatar" />}>
                <img src={getGravatarUrl(props.userName!, 48)} alt="Avatar" class="header-user-avatar-img" width={24} height={24} />
              </Show>
              <Show when={props.userName}>
                <span class="header-user-name">{props.userName}</span>
              </Show>
            </button>
            <button type="button" class="header-settings-button" data-testid="dashboard-settings-button" title="Settings" onClick={() => props.onSettingsClick?.()}>
              <Icon path={mdiCogOutline} size={20} />
            </button>
            <button type="button" class="header-logout-button" data-testid="dashboard-logout-button" title="Logout" onClick={() => props.onLogout?.()}>
              <Icon path={mdiLogout} size={20} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div class="dashboard-panel-body">
          {/* Left Column */}
          <div class="dashboard-panel-left" data-testid="dashboard-panel-left">
            <DashboardCard sessions={props.sessions} />

            <div class="dashboard-new-session-wrapper">
                <Portal>
                  <CreateSessionDialog
                    isOpen={showCreateDialog()}
                    onClose={() => setShowCreateDialog(false)}
                    onSelect={(agentType, tabConfig) => {
                      setShowCreateDialog(false);
                      props.onCreateSession(agentType, tabConfig);
                    }}
                    anchorRef={newSessionBtnRef()}
                  />
                </Portal>
                <button type="button" ref={setNewSessionBtnRef} class="dashboard-new-session-btn" data-testid="dashboard-new-session" onClick={() => setShowCreateDialog(!showCreateDialog())}>
                  + New Session
                </button>
            </div>

            <Show when={props.sessions.length > 0}>
              <div class="dashboard-sessions-section">
                <div class="dashboard-section-divider"><span>Recent Sessions</span></div>
                <div class="dashboard-session-list">
                  <For each={props.sessions}>
                    {(session) => (
                      <SessionStatCard
                        session={session}
                        isActive={false}
                        onSelect={() => handleSessionSelect(session)}
                        onStop={() => props.onStopSession(session.id)}
                        onDelete={() => props.onDeleteSession(session.id)}
                        onMenuClick={handleMenuClick}
                      />
                    )}
                  </For>
                </div>
                <Portal>
                  <SessionContextMenu
                    isOpen={menuState().isOpen}
                    position={menuState().position}
                    canStop={menuState().session ? (menuState().session!.status === 'running' || menuState().session!.status === 'initializing') : false}
                    sessionName={menuState().session?.name || ''}
                    onStop={() => { if (menuState().session) props.onStopSession(menuState().session!.id); }}
                    onDelete={() => { if (menuState().session) props.onDeleteSession(menuState().session!.id); }}
                    onClose={handleMenuClose}
                  />
                </Portal>
              </div>
            </Show>


            <div class="dashboard-stats-section">
              <div class="dashboard-section-divider"><span>Storage</span></div>
              <StatCards stats={storageStore.stats} />
            </div>
          </div>

          {/* Right Column */}
          <div class="dashboard-panel-right" data-testid="dashboard-panel-right">
            <Show when={storageStore.previewFile} fallback={<StorageBrowser />}>
              <FilePreview file={storageStore.previewFile} onBack={handlePreviewBack} onDownload={handlePreviewDownload} />
            </Show>
          </div>
        </div>

        </div>
      </div>
    </div>
  );
};

export default Dashboard;
