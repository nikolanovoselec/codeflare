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
  dynamicRoutes: [] as string[],
  defaultRouteName: '',
  defaultRouteReasoning: 'off' as 'off' | 'low' | 'medium' | 'high',
}));

const storeMethods = vi.hoisted(() => ({
  setCustomDomain: vi.fn((val: string) => { storeState.customDomain = val; }),
  addAdminUser: vi.fn((email: string) => { storeState.adminUsers.push(email); }),
  removeAdminUser: vi.fn((email: string) => { storeState.adminUsers = storeState.adminUsers.filter(e => e !== email); }),
  addAllowedUser: vi.fn((email: string) => { storeState.allowedUsers.push(email); }),
  removeAllowedUser: vi.fn((email: string) => { storeState.allowedUsers = storeState.allowedUsers.filter(e => e !== email); }),
  addAccessGroup: vi.fn((name: string) => { storeState.enterpriseAccessGroups.push(name); }),
  removeAccessGroup: vi.fn((name: string) => { storeState.enterpriseAccessGroups = storeState.enterpriseAccessGroups.filter(g => g !== name); }),
  addDynamicRoute: vi.fn((name: string) => { storeState.dynamicRoutes.push(name); }),
  removeDynamicRoute: vi.fn((name: string) => { storeState.dynamicRoutes = storeState.dynamicRoutes.filter(r => r !== name); }),
  setDefaultRouteName: vi.fn((name: string) => { storeState.defaultRouteName = name; }),
  setDefaultRouteReasoning: vi.fn((level: 'off' | 'low' | 'medium' | 'high') => { storeState.defaultRouteReasoning = level; }),
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
    get dynamicRoutes() { return storeState.dynamicRoutes; },
    get defaultRouteName() { return storeState.defaultRouteName; },
    get defaultRouteReasoning() { return storeState.defaultRouteReasoning; },
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
    storeState.dynamicRoutes = [];
    storeState.defaultRouteName = '';
    storeState.defaultRouteReasoning = 'off';
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
});
