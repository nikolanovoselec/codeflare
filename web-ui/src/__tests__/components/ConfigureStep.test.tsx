import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import ConfigureStep from '../../components/setup/ConfigureStep';

// Track store state so tests can inspect and modify it
const storeState = vi.hoisted(() => ({
  customDomain: '',
  adminUsers: [] as string[],
  allowedUsers: [] as string[],
  saasMode: false,
  enterpriseMode: false,
  enterpriseAccessGroups: [] as string[],
  adminAccessGroups: [] as string[],
  dynamicRoutes: [] as string[],
  defaultRouteName: '',
  defaultRouteReasoning: 'off' as 'off' | 'low' | 'medium' | 'high',
  cloudflareBrowserToken: '',
  cloudflareBrowserTokenSet: false,
  cloudflareBrowserAccountId: '',
  githubProviderType: 'app' as 'app' | 'oauth',
  githubAppClientId: '',
  githubAppClientSecret: '',
  githubAppClientSecretSet: false,
  githubOauthClientId: '',
  githubOauthClientSecret: '',
  githubOauthClientSecretSet: false,
  cloudflareOauthClientId: '',
  cloudflareOauthClientSecret: '',
  cloudflareOauthClientSecretSet: false,
  groupRouting: {} as Record<string, { routes: string[]; defaultRoute: string; reasoning: 'off' | 'low' | 'medium' | 'high' }>,
}));

const storeMethods = vi.hoisted(() => ({
  setCustomDomain: vi.fn((val: string) => { storeState.customDomain = val; }),
  addAdminUser: vi.fn((email: string) => { storeState.adminUsers.push(email); }),
  removeAdminUser: vi.fn((email: string) => { storeState.adminUsers = storeState.adminUsers.filter(e => e !== email); }),
  addAllowedUser: vi.fn((email: string) => { storeState.allowedUsers.push(email); }),
  removeAllowedUser: vi.fn((email: string) => { storeState.allowedUsers = storeState.allowedUsers.filter(e => e !== email); }),
  addAccessGroup: vi.fn((name: string) => { storeState.enterpriseAccessGroups.push(name); }),
  removeAccessGroup: vi.fn((name: string) => { storeState.enterpriseAccessGroups = storeState.enterpriseAccessGroups.filter(g => g !== name); }),
  addAdminAccessGroup: vi.fn((name: string) => { storeState.adminAccessGroups.push(name); }),
  removeAdminAccessGroup: vi.fn((name: string) => { storeState.adminAccessGroups = storeState.adminAccessGroups.filter(g => g !== name); }),
  addDynamicRoute: vi.fn((name: string) => { storeState.dynamicRoutes.push(name); }),
  removeDynamicRoute: vi.fn((name: string) => { storeState.dynamicRoutes = storeState.dynamicRoutes.filter(r => r !== name); }),
  setDefaultRouteName: vi.fn((name: string) => { storeState.defaultRouteName = name; }),
  setDefaultRouteReasoning: vi.fn((level: 'off' | 'low' | 'medium' | 'high') => { storeState.defaultRouteReasoning = level; }),
  setCloudflareBrowserToken: vi.fn((val: string) => { storeState.cloudflareBrowserToken = val; }),
  setCloudflareBrowserAccountId: vi.fn((val: string) => { storeState.cloudflareBrowserAccountId = val; }),
  setGithubProviderType: vi.fn((t: 'app' | 'oauth') => { storeState.githubProviderType = t; }),
  setGithubAppClientId: vi.fn((v: string) => { storeState.githubAppClientId = v; }),
  setGithubAppClientSecret: vi.fn((v: string) => { storeState.githubAppClientSecret = v; }),
  setGithubOauthClientId: vi.fn((v: string) => { storeState.githubOauthClientId = v; }),
  setGithubOauthClientSecret: vi.fn((v: string) => { storeState.githubOauthClientSecret = v; }),
  setCloudflareOauthClientId: vi.fn((v: string) => { storeState.cloudflareOauthClientId = v; }),
  setCloudflareOauthClientSecret: vi.fn((v: string) => { storeState.cloudflareOauthClientSecret = v; }),
  toggleGroupRoute: vi.fn(),
  setGroupDefaultRoute: vi.fn(),
  setGroupReasoning: vi.fn(),
  applyGroupRoutingToAll: vi.fn(),
  nextStep: vi.fn(),
  prevStep: vi.fn(),
  loadExistingConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../stores/setup', () => ({
  setupStore: {
    get customDomain() { return storeState.customDomain; },
    get adminUsers() { return storeState.adminUsers; },
    get allowedUsers() { return storeState.allowedUsers; },
    get saasMode() { return storeState.saasMode; },
    get enterpriseMode() { return storeState.enterpriseMode; },
    get enterpriseAccessGroups() { return storeState.enterpriseAccessGroups; },
    get adminAccessGroups() { return storeState.adminAccessGroups; },
    get dynamicRoutes() { return storeState.dynamicRoutes; },
    get defaultRouteName() { return storeState.defaultRouteName; },
    get defaultRouteReasoning() { return storeState.defaultRouteReasoning; },
    get cloudflareBrowserToken() { return storeState.cloudflareBrowserToken; },
    get cloudflareBrowserTokenSet() { return storeState.cloudflareBrowserTokenSet; },
    get cloudflareBrowserAccountId() { return storeState.cloudflareBrowserAccountId; },
    get githubProviderType() { return storeState.githubProviderType; },
    get githubAppClientId() { return storeState.githubAppClientId; },
    get githubAppClientSecret() { return storeState.githubAppClientSecret; },
    get githubAppClientSecretSet() { return storeState.githubAppClientSecretSet; },
    get githubOauthClientId() { return storeState.githubOauthClientId; },
    get githubOauthClientSecret() { return storeState.githubOauthClientSecret; },
    get githubOauthClientSecretSet() { return storeState.githubOauthClientSecretSet; },
    get cloudflareOauthClientId() { return storeState.cloudflareOauthClientId; },
    get cloudflareOauthClientSecret() { return storeState.cloudflareOauthClientSecret; },
    get cloudflareOauthClientSecretSet() { return storeState.cloudflareOauthClientSecretSet; },
    get groupRouting() { return storeState.groupRouting; },
    ...storeMethods,
  },
}));

vi.mock('../../components/Icon', () => ({
  default: (props: { path: string; size?: number }) => (
    <span data-testid="mock-icon" data-path={props.path} />
  ),
}));

describe('ConfigureStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.customDomain = '';
    storeState.adminUsers = [];
    storeState.allowedUsers = [];
    storeState.saasMode = false;
    storeState.enterpriseMode = false;
    storeState.enterpriseAccessGroups = [];
    storeState.adminAccessGroups = [];
    storeState.dynamicRoutes = [];
    storeState.defaultRouteName = '';
    storeState.defaultRouteReasoning = 'off';
    storeState.cloudflareBrowserToken = '';
    storeState.cloudflareBrowserTokenSet = false;
    storeState.cloudflareBrowserAccountId = '';
    storeState.githubProviderType = 'app';
    storeState.githubAppClientId = '';
    storeState.githubAppClientSecret = '';
    storeState.githubAppClientSecretSet = false;
    storeState.githubOauthClientId = '';
    storeState.githubOauthClientSecret = '';
    storeState.githubOauthClientSecretSet = false;
    storeState.cloudflareOauthClientId = '';
    storeState.cloudflareOauthClientSecret = '';
    storeState.cloudflareOauthClientSecretSet = false;
    storeState.groupRouting = {};
  });

  afterEach(() => {
    cleanup();
  });

  describe('Rendering', () => {
    it('renders the configure title', () => {
      render(() => <ConfigureStep />);
      expect(screen.getByText('Configure Your Instance')).toBeInTheDocument();
    });

    it('renders custom domain field', () => {
      render(() => <ConfigureStep />);
      expect(screen.getByText('Custom Domain')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('claude.example.com')).toBeInTheDocument();
    });

    it('renders admin users section', () => {
      render(() => <ConfigureStep />);
      expect(screen.getByText('Admin Users')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('admin@example.com')).toBeInTheDocument();
    });

    it('renders regular users section', () => {
      render(() => <ConfigureStep />);
      expect(screen.getByText('Regular Users')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('user@example.com')).toBeInTheDocument();
    });

    it('renders Back and Continue buttons', () => {
      render(() => <ConfigureStep />);
      expect(screen.getByText('Back')).toBeInTheDocument();
      expect(screen.getByText('Continue')).toBeInTheDocument();
    });
  });

  // REQ-ENTERPRISE-008 AC7: in enterprise mode the setup wizard configures only
  // admins + the optional Access group; regular users arrive via JIT, so the
  // Regular Users section is suppressed. Flag-unset parity is the default case
  // already covered by the "renders regular users section" test above.
  describe('Enterprise mode surface suppression', () => {
    it('hides the Regular Users section when enterpriseMode is set', () => {
      storeState.enterpriseMode = true;
      render(() => <ConfigureStep />);
      expect(screen.queryByText('Regular Users')).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText('user@example.com')).not.toBeInTheDocument();
    });

    it('still renders Admin Users and the Access Group field when enterpriseMode is set', () => {
      storeState.enterpriseMode = true;
      render(() => <ConfigureStep />);
      expect(screen.getByText('Admin Users')).toBeInTheDocument();
      expect(screen.getByText('Cloudflare Access Groups (optional)')).toBeInTheDocument();
    });
  });

  // REQ-ENTERPRISE-014: admin Access groups field — Setup access, not routing.
  describe('Admin Access groups (REQ-ENTERPRISE-014)', () => {
    it('renders the admin Access groups field in enterprise mode', () => {
      storeState.enterpriseMode = true;
      render(() => <ConfigureStep />);
      expect(screen.getByPlaceholderText('e.g. codeflare_admins')).toBeInTheDocument();
    });

    it('does not render the admin Access groups field outside enterprise mode', () => {
      storeState.enterpriseMode = false;
      render(() => <ConfigureStep />);
      expect(screen.queryByPlaceholderText('e.g. codeflare_admins')).not.toBeInTheDocument();
    });

    it('routes the admin-group Add to addAdminAccessGroup', () => {
      storeState.enterpriseMode = true;
      render(() => <ConfigureStep />);
      const input = screen.getByPlaceholderText('e.g. codeflare_admins');
      fireEvent.input(input, { target: { value: 'ops_admins' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(storeMethods.addAdminAccessGroup).toHaveBeenCalledWith('ops_admins');
    });

    it('admin groups never produce a per-group routing card (routing is user-groups only)', () => {
      storeState.enterpriseMode = true;
      storeState.adminAccessGroups = ['ops_admins'];
      storeState.enterpriseAccessGroups = [];
      storeState.dynamicRoutes = ['development'];
      render(() => <ConfigureStep />);
      expect(document.querySelector('.group-routing-card')).toBeNull();
    });
  });

  // Feature A/C: enterprise chip lists (groups + dynamic routes) and the
  // optional default route + reasoning selector.
  describe('Enterprise groups + routes chips', () => {
    it('adds an access group via the group Add button', () => {
      storeState.enterpriseMode = true;
      render(() => <ConfigureStep />);

      const input = screen.getByPlaceholderText('e.g. codeflare_developers');
      fireEvent.input(input, { target: { value: 'team_a' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(storeMethods.addAccessGroup).toHaveBeenCalledWith('team_a');
    });

    it('displays access group chips and removes one on x click', () => {
      storeState.enterpriseMode = true;
      storeState.enterpriseAccessGroups = ['team_a'];
      render(() => <ConfigureStep />);

      expect(screen.getByText('team_a')).toBeInTheDocument();
      const removeBtn = screen.getByText('team_a').querySelector('.email-tag-remove') as HTMLElement;
      fireEvent.click(removeBtn);
      expect(storeMethods.removeAccessGroup).toHaveBeenCalledWith('team_a');
    });

    it('adds a dynamic route via Enter', () => {
      storeState.enterpriseMode = true;
      render(() => <ConfigureStep />);

      const input = screen.getByPlaceholderText('e.g. development');
      fireEvent.input(input, { target: { value: 'development' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(storeMethods.addDynamicRoute).toHaveBeenCalledWith('development');
    });

    it('hides the Default Route selector when no routes exist', () => {
      storeState.enterpriseMode = true;
      storeState.dynamicRoutes = [];
      render(() => <ConfigureStep />);
      expect(screen.queryByText('Default Route')).not.toBeInTheDocument();
    });

    it('shows the Default Route selector and lists routes as options when routes exist', () => {
      storeState.enterpriseMode = true;
      storeState.dynamicRoutes = ['development', 'prod'];
      render(() => <ConfigureStep />);

      expect(screen.getByText('Default Route')).toBeInTheDocument();
      const routeSelect = document.querySelectorAll('.route-select')[0] as HTMLSelectElement;
      const optionValues = Array.from(routeSelect.options).map(o => o.value);
      expect(optionValues).toContain('development');
      expect(optionValues).toContain('prod');
    });

    it('sets the default route name on change', () => {
      storeState.enterpriseMode = true;
      storeState.dynamicRoutes = ['development'];
      render(() => <ConfigureStep />);

      const routeSelect = document.querySelectorAll('.route-select')[0] as HTMLSelectElement;
      fireEvent.change(routeSelect, { target: { value: 'development' } });
      expect(storeMethods.setDefaultRouteName).toHaveBeenCalledWith('development');
    });

    it('disables the reasoning selector until a default route is chosen', () => {
      storeState.enterpriseMode = true;
      storeState.dynamicRoutes = ['development'];
      storeState.defaultRouteName = '';
      render(() => <ConfigureStep />);

      const reasoningSelect = document.querySelectorAll('.route-select')[1] as HTMLSelectElement;
      expect(reasoningSelect.disabled).toBe(true);
    });

    it('enables the reasoning selector and sets reasoning when a default route is chosen', () => {
      storeState.enterpriseMode = true;
      storeState.dynamicRoutes = ['development'];
      storeState.defaultRouteName = 'development';
      render(() => <ConfigureStep />);

      const reasoningSelect = document.querySelectorAll('.route-select')[1] as HTMLSelectElement;
      expect(reasoningSelect.disabled).toBe(false);
      fireEvent.change(reasoningSelect, { target: { value: 'medium' } });
      expect(storeMethods.setDefaultRouteReasoning).toHaveBeenCalledWith('medium');
    });

    it('offers no empty "(no default)" route option — every option is a real route', () => {
      storeState.enterpriseMode = true;
      storeState.dynamicRoutes = ['development', 'prod'];
      render(() => <ConfigureStep />);

      const routeSelect = document.querySelectorAll('.route-select')[0] as HTMLSelectElement;
      const optionValues = Array.from(routeSelect.options).map(o => o.value);
      expect(optionValues).toEqual(['development', 'prod']);
      expect(optionValues).not.toContain('');
    });

    it('keeps Continue disabled in enterprise mode until a dynamic route is added (AC6)', () => {
      storeState.enterpriseMode = true;
      storeState.customDomain = 'claude.example.com';
      storeState.adminUsers = ['admin@test.com'];
      storeState.dynamicRoutes = [];
      render(() => <ConfigureStep />);

      const continueBtn = screen.getByText('Continue').closest('button') as HTMLButtonElement;
      expect(continueBtn.disabled).toBe(true);
    });

    it('enables Continue in enterprise mode once domain, admin, and a route exist (AC6)', () => {
      storeState.enterpriseMode = true;
      storeState.customDomain = 'claude.example.com';
      storeState.adminUsers = ['admin@test.com'];
      storeState.dynamicRoutes = ['development'];
      render(() => <ConfigureStep />);

      const continueBtn = screen.getByText('Continue').closest('button') as HTMLButtonElement;
      expect(continueBtn.disabled).toBe(false);
    });
  });

  // REQ-BROWSER-007: the admin-global Cloudflare Browser Rendering token + account id
  // are enterprise-only fields (the per-user Push & Deploy accordion is hidden in
  // enterprise). Asserted via the password input type + the account-id placeholder so
  // no prose copy is pinned.
  describe('Browser Rendering token (enterprise admin-global)', () => {
    it('renders the Browser Rendering token + account fields in enterprise mode', () => {
      storeState.enterpriseMode = true;
      render(() => <ConfigureStep />);
      expect(document.querySelector('input[type="password"]')).not.toBeNull();
      expect(screen.getByPlaceholderText('32-character account ID')).toBeInTheDocument();
    });

    it('does not render the Browser Rendering fields outside enterprise mode', () => {
      storeState.enterpriseMode = false;
      render(() => <ConfigureStep />);
      // The browser-render account-id field is the enterprise-only marker. (Password
      // inputs now also exist from the provider choosers, which render in any mode.)
      expect(screen.queryByPlaceholderText('32-character account ID')).not.toBeInTheDocument();
    });

    it('routes token input to setCloudflareBrowserToken', () => {
      storeState.enterpriseMode = true;
      render(() => <ConfigureStep />);
      const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement;
      fireEvent.input(tokenInput, { target: { value: 'cf-browser-token' } });
      expect(storeMethods.setCloudflareBrowserToken).toHaveBeenCalledWith('cf-browser-token');
    });

    it('routes account-id input to setCloudflareBrowserAccountId', () => {
      storeState.enterpriseMode = true;
      render(() => <ConfigureStep />);
      const acctInput = screen.getByPlaceholderText('32-character account ID');
      fireEvent.input(acctInput, { target: { value: 'acct123' } });
      expect(storeMethods.setCloudflareBrowserAccountId).toHaveBeenCalledWith('acct123');
    });
  });

  describe('Domain input', () => {
    it('calls setCustomDomain on input change', () => {
      render(() => <ConfigureStep />);
      const input = screen.getByPlaceholderText('claude.example.com');
      fireEvent.input(input, { target: { value: 'app.example.com' } });
      expect(storeMethods.setCustomDomain).toHaveBeenCalledWith('app.example.com');
    });
  });

  describe('Admin user list management', () => {
    it('adds admin email when Add button is clicked', () => {
      render(() => <ConfigureStep />);

      const input = screen.getByPlaceholderText('admin@example.com');
      fireEvent.input(input, { target: { value: 'admin@test.com' } });

      // Click the Add button next to admin input
      const addButtons = screen.getAllByText('Add');
      fireEvent.click(addButtons[0]); // first Add is for admin

      expect(storeMethods.addAdminUser).toHaveBeenCalledWith('admin@test.com');
    });

    it('adds admin email on Enter key press', () => {
      render(() => <ConfigureStep />);

      const input = screen.getByPlaceholderText('admin@example.com');
      fireEvent.input(input, { target: { value: 'admin@test.com' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(storeMethods.addAdminUser).toHaveBeenCalledWith('admin@test.com');
    });

    it('displays admin email tags', () => {
      storeState.adminUsers = ['admin@test.com', 'boss@test.com'];
      render(() => <ConfigureStep />);

      expect(screen.getByText('admin@test.com')).toBeInTheDocument();
      expect(screen.getByText('boss@test.com')).toBeInTheDocument();
    });

    it('removes admin email tag on x click', () => {
      storeState.adminUsers = ['admin@test.com'];
      render(() => <ConfigureStep />);

      const removeBtn = document.querySelector('.email-tag--accent .email-tag-remove') as HTMLElement;
      fireEvent.click(removeBtn);

      expect(storeMethods.removeAdminUser).toHaveBeenCalledWith('admin@test.com');
    });
  });

  describe('Regular user list management', () => {
    it('adds regular user email', () => {
      render(() => <ConfigureStep />);

      const input = screen.getByPlaceholderText('user@example.com');
      fireEvent.input(input, { target: { value: 'user@test.com' } });

      const addButtons = screen.getAllByText('Add');
      fireEvent.click(addButtons[1]); // second Add is for regular users

      expect(storeMethods.addAllowedUser).toHaveBeenCalledWith('user@test.com');
    });
  });

  describe('Navigation', () => {
    it('calls prevStep when Back is clicked', () => {
      render(() => <ConfigureStep />);
      fireEvent.click(screen.getByText('Back'));
      expect(storeMethods.prevStep).toHaveBeenCalled();
    });

    it('calls nextStep when Continue is clicked', () => {
      storeState.customDomain = 'app.example.com';
      storeState.adminUsers = ['admin@example.com'];
      render(() => <ConfigureStep />);
      fireEvent.click(screen.getByText('Continue'));
      expect(storeMethods.nextStep).toHaveBeenCalled();
    });

    it('disables Continue when custom domain is empty', () => {
      storeState.customDomain = '';
      storeState.adminUsers = ['admin@example.com'];
      render(() => <ConfigureStep />);
      const continueBtnText = screen.getByText('Continue');
      const continueBtn = continueBtnText.closest('button')!;
      expect(continueBtn).toBeDisabled();
    });

    it('disables Continue when no admin users', () => {
      storeState.customDomain = 'app.example.com';
      storeState.adminUsers = [];
      render(() => <ConfigureStep />);
      const continueBtnText = screen.getByText('Continue');
      const continueBtn = continueBtnText.closest('button')!;
      expect(continueBtn).toBeDisabled();
    });
  });

  // REQ-ENTERPRISE-013: per-group routing cards render once groups + routes exist.
  describe('Per-group routing', () => {
    it('renders one card per group, each with a route pill per catalog route', () => {
      storeState.enterpriseMode = true;
      storeState.enterpriseAccessGroups = ['team_a'];
      storeState.dynamicRoutes = ['development', 'prod'];
      render(() => <ConfigureStep />);
      expect(document.querySelectorAll('.group-routing-card').length).toBe(1);
      expect(document.querySelectorAll('.group-routing-card .pill').length).toBe(2);
    });

    it('does not render per-group routing when there are no groups', () => {
      storeState.enterpriseMode = true;
      storeState.enterpriseAccessGroups = [];
      storeState.dynamicRoutes = ['development'];
      render(() => <ConfigureStep />);
      expect(document.querySelector('.group-routing-card')).toBeNull();
    });

    it('toggles a group route when its pill is clicked', () => {
      storeState.enterpriseMode = true;
      storeState.enterpriseAccessGroups = ['team_a'];
      storeState.dynamicRoutes = ['development'];
      render(() => <ConfigureStep />);
      const pill = document.querySelector('.group-routing-card [data-value="development"]') as HTMLElement;
      fireEvent.click(pill);
      expect(storeMethods.toggleGroupRoute).toHaveBeenCalledWith('team_a', 'development');
    });

    // Item 10: "Apply to all groups" is only meaningful with more than one group.
    it('omits the per-card Apply-to-all control when only one group exists', () => {
      storeState.enterpriseMode = true;
      storeState.enterpriseAccessGroups = ['team_a'];
      storeState.dynamicRoutes = ['development'];
      render(() => <ConfigureStep />);
      expect(document.querySelector('.group-routing-card-header button')).toBeNull();
    });

    it('shows a per-card Apply-to-all control once >1 group exists and applies that card config', () => {
      storeState.enterpriseMode = true;
      storeState.enterpriseAccessGroups = ['team_a', 'team_b'];
      storeState.dynamicRoutes = ['development'];
      render(() => <ConfigureStep />);
      const applyButtons = document.querySelectorAll('.group-routing-card-header button');
      expect(applyButtons.length).toBe(2);
      fireEvent.click(applyButtons[0] as HTMLElement);
      expect(storeMethods.applyGroupRoutingToAll).toHaveBeenCalledWith('team_a');
    });

    // Item 11: once any group exists the global Default Route editor disappears —
    // routing is configured per-group (the stored global default remains the
    // backend fallback for users who match no configured group).
    it('hides the global Default Route editor once a group exists', () => {
      storeState.enterpriseMode = true;
      storeState.enterpriseAccessGroups = ['team_a'];
      storeState.dynamicRoutes = ['development'];
      render(() => <ConfigureStep />);
      // team_a has no selected routes, so neither the global editor nor any
      // per-group default row renders — zero route-default-rows total.
      expect(document.querySelectorAll('.route-default-row').length).toBe(0);
      expect(screen.queryByText('Default Route')).not.toBeInTheDocument();
    });

    it('shows the global Default Route editor when no group exists', () => {
      storeState.enterpriseMode = true;
      storeState.enterpriseAccessGroups = [];
      storeState.dynamicRoutes = ['development'];
      render(() => <ConfigureStep />);
      expect(document.querySelectorAll('.route-default-row').length).toBe(1);
    });
  });

  // REQ-GITHUB-008: GitHub provider chooser renders for admins in ANY mode (the
  // Setup wizard is admin-gated everywhere).
  describe('GitHub provider chooser', () => {
    it('renders the provider chooser in enterprise mode', () => {
      storeState.enterpriseMode = true;
      render(() => <ConfigureStep />);
      expect(document.querySelector('.github-provider-select')).not.toBeNull();
    });

    it('renders the chooser outside enterprise mode too (admin, any mode)', () => {
      storeState.enterpriseMode = false;
      render(() => <ConfigureStep />);
      expect(document.querySelector('.github-provider-select')).not.toBeNull();
    });

    it('shows the App client-id field for the app provider and switches provider on change', () => {
      storeState.enterpriseMode = true;
      storeState.githubProviderType = 'app';
      render(() => <ConfigureStep />);
      expect(screen.getByPlaceholderText('GitHub App Client ID')).toBeInTheDocument();
      const sel = document.querySelector('.github-provider-select') as HTMLSelectElement;
      fireEvent.change(sel, { target: { value: 'oauth' } });
      expect(storeMethods.setGithubProviderType).toHaveBeenCalledWith('oauth');
    });

    it('shows the OAuth client-id field for the oauth provider', () => {
      storeState.enterpriseMode = true;
      storeState.githubProviderType = 'oauth';
      render(() => <ConfigureStep />);
      expect(screen.getByPlaceholderText('OAuth App Client ID')).toBeInTheDocument();
    });
  });

  // Connect-to-Cloudflare OAuth client chooser: admin, non-enterprise only.
  describe('Cloudflare provider chooser', () => {
    it('renders the chooser outside enterprise mode', () => {
      storeState.enterpriseMode = false;
      render(() => <ConfigureStep />);
      expect(screen.getByTestId('cloudflare-provider-chooser')).toBeInTheDocument();
    });

    it('does not render the chooser in enterprise mode', () => {
      storeState.enterpriseMode = true;
      render(() => <ConfigureStep />);
      expect(screen.queryByTestId('cloudflare-provider-chooser')).not.toBeInTheDocument();
    });

    it('routes the client-id input to setCloudflareOauthClientId', () => {
      storeState.enterpriseMode = false;
      render(() => <ConfigureStep />);
      const idInput = screen.getByPlaceholderText('Cloudflare OAuth Client ID');
      fireEvent.input(idInput, { target: { value: 'cf-cid' } });
      expect(storeMethods.setCloudflareOauthClientId).toHaveBeenCalledWith('cf-cid');
    });

    it('routes the client-secret input to setCloudflareOauthClientSecret', () => {
      storeState.enterpriseMode = false;
      render(() => <ConfigureStep />);
      const secretInput = screen.getByPlaceholderText('Cloudflare OAuth Client Secret');
      fireEvent.input(secretInput, { target: { value: 'cf-sec' } });
      expect(storeMethods.setCloudflareOauthClientSecret).toHaveBeenCalledWith('cf-sec');
    });
  });
});
