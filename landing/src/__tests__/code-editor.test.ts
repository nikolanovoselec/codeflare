/**
 * Behavioral tests for the Browser IDE band (REQ-LANDING-007). Rendered via the
 * Astro Container API into a real DOM; the assertions check STRUCTURE, slot
 * routing, and the reel/resting-state CONTRACT the page + feature-terminals.ts
 * rely on — never the prose copy. Contract values (file name, folder, the file
 * tree, the stream array, the status segments) are read from the content model,
 * not pinned. Gut-check: gutting the rail, the explorer, the code pane, or the
 * integrated terminal each fails a test here.
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

  it('renders the full workbench: activity rail with an active item and the source-control change badge', async () => {
    const el = await render();
    expect(el.querySelector('.ce-workbench')).not.toBeNull();
    const rail = el.querySelector('.ce-rail')!;
    expect(rail).not.toBeNull();
    // the five workbench icons (Explorer / Search / SCM / Run / Extensions)
    expect(rail.querySelectorAll('.ce-rail-btn')).toHaveLength(5);
    expect(rail.querySelectorAll('.ce-rail-btn.is-active')).toHaveLength(1);
    // the source-control badge carries the modified-file count from the model
    expect(rail.querySelector('.ce-rail-scm .ce-rail-badge')?.textContent).toBe(String(IDE.changes));
  });

  it('renders the explorer file tree with one row per model node and the open file selected', async () => {
    const el = await render();
    const nodes = el.querySelectorAll('.ce-explorer .ce-tree .ce-node');
    expect(nodes).toHaveLength(IDE.explorer.length);
    // the workspace root row is the folder name
    expect(el.querySelector('.ce-node.is-root .ce-node-label')?.textContent).toBe(IDE.folder);
    // exactly one row is the active/open file, and it is the file the tab shows
    const active = el.querySelectorAll('.ce-node.is-active');
    expect(active).toHaveLength(1);
    expect(active[0].querySelector('.ce-node-label')?.textContent).toBe(IDE.file);
  });

  it('renders one line-numbered code row per source line', async () => {
    const el = await render();
    const lines = el.querySelectorAll('.ce-main .ce-code .ce-codeline');
    expect(lines).toHaveLength(IDE.code.length);
    // gutter numbers come from a CSS counter, so nothing is hardcoded in the DOM text
    expect(el.querySelector('.ce-code')?.tagName.toLowerCase()).toBe('ol');
  });

  it('wires the integrated terminal to the shared reel: data-ft-loop + data-ft-shuffle on the frame, resting log lines, one data-ft-typed line on the first beat', async () => {
    const el = await render();
    // feature-terminals.ts drives ANY [data-ft-loop] element with a [data-ft-typed] child
    expect(JSON.parse(el.getAttribute('data-ft-loop')!)).toEqual(IDE.stream);
    expect(el.hasAttribute('data-ft-shuffle')).toBe(true);
    // calm resting output above the live command line (one row per model log line)
    expect(el.querySelectorAll('.ce-term .ce-term-body .t-line.t-dim')).toHaveLength(IDE.termLog.length);
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
