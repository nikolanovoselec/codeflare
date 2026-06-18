import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import TerminalGrid from '../../components/TerminalGrid';

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
});
