import { Component, onMount, onCleanup, createSignal, Show, lazy, type JSX } from 'solid-js';
import { Router, Route, Navigate, useNavigate } from '@solidjs/router';
import Layout from './components/Layout';
import SetupWizard from './components/setup/SetupWizard';
import { getUser, getSetupStatus } from './api/client';
import { sessionStore } from './stores/session';
import { storageStore } from './stores/storage';
import { terminalStore } from './stores/terminal';
import { logger } from './lib/logger';
import './styles/app.css';

// Lazy-load the onboarding landing page (only needed when onboarding mode is active)
const OnboardingLanding = lazy(() => import('./components/OnboardingLanding'));

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
  const [onboardingActive, setOnboardingActive] = createSignal<boolean | undefined>();
  const [loading, setLoading] = createSignal(true);
  const [authError, setAuthError] = createSignal<string | null>(null);

  onMount(async () => {
    try {
      const user = await getUser();
      setUserName(user.email);
      setUserRole(user.role);
      setOnboardingActive(user.onboardingActive);
      if (user.workerName) storageStore.setWorkerName(user.workerName);
    } catch (err) {
      logger.warn('Failed to get user info:', err);
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
    sessionStore.stopAllMetricsPolling();
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
        <Layout userName={userName()} userRole={userRole()} onboardingActive={onboardingActive()} />
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

const App: Component = () => {
  return (
    <Router>
      <Route path="/setup" component={SetupWizard} />
      <Route path="/" component={OnboardingLanding} />
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
