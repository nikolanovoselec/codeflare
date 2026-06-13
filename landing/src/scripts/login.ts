/**
 * Onboarding /login page script. The page ships the sign-in choices as its
 * default markup (correct with no JS); this reflects the OAuth round-trip
 * outcome the Worker carries back in the URL:
 *
 *   ?status=requested  a new visitor's access request was recorded and emailed,
 *                      so swap the choices for the confirmation panel.
 *   ?error=<code>      sign-in failed; show a friendly message (mapped from the
 *                      build-time #login-errors JSON) and keep the choices so the
 *                      visitor can retry.
 *
 * No animation here, so nothing to gate on reduced motion. The enterprise SSO
 * accordion is native <details name="sso">; it needs no JS.
 */
const params = new URLSearchParams(window.location.search);

if (params.get('status') === 'requested') {
  document.querySelector('[data-login-choices]')?.setAttribute('hidden', '');
  document.querySelector('[data-login-requested]')?.removeAttribute('hidden');
}

const errorCode = params.get('error');
if (errorCode) {
  const box = document.querySelector<HTMLElement>('[data-login-error]');
  if (box) {
    box.textContent = lookupErrorMessage(errorCode);
    box.removeAttribute('hidden');
  }
}

/** Resolve an OAuth error code to copy via the page's build-time error map,
 *  falling back to a generic message for unknown codes or a missing/invalid map. */
function lookupErrorMessage(code: string): string {
  const fallback = 'Sign-in failed. Please try again.';
  const raw = document.getElementById('login-errors')?.textContent;
  if (!raw) return fallback;
  try {
    const map = JSON.parse(raw) as Record<string, string>;
    return map[code] ?? map.default ?? fallback;
  } catch {
    return fallback;
  }
}
