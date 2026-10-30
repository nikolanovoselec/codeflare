/** @jsxImportSource react */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { getByLabelText, getByRole, getAllByRole, queryByRole } from '@testing-library/dom';
import { encodePromptAnswer, validateQuestionAnswer } from '@blackbelt-technology/pi-dashboard-shared/prompt-answer.js';
import { BatchRenderer } from '../upstream/client/src/components/interactive-renderers/BatchRenderer';
import { ThemeProvider } from '../upstream/client/src/components/settings/ThemeProvider';
import type { InteractiveRendererProps } from '../upstream/client/src/components/interactive-renderers/types';
import { encodeDialogAnswer } from '../upstream/client/src/lib/questions/dialog-answer';

// REQ-AGENT-218 AC7 / REQ-AGENT-219 AC6/7 submitted-answer preservation:
// only the Codeflare opt-in presentation and intentional answer wire contract.
// No donor/SDK regression suite, timer, native-state or draft-sync claims.
const authoredOptions = [
  { label: 'Use the existing path', description: 'Keep the current integration.', preview: '## Proposed change\n\nFirst paragraph.\n\n- Keep the adapter\n- Preserve the boundary\n\n```text\nline one\nline two\n```' },
  { label: 'Cancel this rollout', description: 'An authored choice, not cancellation.' },
  { label: 'Other approach', description: 'An authored choice, not the custom-answer control.' },
];
function question(method: 'select' | 'multiselect' = 'select', title = 'Which integration should we use?', last = true) {
  return {
    method, title, options: ['0', '1', '2'], allowOther: true,
    codeflareQuestionnaire: { header: 'Integration', options: authoredOptions, last },
  };
}
type Question = ReturnType<typeof question>;
let root: Root | undefined;
let container: HTMLDivElement;
let responses: unknown[];
let cancellations: string[];
let props: InteractiveRendererProps;

afterEach(async () => {
  if (root) await act(() => root!.unmount());
  container?.remove(); root = undefined;
});
function render(props: InteractiveRendererProps) {
  // The real Markdown renderer requires the same supplied theme as the embed.
  root!.render(<ThemeProvider value={{ preference: 'dark', resolved: 'dark', themeName: 'base', setPreference() {}, setThemeName() {} }}>
    <BatchRenderer {...props} />
  </ThemeProvider>);
}
async function mount(questions: Question[]) {
  responses = []; cancellations = [];
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  props = {
    requestId: 'owned-questionnaire', method: 'batch', params: { title: 'Plan choices', questions }, status: 'pending',
    onRespond: answer => { responses.push(answer); }, onCancel: () => { cancellations.push('cancelled'); },
  };
  await act(() => render(props));
}
function button(name: string | RegExp) { return getByRole(container, 'button', { name }) as HTMLButtonElement; }
async function click(element: HTMLElement) { await act(() => element.click()); }
async function next() { await click(button('Next →')); }
async function enter(label: string, text: string) {
  const input = getByLabelText(container, label) as HTMLInputElement | HTMLTextAreaElement;
  await act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function other(method: 'select' | 'multiselect') {
  await click(method === 'select' ? button('Other') : getByRole(container, 'checkbox', { name: 'Other' }));
}
async function submit(expectedAnswers: unknown[]) {
  await click(button(/^Submit all/));
  // Exact public wire contract: only stock valid fields plus the owned metadata,
  // never automatic/provenance/authorization claims or a caller-supplied index.
  expect(responses).toEqual([{ answers: expectedAnswers }]);
  const encoded = encodePromptAnswer(responses[0], false)!;
  expect(JSON.parse(encoded)).toEqual(expectedAnswers);
  expect(JSON.parse(encodeDialogAnswer(responses[0]))).toEqual(expectedAnswers);
  // Exercise the existing validator as a public dependency of our new payload,
  // not as a new regression suite for the unchanged SDK.
  expect(validateQuestionAnswer({ type: 'batch', metadata: { questions: props.params.questions } }, encoded)).toEqual({ ok: true });
}

describe('Codeflare opted-in Batch questionnaire', () => {
  it('shows full questions, authored descriptions, header and expandable rich multiline previews', async () => {
    await mount([question()]);
    expect(container.textContent).toContain('Which integration should we use?');
    expect(container.textContent).toContain('Integration');
    expect(container.textContent).toContain('Keep the current integration.');
    const preview = getByRole(container, 'button', { name: 'Preview: Use the existing path' });
    await click(preview);
    expect(getByRole(container, 'heading', { name: 'Proposed change', level: 2 })).toBeVisible();
    expect(getAllByRole(container, 'listitem').map(item => item.textContent)).toEqual(['Keep the adapter', 'Preserve the boundary']);
    expect(container.querySelector('pre')?.textContent).toContain('line one\nline two');
    await click(preview);
    expect(queryByRole(container, 'heading', { name: 'Proposed change' })).toBeNull();
    // Notes are alongside this question, not another wizard step.
    expect(getByLabelText(container, 'Notes (optional)')).toBeVisible();
    expect(container.textContent).toContain('Question 1 of 1');
  });

  it('treats authored cancel/other labels as ordinary single choices and emits exact native indices', async () => {
    await mount([question()]);
    await click(button(/^Other approach/));
    expect(button(/^Other approach/)).toHaveAttribute('aria-pressed', 'true');
    await click(button(/^Cancel this rollout/));
    expect(button(/^Other approach/)).toHaveAttribute('aria-pressed', 'false');
    await next();
    expect(container.textContent).toContain('Cancel this rollout');
    expect(cancellations).toEqual([]);
    await submit([{ value: '1', codeflare: { optionIndexes: [1] } }]);
  });

  it('supports multiple authored choices without label heuristics and retains native index order', async () => {
    await mount([question('multiselect')]);
    await click(getByRole(container, 'checkbox', { name: /Other approach/ }));
    await click(getByRole(container, 'checkbox', { name: /Use the existing path/ }));
    await click(getByRole(container, 'checkbox', { name: /Cancel this rollout/ }));
    await click(getByRole(container, 'checkbox', { name: /Cancel this rollout/ }));
    await next();
    expect(container.textContent).toContain('Use the existing path');
    expect(container.textContent).toContain('Other approach');
    await submit([{ values: ['0', '2'], codeflare: { optionIndexes: [0, 2] } }]);
  });

  it.each(['select', 'multiselect'] as const)('keeps pure %s freeform equal to a token distinct from authored choices', async method => {
    await mount([question(method)]);
    await other(method);
    await enter('Other answer', ' 0 ');
    if (method === 'select') {
      expect(button(/^Use the existing path/)).toHaveAttribute('aria-pressed', 'false');
    } else {
      expect(getByRole(container, 'checkbox', { name: /Use the existing path/ })).not.toBeChecked();
    }
    await next();
    // Review must not mislabel token-shaped custom text as the first option.
    expect(container.textContent).not.toContain('Use the existing path');
    await submit([{ ...(method === 'select' ? { value: '0' } : { values: ['0'] }), codeflare: { optionIndexes: [], text: '0' } }]);
  });

  it('keeps multi choices and token-equal custom text independent through toggle, navigation and review edits', async () => {
    await mount([question('multiselect')]);
    await click(getByRole(container, 'checkbox', { name: /Use the existing path/ }));
    await other('multiselect');
    await enter('Other answer', '0');
    await next();
    await click(button('Edit'));
    expect(getByRole(container, 'checkbox', { name: /Use the existing path/ })).toBeChecked();
    expect(getByLabelText(container, 'Other answer')).toHaveValue('0');
    await click(getByRole(container, 'checkbox', { name: /Use the existing path/ }));
    expect(getByLabelText(container, 'Other answer')).toHaveValue('0');
    expect(getByRole(container, 'checkbox', { name: /Use the existing path/ })).not.toBeChecked();
    await click(getByRole(container, 'checkbox', { name: /Use the existing path/ }));
    await click(getByRole(container, 'checkbox', { name: /Other approach/ }));
    await next();
    await submit([{ values: ['0', '2'], codeflare: { optionIndexes: [0, 2], text: '0' } }]);
  });

  it('supports multi choices plus non-token custom text in the legacy and authoritative fields', async () => {
    await mount([question('multiselect')]);
    await click(getByRole(container, 'checkbox', { name: /Cancel this rollout/ }));
    await other('multiselect'); await enter('Other answer', '  A different plan  ');
    await next();
    await submit([{ values: ['1', 'A different plan'], codeflare: { optionIndexes: [1], text: 'A different plan' } }]);
  });

  it('accepts a multi choice with a blank optional Other draft, and removes unchecked custom text without losing its draft', async () => {
    await mount([question('multiselect')]);
    await click(getByRole(container, 'checkbox', { name: /Use the existing path/ }));
    await other('multiselect'); await enter('Other answer', '   ');
    expect(button('Next →')).not.toBeDisabled();
    await enter('Other answer', 'keep my draft');
    await other('multiselect');
    await next(); await click(button('Edit'));
    await other('multiselect');
    expect(getByLabelText(container, 'Other answer')).toHaveValue('keep my draft');
    await other('multiselect'); await next();
    await submit([{ values: ['0'], codeflare: { optionIndexes: [0] } }]);
  });

  it('switches single choice and Other exclusively while retaining the custom draft', async () => {
    await mount([question()]);
    await other('select'); await enter('Other answer', 'my plan');
    await click(button(/^Use the existing path/));
    expect(queryByRole(container, 'textbox', { name: 'Other answer' })).toBeNull();
    await other('select');
    expect(getByLabelText(container, 'Other answer')).toHaveValue('my plan');
    expect(button(/^Use the existing path/)).toHaveAttribute('aria-pressed', 'false');
    await next();
    await submit([{ value: 'my plan', codeflare: { optionIndexes: [], text: 'my plan' } }]);
  });

  it('preserves exact per-question notes and global note through steps and review edits, attaching global note only to the final entry', async () => {
    await mount([question('select', 'First question', false), question('multiselect', 'Second question')]);
    await click(button(/^Use the existing path/));
    await enter('Notes (optional)', '  first note\nwith details  ');
    await next();
    await other('multiselect'); await enter('Other answer', 'custom');
    await enter('Notes (optional)', 'second note');
    await click(button('← Back'));
    expect(getByLabelText(container, 'Notes (optional)')).toHaveValue('  first note\nwith details  ');
    await next();
    expect(getByLabelText(container, 'Notes (optional)')).toHaveValue('second note');
    await next();
    expect(container.textContent).toContain('first note');
    expect(container.textContent).toContain('second note');
    await enter('Global note (optional)', '  shared note\nall questions  ');
    await click(getAllByRole(container, 'button', { name: 'Edit' })[0]);
    await enter('Notes (optional)', '  revised first\nnote  ');
    await next(); await next();
    expect(getByLabelText(container, 'Global note (optional)')).toHaveValue('  shared note\nall questions  ');
    await submit([
      { value: '0', codeflare: { optionIndexes: [0] }, notes: '  revised first\nnote  ' },
      { values: ['custom'], codeflare: { optionIndexes: [], text: 'custom' }, notes: 'second note', globalNote: '  shared note\nall questions  ' },
    ]);
  });

  it.each(['select', 'multiselect'] as const)('blocks empty and whitespace-only %s answers without losing notes or Other draft', async method => {
    await mount([question(method)]);
    expect(button('Next →')).toBeDisabled();
    await enter('Notes (optional)', 'keep this note');
    await other(method); await enter('Other answer', '   ');
    expect(button('Next →')).toBeDisabled();
    await enter('Other answer', 'unfinished'); await next();
    await click(button('Edit'));
    expect(getByLabelText(container, 'Other answer')).toHaveValue('unfinished');
    expect(getByLabelText(container, 'Notes (optional)')).toHaveValue('keep this note');
    await enter('Other answer', '  ');
    expect(button('Next →')).toBeDisabled();
    expect(getByLabelText(container, 'Other answer')).toHaveValue('  ');
    expect(getByLabelText(container, 'Notes (optional)')).toHaveValue('keep this note');
    expect(responses).toEqual([]);
  });

  it.each(['select', 'multiselect'] as const)('does not let stepper navigation to Review enable incomplete %s submission and retains partial answers and notes', async method => {
    await mount([question(method, 'First question', false), question('select', 'Second question')]);
    await other(method); await enter('Other answer', '   ');
    await enter('Notes (optional)', 'unanswered note');
    await click(button('Second question'));
    await click(button(/^Other approach/)); await next();
    expect(button(/^Submit all/)).toBeDisabled();
    await enter('Global note (optional)', 'keep globally');
    await click(button(/^Submit all/));
    expect(responses).toEqual([]);
    await click(getAllByRole(container, 'button', { name: 'Edit' })[0]);
    expect(getByLabelText(container, 'Notes (optional)')).toHaveValue('unanswered note');
    expect(getByLabelText(container, 'Other answer')).toHaveValue('   ');
    await enter('Other answer', 'finished'); await next();
    expect(button(/^Other approach/)).toHaveAttribute('aria-pressed', 'true');
    await next();
    expect(button(/^Submit all/)).not.toBeDisabled();
    await submit([
      { ...(method === 'select' ? { value: 'finished' } : { values: ['finished'] }), codeflare: { optionIndexes: [], text: 'finished' }, notes: 'unanswered note' },
      { value: '2', codeflare: { optionIndexes: [2] }, globalNote: 'keep globally' },
    ]);
  });

  it('cancels without submitting partial answers, defaults or provenance claims', async () => {
    await mount([question()]);
    await other('select'); await enter('Other answer', 'draft');
    await enter('Notes (optional)', 'not submitted');
    await click(button('Cancel'));
    expect(cancellations).toEqual(['cancelled']);
    expect(responses).toEqual([]);
    await act(() => render({ ...props, status: 'cancelled' }));
    expect(container.textContent).toContain('Cancelled');
    expect(queryByRole(container, 'button', { name: /^Submit all/ })).toBeNull();
  });

  it('uses authored labels and submitted notes in the opted-in resolved summary', async () => {
    await mount([question()]);
    await act(() => render({ ...props, status: 'resolved', result: { answers: [
      { value: '1', codeflare: { optionIndexes: [1] }, notes: 'saved note', globalNote: 'saved global note' },
    ] } }));
    expect(container.textContent).toContain('Cancel this rollout');
    expect(container.textContent).toContain('saved note');
    expect(container.textContent).toContain('saved global note');
    expect(queryByRole(container, 'button', { name: /^Submit all/ })).toBeNull();
  });
});
