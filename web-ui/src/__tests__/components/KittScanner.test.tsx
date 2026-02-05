import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@solidjs/testing-library';
import KittScanner from '../../components/KittScanner';

describe('KittScanner', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the kitt-scanner container', () => {
    const { container } = render(() => <KittScanner />);

    const scanner = container.querySelector('.kitt-scanner');
    expect(scanner).toBeInTheDocument();
  });

  it('renders the kitt-beam element inside the scanner', () => {
    const { container } = render(() => <KittScanner />);

    const beam = container.querySelector('.kitt-beam');
    expect(beam).toBeInTheDocument();
    expect(beam?.parentElement?.classList.contains('kitt-scanner')).toBe(true);
  });
});
