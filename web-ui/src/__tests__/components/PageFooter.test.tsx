import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@solidjs/testing-library';
import PageFooter from '../../components/PageFooter';

afterEach(cleanup);

// PageFooter was extracted from three byte-identical copies in LoginPage,
// OnboardingPage and SubscribePage. These assertions are the migration oracle:
// they pin structure and contract values (classes, href, rel, target), never
// the copy, so a wording change stays green while a broken extraction fails.
describe('PageFooter', () => {
  it('renders both footer paragraphs, only the second marked legal', () => {
    const { container } = render(() => <PageFooter />);

    const footers = container.querySelectorAll('.login-footer');
    expect(footers.length).toBe(2);
    expect(footers[0].classList.contains('login-footer-legal')).toBe(false);
    expect(footers[1].classList.contains('login-footer-legal')).toBe(true);
  });

  it('renders the flag element with an accessible label', () => {
    const { container } = render(() => <PageFooter />);

    const flag = container.querySelector('.login-footer-flag');
    expect(flag).not.toBeNull();
    expect(flag?.getAttribute('aria-label')).toBe('Swiss flag');
  });

  it('links to the company site with a safe external-link contract', () => {
    const { container } = render(() => <PageFooter />);

    const link = container.querySelector<HTMLAnchorElement>('.login-footer-legal a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://graymatter.ch');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
