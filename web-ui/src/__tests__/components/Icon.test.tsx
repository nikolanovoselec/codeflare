import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@solidjs/testing-library';
import { mdiPlay, mdiStop } from '@mdi/js';
import Icon from '../../components/Icon';

describe('Icon', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders an SVG with the correct path', () => {
    const { container } = render(() => <Icon path={mdiPlay} />);

    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();

    const path = svg?.querySelector('path');
    expect(path).toBeInTheDocument();
    expect(path?.getAttribute('d')).toBe(mdiPlay);
  });

  it('defaults to size 24', () => {
    const { container } = render(() => <Icon path={mdiPlay} />);

    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('24');
    expect(svg?.getAttribute('height')).toBe('24');
  });

  it('accepts a custom size', () => {
    const { container } = render(() => <Icon path={mdiPlay} size={16} />);

    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.getAttribute('height')).toBe('16');
  });

  it('applies custom class', () => {
    const { container } = render(() => <Icon path={mdiPlay} class="my-icon" />);

    const svg = container.querySelector('svg');
    expect(svg?.classList.contains('my-icon')).toBe(true);
  });

  it('uses viewBox 0 0 24 24 for MDI icons', () => {
    const { container } = render(() => <Icon path={mdiPlay} />);

    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('renders different icon paths correctly', () => {
    const { container: c1 } = render(() => <Icon path={mdiPlay} />);
    const { container: c2 } = render(() => <Icon path={mdiStop} />);

    const path1 = c1.querySelector('path')?.getAttribute('d');
    const path2 = c2.querySelector('path')?.getAttribute('d');

    expect(path1).toBe(mdiPlay);
    expect(path2).toBe(mdiStop);
    expect(path1).not.toBe(path2);
  });
});
