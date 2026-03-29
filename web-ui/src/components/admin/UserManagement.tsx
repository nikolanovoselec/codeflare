import { Component, createSignal, createMemo, onMount, For, Show } from 'solid-js';
import { mdiArrowExpandLeft } from '@mdi/js';
import { getUsers, type UserEntry, updateUserTier, deleteUser, updateMaxUsers, getAuthStatus } from '../../api/client';
import type { SubscriptionTier } from '../../types';
import Icon from '../Icon';
import '../../styles/user-management.css';

interface UserManagementProps {
  onBack: () => void;
}

/** User entry with a resolved subscription tier (defaults undefined to 'standard'). */
interface ResolvedUser extends UserEntry {
  resolvedTier: SubscriptionTier;
}

const TIER_ORDER: readonly SubscriptionTier[] = [
  'pending', 'free', 'trial', 'standard', 'advanced', 'max', 'unlimited', 'blocked',
] as const;

const SECTION_LABELS: Record<SubscriptionTier, string> = {
  blocked: 'Blocked',
  pending: 'Pending',
  free: 'Free',
  trial: 'Trial',
  standard: 'Starter',
  advanced: 'Advanced',
  max: 'Max',
  unlimited: 'Custom',
};

function resolveTier(user: UserEntry): SubscriptionTier {
  return (user.subscriptionTier ?? user.accessTier ?? 'standard') as SubscriptionTier;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

const UserManagement: Component<UserManagementProps> = (props) => {
  const [users, setUsers] = createSignal<readonly ResolvedUser[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [searchQuery, setSearchQuery] = createSignal('');
  const [updatingEmails, setUpdatingEmails] = createSignal<ReadonlySet<string>>(new Set());
  const [deletingEmails, setDeletingEmails] = createSignal<ReadonlySet<string>>(new Set());
  const [maxUsers, setMaxUsers] = createSignal(0);
  const [editingMaxUsers, setEditingMaxUsers] = createSignal(false);
  const [maxUsersInput, setMaxUsersInput] = createSignal('');
  const [currentEmail, setCurrentEmail] = createSignal('');

  onMount(async () => {
    try {
      const [{ users: fetched, maxUsers: cap }, auth] = await Promise.all([
        getUsers(),
        getAuthStatus().catch(() => ({ email: '' })),
      ]);
      setUsers(fetched.map((u) => ({ ...u, resolvedTier: resolveTier(u) })));
      setMaxUsers(cap);
      setCurrentEmail((auth.email ?? '').toLowerCase());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  });

  // Filtered users based on search query
  const filteredUsers = createMemo(() => {
    const q = searchQuery().toLowerCase().trim();
    if (!q) return users();
    return users().filter((u) => u.email.toLowerCase().includes(q));
  });

  // Group filtered users by tier
  const groupedUsers = createMemo(() => {
    const mutable: Record<string, ResolvedUser[]> = {};
    for (const tier of TIER_ORDER) {
      mutable[tier] = [];
    }
    for (const user of filteredUsers()) {
      const bucket = mutable[user.resolvedTier];
      if (bucket) bucket.push(user);
      else mutable[user.resolvedTier] = [user];
    }
    return mutable as Record<SubscriptionTier, readonly ResolvedUser[]>;
  });

  const handleTierChange = async (email: string, newTier: SubscriptionTier, mode?: 'default' | 'advanced') => {
    // Mark as updating
    setUpdatingEmails((prev) => {
      const next = new Set(prev);
      next.add(email);
      return next;
    });

    try {
      await updateUserTier(email, newTier, mode);
      // Update local state immutably
      setUsers((prev) =>
        prev.map((u) =>
          u.email === email
            ? { ...u, subscriptionTier: newTier, resolvedTier: newTier, subscribedMode: mode ?? 'default' }
            : u
        )
      );
    } catch (err) {
      setError(
        `Failed to update ${email}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setUpdatingEmails((prev) => {
        const next = new Set(prev);
        next.delete(email);
        return next;
      });
    }
  };

  const handleApproveAllPending = async () => {
    const pending = groupedUsers().pending;
    if (pending.length === 0) return;

    // Mark all pending as updating
    setUpdatingEmails((prev) => {
      const next = new Set(prev);
      for (const u of pending) next.add(u.email);
      return next;
    });

    const errors: string[] = [];

    // Process sequentially to avoid overwhelming the API
    for (const user of pending) {
      try {
        await updateUserTier(user.email, 'standard');
        // Update local state immutably after each success
        setUsers((prev) =>
          prev.map((u) =>
            u.email === user.email
              ? { ...u, subscriptionTier: 'standard' as SubscriptionTier, resolvedTier: 'standard' as SubscriptionTier }
              : u
          )
        );
      } catch (err) {
        errors.push(
          `${user.email}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Clear updating state
    setUpdatingEmails((prev) => {
      const next = new Set(prev);
      for (const u of pending) next.delete(u.email);
      return next;
    });

    if (errors.length > 0) {
      setError(`Some approvals failed: ${errors.join('; ')}`);
    }
  };

  const handleDeleteUser = async (email: string) => {
    if (!confirm(`Delete ${email} and all their data (sessions, storage, credentials)? This cannot be undone.`)) {
      return;
    }

    setDeletingEmails((prev) => {
      const next = new Set(prev);
      next.add(email);
      return next;
    });

    try {
      await deleteUser(email);
      setUsers((prev) => prev.filter((u) => u.email !== email));
    } catch (err) {
      setError(`Failed to delete ${email}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeletingEmails((prev) => {
        const next = new Set(prev);
        next.delete(email);
        return next;
      });
    }
  };

  return (
    <div class="user-mgmt">
      {/* Header */}
      <div class="user-mgmt-header">
        <button
          type="button"
          class="user-mgmt-back"
          onClick={() => props.onBack()}
          title="Go back"
          aria-label="Go back"
        >
          <Icon path={mdiArrowExpandLeft} size={20} />
        </button>
        <h1 class="user-mgmt-title">User Management</h1>
        <Show when={!loading()}>
          <span class="user-mgmt-badge">
            {users().length}{maxUsers() > 0 ? ` / ${maxUsers()}` : ''} users
          </span>
          <button
            type="button"
            class="user-mgmt-badge"
            style={{ cursor: 'pointer', 'margin-left': '8px' }}
            onClick={() => { setEditingMaxUsers(!editingMaxUsers()); setMaxUsersInput(String(maxUsers())); }}
          >
            {editingMaxUsers() ? 'Cancel' : 'Set Limit'}
          </button>
        </Show>
      </div>
      <Show when={editingMaxUsers()}>
        <div style={{ display: 'flex', gap: '8px', 'align-items': 'center', padding: '8px 0' }}>
          <input
            type="number"
            min="0"
            value={maxUsersInput()}
            onInput={(e) => setMaxUsersInput(e.currentTarget.value)}
            placeholder="0 = unlimited"
            style={{ width: '120px', padding: '4px 8px' }}
          />
          <button
            type="button"
            onClick={async () => {
              const val = parseInt(maxUsersInput()) || 0;
              try {
                await updateMaxUsers(val);
                setMaxUsers(val);
                setEditingMaxUsers(false);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to update');
              }
            }}
          >
            Save
          </button>
          <span style={{ color: '#888', 'font-size': '12px' }}>0 = unlimited</span>
        </div>
      </Show>

      {/* Search */}
      <input
        type="text"
        class="user-mgmt-search-input"
        placeholder="Search by email..."
        value={searchQuery()}
        onInput={(e) => setSearchQuery(e.currentTarget.value)}
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck={false}
      />

      {/* Error */}
      <Show when={error()}>
        {(errMsg) => <div class="user-mgmt-error">{errMsg()}</div>}
      </Show>

      {/* Loading */}
      <Show when={loading()}>
        <div class="user-mgmt-section">
          <p class="user-mgmt-meta">Loading users...</p>
        </div>
      </Show>

      {/* Tier sections */}
      <Show when={!loading()}>
        <For each={[...TIER_ORDER]}>
          {(tier) => {
            const sectionUsers = () => groupedUsers()[tier];
            return (
              <Show when={sectionUsers().length > 0}>
                <div class="user-mgmt-section">
                  {/* Section header */}
                  <div class="user-mgmt-section-header">
                    <h2 class={`user-mgmt-section-title user-mgmt-section-title--${tier}`}>
                      {SECTION_LABELS[tier]}
                    </h2>
                    <span class="user-mgmt-count">({sectionUsers().length})</span>
                  </div>

                  {/* Pending: bulk approve button */}
                  <Show when={tier === 'pending' && sectionUsers().length > 0}>
                    <div class="user-mgmt-bulk-actions">
                      <button
                        type="button"
                        class="user-mgmt-btn--approve"
                        onClick={() => { void handleApproveAllPending(); }}
                      >
                        Approve All (Standard)
                      </button>
                    </div>
                  </Show>

                  {/* User list */}
                  <div class="user-mgmt-list">
                    <For each={sectionUsers()}>
                      {(user) => (
                        <div class="user-mgmt-row">
                          <div class="user-mgmt-user-info">
                            <span class="user-mgmt-email">
                              {user.email}
                              <Show when={user.role === 'admin'}>
                                <span class="user-mgmt-admin-badge">ADMIN</span>
                              </Show>
                            </span>
                            <span class="user-mgmt-meta">
                              Added {formatDate(user.addedAt)}
                            </span>
                          </div>
                          <Show
                            when={!updatingEmails().has(user.email)}
                            fallback={<span class="user-mgmt-updating">Updating...</span>}
                          >
                            <div class="user-mgmt-actions">
                              <Show
                                when={user.role !== 'admin' || user.email.toLowerCase() === currentEmail()}
                                fallback={<span class="user-mgmt-tier-fixed">Unlimited</span>}
                              >
                                <select
                                  class="user-mgmt-tier-select"
                                  value={user.resolvedTier}
                                  onChange={(e) => {
                                    const newTier = e.currentTarget.value as SubscriptionTier;
                                    if (newTier !== user.resolvedTier) {
                                      void handleTierChange(user.email, newTier, user.subscribedMode ?? 'default');
                                    }
                                  }}
                                >
                                  <option value="blocked">Blocked</option>
                                  <option value="pending">Pending</option>
                                  <option value="free">Free</option>
                                  <option value="trial">Trial</option>
                                  <option value="standard">Starter</option>
                                  <option value="advanced">Advanced</option>
                                  <option value="max">Max</option>
                                  <option value="unlimited">Custom</option>
                                </select>
                                <select
                                  class="user-mgmt-tier-select"
                                  value={user.subscribedMode ?? 'default'}
                                  onChange={(e) => {
                                    const newMode = e.currentTarget.value as 'default' | 'advanced';
                                    if (newMode !== (user.subscribedMode ?? 'default')) {
                                      void handleTierChange(user.email, user.resolvedTier, newMode);
                                    }
                                  }}
                                >
                                  <option value="default">Standard</option>
                                  <option value="advanced">Pro</option>
                                </select>
                                <button
                                  type="button"
                                  class="user-mgmt-btn--delete"
                                  disabled={deletingEmails().has(user.email)}
                                  onClick={() => { void handleDeleteUser(user.email); }}
                                  title="Delete user and all data"
                                >
                                  {deletingEmails().has(user.email) ? '...' : '\u00D7'}
                                </button>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            );
          }}
        </For>
      </Show>
    </div>
  );
};

export default UserManagement;
