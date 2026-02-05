import { Component, Show, For, onMount } from 'solid-js';
import {
  mdiCog,
  mdiAlertCircle,
  mdiCheckCircle,
  mdiCheckCircleOutline,
  mdiCircleOutline,
  mdiLoading,
  mdiRocketLaunchOutline,
  mdiShieldLockOutline,
  mdiInformationOutline,
} from '@mdi/js';
import Icon from '../Icon';
import Button from '../ui/Button';
import { setupStore } from '../../stores/setup';
import '../../styles/progress-step.css';

const ProgressStep: Component = () => {
  onMount(() => {
    setupStore.configure();
  });

  const stepLabels: Record<string, string> = {
    get_account: 'Verifying account',
    derive_r2_credentials: 'Deriving R2 credentials',
    set_secrets: 'Setting worker secrets',
    configure_custom_domain: 'Configuring custom domain',
    create_access_app: 'Creating Access application',
    configure_turnstile: 'Configuring waitlist Turnstile',
    finalize: 'Finalizing setup',
  };

  const getStepLabel = (step: string) => stepLabels[step] || step;

  const getStepIcon = (status: string) => {
    switch (status) {
      case 'success':
        return mdiCheckCircle;
      case 'error':
        return mdiAlertCircle;
      case 'pending':
        return mdiCircleOutline;
      default:
        return mdiLoading;
    }
  };

  const handleLaunch = () => {
    if (setupStore.customDomainUrl) {
      window.location.href = `${setupStore.customDomainUrl}/app`;
    } else {
      window.location.href = '/app/';
    }
  };

  const handleRetry = () => {
    setupStore.configure();
  };

  return (
    <div class="progress-step">
      <Show
        when={setupStore.setupComplete}
        fallback={
          <>
            <h2 class="progress-title">
              {setupStore.configureError ? (
                <>
                  <Icon path={mdiAlertCircle} size={24} class="title-icon title-icon--error" />
                  Setup Failed
                </>
              ) : (
                <>
                  <Icon path={mdiCog} size={24} class="title-icon title-icon--spin" />
                  Configuring Codeflare
                </>
              )}
            </h2>

            <div class="progress-steps">
              <For each={setupStore.configureSteps}>
                {(step) => (
                  <div class={`progress-step-item ${step.status}`}>
                    <span class={`step-icon ${step.status === 'running' ? 'step-icon--spin' : ''}`}>
                      <Icon path={getStepIcon(step.status)} size={18} />
                    </span>
                    <span class="step-label">{getStepLabel(step.step)}</span>
                    <Show when={step.error}>
                      <span class="step-error">{step.error}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>

            <Show when={setupStore.configuring}>
              <div class="progress-bar-container">
                <div
                  class="progress-bar"
                  style={{
                    width: `${
                      (setupStore.configureSteps.filter((s) => s.status === 'success')
                        .length /
                        Math.max(setupStore.configureSteps.length, 4)) *
                      100
                    }%`,
                  }}
                />
              </div>
            </Show>

            <Show when={setupStore.configureError}>
              <div class="error-message">
                <strong>Error:</strong> {setupStore.configureError}
              </div>
              <div class="progress-actions">
                <Button
                  variant="secondary"
                  onClick={() => setupStore.prevStep()}
                >
                  Back
                </Button>
                <Button onClick={handleRetry}>
                  Retry
                </Button>
              </div>
            </Show>
          </>
        }
      >
        <h2 class="progress-title">
          <Icon path={mdiCheckCircleOutline} size={24} class="title-icon title-icon--success" />
          Setup Complete!
        </h2>

        <div class="success-section">
          <p class="success-message">Your Codeflare instance is ready.</p>

          <Show when={setupStore.customDomainUrl}>
            <div class="url-item">
              <span class="url-icon">
                <Icon path={mdiShieldLockOutline} size={20} />
              </span>
              <div class="url-content">
                <span class="url-label">Custom domain (with Access):</span>
                <a href={setupStore.customDomainUrl || ''} class="url-value">
                  {setupStore.customDomainUrl}
                </a>
                <span class="url-note">Protected by Cloudflare Access</span>
              </div>
            </div>
          </Show>

          <div class="access-note">
            <Icon path={mdiInformationOutline} size={16} class="note-icon" />
            <span>
              To protect your workers.dev URL, enable one-click Access in the Cloudflare dashboard.
            </span>
          </div>

          <Button onClick={handleLaunch} icon={mdiRocketLaunchOutline} size="lg">
            Launch Codeflare
          </Button>

          <Show when={setupStore.customDomainUrl}>
            <p class="launch-note">
              <Icon path={mdiInformationOutline} size={14} class="note-icon" />
              You'll be redirected to Cloudflare Access login
            </p>
          </Show>
        </div>
      </Show>

    </div>
  );
};

export default ProgressStep;
