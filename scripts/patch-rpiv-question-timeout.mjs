import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exact source identities from the integrity-verified, pinned 2.12.0 npm archive.
// Reverse every owned replacement and verify the pristine digest on repeat runs.
const layouts = [
  {
    path: 'ask-user-question.ts',
    sha256: '3259729a00ba3fcab4b626b8525fb5b25c76a9583c1b97d51d0e1c6aedad3c26',
    replacements: [
      ['import type { ExtensionAPI, ExtensionContext, Theme }',
        'import { withQuestionnaireDeadline } from "./codeflare-question-timeout.mjs";\nimport type { ExtensionAPI, ExtensionContext, Theme }'],
      ['\tSession: SessionModule["QuestionnaireSession"];',
        '\tSession: SessionModule["QuestionnaireSession"];\n\tdeadline: { start(expire: () => void, cancel: () => void): void };'],
      ['const { ctx, typed, itemsByTab, collapseKey, canReopenWhileHidden, sessionRef, Session } = config;',
        'const { ctx, typed, itemsByTab, collapseKey, canReopenWhileHidden, sessionRef, Session, deadline } = config;'],
      ['\t\tsessionRef.current = session;\n\t\treturn session.component;',
        '\t\tsessionRef.current = session;\n\t\tdeadline.start(() => session.submitDefaults(), () => session.cancel());\n\t\treturn session.component;'],
      ['async function resolveUndefinedResult(ctx: ExtensionContext, typed: QuestionParams)',
        'async function resolveUndefinedResult(ctx: ExtensionContext, typed: QuestionParams, deadline: { dialogs(ui: unknown): DialogUI })'],
      ['return buildQuestionnaireResponse(await runRpcQuestionnaire(ctx.ui, typed), typed);',
        'return buildQuestionnaireResponse(await runRpcQuestionnaire(deadline.dialogs(ctx.ui), typed), typed);'],
      ['\t\t\t// Emit event for external listeners (e.g., notification plugins)',
        '\t\t\treturn withQuestionnaireDeadline(typed, _signal, async (deadline) => {\n\t\t\t// Emit event for external listeners (e.g., notification plugins)'],
      ['return runRpcPath(pi, ctx.ui, typed);', 'return runRpcPath(pi, deadline.dialogs(ctx.ui), typed);'],
      ['\t\t\t\t\t\tSession: QuestionnaireSession,', '\t\t\t\t\t\tSession: QuestionnaireSession,\n\t\t\t\t\t\tdeadline,'],
      ['return resolveUndefinedResult(ctx, typed);', 'return resolveUndefinedResult(ctx, typed, deadline);'],
      ['\t\t\t\temitAskUserBlockedEvent(pi, false);\n\t\t\t}\n\t\t},',
        '\t\t\t\temitAskUserBlockedEvent(pi, false);\n\t\t\t}\n\t\t\t});\n\t\t},'],
    ],
  },
  {
    path: 'state/questionnaire-session.ts',
    sha256: '1e0daccd2238b38e5c27179753ec7f379a84471058c8e5e873e78e4bf8d6f24a',
    replacements: [
      ['import type { Theme }', 'import { defaultQuestionnaireAnswers } from "../codeflare-question-timeout.mjs";\nimport type { Theme }'],
      ['\tdispatch(data: string): void {', `\tcancel(): void {
\t\tthis.commit({ kind: "cancel" });
\t}

\tsubmitDefaults(): void {
\t\tconst notes = new Map(this.state.notesByTab);
\t\tif (this.state.notesVisible) notes.set(this.state.currentTab, this.notesInput.getExpandedText?.() ?? this.notesInput.getText());
\t\tthis.done({
\t\t\tanswers: defaultQuestionnaireAnswers(this.questions, [...this.state.answers.values()]).map(answer =>
\t\t\t\tnotes.has(answer.questionIndex) ? { ...answer, notes: notes.get(answer.questionIndex) } : answer),
\t\t\tcancelled: false,
\t\t\tglobalNote: notes.get(this.questions.length),
\t\t});
\t}

\tdispatch(data: string): void {`],
    ],
  },
];
const digest = source => createHash('sha256').update(source).digest('hex');
function replaceOnce(source, before, after, path) {
  if (source.split(before).length !== 2) throw new Error(`Questionnaire source layout changed: ${path}`);
  return source.replace(before, after);
}
function transform(source, layout) {
  if (digest(source) === layout.sha256) {
    return layout.replacements.reduce((text, [before, after]) => replaceOnce(text, before, after, layout.path), source);
  }
  const pristine = [...layout.replacements].reverse()
    .reduce((text, [before, after]) => replaceOnce(text, after, before, layout.path), source);
  if (digest(pristine) !== layout.sha256) throw new Error(`Questionnaire source digest changed: ${layout.path}`);
  return source;
}

export function patchQuestionnaireTimeout(root) {
  const destination = join(root, 'codeflare-question-timeout.mjs');
  for (const path of [join(root, 'package.json'), ...layouts.map(layout => join(root, layout.path)), destination]) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info && path === destination) continue;
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe questionnaire source path: ${path}`);
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== '@juicesharp/rpiv-ask-user-question' || manifest.version !== '2.12.0') {
    throw new Error('Unsupported questionnaire package identity/version; expected @juicesharp/rpiv-ask-user-question 2.12.0');
  }
  // Validate every artifact before any installed-package mutation.
  const files = layouts.map(layout => ({ path: join(root, layout.path),
    source: transform(readFileSync(join(root, layout.path), 'utf8'), layout) }));
  const helper = fileURLToPath(new URL('./rpiv-question-timeout.mjs', import.meta.url));
  copyFileSync(helper, destination);
  for (const file of files) writeFileSync(file.path, file.source);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('usage: patch-rpiv-question-timeout.mjs QUESTIONNAIRE_PACKAGE_ROOT');
  patchQuestionnaireTimeout(process.argv[2]);
}
