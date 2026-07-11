/**
 * Behavioral tests for the Browser IDE band (REQ-LANDING-007). Rendered via the
 * Astro Container API into a real DOM; the assertions check STRUCTURE, slot
 * routing, and the reel/resting-state CONTRACT the page + feature-terminals.ts
 * rely on — never the prose copy. Contract values (file name, folder, the stream
 * array, the status segments) are read from the content model, not pinned.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import CodeEditor from '../components/CodeEditor.astro';
import { dom } from './_helpers/dom';
import { IDE } from '../content/site';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

async function render() {
  return dom(await container.renderToString(CodeEditor)).querySelector('.terminal.code-editor')!;
}

describe('CodeEditor (Browser IDE band, REQ-LANDING-007)', () => {
  it('renders the VS Code chrome on the shared terminal frame with the editor tab + modified dot', async () => {
    const el = await render();
    expect(el).not.toBeNull();
    // reuses the shared <Terminal> frame (traffic-light dots) rather than a bespoke box
    expect(el.querySelectorAll('.terminal-bar .terminal-dots span')).toHaveLength(3);
    const activeTab = el.querySelector('.ce-tab.is-active')!;
    expect(activeTab).not.toBeNull();
    expect(activeTab.textContent).toContain(IDE.file);
    expect(activeTab.querySelector('.ce-dot')).not.toBeNull(); // unsaved-file dot
    expect(el.querySelector('.ce-tab.is-dim')?.textContent).toBe(IDE.fileAlt);
    expect(el.querySelector('.ce-folder')?.textContent).toBe(IDE.folder);
  });

  it('renders one line-numbered code row per source line', async () => {
    const el = await render();
    const lines = el.querySelectorAll('.ce-code .ce-codeline');
    expect(lines).toHaveLength(IDE.code.length);
    // gutter numbers come from a CSS counter, so nothing is hardcoded in the DOM text
    expect(el.querySelector('.ce-code')?.tagName.toLowerCase()).toBe('ol');
  });

  it('wires the integrated terminal to the shared reel: data-ft-loop + data-ft-shuffle on the frame, one data-ft-typed line resting on the first beat', async () => {
    const el = await render();
    // feature-terminals.ts drives ANY [data-ft-loop] element with a [data-ft-typed] child
    expect(JSON.parse(el.getAttribute('data-ft-loop')!)).toEqual(IDE.stream);
    expect(el.hasAttribute('data-ft-shuffle')).toBe(true);
    const typed = el.querySelectorAll('.ce-term .t-cmd .ft-typed[data-ft-typed]');
    expect(typed).toHaveLength(1);
    // resting state = first beat: no-JS / reduced motion shows a real line, not blank
    expect(typed[0].textContent).toBe(IDE.stream[0]);
    expect(el.querySelector('.ce-term .t-cmd .t-caret')).not.toBeNull();
  });

  it('renders the editor status bar with the branch and caret-position segments', async () => {
    const el = await render();
    const status = el.querySelector('.terminal-foot.ce-status')!;
    expect(status).not.toBeNull();
    expect(status.querySelector('.ce-branch')?.textContent).toContain(IDE.status.branch);
    expect(status.querySelector('.ce-branch .ce-branch-icon')).not.toBeNull();
    expect(status.querySelector('.ce-ci .ce-ci-dot')).not.toBeNull();
    expect(status.querySelector('.ce-pos')?.textContent).toBe(IDE.status.pos);
    // it is the custom foot slot, not the default prose-caption foot
    expect(el.querySelector('.terminal-foot.tf-static')).toBeNull();
  });
});
