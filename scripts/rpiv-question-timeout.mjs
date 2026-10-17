// Image-owned policy for the reviewed RPIV questionnaire; no SDK or UI replacement.
export const QUESTIONNAIRE_TIMEOUT_MS = 300_000;

export function defaultQuestionnaireAnswers(questions, completed) {
  return questions.map((question, questionIndex) => completed.find(answer => answer.questionIndex === questionIndex)
    ?? (question.multiSelect
      ? { questionIndex, question: question.question, kind: 'multi', answer: null, selected: [question.options[0].label], automatic: true }
      : { questionIndex, question: question.question, kind: 'option', answer: question.options[0].label, automatic: true,
        preview: question.options[0].preview || undefined }));
}

export async function withQuestionnaireDeadline(params, signal, run) {
  const cancelled = () => ({ content: [{ type: 'text', text: 'User declined to answer questions' }],
    details: { answers: [], cancelled: true } });
  if (signal?.aborted) return cancelled();
  const controller = new AbortController();
  let timer;
  let deadlineAt;
  let expired = false;
  let cancelTui;
  const abort = () => { controller.abort(); cancelTui?.(); };
  signal?.addEventListener('abort', abort, { once: true });
  const start = (expire = () => {}, cancel) => {
    cancelTui = cancel;
    if (controller.signal.aborted) { cancel?.(); return; }
    if (deadlineAt !== undefined) return;
    deadlineAt = Date.now() + QUESTIONNAIRE_TIMEOUT_MS;
    timer = setTimeout(() => {
      expired = true;
      // RPC must release its original native wait; TUI must use its real done path.
      controller.abort();
      expire();
    }, QUESTIONNAIRE_TIMEOUT_MS);
  };
  const dialogs = ui => {
    const wait = (method, args) => {
      if (controller.signal.aborted) return Promise.resolve(undefined);
      start();
      return ui[method](...args, { signal: controller.signal, timeout: Math.max(1, deadlineAt - Date.now()) });
    };
    return { select: (title, options) => wait('select', [title, options]),
      input: (title, placeholder) => wait('input', [title, placeholder]) };
  };
  try {
    const result = await run({ start, dialogs });
    if (!expired) return result;
    const answers = defaultQuestionnaireAnswers(params.questions, result.details.answers);
    return {
      content: [{ type: 'text', text: 'Automatic questionnaire timeout after five minutes, not a user response or authorization. '
        + 'Kept completed answers and selected option 1 for unanswered questions.\n' + JSON.stringify(answers)
        + (result.details.globalNote ? `\nGlobal note: ${result.details.globalNote}` : '') }],
      details: { ...result.details, answers, cancelled: false, automatic: true },
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    cancelTui = undefined;
  }
}
