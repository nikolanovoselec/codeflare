import { Component, Show, onMount } from 'solid-js';
import {
  mdiCheckCircleOutline,
  mdiAlertCircleOutline,
  mdiLoading,
} from '@mdi/js';
import Icon from '../Icon';
import { setupStore } from '../../stores/setup';
import Button from '../ui/Button';
import '../../styles/welcome-step.css';

const WelcomeStep: Component = () => {
  onMount(() => {
    setupStore.detectToken();
  });

  return (
    <div class="welcome-step">
      <h2 class="welcome-title">Welcome to Codeflare</h2>
      <p class="welcome-description">
        Let's configure your personal Claude Code environment.
      </p>

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

            <Button onClick={() => setupStore.nextStep()}>
              Get Started
            </Button>
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
  );
};

export default WelcomeStep;
