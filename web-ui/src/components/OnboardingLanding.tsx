import { Component, onMount, createSignal, Show } from 'solid-js';
import { mdiXml } from '@mdi/js';
import { getOnboardingConfig, getUser } from '../api/client';
import SplashCursor from './SplashCursor';
import KittScanner from './KittScanner';
import Icon from './Icon';
import { logger } from '../lib/logger';
import '../styles/onboarding-landing.css';

const OnboardingLanding: Component = () => {
  const [loading, setLoading] = createSignal(true);
  const [turnstileSiteKey, setTurnstileSiteKey] = createSignal<string | null>(null);
  const [email, setEmail] = createSignal('');
  const [message, setMessage] = createSignal('');
  const [messageType, setMessageType] = createSignal<'error' | 'success' | ''>('');
  const [submitting, setSubmitting] = createSignal(false);

  onMount(async () => {
    // Check if user is already authenticated — redirect to app if so
    try {
      const user = await getUser();
      if (user?.authenticated) {
        window.location.href = '/app/';
        return;
      }
    } catch {
      // Not authenticated — expected for public visitors
    }

    // Fetch onboarding config
    try {
      const config = await getOnboardingConfig();
      if (!config.active) {
        window.location.href = '/app/';
        return;
      }
      setTurnstileSiteKey(config.turnstileSiteKey);
    } catch (err) {
      logger.error('Failed to fetch onboarding config:', err);
      // If config fetch fails, still show the page without Turnstile
    }

    setLoading(false);

    // Load Turnstile script dynamically if site key is available
    if (turnstileSiteKey()) {
      loadTurnstileScript();
    }
  });

  function loadTurnstileScript() {
    if (document.querySelector('script[src*="challenges.cloudflare.com"]')) return;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setMessage('');
    setMessageType('');

    const emailValue = email().trim();
    const tokenInput = document.querySelector(
      'textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]'
    ) as HTMLInputElement | HTMLTextAreaElement | null;
    const turnstileToken = tokenInput?.value || '';

    if (!emailValue || !turnstileToken) {
      setMessage('Please complete email and CAPTCHA.');
      setMessageType('error');
      return;
    }

    setSubmitting(true);

    try {
      const response = await fetch('/public/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailValue, turnstileToken }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload as { error?: string }).error || 'Submission failed');
      }
      setMessage('Submitted. We will contact you if approved.');
      setMessageType('success');
      setEmail('');
      // Reset Turnstile widget
      if ((window as any).turnstile?.reset) {
        (window as any).turnstile.reset();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Submission failed');
      setMessageType('error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Show
      when={!loading()}
      fallback={
        <div class="onboarding-loading">
          <div class="onboarding-loading-spinner" />
        </div>
      }
    >
      <div class="onboarding-landing">
        <SplashCursor
          DENSITY_DISSIPATION={3.5}
          VELOCITY_DISSIPATION={2}
          SPLAT_RADIUS={0.2}
          SPLAT_FORCE={6000}
          COLOR_UPDATE_SPEED={10}
        />

        <main class="onboarding-card">
          <KittScanner />
          <header class="onboarding-card-header">
            <Icon path={mdiXml} size={24} class="onboarding-brand-icon" />
            <div class="onboarding-card-title-wrap">
              <span class="onboarding-eyebrow">Onboarding</span>
              <h1>Codeflare access request</h1>
            </div>
            <span class="onboarding-header-spacer" aria-hidden="true" />
            <a
              class="onboarding-repo-link"
              href="https://github.com/nikolanovoselec/codeflare"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open Codeflare GitHub repository"
              title="View Codeflare on GitHub"
            >
              <svg viewBox="0 0 24 24" role="presentation">
                <path d="M12 2C6.48 2 2 6.58 2 12.24c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-1.05-.01-1.9-2.78.62-3.37-1.21-3.37-1.21-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.58 2.35 1.12 2.92.86.09-.67.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.08 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.31.1-2.73 0 0 .84-.27 2.75 1.05A9.25 9.25 0 0 1 12 6.4a9.2 9.2 0 0 1 2.5.35c1.9-1.32 2.74-1.05 2.74-1.05.55 1.42.2 2.47.1 2.73.64.72 1.03 1.64 1.03 2.76 0 3.95-2.33 4.82-4.56 5.07.36.31.68.92.68 1.86 0 1.34-.01 2.42-.01 2.75 0 .27.18.59.69.49A10.26 10.26 0 0 0 22 12.24C22 6.58 17.52 2 12 2z" />
              </svg>
            </a>
          </header>

          <div class="onboarding-card-content">
            <p class="onboarding-lead">
              Join the waitlist for access to an isolated, ephemeral cloud development environment.
            </p>

            <form onSubmit={handleSubmit} autocomplete="off">
              <label for="onboarding-email">Email</label>
              <input
                id="onboarding-email"
                type="email"
                name="email"
                required
                placeholder="you@example.com"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
                class="onboarding-email-input"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck={false}
              />

              <div class="onboarding-form-controls">
                <div class="onboarding-actions">
                  <button
                    class="onboarding-btn-primary"
                    type="submit"
                    disabled={submitting()}
                  >
                    {submitting() ? 'Submitting...' : 'Join waitlist'}
                  </button>
                  <a class="onboarding-btn-secondary" href="/app/" onClick={(e) => { e.preventDefault(); window.location.href = '/app/'; }}>Login</a>
                </div>

                <div class="onboarding-turnstile" data-testid="turnstile-container">
                  <Show
                    when={turnstileSiteKey()}
                    fallback={
                      <div class="onboarding-message onboarding-message-warn">
                        Waitlist is not configured yet. Please try again later.
                      </div>
                    }
                  >
                    <div
                      class="cf-turnstile"
                      data-sitekey={turnstileSiteKey()!}
                      data-theme="dark"
                      data-size="flexible"
                    />
                  </Show>
                </div>
              </div>

              <div
                class={`onboarding-message ${messageType() ? `onboarding-message-${messageType()}` : ''}`}
                aria-live="polite"
              >
                {message()}
              </div>
            </form>

            <div class="onboarding-meta">
              Already approved? Click Login and continue to your dashboard.
            </div>
          </div>
        </main>
      </div>
    </Show>
  );
};

export default OnboardingLanding;
