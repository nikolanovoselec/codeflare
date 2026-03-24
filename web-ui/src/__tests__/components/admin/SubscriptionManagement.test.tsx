import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@solidjs/testing-library';
import SubscriptionManagement from '../../../components/admin/SubscriptionManagement';

// Mock the API client
vi.mock('../../../api/client', () => ({
  getTiers: vi.fn(),
  updateTiers: vi.fn(),
}));

import { getTiers, updateTiers } from '../../../api/client';

const mockedGetTiers = vi.mocked(getTiers);
const mockedUpdateTiers = vi.mocked(updateTiers);

const MOCK_TIERS = [
  { id: 'blocked', displayName: 'Blocked', monthlySeconds: 0, maxSessions: 0, sessionModes: [] as string[], canLogin: false, order: 0, isDefault: false, priceMonthly: null, advancedPriceMonthly: null, trialQuotaHours: 0, description: '' },
  { id: 'pending', displayName: 'Pending', monthlySeconds: 0, maxSessions: 0, sessionModes: [] as string[], canLogin: false, order: 1, isDefault: false, priceMonthly: null, advancedPriceMonthly: null, trialQuotaHours: 0, description: '' },
  { id: 'free', displayName: 'Free', monthlySeconds: 14400, maxSessions: 1, sessionModes: ['default'], canLogin: true, order: 2, isDefault: false, priceMonthly: 0, advancedPriceMonthly: null, trialQuotaHours: 0, description: 'Get started for free' },
  { id: 'trial', displayName: 'Trial', monthlySeconds: 18000, maxSessions: 2, sessionModes: ['default'], canLogin: true, order: 3, isDefault: false, priceMonthly: null, advancedPriceMonthly: null, trialQuotaHours: 0, description: '' },
  { id: 'standard', displayName: 'Starter', monthlySeconds: 144000, maxSessions: 1, sessionModes: ['default', 'advanced'], canLogin: true, order: 4, isDefault: true, priceMonthly: 2900, advancedPriceMonthly: 3400, trialQuotaHours: 40, description: 'For individual developers' },
  { id: 'advanced', displayName: 'Advanced', monthlySeconds: 288000, maxSessions: 2, sessionModes: ['default', 'advanced'], canLogin: true, order: 5, isDefault: false, priceMonthly: 4900, advancedPriceMonthly: 5400, trialQuotaHours: 80, description: '' },
  { id: 'max', displayName: 'Max', monthlySeconds: 576000, maxSessions: 3, sessionModes: ['default', 'advanced'], canLogin: true, order: 6, isDefault: false, priceMonthly: 6900, advancedPriceMonthly: 7400, trialQuotaHours: 160, description: 'For professional teams' },
  { id: 'unlimited', displayName: 'Team', monthlySeconds: null, maxSessions: 5, sessionModes: ['default', 'advanced'], canLogin: true, order: 7, isDefault: false, priceMonthly: null, advancedPriceMonthly: null, trialQuotaHours: 0, description: 'Enterprise-grade access' },
];

const noop = () => {};

describe('SubscriptionManagement (Admin)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetTiers.mockResolvedValue({ tiers: MOCK_TIERS });
    mockedUpdateTiers.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('should show loading state initially', () => {
    mockedGetTiers.mockReturnValue(new Promise(() => {}));
    render(() => <SubscriptionManagement onBack={noop} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('should load tiers from API on mount', async () => {
    render(() => <SubscriptionManagement onBack={noop} />);

    await waitFor(() => {
      expect(mockedGetTiers).toHaveBeenCalledTimes(1);
    });
  });

  it('should show 6 editable tiers (not blocked/pending)', async () => {
    render(() => <SubscriptionManagement onBack={noop} />);

    await waitFor(() => {
      expect(screen.getByText('Free')).toBeInTheDocument();
      expect(screen.getByText('Trial')).toBeInTheDocument();
      expect(screen.getByText('Starter')).toBeInTheDocument();
      expect(screen.getByText('Advanced')).toBeInTheDocument();
      expect(screen.getByText('Max')).toBeInTheDocument();
      expect(screen.getByText('Team')).toBeInTheDocument();
    });

    // Blocked and pending should not appear as editable rows
    expect(screen.queryByText('Blocked')).not.toBeInTheDocument();
    expect(screen.queryByText('Pending')).not.toBeInTheDocument();
  });

  it('should display hours field with correct values from seconds', async () => {
    render(() => <SubscriptionManagement onBack={noop} />);

    await waitFor(() => {
      expect(screen.getByText('Free')).toBeInTheDocument();
    });

    // At least one input should contain "4" (Free = 14400s = 4h)
    const textInputs = Array.from(document.querySelectorAll('input[type="text"]'));
    const hasFourHours = textInputs.some((input) => (input as HTMLInputElement).value === '4');
    expect(hasFourHours).toBe(true);
  });

  it('should show unlimited text for unlimited tier hours when selected', async () => {
    render(() => <SubscriptionManagement onBack={noop} />);

    await waitFor(() => {
      expect(mockedGetTiers).toHaveBeenCalledTimes(1);
    });

    // Select the unlimited tier from dropdown
    const select = document.querySelector('.sub-mgmt-select') as HTMLSelectElement;
    if (select) {
      fireEvent.change(select, { target: { value: 'unlimited' } });
    }

    await waitFor(() => {
      // Unlimited tier has monthlySeconds=null, should show "unlimited" in input
      const textInputs = Array.from(document.querySelectorAll('input[type="text"]'));
      const hasUnlimited = textInputs.some((input) => (input as HTMLInputElement).value === 'unlimited');
      expect(hasUnlimited).toBe(true);
    });
  });

  it('can edit sessions field for a tier', async () => {
    render(() => <SubscriptionManagement onBack={noop} />);

    await waitFor(() => {
      expect(screen.getByText('Free')).toBeInTheDocument();
    });

    const numberInputs = Array.from(document.querySelectorAll('input[type="number"]'));
    expect(numberInputs.length).toBeGreaterThan(0);

    // Change free tier sessions from 1 to 5
    const freeSessionsInput = numberInputs[0] as HTMLInputElement;
    fireEvent.input(freeSessionsInput, { target: { value: '5' } });
    expect(freeSessionsInput.value).toBe('5');
  });

  it('can toggle advanced mode checkbox', async () => {
    render(() => <SubscriptionManagement onBack={noop} />);

    await waitFor(() => {
      expect(screen.getByText('Free')).toBeInTheDocument();
    });

    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    expect(checkboxes.length).toBeGreaterThan(0);

    // Free tier does not have advanced mode, so first checkbox should be unchecked
    const freeAdvancedCheckbox = checkboxes[0] as HTMLInputElement;
    expect(freeAdvancedCheckbox.checked).toBe(false);

    fireEvent.change(freeAdvancedCheckbox, { target: { checked: true } });
  });

  it('should call updateTiers API when Save button is clicked', async () => {
    render(() => <SubscriptionManagement onBack={noop} />);

    await waitFor(() => {
      expect(screen.getByText('Free')).toBeInTheDocument();
    });

    const saveButton = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockedUpdateTiers).toHaveBeenCalledTimes(1);
    });
  });

  it('should show success message after save', async () => {
    render(() => <SubscriptionManagement onBack={noop} />);

    await waitFor(() => {
      expect(screen.getByText('Free')).toBeInTheDocument();
    });

    const saveButton = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText(/saved/i)).toBeInTheDocument();
    });
  });

  it('should show error message when save fails', async () => {
    mockedUpdateTiers.mockRejectedValue(new Error('Network error'));

    render(() => <SubscriptionManagement onBack={noop} />);

    await waitFor(() => {
      expect(screen.getByText('Free')).toBeInTheDocument();
    });

    const saveButton = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText(/network error|failed to save/i)).toBeInTheDocument();
    });
  });

  it('should show error message when loading tiers fails', async () => {
    mockedGetTiers.mockRejectedValue(new Error('Failed to load tier config'));

    render(() => <SubscriptionManagement onBack={noop} />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    });
  });

  it('should disable save button while saving', async () => {
    mockedUpdateTiers.mockReturnValue(new Promise(() => {}));

    render(() => <SubscriptionManagement onBack={noop} />);

    await waitFor(() => {
      expect(screen.getByText('Free')).toBeInTheDocument();
    });

    const saveButton = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(saveButton).toBeDisabled();
      expect(saveButton).toHaveTextContent(/saving/i);
    });
  });

  it('should retain dropdown selection after editing a field', async () => {
    render(() => <SubscriptionManagement onBack={noop} />);

    await waitFor(() => {
      expect(screen.getByText('Free')).toBeInTheDocument();
    });

    // Select "Starter" tier from dropdown (use target to set value via testing-library)
    const select = document.querySelector('.sub-mgmt-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'standard' } });

    // Verify the editor now shows Starter's data (40h = 144000s)
    await waitFor(() => {
      const textInputs = Array.from(document.querySelectorAll('input[type="text"]'));
      expect((textInputs[0] as HTMLInputElement).value).toBe('40');
    });

    // Edit the hours field (triggers allTiers signal update via updateField)
    const textInputs = Array.from(document.querySelectorAll('input[type="text"]'));
    fireEvent.change(textInputs[0], { target: { value: '50' } });

    // After editing, the editor should still show Starter's fields (not reset to Free)
    // Check that Max Sessions still reflects Starter's value (1), not Free's value (1)
    // Both happen to be 1 in current config, so also verify the hours field retained edit
    await waitFor(() => {
      const updatedTextInputs = Array.from(document.querySelectorAll('input[type="text"]'));
      expect((updatedTextInputs[0] as HTMLInputElement).value).toBe('50');
    });
  });
});
