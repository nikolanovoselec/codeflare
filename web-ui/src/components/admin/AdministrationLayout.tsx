import { A, useLocation } from '@solidjs/router';
import { Component, For, Show, createContext, createResource, createSignal, useContext, type JSX } from 'solid-js';
import {
  mdiAccountMultipleOutline,
  mdiArrowLeft,
  mdiChartLine,
  mdiCogOutline,
  mdiCreditCardOutline,
  mdiEmailOutline,
  mdiHistory,
  mdiMenu,
  mdiViewDashboardOutline,
  mdiWrenchOutline,
  mdiClose,
} from '@mdi/js';
import Icon from '../Icon';
import { getAdminConfiguration } from '../../api/client';
import type { AdminConfigurationResponse } from '../../types';
import '../../styles/administration.css';

const AdministrationContext = createContext<AdminConfigurationResponse>();

export function useAdministration(): AdminConfigurationResponse {
  const value = useContext(AdministrationContext);
  if (!value) throw new Error('Administration context is unavailable');
  return value;
}

const AdministrationLayout: Component<{ children?: JSX.Element }> = (props) => {
  const [configuration, { refetch }] = createResource(getAdminConfiguration);
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const location = useLocation();

  const navigation = () => {
    const mode = configuration()?.mode;
    return [
      { href: '/admin', label: 'Overview', icon: mdiViewDashboardOutline, show: true },
      { href: '/admin/environment', label: 'Environment', icon: mdiCogOutline, show: true },
      { href: '/admin/users', label: 'Users', icon: mdiAccountMultipleOutline, show: mode !== 'enterprise' },
      { href: '/admin/subscriptions', label: 'Subscription Tiers', icon: mdiCreditCardOutline, show: mode === 'saas' },
      { href: '/admin/analytics', label: 'Analytics', icon: mdiChartLine, show: true },
      { href: '/admin/reports', label: 'Reports', icon: mdiEmailOutline, show: true },
      { href: '/admin/activity', label: 'Activity', icon: mdiHistory, show: true },
      { href: '/setup', label: 'Initialization', icon: mdiWrenchOutline, show: true },
    ].filter((item) => item.show);
  };

  const isActive = (href: string) => href === '/admin'
    ? location.pathname === href
    : location.pathname.startsWith(href);

  const Navigation = () => (
    <>
      <div class="admin-brand">
        <span class="admin-brand-mark">C</span>
        <span>Administration &amp; Analytics</span>
      </div>
      <nav class="admin-navigation" aria-label="Administration">
        <For each={navigation()}>{(item) => (
          <A
            href={item.href}
            class="admin-navigation-item"
            classList={{ 'is-active': isActive(item.href) }}
            aria-current={isActive(item.href) ? 'page' : undefined}
            title={item.label}
            onClick={() => setDrawerOpen(false)}
          >
            <Icon path={item.icon} size={18} aria-hidden="true" />
            <span>{item.label}</span>
          </A>
        )}</For>
      </nav>
      <div class="admin-context">
        <span class="admin-context-label">Deployment</span>
        <strong>{configuration()?.mode}</strong>
        <span>{(configuration()?.sections.domain as { customDomain?: string } | undefined)?.customDomain || 'Domain not configured'}</span>
      </div>
      <A class="admin-workspace-link" href="/app/">
        <Icon path={mdiArrowLeft} size={18} aria-hidden="true" />
        <span>Back to workspace</span>
      </A>
    </>
  );

  return (
    <Show
      when={!configuration.loading}
      fallback={<div class="admin-state-page"><div class="app-loading-spinner" /><p>Loading Administration…</p></div>}
    >
      <Show
        when={!configuration.error && configuration()}
        fallback={
          <div class="admin-state-page">
            <h1>Administration unavailable</h1>
            <p>Settings could not be loaded. No changes were made.</p>
            <button type="button" class="admin-primary-button" onClick={() => void refetch()}>Retry</button>
            <A href="/app/">Back to workspace</A>
          </div>
        }
      >
        {(resolved) => (
          <AdministrationContext.Provider value={resolved()}>
            <div class="admin-shell">
              <aside class="admin-sidebar"><Navigation /></aside>
              <header class="admin-mobile-header">
                <button
                  type="button"
                  class="admin-icon-button"
                  aria-label="Open administration navigation"
                  aria-expanded={drawerOpen()}
                  onClick={() => setDrawerOpen(true)}
                >
                  <Icon path={mdiMenu} size={22} />
                </button>
                <span>Administration &amp; Analytics</span>
              </header>
              <Show when={drawerOpen()}>
                <button class="admin-drawer-backdrop" aria-label="Close administration navigation" onClick={() => setDrawerOpen(false)} />
                <aside class="admin-drawer">
                  <button type="button" class="admin-icon-button admin-drawer-close" aria-label="Close navigation" onClick={() => setDrawerOpen(false)}>
                    <Icon path={mdiClose} size={22} />
                  </button>
                  <Navigation />
                </aside>
              </Show>
              <main class="admin-main">{props.children}</main>
            </div>
          </AdministrationContext.Provider>
        )}
      </Show>
    </Show>
  );
};

export default AdministrationLayout;
