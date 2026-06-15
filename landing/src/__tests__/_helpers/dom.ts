/**
 * Test helpers shared by the render tests. Components and pages are rendered to
 * an HTML string via the Astro Container API, then parsed into a real, queryable
 * DOM (happy-dom) so the tests assert STRUCTURE and BEHAVIOUR (element relations,
 * counts, attributes) instead of matching copy strings.
 */
import { Window } from 'happy-dom';

/**
 * Parse rendered HTML into a queryable root element. Accepts both a component
 * fragment (e.g. a single <div class="terminal">…) and a full page document
 * (the <body> inner HTML is extracted first so head boilerplate is ignored).
 */
export function dom(html: string): HTMLElement {
  const win = new Window();
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  win.document.body.innerHTML = bodyMatch ? bodyMatch[1] : html;
  return win.document.body as unknown as HTMLElement;
}

/** Undo Astro's entity escaping, for raw-copy / no-dash invariant checks. */
export function decodeEntities(rendered: string): string {
  return rendered
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
