import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@solidjs/testing-library';
import SetupSection from '../../components/setup/SetupSection';

// Structural contract only: the title/description here are test-supplied props (not
// product copy), so asserting them verifies slot routing, not prose. The point of the
// component is "title + optional description + a body slot for fields", and these tests
// fail if any of those routings break.
describe('SetupSection', () => {
  afterEach(() => cleanup());

  it('routes the title prop into the section header title node', () => {
    render(() => <SetupSection title="Access & Identity"><div /></SetupSection>);
    expect(document.querySelector('.setup-section-title')?.textContent).toBe('Access & Identity');
  });

  it('renders the description node when a description is provided', () => {
    render(() => <SetupSection title="X" description="helper text"><div /></SetupSection>);
    expect(document.querySelector('.setup-section-description')?.textContent).toBe('helper text');
  });

  it('omits the description node entirely when none is provided', () => {
    render(() => <SetupSection title="X"><div /></SetupSection>);
    expect(document.querySelector('.setup-section-description')).toBeNull();
  });

  it('routes children into the section body, never the header', () => {
    render(() => <SetupSection title="X"><span data-testid="field" /></SetupSection>);
    expect(document.querySelector('.setup-section-body [data-testid="field"]')).not.toBeNull();
    expect(document.querySelector('.setup-section-header [data-testid="field"]')).toBeNull();
  });
});
