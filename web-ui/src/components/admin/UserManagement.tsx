import { Component, createSignal, createMemo, onMount, For, Show } from 'solid-js';
import { mdiArrowExpandLeft } from '@mdi/js';
import { getUsers, type UserEntry, updateUserAccessTier, deleteUser } from '../../api/client';
import type { AccessTier } from '../../types';
import Icon from '../Icon';
import '../../styles/user-management.css';

interface UserManagementProps {
  onBack: () => void;
}

/** User entry with a resolved access tier (defaults undefined to 'advanced'). */
interface ResolvedUser extends UserEntry {
  resolvedTier: AccessTier;
}

const TIER_ORDER: readonly AccessTier[] = ['pending', 'standard', 'advanced', 'blocked'] as const;

const SECTION_LABELS: Record<AccessTier, string> = {
  pending: 'Pending',
  standard: 'Standard',
  advanced: 'Advanced',
  blocked: 'Blocked',
};

function resolveTier(user: UserEntry): AccessTier {
  return user.accessTier ?? 'advanced';
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

  onMount(async () => {
    try {
      const fetched = await getUsers();
      setUsers(fetched.map((u) => ({ ...u, resolvedTier: resolveTier(u) })));
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
    const groups: Record<AccessTier, readonly ResolvedUser[]> = {
      pending: [],
      standard: [],
      advanced: [],
      blocked: [],
    };
    const mutable: Record<AccessTier, ResolvedUser[]> = {
      pending: [],
      standard: [],
      advanced: [],
      blocked: [],
    };
    for (const user of filteredUsers()) {
      mutable[user.resolvedTier].push(user);
    }
    // Return as readonly
    for (const tier of TIER_ORDER) {
      groups[tier] = mutable[tier];
    }
    return groups;
  });

  const handleTierChange = async (email: string, newTier: AccessTier) => {
    // Mark as updating
    setUpdatingEmails((prev) => {
      const next = new Set(prev);
      next.add(email);
      return next;
    });

    try {
      await updateUserAccessTier(email, newTier);
      // Update local state immutably
      setUsers((prev) =>
        prev.map((u) =>
          u.email === email
            ? { ...u, accessTier: newTier, resolvedTier: newTier }
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
        await updateUserAccessTier(user.email, 'standard');
        // Update local state immutably after each success
        setUsers((prev) =>
          prev.map((u) =>
            u.email === user.email
              ? { ...u, accessTier: 'standard' as AccessTier, resolvedTier: 'standard' as AccessTier }
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
          <span class="user-mgmt-badge">{users().length} users</span>
        </Show>
      </div>

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
                                when={user.role !== 'admin'}
                                fallback={<span class="user-mgmt-tier-fixed">Advanced</span>}
                              >
                                <select
                                  class="user-mgmt-tier-select"
                                  value={user.resolvedTier}
                                  onChange={(e) => {
                                    const newTier = e.currentTarget.value as AccessTier;
                                    if (newTier !== user.resolvedTier) {
                                      void handleTierChange(user.email, newTier);
                                    }
                                  }}
                                >
                                  <option value="pending">Pending</option>
                                  <option value="standard">Standard</option>
                                  <option value="advanced">Advanced</option>
                                  <option value="blocked">Blocked</option>
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
