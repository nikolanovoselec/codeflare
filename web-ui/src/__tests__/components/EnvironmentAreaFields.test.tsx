import { cleanup, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import EnvironmentAreaFields from '../../components/admin/EnvironmentAreaFields';

afterEach(cleanup);

describe('Environment report fields', () => {
  it('REQ-SETUP-020 AC1: renders canonical IANA timezone choices as a select', () => {
    const { getByLabelText } = render(() => (
      <EnvironmentAreaFields
        section="usageReports"
        mode="enterprise"
        current={{ enabled: true, recipients: [], day: 1, hour: 9, timezone: 'Europe/Zurich' }}
      />
    ));

    const timezone = getByLabelText('IANA timezone') as HTMLSelectElement;
    expect(timezone.tagName).toBe('SELECT');
    expect(timezone.value).toBe('Europe/Zurich');
    expect(Array.from(timezone.options, (option) => option.value)).toContain('UTC');
  });

  it('REQ-SETUP-020 AC2: retains an accepted stored timezone outside bundled choices', () => {
    const { getByLabelText } = render(() => (
      <EnvironmentAreaFields
        section="usageReports"
        mode="enterprise"
        current={{ enabled: true, recipients: [], day: 1, hour: 9, timezone: 'Etc/GMT+1' }}
      />
    ));

    const timezone = getByLabelText('IANA timezone') as HTMLSelectElement;
    expect(timezone.value).toBe('Etc/GMT+1');
    expect(Array.from(timezone.options, (option) => option.value)[0]).toBe('Etc/GMT+1');
  });
});
