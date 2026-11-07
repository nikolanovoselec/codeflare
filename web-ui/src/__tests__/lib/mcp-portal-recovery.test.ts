import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/fetch-helper';
import { getMcpPortalStatuses, recoverMcpPortal } from '../../api/mcp-portals';
import { createMcpPortalRecovery } from '../../lib/mcp-portal-recovery';

vi.mock('../../api/mcp-portals', () => ({
  getMcpPortalStatuses: vi.fn(),
  recoverMcpPortal: vi.fn(),
}));

type Recovery = ReturnType<typeof createMcpPortalRecovery>;
type Result = Awaited<ReturnType<typeof recoverMcpPortal>>;
const OWNER = 'alice@example.test';
const STORAGE_KEY = 'codeflare-mcp-recovery';
const SESSION = '/app/session/abcdef0123456789';
const SSO = 'https://identity.example.test/authorize?state=root-issued';
const first = { name: 'calendar', url: 'https://calendar.example.test/mcp', connected: false };
const second = { name: 'issues', url: 'https://issues.example.test/mcp', connected: true };
const key = (portal: typeof first) => `${portal.name}\n${portal.url}`;
const authorization = (): Result => ({ state: 'authorization', url: SSO });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// These arrays describe effects at the public API/browser boundaries, not private
// calls. sessionStorage and history remain the actual jsdom browser objects.
describe('transparent MCP portal SSO recovery', () => {
  let helpers: Recovery[];
  let navigations: string[];
  let authErrors: unknown[];
  let visibility: DocumentVisibilityState;
  let visibilityDescriptor: PropertyDescriptor | undefined;
  let storageDescriptor: PropertyDescriptor | undefined;
  const statuses = vi.mocked(getMcpPortalStatuses);
  const recover = vi.mocked(recoverMcpPortal);
  function create(owner = OWNER, navigate = (url: string) => { navigations.push(url); }) {
    const helper = createMcpPortalRecovery(owner, navigate, error => { authErrors.push(error); });
    helpers.push(helper);
    return helper;
  }
  function seed(returnPath = SESSION, owner = OWNER) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      owner, attempted: [key(first)], pending: key(first), returnPath,
    }));
  }
  function callback() { history.replaceState(null, '', '/app/?mcp=reconnect'); }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    helpers = [];
    navigations = [];
    authErrors = [];
    visibility = 'visible';
    visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    storageDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    sessionStorage.clear();
    history.replaceState(null, '', SESSION);
    statuses.mockResolvedValue([first]);
    recover.mockResolvedValue({ state: 'unavailable' });
  });
  afterEach(() => {
    for (const helper of helpers) helper.dispose();
    if (storageDescriptor) Object.defineProperty(window, 'sessionStorage', storageDescriptor);
    sessionStorage.clear();
    if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
    else Reflect.deleteProperty(document, 'visibilityState');
    history.replaceState(null, '', '/app/');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not contact Root before an explicit check', async () => {
    const effects: string[] = [];
    statuses.mockImplementation(async () => { effects.push('status'); return [first]; });
    recover.mockImplementation(async () => { effects.push('recover'); return authorization(); });
    create();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(effects).toEqual([]);
    expect(navigations).toEqual([]);
  });

  it('checks only while visible and schedules the next visible check after 60 seconds', async () => {
    let rootState: Result = authorization();
    recover.mockImplementation(async () => rootState);
    const helper = create();
    visibility = 'hidden';
    await helper.check();
    expect(navigations).toEqual([]);
    visibility = 'visible';
    rootState = { state: 'unavailable' };
    await helper.check();
    rootState = authorization();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(navigations).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(navigations).toEqual([SSO]);
  });

  it('does not start overlapping recovery while a previous check is awaiting Root', async () => {
    const pending = deferred<Result>();
    let inFlight = false;
    let overlap = false;
    recover.mockImplementation(async () => {
      if (inFlight) overlap = true;
      inFlight = true;
      const result = await pending.promise;
      inFlight = false;
      return result;
    });
    const helper = create();
    const checking = helper.check();
    await Promise.resolve();
    const concurrent = helper.check();
    await vi.advanceTimersByTimeAsync(120_000);
    pending.resolve(authorization());
    await Promise.all([checking, concurrent]);
    expect(overlap).toBe(false);
    expect(navigations).toEqual([SSO]);
  });

  it('pause cancels the scheduled retry but allows a later explicit check', async () => {
    let result: Result = { state: 'unavailable' };
    recover.mockImplementation(async () => result);
    const helper = create();
    await helper.check();
    helper.pause();
    result = authorization();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(navigations).toEqual([]);
    await helper.check();
    expect(navigations).toEqual([SSO]);
  });

  it.each(['status', 'recovery'] as const)('dispose ignores a late %s result and prevents future retries', async boundary => {
    const pendingStatuses = deferred<typeof first[]>();
    const pendingRecovery = deferred<Result>();
    if (boundary === 'status') {
      statuses.mockReturnValue(pendingStatuses.promise);
      recover.mockResolvedValue(authorization());
    } else recover.mockReturnValue(pendingRecovery.promise);
    const helper = create();
    const checking = helper.check();
    await Promise.resolve();
    helper.dispose();
    pendingStatuses.resolve([first]);
    pendingRecovery.resolve(authorization());
    await checking;
    await helper.check();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(navigations).toEqual([]);
    expect(authErrors).toEqual([]);
  });

  it.each(['status', 'recovery'] as const)('delegates a %s 401 instead of initiating provider OAuth', async boundary => {
    const error = new ApiError('Session expired', 401, 'Unauthorized');
    if (boundary === 'status') statuses.mockRejectedValue(error);
    else recover.mockRejectedValue(error);
    await create().check();
    expect(authErrors).toEqual([error]);
    expect(navigations).toEqual([]);
  });

  it('does not report a late 401 after disposal', async () => {
    const pending = deferred<typeof first[]>();
    statuses.mockReturnValue(pending.promise);
    const helper = create();
    const checking = helper.check();
    helper.dispose();
    pending.reject(new ApiError('Expired', 401, 'Unauthorized'));
    await checking;
    expect(authErrors).toEqual([]);
    expect(navigations).toEqual([]);
  });

  it.each(['status', 'recovery'] as const)('does not turn a %s network failure into OAuth', async boundary => {
    if (boundary === 'status') statuses.mockRejectedValue(new TypeError('offline'));
    else recover.mockRejectedValue(new TypeError('offline'));
    await create().check();
    expect(navigations).toEqual([]);
    expect(authErrors).toEqual([]);
  });

  it.each(['ready', 'ineligible', 'unavailable'] as const)('does not navigate for Root state %s', async state => {
    recover.mockResolvedValue({ state });
    await create().check();
    expect(navigations).toEqual([]);
    expect(authErrors).toEqual([]);
  });

  it('waits for each configured portal and accepts Root eligibility regardless of connected', async () => {
    statuses.mockResolvedValue([first, second]);
    const pending = deferred<Result>();
    let firstSettled = false;
    let secondStartedEarly = false;
    recover.mockImplementation(async name => {
      if (name === first.name) {
        const result = await pending.promise;
        firstSettled = true;
        return result;
      }
      secondStartedEarly = !firstSettled;
      return authorization();
    });
    const checking = create().check();
    await Promise.resolve();
    expect(navigations).toEqual([]);
    pending.resolve({ state: 'ineligible' });
    await checking;
    expect(secondStartedEarly).toBe(false);
    expect(navigations).toEqual([SSO]);
  });

  it('persists recovery intent before navigation so an immediate callback restores the session without looping', async () => {
    recover.mockImplementation(async (_name, authorize) => authorize ? authorization() : { state: 'unavailable' });
    let resumed: Recovery | undefined;
    let restoredPath = '';
    await create(OWNER, url => {
      navigations.push(url);
      callback();
      resumed = create();
      restoredPath = window.location.pathname;
    }).check();
    expect(restoredPath).toBe(SESSION);
    await resumed!.check();
    expect(navigations).toEqual([SSO]);
  });

  it.each(['http://identity.example.test/authorize', 'javascript:alert(1)', 'https://user:secret@identity.example.test/authorize'])(
    'does not navigate to an unsafe authorization destination %s', async url => {
      recover.mockResolvedValue({ state: 'authorization', url });
      await create().check();
      expect(navigations).toEqual([]);
    });

  it('restores the session synchronously on cancelled callback and prevents another authorization across recreations', async () => {
    // Root only initiates OAuth when authorize is true. A cancelled roundtrip
    // must continue probing silently, rather than re-open the provider forever.
    recover.mockImplementation(async (_name, authorize) => authorize ? authorization() : { state: 'unavailable' });
    const initial = create();
    await initial.check();
    expect(navigations).toEqual([SSO]);
    initial.dispose();
    callback();
    const returned = create();
    expect(location.pathname).toBe(SESSION);
    expect(location.search).toBe('');
    await returned.check();
    returned.dispose();
    // Reopen the already restored app; no second provider navigation occurred.
    const recreated = create();
    expect(location.pathname).toBe(SESSION);
    await recreated.check();
    expect(navigations).toEqual([SSO]);
  });

  it('clears an attempted portal only after ready, allowing a later genuine repair', async () => {
    seed();
    callback();
    let repaired = false;
    recover.mockImplementation(async (_name, authorize) => repaired ? { state: 'ready' }
      : authorize ? authorization() : { state: 'unavailable' });
    const helper = create();
    await helper.check();
    expect(navigations).toEqual([]);
    repaired = true;
    await helper.check();
    repaired = false;
    await helper.check();
    expect(navigations).toEqual([SSO]);
  });

  it('serializes multiple provider redirects across roundtrips without retrying the failed first provider', async () => {
    statuses.mockResolvedValue([first, second]);
    recover.mockImplementation(async (name, authorize) => authorize
      ? { state: 'authorization', url: name === first.name ? SSO : 'https://issues.example.test/authorize' }
      : { state: 'unavailable' });
    const initial = create();
    await initial.check();
    expect(navigations).toEqual([SSO]);
    initial.dispose();
    callback();
    const returned = create();
    await returned.check();
    expect(navigations).toEqual([SSO, 'https://issues.example.test/authorize']);
    returned.dispose();
    callback();
    await create().check();
    expect(navigations).toEqual([SSO, 'https://issues.example.test/authorize']);
    expect(location.pathname).toBe(SESSION);
  });

  it('does not restore a different owner’s saved session path', () => {
    seed();
    callback();
    create('bob@example.test');
    expect(location.pathname).toBe('/app/');
  });

  it.each(['/app/', SESSION])('restores an allowed canonical return path %s', path => {
    seed(path);
    callback();
    create();
    expect(location.pathname).toBe(path);
    expect(location.search).toBe('');
  });

  it.each([
    'https://attacker.example/app/session/abcdef0123456789',
    '//attacker.example/app/', '/admin', '/app/arbitrary',
    '/app/session/short', '/app/session/ABCDEF01',
    '/app/session/abcdef0123456789/extra',
    '/app/session/abcdef0123456789?redirect=https://attacker.example',
  ])('never restores unsafe or noncanonical saved return path %s', path => {
    seed(path);
    callback();
    const origin = location.origin;
    create();
    expect(location.origin).toBe(origin);
    expect(location.pathname).toBe('/app/');
    expect(navigations).toEqual([]);
  });

  it('fails closed without automatic navigation when sessionStorage is unavailable', async () => {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new DOMException('Storage denied', 'SecurityError'); },
    });
    recover.mockResolvedValue(authorization());
    const helper = create();
    await helper.check();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(navigations).toEqual([]);
    expect(authErrors).toEqual([]);
  });
});
