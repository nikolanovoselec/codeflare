import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import PiWebChat from '../../components/PiWebChat';

const SESSION_ID = 'abcdef1234567890';
const GENERATION = 7;
const SCOPE = `/api/pi-web/${SESSION_ID}/g/${GENERATION}/`;
const CHAT_URL = `${SCOPE}?project=project-a&workspace=workspace-a&session=native-pi-a&view=chat`;
const STOPPING = 'Stopping the current turn…';
const active = { phase: 'active' as const, surface: 'chat' as const, chatUrl: CHAT_URL };
const waiting = { ...active, phase: 'waiting' as const };
const stopping = { ...active, phase: 'stopping' as const };
const cancelled = { ...active, phase: 'cancelled' as const };
const releasing = { ...active, phase: 'releasing' as const };
const opening = { phase: 'opening' as const, surface: null };

function chatFrame(): HTMLIFrameElement {
  const frame = screen.getByTitle(/chat/i);
  if (!(frame instanceof HTMLIFrameElement)) throw new Error('The stock Chat view needs its own titled frame');
  return frame;
}

describe('Pi web Chat wrapper (REQ-AGENT-272)', () => {
  it('REQ-AGENT-272 AC4: embeds the bound stock Chat deep link in the same-origin Codeflare session scope', () => {
    render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={active} onTerminal={() => {}} onCancel={() => {}} />);

    const frame = chatFrame();
    const location = new URL(frame.src);
    expect(location.origin).toBe(window.location.origin);
    expect(location.pathname).toBe(SCOPE);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      project: 'project-a', workspace: 'workspace-a', session: 'native-pi-a', view: 'chat',
    });
    expect(frame).toBeVisible();
    expect(screen.getByRole('button', { name: /terminal/i })).toBeVisible();
  });

  it('reloads the same opening Chat frame without switching writers', async () => {
    const onTerminal = () => { throw new Error('Reload must not switch surfaces'); };
    const onRetry = () => { throw new Error('Reload must not dispatch a handoff'); };
    const [status, setStatus] = createSignal<typeof active | (typeof opening & { target: 'chat'; chatUrl: string })>(
      { ...opening, target: 'chat', chatUrl: CHAT_URL });
    render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={status()}
      onTerminal={onTerminal} onCancel={() => {}} onRetry={onRetry} />);
    const failedFrame = chatFrame();
    await fireEvent.click(screen.getByRole('button', { name: 'Reload Chat' }));
    expect(failedFrame).not.toBeInTheDocument();
    expect(chatFrame().src).toBe(failedFrame.src);
    expect(chatFrame()).toBeVisible();
    setStatus(active);
    expect(screen.queryByRole('button', { name: 'Reload Chat' })).not.toBeInTheDocument();
  });

  it('REQ-AGENT-272 AC3: announces automatic stop without replacing the source frame', async () => {
    const [status, setStatus] = createSignal<typeof active | typeof waiting | typeof stopping>(active);
    render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={status()}
      onTerminal={() => setStatus(waiting)} onCancel={() => {}} />);
    const source = chatFrame();
    const sourceUrl = source.src;
    const switchButton = screen.getByRole('button', { name: 'Switch to Terminal' });
    expect(screen.queryByText(STOPPING, { exact: true })).not.toBeInTheDocument();
    expect(switchButton).toBeEnabled();

    const expectStoppingInPlace = () => {
      const announced = screen.getByRole('status');
      expect(announced.textContent).toBe(STOPPING);
      expect(announced).toBeVisible();
      expect(chatFrame()).toBe(source);
      expect(source.src).toBe(sourceUrl);
      expect(source).toBeVisible();
      expect(screen.getByRole('button', { name: 'Switch to Terminal' })).toBeDisabled();
    };
    await fireEvent.click(switchButton);
    expectStoppingInPlace();
    setStatus(stopping);
    expectStoppingInPlace();
  });

  it('REQ-AGENT-272 AC7: mounts the known stock row during startup without admitting another switch', () => {
    render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION}
      status={{ phase: 'opening', target: 'chat', surface: null, chatUrl: CHAT_URL }}
      onTerminal={() => { throw new Error('Cannot switch during destination startup'); }} onCancel={() => {}} />);
    expect(chatFrame()).toBeVisible();
    expect(new URL(chatFrame().src).searchParams.get('session')).toBe('native-pi-a');
    expect(screen.getByRole('button', { name: /terminal/i })).toBeDisabled();
  });

  it('REQ-AGENT-272 AC6: offers Cancel switch only before Abort is committed', async () => {
    const [status, setStatus] = createSignal<typeof waiting | typeof cancelled | typeof stopping | typeof releasing | typeof opening>(waiting);
    render(() => <PiWebChat sessionId={SESSION_ID} generation={GENERATION} status={status()}
      onTerminal={() => setStatus(waiting)} onCancel={() => setStatus(cancelled)} />);
    const source = chatFrame();
    const cancel = screen.getByRole('button', { name: 'Cancel switch' });
    expect(cancel).toBeEnabled();

    await fireEvent.click(cancel);
    expect(screen.queryByText(STOPPING, { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel switch' })).not.toBeInTheDocument();
    expect(chatFrame()).toBe(source);
    expect(source).toBeVisible();

    await fireEvent.click(screen.getByRole('button', { name: 'Switch to Terminal' }));
    expect(screen.getByRole('button', { name: 'Cancel switch' })).toBeEnabled();
    setStatus(stopping);
    expect(screen.queryByRole('button', { name: 'Cancel switch' })).not.toBeInTheDocument();
    for (const phase of [releasing, opening]) {
      setStatus(phase);
      expect(screen.queryByRole('button', { name: 'Cancel switch' })).not.toBeInTheDocument();
      expect(screen.queryByText(STOPPING, { exact: true })).not.toBeInTheDocument();
    }
  });
});

it('REQ-AGENT-272 AC5: never mounts an old, foreign, or malformed Chat frame for the current generation', () => {
  const [status, setStatus] = createSignal(active);
  const [generation, setGeneration] = createSignal(GENERATION);
  render(() => <PiWebChat sessionId={SESSION_ID} generation={generation()} status={status()}
    onTerminal={() => {}} onCancel={() => {}} />);
  expect(chatFrame()).toBeVisible();
  setGeneration(GENERATION + 1);
  expect(screen.queryByTitle('Pi Chat')).not.toBeInTheDocument();
  expect(screen.getByText('Chat could not be opened.')).toBeVisible();
  const matching = CHAT_URL.replace('/g/7/', '/g/8/');
  for (const chatUrl of [`https://other.example${matching}`, `/unrelated${matching}`, 'http://[invalid']) {
    setStatus({ ...active, chatUrl });
    expect(screen.queryByTitle('Pi Chat')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Terminal' })).toBeDisabled();
  }
  setStatus({ ...active, chatUrl: matching });
  expect(new URL(chatFrame().src).pathname).toBe(`/api/pi-web/${SESSION_ID}/g/8/`);
});

it('offers the existing retry action without presenting an unconfirmed Chat writer', async () => {
  const [retried, setRetried] = createSignal(false);
  render(() => <><PiWebChat sessionId={SESSION_ID} generation={GENERATION}
    status={{ phase: 'failed', surface: null, target: 'chat', chatUrl: CHAT_URL }}
    problem="Chat startup did not settle." onTerminal={() => {}} onCancel={() => {}} onRetry={() => setRetried(true)} />
    {retried() && <output>Retry requested</output>}</>);
  expect(screen.queryByTitle('Pi Chat')).not.toBeInTheDocument();
  expect(screen.getByText('Chat startup did not settle.')).toBeVisible();
  await fireEvent.click(screen.getByRole('button', { name: 'Retry switch' }));
  expect(screen.getByText('Retry requested')).toBeVisible();
});
