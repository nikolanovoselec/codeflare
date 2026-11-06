import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import McpPortalSettings from '../../../components/admin/McpPortalSettings';
import type { McpPortal } from '../../../types';

vi.mock('../../../api/client', () => ({ getMcpPortals: vi.fn(), saveMcpPortals: vi.fn() }));
import { getMcpPortals, saveMcpPortals } from '../../../api/client';
const get = vi.mocked(getMcpPortals);
const save = vi.mocked(saveMcpPortals);
let stored: McpPortal[];
const github = { name: 'github', url: 'https://api.githubcopilot.com/mcp/' };
const cloudflare = { name: 'codeflare_enterprise', url: 'https://portal.example.com/mcp?codemode=search_and_execute' };
const input = (label: string, value: string) => fireEvent.input(screen.getByRole('textbox', { name: label }), { target: { value } });
const submit = () => fireEvent.submit(screen.getByRole('button', { name: 'Save portals' }).closest('form')!);

beforeEach(() => {
  vi.resetAllMocks();
  stored = [github];
  get.mockImplementation(async () => structuredClone(stored));
  save.mockImplementation(async (rows) => { stored = structuredClone(rows); return structuredClone(stored); });
});
afterEach(cleanup);

describe('MCP portal administration', () => {
  it('REQ-AGENT-227 AC1: administrators manage multiple named portal URLs', async () => {
    render(() => <McpPortalSettings />);
    await screen.findByDisplayValue(github.url);
    fireEvent.click(screen.getByRole('button', { name: 'Add portal' }));
    input('Name 2', cloudflare.name);
    input('URL 2', cloudflare.url);
    input('URL 1', 'https://api.githubcopilot.com/mcp/');
    submit();
    await screen.findByText(/MCP portals saved/);
    expect(stored).toEqual([github, cloudflare]);
    cleanup();
    render(() => <McpPortalSettings />);
    await screen.findByDisplayValue(cloudflare.url);
    expect(screen.getByRole('textbox', { name: 'Name 1' })).toHaveValue('github');
    fireEvent.click(screen.getByRole('button', { name: 'Remove portal 1' }));
    submit();
    await screen.findByText(/MCP portals saved/);
    expect(stored).toEqual([cloudflare]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove portal 1' }));
    submit();
    await screen.findByText(/MCP portals saved/);
    expect(stored).toEqual([]);
  });

  it('REQ-AGENT-227 AC1: load validation save errors and saved feedback remain accessible', async () => {
    let finishLoad!: (rows: McpPortal[]) => void;
    get.mockReturnValueOnce(new Promise((resolve) => { finishLoad = resolve; }));
    render(() => <McpPortalSettings />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading MCP portals');
    expect(screen.getByRole('button', { name: 'Add portal' })).toBeDisabled();
    finishLoad([github]);
    await screen.findByDisplayValue(github.url);
    input('URL 1', 'http://portal.example.com/mcp');
    save.mockRejectedValueOnce(new Error('Use an HTTPS URL without credentials.'));
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Use an HTTPS URL without credentials.');
    expect(screen.getByRole('textbox', { name: 'URL 1' })).toHaveValue('http://portal.example.com/mcp');
    input('URL 1', cloudflare.url);
    save.mockRejectedValueOnce(new Error('Configuration could not be saved.'));
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Configuration could not be saved.');
    expect(screen.getByRole('textbox', { name: 'URL 1' })).toHaveValue(cloudflare.url);
    let finishSave!: (rows: McpPortal[]) => void;
    save.mockReturnValueOnce(new Promise((resolve) => { finishSave = resolve; }));
    submit();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'URL 1' })).toBeDisabled();
    finishSave([{ name: 'github', url: cloudflare.url }]);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('MCP portals saved'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'URL 1' })).toHaveValue(cloudflare.url);
  });

  it('REQ-AGENT-227 AC1: a failed load cannot overwrite unseen configuration', async () => {
    get.mockRejectedValueOnce(new Error('Unavailable'));
    render(() => <McpPortalSettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent('MCP portals could not be loaded');
    expect(screen.getByRole('button', { name: 'Save portals' })).toBeDisabled();
    expect(stored).toEqual([github]);
  });
});
