import { cleanup, render, screen } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const configuration = {
  mode: 'enterprise' as const,
  revision: 4,
  applicableSections: ['access', 'domain', 'managedEnvironment', 'github', 'cloudflareConnection', 'usageReports'] as const,
  sections: {
    access: { adminUsers: ['admin@example.com'] },
    domain: { customDomain: 'codeflare.example' },
    managedEnvironment: { configured: true, activeReleaseTag: 'seed-v47' },
    github: { providerType: 'oauth' },
    cloudflareConnection: { clientId: 'client-id' },
    usageReports: { enabled: true },
  },
  activeRunId: null,
  latest: {},
};

vi.mock('../../components/admin/AdministrationLayout', () => ({
  useAdministration: () => configuration,
}));

import AdministrationOverview from '../../components/admin/AdministrationOverview';

afterEach(cleanup);

describe('Administration overview Environment navigation', () => {
  it('links each summary directly to its Environment area without duplicate navigation', () => {
    render(() => <Router><Route path="*" component={AdministrationOverview} /></Router>);

    expect(screen.queryByText('Environment settings')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Environment' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Access and identity/ })).toHaveAttribute('href', '/admin/environment/access');
    expect(screen.getByRole('link', { name: /Domain and DNS/ })).toHaveAttribute('href', '/admin/environment/domain');
    expect(screen.getByRole('link', { name: /Managed environment/ })).toHaveAttribute('href', '/admin/environment/managedEnvironment');
    expect(screen.getByRole('link', { name: /Monthly usage reports/ })).toHaveAttribute('href', '/admin/environment/usageReports');
  });
});
