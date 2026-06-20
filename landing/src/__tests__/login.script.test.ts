// @vitest-environment happy-dom
/**
 * Behavioral DOM-integration tests for login.ts (the onboarding /login page
 * script). The script reads the OAuth round-trip outcome carried in the URL at
 * import time and reshapes the page accordingly: it swaps the sign-in choices
 * for the "request submitted" confirmation on ?status=requested, and surfaces a
 * mapped, friendly message on ?error=<code> (keeping the choices visible so the
 * visitor can retry).
 *
 * The script runs top-level code on import, so each test sets the URL and builds
 * the fixture DOM BEFORE importing; vi.resetModules() re-runs it per case. These
 * assert the actual reshaping (hidden toggles + message text), so a no-op script
 * or a broken error lookup fails them.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// A standalone error map (the page renders LOGIN.errors here at build time). The
// test ships its own so it exercises the LOOKUP, not a particular copy string.
const ERROR_MAP: Record<string, string> = {
  'session-expired': 'Your sign-in took too long. Please try again.',
  'no-verified-email': 'Your GitHub account has no verified primary email.',
  default: 'Sign-in failed. Please try again.',
};

function buildFixture(): void {
  document.body.innerHTML = `
    <p class="login-error" data-login-error hidden></p>
    <div data-login-choices>choices</div>
    <div class="login-requested" data-login-requested hidden>requested</div>
    <script type="application/json" id="login-errors">${JSON.stringify(ERROR_MAP)}</script>
  `;
}

function setUrl(search: string): void {
  window.history.replaceState({}, '', `/login${search}`);
}

const isHidden = (sel: string): boolean =>
  document.querySelector(sel)?.hasAttribute('hidden') ?? true;

afterEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  setUrl('');
});

describe('REQ-AUTH-021: login.ts onboarding /login outcome handling', () => {
  it('default URL: keeps the sign-in choices visible, confirmation and error hidden', async () => {
    setUrl('');
    buildFixture();

    await import('../scripts/login');

    expect(isHidden('[data-login-choices]')).toBe(false);
    expect(isHidden('[data-login-requested]')).toBe(true);
    expect(isHidden('[data-login-error]')).toBe(true);
  });

  it('?status=requested: hides the choices and reveals the confirmation', async () => {
    setUrl('?status=requested');
    buildFixture();

    await import('../scripts/login');

    expect(isHidden('[data-login-choices]')).toBe(true);
    expect(isHidden('[data-login-requested]')).toBe(false);
  });

  it('?error=<known code>: reveals the error box with the mapped message, choices stay for retry', async () => {
    setUrl('?error=session-expired');
    buildFixture();

    await import('../scripts/login');

    const box = document.querySelector('[data-login-error]');
    expect(box?.hasAttribute('hidden')).toBe(false);
    expect(box?.textContent).toBe('Your sign-in took too long. Please try again.');
    // The choices remain so the visitor can try again.
    expect(isHidden('[data-login-choices]')).toBe(false);
  });

  it('?error=<unknown code>: falls back to the default message', async () => {
    setUrl('?error=totally-unknown-code');
    buildFixture();

    await import('../scripts/login');

    const box = document.querySelector('[data-login-error]');
    expect(box?.hasAttribute('hidden')).toBe(false);
    expect(box?.textContent).toBe('Sign-in failed. Please try again.');
  });
});
