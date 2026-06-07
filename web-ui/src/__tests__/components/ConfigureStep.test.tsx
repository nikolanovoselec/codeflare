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
  enterpriseAccessGroup: '',
}));

const storeMethods = vi.hoisted(() => ({
  setCustomDomain: vi.fn((val: string) => { storeState.customDomain = val; }),
  addAdminUser: vi.fn((email: string) => { storeState.adminUsers.push(email); }),
  removeAdminUser: vi.fn((email: string) => { storeState.adminUsers = storeState.adminUsers.filter(e => e !== email); }),
  addAllowedUser: vi.fn((email: string) => { storeState.allowedUsers.push(email); }),
  removeAllowedUser: vi.fn((email: string) => { storeState.allowedUsers = storeState.allowedUsers.filter(e => e !== email); }),
  setEnterpriseAccessGroup: vi.fn((val: string) => { storeState.enterpriseAccessGroup = val; }),
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
    get enterpriseAccessGroup() { return storeState.enterpriseAccessGroup; },
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
    storeState.enterpriseAccessGroup = '';
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

      const removeBtn = document.querySelector('.email-tag--admin .email-tag-remove') as HTMLElement;
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
