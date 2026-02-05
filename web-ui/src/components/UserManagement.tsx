import { Component, createSignal, createEffect, Show, For } from 'solid-js';
import { mdiAccountGroupOutline } from '@mdi/js';
import Icon from './Icon';
import Button from './ui/Button';
import Input from './ui/Input';
import { getUsers, addUser, removeUser } from '../api/client';
import type { UserEntry } from '../api/client';

interface UserManagementProps {
  isOpen: boolean;
  currentUserEmail?: string;
  currentUserRole?: 'admin' | 'user';
}

const UserManagement: Component<UserManagementProps> = (props) => {
  const [users, setUsers] = createSignal<UserEntry[]>([]);
  const [usersLoading, setUsersLoading] = createSignal(false);
  const [userEmail, setUserEmail] = createSignal('');
  const [newUserRole, setNewUserRole] = createSignal<'admin' | 'user'>('user');
  const [userError, setUserError] = createSignal('');

  const isAdmin = () => props.currentUserRole === 'admin';

  const loadUsers = async () => {
    setUsersLoading(true);
    setUserError('');
    try {
      const result = await getUsers();
      setUsers(result);
    } catch (err) {
      setUserError('Failed to load users');
    } finally {
      setUsersLoading(false);
    }
  };

  // Load users when panel opens
  createEffect(() => {
    if (props.isOpen && isAdmin()) {
      loadUsers();
    } else if (!isAdmin()) {
      setUsers([]);
      setUserError('');
      setUsersLoading(false);
    }
  });

  const handleAddUser = async () => {
    const email = userEmail().trim().toLowerCase();
    if (!email || !/.+@.+\..+/.test(email)) return;
    try {
      setUserError('');
      await addUser(email, newUserRole());
      setUserEmail('');
      setNewUserRole('user');
      await loadUsers();
    } catch (err) {
      setUserError(err instanceof Error ? err.message : 'Failed to add user');
    }
  };

  const handleRemoveUser = async (email: string) => {
    try {
      setUserError('');
      await removeUser(email);
      await loadUsers();
    } catch (err) {
      setUserError(err instanceof Error ? err.message : 'Failed to remove user');
    }
  };

  const handleUserEmailKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAddUser();
    }
  };

  return (
    <Show when={isAdmin()}>
      <section class="settings-section settings-section-3" data-testid="settings-user-management">
        <div class="settings-section-header">
          <Icon path={mdiAccountGroupOutline} size={16} />
          <h3 class="settings-section-title">User Management</h3>
        </div>

        <div class="setting-row">
          <div class="setting-row__actions settings-add-user-fields" data-testid="settings-add-user-fields-row">
            <div class="setting-row__input-wrapper" onKeyDown={handleUserEmailKeyDown}>
              <Input
                value={userEmail()}
                onInput={(value) => { setUserEmail(value); setUserError(''); }}
                placeholder="user@example.com"
              />
            </div>
            <select
              value={newUserRole()}
              onChange={(e) => setNewUserRole(e.currentTarget.value as 'admin' | 'user')}
              class="settings-role-select settings-role-select--compact"
              data-testid="settings-new-user-role-select"
              autocomplete="off"
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
            <Button onClick={handleAddUser} variant="primary" size="sm">Add</Button>
          </div>
        </div>

        {/* Error */}
        <Show when={userError()}>
          <div class="settings-error" data-testid="settings-user-error">{userError()}</div>
        </Show>

        {/* User list */}
        <Show when={usersLoading()}>
          <div class="setting-row setting-row--centered">
            <span class="settings-hint">Loading users...</span>
          </div>
        </Show>
        <Show when={!usersLoading()}>
          <For each={users()}>
            {(user) => (
              <div class="setting-row setting-row--user" data-testid="settings-user-row">
                <div class="setting-row__user-info">
                  <span class="setting-row__user-email">{user.email}</span>
                  <span
                    class={`settings-role-badge ${user.role === 'admin' ? 'settings-role-badge--admin' : 'settings-role-badge--user'}`}
                    data-testid="settings-user-role-badge"
                  >
                    {user.role === 'admin' ? 'Admin' : 'User'}
                  </span>
                  <span class="settings-hint setting-row__added-by">
                    added by {user.addedBy}
                  </span>
                </div>
                <Button
                  onClick={() => handleRemoveUser(user.email)}
                  variant="ghost"
                  size="sm"
                  disabled={user.email === props.currentUserEmail}
                >
                  Remove
                </Button>
              </div>
            )}
          </For>
        </Show>
        <Show when={!usersLoading() && users().length === 0 && !userError()}>
          <div class="setting-row setting-row--centered">
            <span class="settings-hint">No users added yet</span>
          </div>
        </Show>
      </section>
    </Show>
  );
};

export default UserManagement;
