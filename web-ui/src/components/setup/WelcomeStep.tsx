import { Component, Show, onMount } from 'solid-js';
import {
  mdiCheckCircleOutline,
  mdiAlertCircleOutline,
  mdiLoading,
} from '@mdi/js';
import Icon from '../Icon';
import { setupStore } from '../../stores/setup';
import Button from '../ui/Button';
import SetupJourneyNav from './SetupJourneyNav';
import '../../styles/welcome-step.css';

const WelcomeStep: Component = () => {
  onMount(() => {
    setupStore.detectToken();
  });

  return (
    <div class="setup-journey-layout">
      <SetupJourneyNav active="readiness" enterprise={setupStore.enterpriseMode} />
      <div class="welcome-step setup-journey-main">
        <div class="setup-page-heading">
          <div>
            <span class="setup-page-eyebrow">Provisioning</span>
            <h2 class="welcome-title">Deployment readiness</h2>
            <p class="welcome-description">Verify control boundaries before creating resources.</p>
          </div>
          <span class="setup-page-status">Complete sequence</span>
        </div>

        <div class="token-detect-section">
        {/* Detecting state */}
        <Show when={setupStore.tokenDetecting}>
          <div class="token-status token-status--detecting">
            <span class="token-status-icon token-status-icon--spin">
              <Icon path={mdiLoading} size={24} />
            </span>
            <div class="token-status-text">
              <strong>Detecting API token...</strong>
              <span>Checking for a pre-configured Cloudflare API token</span>
            </div>
          </div>
        </Show>

        {/* Detected + valid */}
        <Show when={!setupStore.tokenDetecting && setupStore.tokenDetected && setupStore.accountInfo}>{(info) =>
          <>
            <div class="token-status token-status--success">
              <span class="token-status-icon">
                <Icon path={mdiCheckCircleOutline} size={24} />
              </span>
              <div class="token-status-text">
                <strong>API Token Detected</strong>
                <span>
                  Account: {info().name} ({info().id})
                </span>
              </div>
            </div>

            <div class="readiness-facts">
              <div><span>Deployment mode</span><strong>{setupStore.enterpriseMode ? 'Enterprise' : setupStore.saasMode ? 'SaaS' : 'Standard'}</strong></div>
              <div><span>Routine changes</span><strong>Bounded by area</strong></div>
            </div>
            <div class="setup-actions setup-actions--end">
              <Button onClick={() => setupStore.nextStep()}>
                Start setup
              </Button>
            </div>
          </>
        }</Show>

        {/* Detected but invalid / error */}
        <Show when={!setupStore.tokenDetecting && setupStore.tokenDetectError}>
          <div class="token-status token-status--error">
            <span class="token-status-icon">
              <Icon path={mdiAlertCircleOutline} size={24} />
            </span>
            <div class="token-status-text">
              <strong>Token Error</strong>
              <span>{setupStore.tokenDetectError}</span>
            </div>
          </div>

          <div class="token-error-help">
            <p>
              The API token could not be verified. This usually means you need to
              re-deploy with a valid <code>CLOUDFLARE_API_TOKEN</code> secret set
              via GitHub Actions.
            </p>
          </div>

        </Show>

        {/* Not detected at all */}
        <Show when={!setupStore.tokenDetecting && !setupStore.tokenDetected && !setupStore.tokenDetectError}>
          <div class="token-status token-status--error">
            <span class="token-status-icon">
              <Icon path={mdiAlertCircleOutline} size={24} />
            </span>
            <div class="token-status-text">
              <strong>No Token Found</strong>
              <span>
                Deploy via GitHub Actions first with a <code>CLOUDFLARE_API_TOKEN</code> secret
                to set up the API token automatically.
              </span>
            </div>
          </div>

        </Show>
        </div>
      </div>
    </div>
  );
};

export default WelcomeStep;
