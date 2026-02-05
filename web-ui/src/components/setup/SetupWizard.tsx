import { Component, Switch, Match, createSignal, onMount, Show } from 'solid-js';
import { mdiAlertCircleOutline, mdiXml, mdiLoading } from '@mdi/js';
import { setupStore } from '../../stores/setup';
import { getSetupStatus, getUser } from '../../api/client';
import WelcomeStep from './WelcomeStep';
import ConfigureStep from './ConfigureStep';
import ProgressStep from './ProgressStep';
import SplashCursor from '../SplashCursor';
import Icon from '../Icon';
import KittScanner from '../KittScanner';
import '../../styles/setup-wizard.css';

type AuthState = 'loading' | 'authorized' | 'denied';

const SetupWizard: Component = () => {
  const [authState, setAuthState] = createSignal<AuthState>('loading');

  onMount(async () => {
    try {
      const status = await getSetupStatus();
      if (!status.configured) {
        // First-time setup: allow public access
        setAuthState('authorized');
        return;
      }
      // Already configured: check if current user is admin
      const user = await getUser();
      if (user.role === 'admin') {
        setAuthState('authorized');
      } else {
        setAuthState('denied');
      }
    } catch {
      // If we can't determine status, deny access (safe default)
      setAuthState('denied');
    }
  });

  const handleReturn = () => {
    window.location.href = '/app/';
  };

  return (
    <div class="setup-wizard">
      <SplashCursor />

      <Show when={authState() === 'loading'}>
        <div class="setup-container">
          <KittScanner />
          <div class="setup-header">
            <Icon path={mdiXml} size={24} class="setup-logo-icon" />
            <h1 class="setup-title">Codeflare Setup</h1>
            <span class="setup-header-status">
              <Icon path={mdiLoading} size={14} class="setup-header-status-icon--spin" />
              Loading
            </span>
          </div>
        </div>
      </Show>

      <Show when={authState() === 'denied'}>
        <div class="setup-container">
          <KittScanner />
          <div class="setup-header">
            <Icon path={mdiAlertCircleOutline} size={24} class="setup-logo-icon setup-logo-icon--error" />
            <h1 class="setup-title">Codeflare Setup</h1>
            <span class="setup-header-status setup-header-status--error">
              <Icon path={mdiAlertCircleOutline} size={14} />
              Access Denied
            </span>
          </div>
          <div class="setup-content">
            <p class="denied-message">
              Only administrators can access the setup wizard.
            </p>
            <button type="button" class="denied-button" onClick={handleReturn}>
              Return to Dashboard
            </button>
          </div>
        </div>
      </Show>

      <Show when={authState() === 'authorized'}>
      <div class="setup-container">
        <KittScanner />
        <div class="setup-header">
          <Icon path={mdiXml} size={24} class="setup-logo-icon" />
          <h1 class="setup-title">Codeflare Setup</h1>
          <span class="setup-header-status">
            Step {setupStore.step} of 3
          </span>
        </div>

        <div class="progress-bar setup-progress">
          <div
            class="progress-bar-fill"
            style={{ width: `${(setupStore.step / 3) * 100}%` }}
          />
        </div>

        <div class="setup-content">
          <Switch>
            <Match when={setupStore.step === 1}>
              <WelcomeStep />
            </Match>
            <Match when={setupStore.step === 2}>
              <ConfigureStep />
            </Match>
            <Match when={setupStore.step === 3}>
              <ProgressStep />
            </Match>
          </Switch>
        </div>
      </div>
      </Show>

    </div>
  );
};

export default SetupWizard;
