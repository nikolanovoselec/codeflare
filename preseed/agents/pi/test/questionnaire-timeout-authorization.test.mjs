import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import authorizationPolicy from '../extensions/questionnaire-timeout-authorization.ts';

// Exercise the installed extension's public tool_result boundary, not its
// private helpers. Pi documents omitted patch fields as retaining their values.
const handlers = new Map();
authorizationPolicy({ on: (event, handler) => handlers.set(event, handler) });
const denial = 'Automatic questionnaire timeout after five minutes, not a user response or authorization.';
function fixture(multiSelect = false) {
  const label = 'Small change (Recommended)';
  const question = { question: 'Which implementation?', header: 'Approach', multiSelect,
    options: [{ label, description: 'Preserve ownership.', preview: 'Existing design' },
      { label: 'Alternative', description: 'Different approach.' }] };
  return { type: 'tool_result', toolName: 'ask_user_question', toolCallId: 'fixture', isError: false,
    input: { questions: [question] },
    content: [{ type: 'text', text: denial + '\nRetained questionnaire notes.' },
      { type: 'image', mimeType: 'image/png', data: 'AA==' }],
    details: { automatic: true, cancelled: false, globalNote: 'Keep this note.', answers: [{
      questionIndex: 0, question: question.question, automatic: true,
      kind: multiSelect ? 'multi' : 'option', answer: multiSelect ? null : label,
      ...(multiSelect ? { selected: [label] } : {}), note: 'Keep this answer note.',
    }] } };
}
async function deliver(event) {
  const before = structuredClone(event);
  const patch = await handlers.get('tool_result')(event);
  assert.deepEqual(event, before, 'delivery must not mutate input, provenance, notes or content');
  return { ...event, ...patch };
}
const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');

describe('REQ-AGENT-218: automatic questionnaire authorization', () => {
  for (const multiSelect of [false, true]) {
    it(`authorizes only the verified recommended ${multiSelect ? 'multi-select' : 'single-select'} default`, async () => {
      const event = fixture(multiSelect);
      const result = await deliver(event);
      // Intentional user-copy contract: delegation is explicit, remains
      // automatic, and cannot bypass protected grants/platform constraints.
      assert.match(text(result), /Question 1: "Small change \(Recommended\)" is user-authorized/);
      assert.match(text(result), /proceed without routine re-confirmation/);
      assert.match(text(result), /Automatic provenance is unchanged; this is not a manual response/);
      assert.match(text(result), /Protected server grants, security boundaries and platform constraints still apply/);
      assert.doesNotMatch(text(result), /not a user response or authorization/);
      assert.deepEqual(result.details, event.details);
      assert.deepEqual(result.content[1], event.content[1]);
      assert.match(text(result), /Retained questionnaire notes/);
    });
  }

  it('authorizes only automatic recommended answers in a mixed result without changing manual answers or notes', async () => {
    const event = fixture();
    event.input.questions.push({ question: 'Manual decision?', options: [{ label: 'Manual' }] },
      { question: 'Unrecommended timeout?', options: [{ label: 'First' }, { label: 'Later (Recommended)' }] });
    event.details.answers.push({ questionIndex: 1, question: 'Manual decision?', automatic: false,
      kind: 'custom', answer: 'My answer', note: 'Manual note.' },
    { questionIndex: 2, question: 'Unrecommended timeout?', automatic: true, kind: 'option', answer: 'First' });
    const result = await deliver(event);
    assert.match(text(result), /Question 1: .*is user-authorized/);
    assert.doesNotMatch(text(result), /Question [23]: .*is user-authorized/);
    assert.deepEqual(result.details, event.details);
  });

  const refused = [
    ['another tool', e => { e.toolName = 'different_tool'; }],
    ['tool error', e => { e.isError = true; }],
    ['unknown success state', e => { delete e.isError; }],
    ['manual result', e => { e.details.automatic = false; }],
    ['cancelled result', e => { e.details.cancelled = true; }],
    ['result error', e => { e.details.error = 'Failed'; }],
    ['unrecognized details', e => { e.details = []; }],
    ['unrecognized input', e => { e.input = null; }],
    ['missing questions', e => { e.input.questions = []; }],
    ['missing answers', e => { e.details.answers = []; }],
    ['non-record answer', e => { e.details.answers[0] = null; }],
    ['negative question index', e => { e.details.answers[0].questionIndex = -1; }],
    ['fractional question index', e => { e.details.answers[0].questionIndex = 0.5; }],
    ['foreign question index', e => { e.details.answers[0].questionIndex = 1; }],
    ['changed question', e => { e.details.answers[0].question = 'Another question'; }],
    ['missing question text', e => { delete e.input.questions[0].question; }],
    ['manual answer', e => { e.details.answers[0].automatic = false; }],
    ['empty options', e => { e.input.questions[0].options = []; }],
    ['invalid option label', e => { e.input.questions[0].options[0].label = null; }],
    ['duplicate option labels', e => { e.input.questions[0].options[1].label = e.input.questions[0].options[0].label; }],
    ['unrecognized select mode', e => { e.input.questions[0].multiSelect = 'true'; }],
    ['different automatic answer', e => { e.details.answers[0].answer = 'Alternative'; }],
    ['unrecognized answer kind', e => { e.details.answers[0].kind = 'unknown'; }],
    ['recommendation is not first', e => {
      e.input.questions[0].options[0].label = e.details.answers[0].answer = 'First';
      e.input.questions[0].options[1].label = 'Alternative (Recommended)';
    }],
    ['duplicate answered question', e => {
      e.input.questions.push(structuredClone(e.input.questions[0]));
      e.details.answers.push(structuredClone(e.details.answers[0]));
    }],
  ];
  for (const [name, change] of refused) {
    it(`does not authorize ${name}`, async () => {
      const event = fixture(); change(event);
      const result = await deliver(event);
      assert.deepEqual(result, event);
      assert.doesNotMatch(text(result), /is user-authorized|standing user delegation/);
    });
  }
  for (const [name, change] of [
    ['multiple automatic choices', e => { e.details.answers[0].selected.push('Alternative'); }],
    ['foreign automatic choice', e => { e.details.answers[0].selected = ['Alternative']; }],
    ['non-null multi-select answer', e => { e.details.answers[0].answer = 'Small change (Recommended)'; }],
    ['single-select kind for multi-select', e => { e.details.answers[0].kind = 'option'; }],
  ]) {
    it(`does not authorize ${name}`, async () => {
      const event = fixture(true); change(event);
      assert.deepEqual(await deliver(event), event);
    });
  }
});
