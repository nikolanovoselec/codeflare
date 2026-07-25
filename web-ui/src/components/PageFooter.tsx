import { Component } from 'solid-js';
// Owns its own styles so a future caller cannot render it unstyled, and owns
// them in its own file so a caller does not inherit a whole page's rules.
import '../styles/page-footer.css';

/**
 * Footer shared by LoginPage, OnboardingPage and SubscribePage. The markup was
 * identical in all three, so it lives here — one edit changes every page.
 */
const PageFooter: Component = () => (
  <>
    <p class="page-footer">From Switzerland <span class="page-footer-flag" aria-label="Swiss flag">&#127464;&#127469;</span> for <span style={{ color: 'var(--color-brand-cloud)' }}>Region: Earth</span></p>
    <p class="page-footer page-footer-legal"><a href="https://graymatter.ch" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', 'text-decoration': 'none' }}>&copy; 2026 Gray Matter GmbH</a></p>
  </>
);

export default PageFooter;
