import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import UserManagement from '../../components/UserManagement';

// Mock the API client
const mockGetUsers = vi.fn();
const mockRemoveUser = vi.fn();

vi.mock('../../api/client', () => ({
  getUsers: (...args: unknown[]) => mockGetUsers(...args),
  removeUser: (...args: unknown[]) => mockRemoveUser(...args),
}));

vi.mock('../../components/Icon', () => ({
  default: (props: { path: string; size?: number }) => (
    <span data-testid="mock-icon" data-path={props.path} />
  ),
}));

describe('UserManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsers.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  describe('Visibility', () => {
    it('renders nothing for non-admin users', () => {
      render(() => (
        <UserManagement
          isOpen={true}
          currentUserEmail="user@example.com"
          currentUserRole="user"
        />
      ));
      expect(screen.queryByTestId('settings-user-management')).not.toBeInTheDocument();
    });

    it('renders user management section for admin users', async () => {
      render(() => (
        <UserManagement
          isOpen={true}
          currentUserEmail="admin@example.com"
          currentUserRole="admin"
        />
      ));
      expect(screen.getByTestId('settings-user-management')).toBeInTheDocument();
    });
  });

  describe('User list', () => {
    it('loads users when panel opens', async () => {
      const users = [
        { email: 'alice@example.com', addedBy: 'admin@example.com', addedAt: '2024-01-01', role: 'user' as const },
        { email: 'bob@example.com', addedBy: 'admin@example.com', addedAt: '2024-01-02', role: 'admin' as const },
      ];
      mockGetUsers.mockResolvedValue(users);

      render(() => (
        <UserManagement
          isOpen={true}
          currentUserEmail="admin@example.com"
          currentUserRole="admin"
        />
      ));

      await waitFor(() => {
        expect(screen.getAllByTestId('settings-user-row')).toHaveLength(2);
      });

      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
      expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    });

    it('shows role badges', async () => {
      const users = [
        { email: 'admin@example.com', addedBy: 'setup', addedAt: '2024-01-01', role: 'admin' as const },
        { email: 'user@example.com', addedBy: 'admin@example.com', addedAt: '2024-01-02', role: 'user' as const },
      ];
      mockGetUsers.mockResolvedValue(users);

      render(() => (
        <UserManagement
          isOpen={true}
          currentUserEmail="admin@example.com"
          currentUserRole="admin"
        />
      ));

      await waitFor(() => {
        const badges = screen.getAllByTestId('settings-user-role-badge');
        expect(badges).toHaveLength(2);
        expect(badges[0].textContent).toBe('Admin');
        expect(badges[1].textContent).toBe('User');
      });
    });

    it('shows empty state when no users', async () => {
      mockGetUsers.mockResolvedValue([]);

      render(() => (
        <UserManagement
          isOpen={true}
          currentUserEmail="admin@example.com"
          currentUserRole="admin"
        />
      ));

      await waitFor(() => {
        expect(screen.getByText('No users added yet')).toBeInTheDocument();
      });
    });

    it('shows error message on load failure', async () => {
      mockGetUsers.mockRejectedValue(new Error('Network error'));

      render(() => (
        <UserManagement
          isOpen={true}
          currentUserEmail="admin@example.com"
          currentUserRole="admin"
        />
      ));

      await waitFor(() => {
        expect(screen.getByTestId('settings-user-error')).toBeInTheDocument();
        expect(screen.getByText('Failed to load users')).toBeInTheDocument();
      });
    });
  });

  describe('Add user form removed', () => {
    it('does not render add-user form', () => {
      render(() => (
        <UserManagement
          isOpen={true}
          currentUserEmail="admin@example.com"
          currentUserRole="admin"
        />
      ));

      expect(screen.queryByPlaceholderText('user@example.com')).not.toBeInTheDocument();
      expect(screen.queryByTestId('settings-new-user-role-select')).not.toBeInTheDocument();
      expect(screen.queryByTestId('settings-add-user-fields-row')).not.toBeInTheDocument();
    });
  });

  describe('Remove user', () => {
    it('calls removeUser API when remove button is clicked', async () => {
      const users = [
        { email: 'other@example.com', addedBy: 'admin@example.com', addedAt: '2024-01-01', role: 'user' as const },
      ];
      mockGetUsers.mockResolvedValue(users);
      mockRemoveUser.mockResolvedValue(undefined);

      render(() => (
        <UserManagement
          isOpen={true}
          currentUserEmail="admin@example.com"
          currentUserRole="admin"
        />
      ));

      await waitFor(() => {
        expect(screen.getByText('other@example.com')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Remove'));

      await waitFor(() => {
        expect(mockRemoveUser).toHaveBeenCalledWith('other@example.com');
      });
    });

    it('disables remove button for current user', async () => {
      const users = [
        { email: 'admin@example.com', addedBy: 'setup', addedAt: '2024-01-01', role: 'admin' as const },
      ];
      mockGetUsers.mockResolvedValue(users);

      render(() => (
        <UserManagement
          isOpen={true}
          currentUserEmail="admin@example.com"
          currentUserRole="admin"
        />
      ));

      await waitFor(() => {
        const removeBtnText = screen.getByText('Remove');
        const removeBtn = removeBtnText.closest('button')!;
        expect(removeBtn).toBeDisabled();
      });
    });

    it('shows error on remove failure', async () => {
      const users = [
        { email: 'target@example.com', addedBy: 'admin@example.com', addedAt: '2024-01-01', role: 'user' as const },
      ];
      mockGetUsers.mockResolvedValue(users);
      mockRemoveUser.mockRejectedValue(new Error('Failed to remove user'));

      render(() => (
        <UserManagement
          isOpen={true}
          currentUserEmail="admin@example.com"
          currentUserRole="admin"
        />
      ));

      await waitFor(() => {
        expect(screen.getByText('target@example.com')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Remove'));

      await waitFor(() => {
        expect(screen.getByTestId('settings-user-error')).toBeInTheDocument();
      });
    });
  });
});
