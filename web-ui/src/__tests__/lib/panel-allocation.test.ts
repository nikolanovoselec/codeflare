import { describe, it, expect } from 'vitest';
import { decidePanelLayoutMode, naturalPanelHeight } from '../../lib/panel-allocation';

describe('decidePanelLayoutMode', () => {
  const minPanel = 300; // chrome + minRows worth of height for one panel

  it('flips when the column is narrower than the breakpoint', () => {
    expect(decidePanelLayoutMode({ width: 500, height: 1000, minPanelHeight: minPanel })).toBe('flip');
  });

  it('splits at and above the narrow breakpoint when tall enough', () => {
    expect(decidePanelLayoutMode({ width: 600, height: 1000, minPanelHeight: minPanel })).toBe('split');
    expect(decidePanelLayoutMode({ width: 1280, height: 1000, minPanelHeight: minPanel })).toBe('split');
  });

  it('flips on a wide but too-short column that cannot fit two usable panels', () => {
    expect(decidePanelLayoutMode({ width: 1280, height: minPanel * 2 - 1, minPanelHeight: minPanel })).toBe('flip');
  });

  it('splits when exactly two minimum panels fit', () => {
    expect(decidePanelLayoutMode({ width: 1280, height: minPanel * 2, minPanelHeight: minPanel })).toBe('split');
  });

  it('honors a custom narrowWidth (tablet treated as narrow)', () => {
    expect(decidePanelLayoutMode({ width: 700, height: 1000, minPanelHeight: minPanel, narrowWidth: 768 })).toBe('flip');
  });

  it('defaults to split before measurement (zero dimensions never flash flip)', () => {
    expect(decidePanelLayoutMode({ width: 0, height: 0, minPanelHeight: minPanel })).toBe('split');
    expect(decidePanelLayoutMode({ width: 0, height: 100, minPanelHeight: minPanel })).toBe('split');
  });
});

describe('naturalPanelHeight', () => {
  it('is chrome plus rows times row height', () => {
    expect(naturalPanelHeight(120, 5, 52)).toBe(380);
  });

  it('clamps negative row counts to zero rows', () => {
    expect(naturalPanelHeight(120, -3, 52)).toBe(120);
  });

  it('is just the chrome when there are no rows', () => {
    expect(naturalPanelHeight(96, 0, 52)).toBe(96);
  });
});
