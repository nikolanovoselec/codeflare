import { cleanup, render, screen, waitFor } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getAdminConfigurationMock = vi.fn();

vi.mock('../../api/client', () => ({
  getAdminConfiguration: (...args: unknown[]) => getAdminConfigurationMock(...args),
}));

import AdministrationLayout from '../../components/admin/AdministrationLayout';

const response = (mode: 'default' | 'onboarding' | 'saas' | 'enterprise') => ({
  mode,
  revision: 1,
  applicableSections: [],
  sections: { domain: {} },
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('REQ-SETUP-019 AC2: gates navigation by deployment mode', () => {
  it.each([
    ['default', true, false],
    ['onboarding', true, false],
    ['saas', true, true],
    ['enterprise', false, false],
  ] as const)('renders the %s navigation', async (mode, showsUsers, showsSubscriptions) => {
    window.history.replaceState({}, '', '/admin');
    getAdminConfigurationMock.mockResolvedValue(response(mode));

    render(() => <Router><Route path="/admin" component={AdministrationLayout} /></Router>);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Overview' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Environment' })).toHaveAttribute('href', '/admin/environment');
    expect(screen.getByRole('link', { name: 'Analytics' })).toHaveAttribute('href', '/admin/analytics');
    expect(screen.getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/admin/reports');
    expect(screen.getByRole('link', { name: 'Activity' })).toHaveAttribute('href', '/admin/activity');
    expect(screen.queryByRole('link', { name: 'Users' }) !== null).toBe(showsUsers);
    expect(screen.queryByRole('link', { name: 'Subscription Tiers' }) !== null).toBe(showsSubscriptions);
  });
});
