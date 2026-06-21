import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { render, screen, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';
import TerminalGrid from '../../components/TerminalGrid';

// REQ-TERM-017: MultiView Pane Focus and Input Routing
describe('TerminalGrid reusable pane layout', () => {
  afterEach(() => cleanup());

  it('REQ-TERM-007: renders the requested layout slots and routes pane clicks', () => {
    const onPaneClick = vi.fn();
    const panes = [
      { id: 'pane-a', data: { label: 'A' }, active: false },
      { id: 'pane-b', data: { label: 'B' }, active: true },
    ];

    render(() => (
      <TerminalGrid
        layout="2-split"
        panes={panes}
        onPaneClick={onPaneClick}
        renderPane={(pane) => <div data-testid={`pane-content-${pane.id}`}>{pane.data.label}</div>}
      />
    ));

    expect(screen.getByTestId('terminal-grid')).toHaveAttribute('data-layout', '2-split');
    expect(screen.getByTestId('terminal-grid-slot-pane-a')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('terminal-grid-slot-pane-b')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('pane-content-pane-a')).toBeInTheDocument();
    expect(screen.getByTestId('pane-content-pane-b')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('terminal-grid-slot-pane-a'));
    expect(onPaneClick).toHaveBeenCalledWith('pane-a');
  });

  it('REQ-TERM-012: leaves hidden sessions unrendered when they are not grid panes', () => {
    render(() => (
      <TerminalGrid
        layout="4-grid"
        panes={[{ id: 'pane-a', data: { sessionId: 'session-a' }, active: true }]}
        onPaneClick={vi.fn()}
        renderPane={(pane) => <div data-testid={`session-${pane.data.sessionId}`} />}
      />
    ));

    expect(screen.getByTestId('session-session-a')).toBeInTheDocument();
    expect(screen.queryByTestId('session-session-b')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-grid-empty-1')).toHaveAttribute('data-active', 'false');
  });

  it('REQ-TERM-012: updates pane state without disposing stable pane ids', async () => {
    const [panes, setPanes] = createSignal([
      { id: 'pane-a', data: { label: 'A' }, active: true },
      { id: 'pane-b', data: { label: 'B' }, active: false },
    ]);
    const disposed: string[] = [];
    const PaneProbe = (props: { id: string; active: boolean }) => {
      onCleanup(() => disposed.push(props.id));
      return <div data-testid={`pane-content-${props.id}`} data-active={String(props.active)} />;
    };

    render(() => (
      <TerminalGrid
        layout="2-split"
        panes={panes()}
        onPaneClick={vi.fn()}
        renderPane={(pane) => <PaneProbe id={pane.id} active={pane.active} />}
      />
    ));

    expect(screen.getByTestId('pane-content-pane-a')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('pane-content-pane-b')).toHaveAttribute('data-active', 'false');

    setPanes([
      { id: 'pane-a', data: { label: 'A' }, active: false },
      { id: 'pane-b', data: { label: 'B' }, active: true },
    ]);

    await waitFor(() => expect(screen.getByTestId('pane-content-pane-b')).toHaveAttribute('data-active', 'true'));
    expect(screen.getByTestId('pane-content-pane-a')).toHaveAttribute('data-active', 'false');
    expect(disposed).toEqual([]);
  });

  it('REQ-TERM-012: clearing panes during a transition renders empty slots without dereferencing stale pane data', async () => {
    const [panes, setPanes] = createSignal([
      { id: 'pane-a', data: { sessionId: 'session-a' }, active: true },
      { id: 'pane-b', data: { sessionId: 'session-b' }, active: false },
    ]);

    render(() => (
      <TerminalGrid
        layout="2-split"
        panes={panes()}
        onPaneClick={vi.fn()}
        renderPane={(pane) => <div data-testid={`session-${pane.data.sessionId}`} />}
      />
    ));

    expect(screen.getByTestId('session-session-a')).toBeInTheDocument();
    expect(screen.getByTestId('session-session-b')).toBeInTheDocument();

    expect(() => setPanes([])).not.toThrow();

    await waitFor(() => expect(screen.queryByTestId('session-session-a')).not.toBeInTheDocument());
    expect(screen.queryByTestId('session-session-b')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-grid-empty-0')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('terminal-grid-empty-1')).toHaveAttribute('data-active', 'false');
  });

  it('REQ-TERM-011: disposes the old pane subtree when a slot receives a different pane id', async () => {
    const [panes, setPanes] = createSignal([{ id: 'pane-a', data: { label: 'A' }, active: true }]);
    const mounted: string[] = [];
    const disposed: string[] = [];
    const PaneProbe = (props: { id: string }) => {
      onMount(() => mounted.push(props.id));
      onCleanup(() => disposed.push(props.id));
      return <div data-testid={`pane-content-${props.id}`} />;
    };

    render(() => (
      <TerminalGrid
        layout="2-split"
        panes={panes()}
        onPaneClick={vi.fn()}
        renderPane={(pane) => <PaneProbe id={pane.id} />}
      />
    ));

    expect(screen.getByTestId('pane-content-pane-a')).toBeInTheDocument();

    setPanes([{ id: 'pane-b', data: { label: 'B' }, active: true }]);

    await waitFor(() => expect(screen.getByTestId('pane-content-pane-b')).toBeInTheDocument());
    expect(screen.queryByTestId('pane-content-pane-a')).not.toBeInTheDocument();
    expect(mounted).toEqual(['pane-a', 'pane-b']);
    expect(disposed).toEqual(['pane-a']);
  });
});
