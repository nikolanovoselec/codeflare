import { Component, onMount, onCleanup, createSignal, Show, lazy, type JSX } from 'solid-js';
import type { AccessTier, SubscriptionTier } from './types';
import { Router, Route, Navigate, useNavigate } from '@solidjs/router';
import Layout from './components/Layout';
import SetupWizard from './components/setup/SetupWizard';
import { getUser, getSetupStatus, getAuthProviders, getOnboardingConfig, getAuthStatus } from './api/client';
import { ApiError } from './api/fetch-helper';
import { sessionStore } from './stores/session';
import { storageStore } from './stores/storage';
import { terminalStore } from './stores/terminal';
import { logger } from './lib/logger';
import './styles/app.css';

// Lazy-load the onboarding landing page (only needed when onboarding mode is active)
const OnboardingLanding = lazy(() => import('./components/OnboardingLanding'));
const LoginPage = lazy(() => import('./components/LoginPage'));
const SubscribePage = lazy(() => import('./components/SubscribePage'));
const UserManagement = lazy(() => import('./components/admin/UserManagement'));
const OnboardingPage = lazy(() => import('./components/OnboardingPage'));
const UsagePage = lazy(() => import('./components/UsagePage'));
const AdminSubscriptionManagement = lazy(() => import('./components/admin/SubscriptionManagement'));

// Check setup status from API.
// Returns null when status cannot be determined (e.g. Access redirect/network error).
async function checkSetupStatus(): Promise<boolean | null> {
  try {
    const status = await getSetupStatus();
    return status.configured;
  } catch (err) {
    logger.error('Failed to check setup status:', err);
    // Unknown status should not force a /setup redirect.
    return null;
  }
}

// Main app content after setup check
const AppContent: Component = () => {
  const [userName, setUserName] = createSignal<string | undefined>();
  const [userRole, setUserRole] = createSignal<'admin' | 'user' | undefined>();
  const [userAccessTier, setUserAccessTier] = createSignal<AccessTier | undefined>();
  const [userSubscriptionTier, setUserSubscriptionTier] = createSignal<SubscriptionTier | undefined>();
  const [onboardingActive, setOnboardingActive] = createSignal<boolean | undefined>();
  const [enterpriseMode, setEnterpriseMode] = createSignal<boolean | undefined>();
  const [loading, setLoading] = createSignal(true);
  const [authError, setAuthError] = createSignal<string | null>(null);

  onMount(async () => {
    try {
      const user = await getUser();
      setUserName(user.email);
      setUserRole(user.role);
      setUserAccessTier(user.accessTier);
      setUserSubscriptionTier(user.subscriptionTier);
      setOnboardingActive(user.onboardingActive);
      setEnterpriseMode(user.enterpriseMode);
      sessionStore.setEnterpriseMode(user.enterpriseMode === true);
      if (user.workerName) storageStore.setWorkerName(user.workerName);

      // SaaS mode redirect priority:
      // 1. Pending tier → subscribe page (choose a plan)
      // 2. Not onboarded → onboarding page (first-time guided setup)
      // 3. Otherwise → dashboard
      // Enterprise users are always unlimited (never pending) — skip the
      // subscribe redirect so the billing flow stays hidden in enterprise mode.
      const effectiveTier = user.subscriptionTier ?? user.accessTier;
      if (!user.enterpriseMode && user.saasMode && effectiveTier === 'pending') {
        window.location.href = '/app/subscribe';
        return;
      }
      if (user.saasMode && !user.onboardingComplete) {
        window.location.href = '/app/onboarding';
        return;
      }
    } catch (err) {
      logger.warn('Failed to get user info:', err);
      // SaaS mode: pending/blocked users get 403 from requireActiveUser
      if (err instanceof ApiError && err.status === 403) {
        try {
          const parsed = typeof err.body === 'string' ? JSON.parse(err.body) : err.body;
          const code = parsed && typeof parsed === 'object' && 'code' in parsed ? (parsed as { code: string }).code : null;
          if (code === 'PENDING' || code === 'BLOCKED') {
            window.location.href = '/app/subscribe';
            return;
          }
        } catch {
          // Failed to parse body — fall through to generic error
        }
      }
      if (import.meta.env.DEV) {
        setUserName('dev@localhost');
        setUserRole('admin');
      } else {
        setAuthError('Authentication required. Please refresh the page.');
      }
    } finally {
      setLoading(false);
    }
  });

  onCleanup(() => {
    sessionStore.stopAllPolling();
    terminalStore.disposeAll();
  });

  return (
    <Show
      when={!loading()}
      fallback={
        <div class="app-loading">
          <div class="app-loading-spinner" />
          <span>Loading...</span>
        </div>
      }
    >
      <Show
        when={!authError()}
        fallback={
          <div class="app-auth-error">
            <h1>Authentication Error</h1>
            <p>{authError()}</p>
            <button type="button" onClick={() => window.location.reload()}>Retry</button>
          </div>
        }
      >
        <Layout userName={userName()} userRole={userRole()} userAccessTier={userAccessTier()} userSubscriptionTier={userSubscriptionTier()} onboardingActive={onboardingActive()} enterpriseMode={enterpriseMode()} />
      </Show>
    </Show>
  );
};

// Router wrapper that checks setup status
const SetupGuard: Component<{ children: JSX.Element }> = (props) => {
  const [setupRequired, setSetupRequired] = createSignal<boolean | null>(null);
  const navigate = useNavigate();

  onMount(async () => {
    const configured = await checkSetupStatus();

    // Unknown status (commonly unauthenticated Access redirect). Do not
    // treat this as "setup required" to avoid false redirects to /setup.
    if (configured === null) {
      setSetupRequired(false);
      return;
    }

    setSetupRequired(!configured);

    // If setup is required and we're not on /setup, navigate there
    if (!configured && window.location.pathname !== '/setup') {
      navigate('/setup', { replace: true });
    }
  });

  return (
    <Show
      when={setupRequired() !== null}
      fallback={
        <div class="app-loading">
          <div class="app-loading-spinner" />
          <span>Checking setup status...</span>
        </div>
      }
    >
      <Show when={!setupRequired()} fallback={<Navigate href="/setup" />}>
        {props.children}
      </Show>
    </Show>
  );
};

/**
 * Root page component — decides which landing to show based on deployment mode.
 * SaaS mode (providers configured) → LoginPage
 * Onboarding mode (onboarding active) → OnboardingLanding
 * Default → redirect to /app/
 */
const RootPage: Component = () => {
  const [mode, setMode] = createSignal<'loading' | 'login' | 'onboarding' | 'redirect'>('loading');

  onMount(async () => {
    // Check if SaaS mode is active (providers endpoint is public)
    try {
      const { providers } = await getAuthProviders();
      if (providers.length > 0) {
        setMode('login');
        return;
      }
    } catch {
      // providers endpoint failed — not in SaaS mode or backend issue
    }

    // Check if onboarding mode is active
    try {
      const config = await getOnboardingConfig();
      if (config.active) {
        setMode('onboarding');
        return;
      }
    } catch {
      // onboarding config failed — default mode
    }

    // Default mode — redirect to /app/
    setMode('redirect');
    window.location.href = '/app/';
  });

  return (
    <Show when={mode() !== 'loading'} fallback={
      <div class="app-loading">
        <div class="app-loading-spinner" />
        <span>Loading...</span>
      </div>
    }>
      <Show when={mode() === 'login'}>
        <LoginPage />
      </Show>
      <Show when={mode() === 'onboarding'}>
        <OnboardingLanding />
      </Show>
    </Show>
  );
};

/**
 * Subscribe-route guard. Enterprise users are always unlimited and the billing
 * flow is hidden, so direct navigation to /app/subscribe redirects to /app.
 * Non-enterprise (flag unset/false): renders SubscribePage unchanged.
 */
const SubscribeGuard: Component = () => {
  const [decision, setDecision] = createSignal<'loading' | 'subscribe' | 'redirect'>('loading');

  onMount(async () => {
    try {
      const status = await getAuthStatus();
      if (status.enterpriseMode === true) {
        setDecision('redirect');
        window.location.href = '/app/';
        return;
      }
    } catch {
      // Status unavailable — fall through to the normal subscribe page.
    }
    setDecision('subscribe');
  });

  return (
    <Show when={decision() === 'subscribe'} fallback={
      <div class="app-loading">
        <div class="app-loading-spinner" />
        <span>Loading...</span>
      </div>
    }>
      <SubscribePage />
    </Show>
  );
};

const App: Component = () => {
  return (
    <Router>
      <Route path="/setup" component={SetupWizard} />
      <Route path="/" component={RootPage} />
      <Route path="/login" component={LoginPage} />
      <Route path="/app/subscribe" component={SubscribeGuard} />
      <Route path="/app/onboarding" component={OnboardingPage} />
      <Route path="/app/usage" component={UsagePage} />
      <Route path="/admin/users" component={() => (
        <SetupGuard>
          <UserManagement onBack={() => { window.location.href = '/app/'; }} />
        </SetupGuard>
      )} />
      <Route path="/admin/subscriptions" component={() => (
        <SetupGuard>
          <AdminSubscriptionManagement onBack={() => { window.location.href = '/app/'; }} />
        </SetupGuard>
      )} />
      <Route
        path="/*"
        component={() => (
          <SetupGuard>
            <AppContent />
          </SetupGuard>
        )}
      />
    </Router>
  );
};

export default App;
