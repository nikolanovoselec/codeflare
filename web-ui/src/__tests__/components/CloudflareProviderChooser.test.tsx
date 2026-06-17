import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import CloudflareProviderChooser from '../../components/setup/CloudflareProviderChooser';

afterEach(() => cleanup());

const base = {
  clientId: '',
  clientSecret: '',
  clientSecretSet: false,
  onClientIdChange: () => {},
  onClientSecretChange: () => {},
};

describe('CloudflareProviderChooser', () => {
  it('renders the client id + secret pair', () => {
    render(() => <CloudflareProviderChooser {...base} />);
    expect(screen.getByTestId('cloudflare-provider-chooser')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Cloudflare OAuth Client ID')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Cloudflare OAuth Client Secret')).toBeInTheDocument();
  });

  it('routes client id + secret input to their callbacks', () => {
    const onClientIdChange = vi.fn();
    const onClientSecretChange = vi.fn();
    render(() => (
      <CloudflareProviderChooser {...base} onClientIdChange={onClientIdChange} onClientSecretChange={onClientSecretChange} />
    ));
    fireEvent.input(screen.getByPlaceholderText('Cloudflare OAuth Client ID'), { target: { value: 'cid' } });
    expect(onClientIdChange).toHaveBeenCalledWith('cid');
    const secret = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.input(secret, { target: { value: 'sec' } });
    expect(onClientSecretChange).toHaveBeenCalledWith('sec');
  });

  it('drops the unsaved-secret placeholder once a secret is already stored', () => {
    render(() => <CloudflareProviderChooser {...base} clientSecretSet />);
    expect(screen.queryByPlaceholderText('Cloudflare OAuth Client Secret')).not.toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
  });
});
