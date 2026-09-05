import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import EnvironmentAreaFields from '../../components/admin/EnvironmentAreaFields';

const current = {
  gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway',
  dynamicRoutes: ['mesh'],
  defaultRoute: { route: 'mesh', reasoning: 'medium' },
  routeContextWindows: { mesh: 262144 },
  reasoningCatalog: {
    profiles: [{ id: 'codeflare-inference-mesh-binary-thinking', revision: 1, name: 'Mesh binary thinking', supportedLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }],
    notices: [{ id: 'gpt-oss-tool-replay', name: 'GPT-OSS tool replay', assignable: false }],
  },
  reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} },
  groupRouting: [],
};

afterEach(cleanup);

describe('REQ-ENTERPRISE-031 typed custom profile workflow', () => {
  it('creates mappings with typed scalar rows and aliases without an editable JSON field', async () => {
    const { getByRole, getByLabelText, queryByRole } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await fireEvent.click(getByRole('button', { name: /create custom profile/i }));
    expect(getByLabelText('Profile name')).toBeTruthy();
    expect(getByLabelText('Supported reasoning levels')).toBeTruthy();
    expect(getByRole('button', { name: /add mapping row/i })).toBeTruthy();
    expect(getByLabelText('Mapping value type')).toBeTruthy();
    expect(getByRole('button', { name: /alias reasoning level/i })).toBeTruthy();
    expect(queryByRole('textbox', { name: /json/i })).toBeNull();
  });

  it('shows off semantics, limitations, immutable provenance, and a read-only wire preview', async () => {
    const { getByRole, getByText, getByLabelText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await fireEvent.click(getByRole('button', { name: /create custom profile/i }));
    expect(getByLabelText('Off semantics')).toBeTruthy();
    expect(getByText(/immutable revision/i)).toBeTruthy();
    expect(getByText(/limitations/i)).toBeTruthy();
    expect(getByLabelText('Normalized wire preview')).toHaveAttribute('readonly');
  });

  it('renders failed families as non-assignable compatibility notices', () => {
    const { getByText, queryByRole } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    expect(getByText('GPT-OSS tool replay')).toBeTruthy();
    expect(queryByRole('option', { name: 'GPT-OSS tool replay' })).toBeNull();
  });
});
