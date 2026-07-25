import { Component } from 'solid-js';

/**
 * Footer shared by LoginPage, OnboardingPage and SubscribePage. The markup was
 * identical in all three, so it lives here — one edit changes every page.
 */
const PageFooter: Component = () => (
  <>
    <p class="login-footer">From Switzerland <span class="login-footer-flag" aria-label="Swiss flag">&#127464;&#127469;</span> for <span style={{ color: 'var(--color-brand-cloud)' }}>Region: Earth</span></p>
    <p class="login-footer login-footer-legal"><a href="https://graymatter.ch" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', 'text-decoration': 'none' }}>&copy; 2026 Gray Matter GmbH</a></p>
  </>
);

export default PageFooter;
