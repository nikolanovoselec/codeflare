import { describe, it, expect } from 'vitest';
import { decidePanelLayoutMode } from '../../lib/panel-allocation';

// Adaptive GitHub/Storage panel split — split vs single-panel flip.
// `width` is the VIEWPORT width (mobile breakpoint, matches the CSS flip);
// `height` is the right column's own height (too-short check). The decision must
// NOT use the right column's measured width — capped small by the layout, it
// wrongly flipped every tablet/laptop (the regression these cases pin).
describe('decidePanelLayoutMode', () => {
  it('flips when the viewport is narrower than the mobile breakpoint', () => {
    expect(decidePanelLayoutMode({ width: 599, height: 1000 })).toBe('flip');
    expect(decidePanelLayoutMode({ width: 375, height: 800 })).toBe('flip');
  });

  it('splits on tablet/laptop viewports tall enough for two panels (regression: these used to flip)', () => {
    expect(decidePanelLayoutMode({ width: 600, height: 1000 })).toBe('split');
    expect(decidePanelLayoutMode({ width: 768, height: 700 })).toBe('split');   // portrait tablet
    expect(decidePanelLayoutMode({ width: 1024, height: 800 })).toBe('split');  // laptop
    expect(decidePanelLayoutMode({ width: 1920, height: 1080 })).toBe('split');
  });

  it('flips a wide viewport when the column is shorter than the split floor', () => {
    expect(decidePanelLayoutMode({ width: 1280, height: 599 })).toBe('flip');
  });

  it('splits at the exact too-short boundary (600)', () => {
    expect(decidePanelLayoutMode({ width: 1280, height: 600 })).toBe('split');
  });

  it('honors a custom minSplitHeight', () => {
    expect(decidePanelLayoutMode({ width: 1280, height: 500, minSplitHeight: 600 })).toBe('flip');
  });

  it('honors a custom narrowWidth', () => {
    expect(decidePanelLayoutMode({ width: 700, height: 1000, narrowWidth: 768 })).toBe('flip');
  });

  it('defaults to split before measurement (zero dimensions never flash flip)', () => {
    expect(decidePanelLayoutMode({ width: 0, height: 0 })).toBe('split');
    expect(decidePanelLayoutMode({ width: 0, height: 100 })).toBe('split');
    expect(decidePanelLayoutMode({ width: 800, height: 0 })).toBe('split');
  });
});
