import { createStore, produce } from 'solid-js/store';
import * as api from '../api/client';

/** Whether loadExistingConfig has already been called (prevents duplicate fetches). */
let configLoaded = false;

const TOTAL_STEPS = 3;

interface SetupState {
  step: number;
  // Token detection (auto-detected from env)
  tokenDetected: boolean;
  tokenDetecting: boolean;
  tokenDetectError: string | null;
  accountInfo: { id: string; name: string } | null;
  // Custom domain (optional)
  customDomain: string;
  customDomainError: string | null;
  // Allowed users
  adminUsers: string[];
  allowedUsers: string[];
  // Configuration progress
  configuring: boolean;
  configureSteps: Array<{ step: string; status: string; error?: string }>;
  configureError: string | null;
  setupComplete: boolean;
  // Result URLs
  customDomainUrl: string | null;
  accountId: string | null;
}

const initialState: SetupState = {
  step: 1,
  tokenDetected: false,
  tokenDetecting: false,
  tokenDetectError: null,
  accountInfo: null,
  customDomain: '',
  customDomainError: null,
  adminUsers: [],
  allowedUsers: [],
  configuring: false,
  configureSteps: [],
  configureError: null,
  setupComplete: false,
  customDomainUrl: null,
  accountId: null,
};

const [state, setState] = createStore<SetupState>({ ...initialState });

async function detectToken(): Promise<void> {
  setState('tokenDetecting', true);
  setState('tokenDetectError', null);
  try {
    const data = await api.detectToken();
    if (data.detected && data.valid) {
      setState('tokenDetected', true);
      setState('accountInfo', data.account ?? null);
    } else {
      setState('tokenDetectError', data.error || 'Token not detected');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to detect token';
    setState('tokenDetectError', msg);
  } finally {
    setState('tokenDetecting', false);
  }
}

/** Add a user as admin. If already in allowedUsers, promotes to admin. */
function addAdminUser(email: string): void {
  if (email && !state.adminUsers.includes(email)) {
    setState(
      produce((s) => {
        // If already in regular users list, remove from there
        const regularIndex = s.allowedUsers.indexOf(email);
        if (regularIndex !== -1) {
          s.allowedUsers.splice(regularIndex, 1);
        }
        s.adminUsers.push(email);
      })
    );
  }
}

function removeAdminUser(email: string): void {
  setState(
    produce((s) => {
      const index = s.adminUsers.indexOf(email);
      if (index !== -1) {
        s.adminUsers.splice(index, 1);
      }
    })
  );
}

/** Add a user as regular allowed user. If already in adminUsers, demotes to regular user. */
function addAllowedUser(email: string): void {
  if (email && !state.allowedUsers.includes(email)) {
    setState(
      produce((s) => {
        // If already in admin list, remove from there
        const adminIndex = s.adminUsers.indexOf(email);
        if (adminIndex !== -1) {
          s.adminUsers.splice(adminIndex, 1);
        }
        s.allowedUsers.push(email);
      })
    );
  }
}

function removeAllowedUser(email: string): void {
  setState(
    produce((s) => {
      const index = s.allowedUsers.indexOf(email);
      if (index !== -1) {
        s.allowedUsers.splice(index, 1);
      }
    })
  );
}

function setCustomDomain(domain: string): void {
  setState({ customDomain: domain, customDomainError: null });
}

function nextStep(): void {
  if (state.step < TOTAL_STEPS) {
    setState('step', state.step + 1);
  }
}

function prevStep(): void {
  setState('step', Math.max(1, state.step - 1));
}

function goToStep(step: number): void {
  setState('step', Math.max(1, Math.min(TOTAL_STEPS, step)));
}

/**
 * Pre-fill the store from the existing backend configuration.
 * Called when setup is already configured (re-configuration flow).
 */
async function loadExistingConfig(): Promise<void> {
  if (configLoaded) return;
  configLoaded = true;
  try {
    const statusRes = await api.getSetupStatus();

    if (statusRes.configured) {
      const usersRes = await api.getUsers();
      setState(
        produce((s) => {
          if ((statusRes as Record<string, unknown>).customDomain) {
            s.customDomain = (statusRes as Record<string, unknown>).customDomain as string;
          }
          s.adminUsers = usersRes
            .filter((u) => u.role === 'admin')
            .map((u) => u.email);
          s.allowedUsers = usersRes
            .filter((u) => u.role !== 'admin')
            .map((u) => u.email);
        })
      );
      return;
    }

    const prefill = await api.getSetupPrefill();
    setState(
      produce((s) => {
        if (prefill.customDomain) {
          s.customDomain = prefill.customDomain;
        }
        const admins = Array.from(new Set(prefill.adminUsers.map((email) => email.trim().toLowerCase())));
        const regularUsers = Array.from(new Set(prefill.allowedUsers.map((email) => email.trim().toLowerCase())))
          .filter((email) => !admins.includes(email));
        s.adminUsers = admins;
        s.allowedUsers = regularUsers;
      })
    );
  } catch {
    // Silently fail — pre-fill is best-effort
    configLoaded = false;
  }
}

async function configure(): Promise<boolean> {
  setState({ configuring: true, configureSteps: [], configureError: null });

  try {
    const allUsers = [...state.adminUsers, ...state.allowedUsers];
    const response = await fetch('/api/setup/configure', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      redirect: 'manual',
      body: JSON.stringify({
        customDomain: state.customDomain,
        allowedUsers: allUsers,
        adminUsers: state.adminUsers,
      }),
    });

    // Detect CF Access auth redirects
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      setState({ configureError: 'Authentication redirect detected — session may have expired' });
      return false;
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let errorMsg = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.error) errorMsg = parsed.error;
        if (Array.isArray(parsed.steps)) setState({ configureSteps: parsed.steps });
      } catch { /* not JSON */ }
      setState({ configureError: errorMsg });
      return false;
    }

    // Read NDJSON stream line by line
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let success = false;

    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line) as Record<string, unknown>;

          if (msg.done) {
            // Final summary message
            if (msg.success) {
              success = true;
              setState({
                setupComplete: true,
                customDomainUrl: (msg.customDomainUrl as string) || null,
                accountId: (msg.accountId as string) || null,
              });
              if (Array.isArray(msg.steps)) {
                setState({ configureSteps: msg.steps as SetupState['configureSteps'] });
              }
            } else {
              setState({ configureError: (msg.error as string) || 'Configuration failed' });
              if (Array.isArray(msg.steps)) {
                setState({ configureSteps: msg.steps as SetupState['configureSteps'] });
              }
            }
          } else if (msg.step && msg.status) {
            // Progressive step update
            setState(
              produce((s) => {
                const existing = s.configureSteps.find((st) => st.step === msg.step);
                if (existing) {
                  existing.status = msg.status as string;
                  if (msg.error) existing.error = msg.error as string;
                } else {
                  const entry: { step: string; status: string; error?: string } = {
                    step: msg.step as string,
                    status: msg.status as string,
                  };
                  if (msg.error) entry.error = msg.error as string;
                  s.configureSteps.push(entry);
                }
              })
            );
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (done) break;
    }

    return success;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Configuration request failed';
    setState({ configureError: msg });
    return false;
  } finally {
    setState({ configuring: false });
  }
}

function reset(): void {
  configLoaded = false;
  setState({ ...initialState, adminUsers: [], allowedUsers: [], configureSteps: [] });
}

export const setupStore = {
  // State (readonly via getters)
  get step() {
    return state.step;
  },
  get tokenDetected() {
    return state.tokenDetected;
  },
  get tokenDetecting() {
    return state.tokenDetecting;
  },
  get tokenDetectError() {
    return state.tokenDetectError;
  },
  get accountInfo() {
    return state.accountInfo;
  },
  get customDomain() {
    return state.customDomain;
  },
  get customDomainError() {
    return state.customDomainError;
  },
  get adminUsers() {
    return state.adminUsers;
  },
  get allowedUsers() {
    return state.allowedUsers;
  },
  get configuring() {
    return state.configuring;
  },
  get configureSteps() {
    return state.configureSteps;
  },
  get configureError() {
    return state.configureError;
  },
  get setupComplete() {
    return state.setupComplete;
  },
  get customDomainUrl() {
    return state.customDomainUrl;
  },
  get accountId() {
    return state.accountId;
  },

  // Actions
  detectToken,
  loadExistingConfig,
  addAdminUser,
  removeAdminUser,
  addAllowedUser,
  removeAllowedUser,
  setCustomDomain,
  nextStep,
  prevStep,
  goToStep,
  configure,
  reset,
};
