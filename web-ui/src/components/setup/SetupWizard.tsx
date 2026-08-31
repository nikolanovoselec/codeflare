import { Component, Switch, Match, createSignal, onMount, Show } from 'solid-js';
import { mdiAlertCircleOutline, mdiXml, mdiLoading } from '@mdi/js';
import { setupStore } from '../../stores/setup';
import { getSetupStatus, getUser } from '../../api/client';
import WelcomeStep from './WelcomeStep';
import ConfigureStep from './ConfigureStep';
import ProgressStep from './ProgressStep';
import Icon from '../Icon';
import '../../styles/setup-wizard.css';

type AuthState = 'loading' | 'authorized' | 'denied' | 'load-error';

const SetupWizard: Component = () => {
  const [authState, setAuthState] = createSignal<AuthState>('loading');
  const [initializationComplete, setInitializationComplete] = createSignal(false);

  onMount(async () => {
    try {
      const status = await getSetupStatus();
      if (status.configured) {
        const user = await getUser();
        if (user.role !== 'admin') {
          setAuthState('denied');
          return;
        }
      }
      const loaded = await setupStore.loadExistingConfig();
      if (status.configured && !loaded) {
        setAuthState('load-error');
        return;
      }
      setInitializationComplete(status.configured);
      setAuthState('authorized');
    } catch {
      setAuthState('denied');
    }
  });

  return (
    <div class="setup-wizard">
      <Show when={authState() === 'loading'}>
        <div class="setup-container setup-container--message">
          <div class="setup-header">
            <Icon path={mdiXml} size={24} class="setup-logo-icon" />
            <h1 class="setup-title">Administration &amp; Analytics</h1>
            <span class="setup-header-status">
              <Icon path={mdiLoading} size={14} class="setup-header-status-icon--spin" />
              Loading
            </span>
          </div>
        </div>
      </Show>

      <Show when={authState() === 'load-error'}>
        <div class="setup-container setup-container--message">
          <div class="setup-header">
            <Icon path={mdiAlertCircleOutline} size={24} class="setup-logo-icon setup-logo-icon--error" />
            <h1 class="setup-title">Administration &amp; Analytics</h1>
            <span class="setup-header-status setup-header-status--error">Unavailable</span>
          </div>
          <div class="setup-content setup-content--message">
            <p class="denied-message">Initialization settings could not be loaded. No values were changed.</p>
            <button type="button" class="denied-button" onClick={() => window.location.reload()}>
              Retry
            </button>
          </div>
        </div>
      </Show>

      <Show when={authState() === 'denied'}>
        <div class="setup-container setup-container--message">
          <div class="setup-header">
            <Icon path={mdiAlertCircleOutline} size={24} class="setup-logo-icon setup-logo-icon--error" />
            <h1 class="setup-title">Administration &amp; Analytics</h1>
            <span class="setup-header-status setup-header-status--error">Access denied</span>
          </div>
          <div class="setup-content setup-content--message">
            <p class="denied-message">Only administrators can access Initialization.</p>
            <button type="button" class="denied-button" onClick={() => { window.location.href = '/app/'; }}>
              Return to dashboard
            </button>
          </div>
        </div>
      </Show>

      <Show when={authState() === 'authorized'}>
        <div class="setup-container">
          <div class="setup-header">
            <Icon path={mdiXml} size={24} class="setup-logo-icon" />
            <h1 class="setup-title">Administration &amp; Analytics</h1>
            <span class="setup-header-status">{initializationComplete() ? 'Completed' : 'First-run setup'}</span>
          </div>
          <div class="setup-content">
            <Switch>
              <Match when={setupStore.step === 1}><WelcomeStep /></Match>
              <Match when={setupStore.step === 2}><ConfigureStep /></Match>
              <Match when={setupStore.step === 3}><ProgressStep /></Match>
            </Switch>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default SetupWizard;
