/** @jsxImportSource react */
import { isOtherAllowed } from "@blackbelt-technology/pi-dashboard-shared/prompt-answer.js";
import type { ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { mdiCheck, mdiCheckCircle, mdiImageMultiple, mdiViewListOutline } from "@mdi/js";
import { Icon } from "@mdi/react";
import type React from "react";
import { useId, useState } from "react";
import { t as i18nT } from "../../lib/i18n/i18n.js";
import { MarkdownContent } from "../preview/MarkdownContent.js";
import { InlineMarkdown } from "./InlineMarkdown.js";
import { InputComposer } from "./InputComposer.js";
import { OtherOption } from "./OtherOption.js";
import { isCancelOption, parseOption } from "./parseOption.js";
import type { InteractiveRendererProps } from "./types.js";

/**
 * BatchRenderer — renders a `batch` ask_user request as a single wizard card:
 * stepper header, one sub-question per page, Back/Next, a Review page with
 * per-row Edit, and a final Submit. Answers are held in component state and
 * sent only on Submit (one `{answers}` response). A multiselect step yields
 * multiple values (rendered as pills).
 *
 * See change: redesign-ask-user-question-cards.
 */

interface SubQuestion {
  method: "confirm" | "select" | "multiselect" | "input";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  /** Inline "Other" opt-in. See change: add-ask-user-inline-other. */
  allowOther?: boolean;
  /** Codeflare's native questionnaire presentation; ordinary batches omit this. */
  codeflareQuestionnaire?: {
    header: string;
    options: Array<{ label: string; description: string; preview?: string }>;
    last: boolean;
  };
}

/** Per-step inline-Other draft; lives next to `answers` so it survives step changes. */
interface OtherDraft {
  active: boolean;
  text: string;
}

type Answer = (
  | { confirmed: boolean }
  | { value: string; images?: ImageContent[] }
  | { values: string[] }
) & {
  codeflare?: { optionIndexes: number[]; text?: string };
  notes?: string;
  globalNote?: string;
};

/** Keep native choices authoritative and separate from token-shaped custom text. */
function questionnaireAnswer(q: SubQuestion, indexes: number[], other: OtherDraft): Answer {
  const optionIndexes = indexes.slice().sort((a, b) => a - b);
  const text = other.active ? other.text.trim() : "";
  const tokens = optionIndexes.map((index) => q.options![index]);
  return {
    ...(q.method === "multiselect"
      ? { values: Array.from(new Set(text ? [...tokens, text] : tokens)) }
      : { value: text || tokens[0] || "" }),
    codeflare: { optionIndexes, ...(text ? { text } : {}) },
  };
}

function isAnswered(q: SubQuestion, a: Answer | undefined): boolean {
  if (!q.codeflareQuestionnaire) return a !== undefined;
  const owned = a?.codeflare;
  const count = owned?.optionIndexes.length ?? 0;
  const hasText = !!owned?.text?.trim();
  return q.method === "multiselect" ? count > 0 || hasText : (count === 1 && !hasText) || (count === 0 && hasText);
}

function initialAnswer(q: SubQuestion): Answer | undefined {
  if (q.method === "input") return { value: "" };
  if (q.method === "multiselect") return { values: [] };
  return undefined; // confirm / select require an explicit pick
}

function answerToText(q: SubQuestion, a: Answer | undefined): React.ReactNode {
  if (!a) return <span className="text-[var(--text-tertiary)] italic">(unanswered)</span>;
  if (q.codeflareQuestionnaire && a.codeflare) {
    if (!isAnswered(q, a)) return <span className="text-[var(--text-tertiary)] italic">(unanswered)</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {a.codeflare.optionIndexes.map((index) => (
          <span key={index} className="inline-block rounded px-2 py-0.5 text-[11px] bg-blue-500/15 text-blue-300">
            {q.codeflareQuestionnaire!.options[index]?.label}
          </span>
        ))}
        {a.codeflare.text && <span className="whitespace-pre-wrap">{a.codeflare.text}</span>}
      </span>
    );
  }
  if ("confirmed" in a) return a.confirmed ? "Yes" : "No";
  if ("values" in a) {
    if (a.values.length === 0) return <span className="text-[var(--text-tertiary)] italic">(none)</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {a.values.map((v) => (
          <span key={v} className="inline-block rounded px-2 py-0.5 text-[11px] bg-blue-500/15 text-blue-300">
            {v}
          </span>
        ))}
      </span>
    );
  }
  if ("value" in a) {
    const imgCount = a.images?.length ?? 0;
    const pill = imgCount > 0 ? (
      <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] align-middle">
        <Icon path={mdiImageMultiple} size={0.5} />+{imgCount}
      </span>
    ) : null;
    if (a.value === "" && imgCount === 0) return <span className="text-[var(--text-tertiary)] italic">{i18nT("common.leftBlank", undefined, "(left blank)")}</span>;
    return <span>{a.value === "" ? <span className="text-[var(--text-tertiary)] italic">{i18nT("common.noText", undefined, "(no text)")}</span> : a.value}{pill}</span>;
  }
  return null;
}

export function BatchRenderer({ params, status, result, onRespond, onCancel }: InteractiveRendererProps) {
  const title = (params.title as string) ?? "Questions";
  const questions = ((params.questions as SubQuestion[]) ?? []).filter(Boolean);
  const resolvedAnswers = (result as any)?.answers as Answer[] | undefined;

  const [answers, setAnswers] = useState<Array<Answer | undefined>>(() =>
    questions.map(initialAnswer),
  );
  // step in 0..questions.length-1 are questions; questions.length is Review.
  const [step, setStep] = useState(0);
  const [otherDraft, setOtherDraft] = useState<Array<OtherDraft | undefined>>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [globalNote, setGlobalNote] = useState("");
  const hasQuestionnaire = questions.some((q) => !!q.codeflareQuestionnaire);

  function answerWithNotes(q: SubQuestion, i: number): Answer | undefined {
    const answer = answers[i];
    if (!q.codeflareQuestionnaire || !answer) return answer;
    return {
      ...answer,
      ...(notes[i] ? { notes: notes[i] } : {}),
      ...(i === questions.length - 1 && globalNote ? { globalNote } : {}),
    };
  }

  // ── Resolved / cancelled / dismissed: read-only summary ──────────
  if (status !== "pending") {
    if (status === "cancelled" || status === "dismissed") {
      return (
        <div className="mx-4 my-1 p-2 bg-[var(--bg-hover)] rounded text-xs flex items-center gap-2">
          <Icon path={mdiViewListOutline} size={0.55} className="text-[var(--text-secondary)] shrink-0" />
          <span className="text-[var(--text-secondary)]"><InlineMarkdown content={title} /></span>
          <span className="ml-1 text-[var(--text-tertiary)]">
            {status === "cancelled" ? "Cancelled" : "Answered in terminal"}
          </span>
        </div>
      );
    }
    return (
      <div className="mx-4 my-1 bg-[var(--bg-hover)] rounded-lg overflow-hidden text-xs">
        <div className="px-4 py-3 border-b border-[var(--border-subtle)] flex items-center gap-2">
          <Icon path={mdiCheckCircle} size={0.55} className="text-green-400 shrink-0" />
          <span className="text-[var(--text-primary)] font-medium"><InlineMarkdown content={title} /></span>
          <span className="ml-auto text-green-400">{resolvedAnswers?.length ?? 0} answers</span>
        </div>
        <div className="p-3 flex flex-col gap-2">
          {questions.map((q, i) => (
            <ReviewRow key={i} num={i + 1} question={q} answer={resolvedAnswers?.[i]} />
          ))}
        </div>
      </div>
    );
  }

  const onReview = step >= questions.length;
  const current = questions[step];

  function setAnswer(a: Answer | undefined) {
    setAnswers((prev) => {
      const next = prev.slice();
      next[step] = a;
      return next;
    });
  }

  const draft = otherDraft[step];
  const otherBlocked =
    !onReview && !current?.codeflareQuestionnaire && current?.method === "multiselect" && isOtherAllowed({ allowOther: current.allowOther, options: current.options }) && !!draft?.active && !draft.text.trim();
  const canAdvance = onReview || (isAnswered(current, answers[step]) && !otherBlocked);
  // Review is reachable via the stepper, so being on Review is not completion.
  const canSubmit = !hasQuestionnaire || questions.every((q, i) => isAnswered(q, answers[i]));

  function setDraft(d: OtherDraft | undefined) {
    setOtherDraft((prev) => {
      const next = prev.slice();
      next[step] = d;
      return next;
    });
  }

  return (
    <div className="mx-4 my-2 bg-[var(--bg-hover)] border border-[var(--border-secondary)] rounded-xl overflow-hidden">
      {/* Header + stepper */}
      <div className="px-4 py-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2">
          <Icon path={mdiViewListOutline} size={0.6} className="text-blue-400 shrink-0" />
          <span className="text-sm font-medium text-[var(--text-primary)]"><InlineMarkdown content={title} /></span>
          <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">
            {onReview ? "Review" : `Question ${step + 1} of ${questions.length}`}
          </span>
        </div>
        <div className="flex gap-1.5 mt-3">
          {questions.map((q, i) => {
            const done = isAnswered(q, answers[i]);
            const active = i === step;
            return (
              <button
                key={i}
                onClick={() => setStep(i)}
                className="flex-1 flex flex-col gap-1.5 text-left"
                title={q.title}
              >
                <span
                  className={
                    active
                      ? "h-1 rounded bg-blue-500"
                      : done
                        ? "h-1 rounded bg-green-500"
                        : "h-1 rounded bg-[var(--border-secondary)]"
                  }
                />
                <span
                  className={
                    active
                      ? "text-[10px] text-[var(--text-primary)] truncate"
                      : done
                        ? "text-[10px] text-green-400 truncate"
                        : "text-[10px] text-[var(--text-tertiary)] truncate"
                  }
                >
                  {q.title}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-4">
        {onReview ? (
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium text-[var(--text-primary)] mb-1">{i18nT("common.reviewYourAnswers", undefined, "Review your answers")}</div>
            {questions.map((q, i) => (
              <ReviewRow
                key={i}
                num={i + 1}
                question={q}
                answer={answerWithNotes(q, i)}
                onEdit={() => setStep(i)}
              />
            ))}
            {hasQuestionnaire && <NoteInput label="Global note (optional)" value={globalNote} onChange={setGlobalNote} />}
          </div>
        ) : (
          <>
            <StepBody
              key={current?.codeflareQuestionnaire ? step : "stock"}
              question={current}
              answer={answers[step]}
              onChange={setAnswer}
              other={draft}
              onOtherChange={setDraft}
            />
            {current?.codeflareQuestionnaire && (
              <NoteInput label="Notes (optional)" value={notes[step] ?? ""} onChange={(text) => setNotes((prev) => {
                const next = prev.slice();
                next[step] = text;
                return next;
              })} />
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-[var(--border-subtle)] flex items-center gap-2">
        {step > 0 ? (
          <button
            onClick={() => setStep((s) => s - 1)}
            className="px-3 py-1 text-xs rounded bg-transparent hover:bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border-secondary)] transition-colors"
          >
            {i18nT("common.back22", undefined, "← Back")}
          </button>
        ) : (
          <button
            onClick={onCancel}
            className="px-3 py-1 text-xs rounded bg-transparent hover:bg-[var(--bg-surface)] text-[var(--text-tertiary)] border border-[var(--border-secondary)] transition-colors"
          >
            {i18nT("common.cancel", undefined, "Cancel")}
          </button>
        )}
        <div className="flex-1" />
        {onReview ? (
          <button
            onClick={() => { if (canSubmit) onRespond({ answers: hasQuestionnaire ? questions.map(answerWithNotes) : answers }); }}
            disabled={!canSubmit}
            className="px-3 py-1 text-xs rounded bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors inline-flex items-center gap-1"
          >
            <Icon path={mdiCheck} size={0.5} /> {i18nT("common.submitAll", undefined, "Submit all")} {questions.length}
          </button>
        ) : (
          <button
            onClick={() => setStep((s) => s + 1)}
            disabled={!canAdvance}
            className="px-3 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
          >
            {i18nT("common.next", undefined, "Next →")}
          </button>
        )}
      </div>
    </div>
  );
}

function ReviewRow({
  num,
  question,
  answer,
  onEdit,
}: {
  num: number;
  question: SubQuestion;
  answer: Answer | undefined;
  onEdit?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <span className="w-5 h-5 rounded grid place-items-center text-[11px] font-semibold bg-green-500/20 text-green-400 shrink-0">
        {num}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{question.title}</div>
        <div className="text-xs text-[var(--text-primary)] font-medium mt-0.5">{answerToText(question, answer)}</div>
        {question.codeflareQuestionnaire && answer?.notes && <p className="mt-1 text-xs whitespace-pre-wrap text-[var(--text-secondary)]">{answer.notes}</p>}
        {question.codeflareQuestionnaire && answer?.globalNote && !onEdit && <p className="mt-1 text-xs whitespace-pre-wrap text-[var(--text-secondary)]">Global note: {answer.globalNote}</p>}
      </div>
      {onEdit && (
        <button onClick={onEdit} className="text-[11px] text-blue-400 hover:text-blue-300 self-center shrink-0">
          {i18nT("common.edit", undefined, "Edit")}
        </button>
      )}
    </div>
  );
}

/** Plain-text notes reuse the existing InputComposer textarea's styling, without image input. */
function NoteInput({ label, value, onChange }: { label: string; value: string; onChange: (text: string) => void }) {
  return (
    <label className="mt-3 block text-[11px] text-[var(--text-secondary)]">
      {label}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        className="mt-1 w-full px-2.5 py-1.5 text-xs rounded bg-[var(--bg-primary)] border border-[var(--border-secondary)] text-[var(--text-primary)] outline-none focus:border-blue-500 resize-y"
      />
    </label>
  );
}

/** Options checked + the trimmed custom text (when Other is active and non-empty), de-duplicated. */
function composeValues(checked: string[], other: OtherDraft | undefined): string[] {
  const t = other?.active ? other.text.trim() : "";
  return Array.from(new Set(t ? [...checked, t] : checked));
}

function StepBody({
  question,
  answer,
  onChange,
  other,
  onOtherChange,
}: {
  question: SubQuestion;
  answer: Answer | undefined;
  onChange: (a: Answer | undefined) => void;
  other: OtherDraft | undefined;
  onOtherChange: (d: OtherDraft | undefined) => void;
}) {
  const options = question.options ?? [];
  const presentation = question.codeflareQuestionnaire;
  const otherAllowed = isOtherAllowed({ allowOther: question.allowOther, options });
  const draft: OtherDraft = other ?? { active: false, text: "" };
  const [previewIndex, setPreviewIndex] = useState<number>();
  const previewId = useId();
  const indexes = answer?.codeflare?.optionIndexes ?? [];

  function changeOther(next: OtherDraft) {
    onOtherChange(next);
    onChange(questionnaireAnswer(question, question.method === "select" && next.active ? [] : indexes, next));
  }

  return (
    <div>
      {presentation?.header && <span className="mb-2 inline-block rounded px-2 py-0.5 text-[10px] bg-blue-500/15 text-blue-300">{presentation.header}</span>}
      <div className={`text-sm font-medium text-[var(--text-primary)] mb-1${presentation ? " whitespace-pre-wrap" : ""}`}>{question.title}</div>
      {question.message && (
        <div className="text-[11px] text-[var(--text-tertiary)] mb-3"><InlineMarkdown content={question.message} /></div>
      )}
      {question.method === "input" && (
        <InputComposer
          autoFocus
          value={(answer as { value: string } | undefined)?.value ?? ""}
          images={(answer as { images?: ImageContent[] } | undefined)?.images ?? []}
          placeholder={question.placeholder}
          onChange={(next) => onChange({ value: next.value, images: next.images.length > 0 ? next.images : undefined })}
          onSubmit={() => { /* batch advances via Next/Submit; no per-step submit */ }}
        />
      )}
      {question.method === "confirm" && (
        <div className="flex gap-2">
          {(["Yes", "No"] as const).map((label) => {
            const val = label === "Yes";
            const picked = (answer as { confirmed: boolean } | undefined)?.confirmed === val;
            return (
              <button
                key={label}
                onClick={() => onChange({ confirmed: val })}
                className={
                  picked
                    ? val
                      ? "px-3 py-1 text-xs rounded bg-green-600 text-white"
                      : "px-3 py-1 text-xs rounded bg-red-600 text-white"
                    : "px-3 py-1 text-xs rounded bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border-secondary)]"
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      {presentation && (
        <div className="flex flex-col gap-1.5">
          {presentation.options.map((option, index) => {
            const picked = indexes.includes(index);
            const description = (
              <span className="min-w-0">
                <span className="block text-xs font-medium">{option.label}</span>
                {option.description && <span className="block text-[11px] whitespace-pre-wrap text-[var(--text-tertiary)] mt-0.5">{option.description}</span>}
              </span>
            );
            const className = picked
              ? "w-full text-left flex items-start gap-2 px-3 py-2 rounded-lg border border-blue-500 bg-blue-500/10 text-[var(--text-primary)]"
              : "w-full text-left flex items-start gap-2 px-3 py-2 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:border-blue-500";
            function choose() {
              if (question.method === "select") {
                const next = { ...draft, active: false };
                onOtherChange(next);
                onChange(questionnaireAnswer(question, [index], next));
              } else {
                onChange(questionnaireAnswer(question, picked ? indexes.filter((i) => i !== index) : [...indexes, index], draft));
              }
            }
            return (
              <div key={index}>
                {question.method === "select" ? (
                  <button type="button" aria-pressed={picked} onClick={choose} className={className}>{description}</button>
                ) : (
                  <label className={`${className} cursor-pointer`}>
                    <input type="checkbox" checked={picked} onChange={choose} className="accent-blue-500" />
                    {description}
                  </label>
                )}
                {option.preview && (
                  <div className="mt-1 ml-3">
                    <button
                      type="button"
                      aria-label={`Preview: ${option.label}`}
                      aria-expanded={previewIndex === index}
                      aria-controls={`${previewId}-${index}`}
                      onClick={() => setPreviewIndex(previewIndex === index ? undefined : index)}
                      className="text-[11px] text-blue-400 hover:text-blue-300 focus-ring"
                    >
                      {previewIndex === index ? "Hide preview" : "Preview"}
                    </button>
                    {previewIndex === index && (
                      <div id={`${previewId}-${index}`} role="region" aria-label={`Preview: ${option.label}`} tabIndex={0} className="mt-2 max-h-64 overflow-auto text-xs text-[var(--text-secondary)]">
                        <MarkdownContent content={option.preview} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <OtherOption
            variant={question.method === "multiselect" ? "checkbox" : "radio"}
            active={draft.active}
            text={draft.text}
            onActiveChange={(active) => changeOther({ ...draft, active })}
            onTextChange={(text) => changeOther({ ...draft, text })}
          />
        </div>
      )}
      {!presentation && question.method === "select" && (
        <div className="flex flex-col gap-1.5">
          {(question.options ?? []).filter((o) => !isCancelOption(o)).map((option) => {
            const { title: oTitle, description } = parseOption(option);
            const picked = (answer as { value: string } | undefined)?.value === option;
            return (
              <button
                key={option}
                onClick={() => {
                  if (draft.active) onOtherChange({ ...draft, active: false });
                  onChange({ value: option });
                }}
                className={
                  picked
                    ? "w-full text-left flex items-start gap-2 px-3 py-2 rounded-lg border border-blue-500 bg-blue-500/10 text-[var(--text-primary)]"
                    : "w-full text-left flex items-start gap-2 px-3 py-2 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:border-blue-500"
                }
              >
                <span className="min-w-0">
                  <span className="block text-xs font-medium">{oTitle}</span>
                  {description && <span className="block text-[11px] text-[var(--text-tertiary)] mt-0.5">{description}</span>}
                </span>
              </button>
            );
          })}
          {otherAllowed && (
            <OtherOption
              variant="radio"
              active={draft.active}
              text={draft.text}
              onActiveChange={(active) => {
                onOtherChange({ ...draft, active });
                const t = draft.text.trim();
                onChange(active && t ? { value: t } : undefined);
              }}
              onTextChange={(text) => {
                onOtherChange({ ...draft, text });
                const t = text.trim();
                onChange(t ? { value: t } : undefined);
              }}
            />
          )}
        </div>
      )}
      {!presentation && question.method === "multiselect" && (
        <MultiselectStep
          options={options}
          values={((answer as { values: string[] } | undefined)?.values ?? []).filter((v) => options.includes(v))}
          onChange={(values) => onChange({ values: composeValues(values, draft) })}
          other={
            otherAllowed
              ? {
                  draft,
                  onActiveChange: (active) => {
                    const next = { ...draft, active };
                    onOtherChange(next);
                    onChange({ values: composeValues(((answer as { values: string[] } | undefined)?.values ?? []).filter((v) => options.includes(v)), next) });
                  },
                  onTextChange: (text) => {
                    const next = { ...draft, text };
                    onOtherChange(next);
                    onChange({ values: composeValues(((answer as { values: string[] } | undefined)?.values ?? []).filter((v) => options.includes(v)), next) });
                  },
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function MultiselectStep({
  options,
  values,
  onChange,
  other,
}: {
  options: string[];
  values: string[];
  onChange: (values: string[]) => void;
  other?: { draft: OtherDraft; onActiveChange: (a: boolean) => void; onTextChange: (t: string) => void };
}) {
  function toggle(option: string) {
    onChange(values.includes(option) ? values.filter((v) => v !== option) : [...values, option]);
  }
  return (
    <div className="flex flex-col gap-1">
      {options.map((option) => {
        const on = values.includes(option);
        return (
          <label
            key={option}
            className={
              on
                ? "flex items-center gap-2.5 px-3 py-2 rounded-lg border border-blue-500/40 bg-blue-500/10 text-[var(--text-primary)] text-xs cursor-pointer"
                : "flex items-center gap-2.5 px-3 py-2 rounded-lg border border-transparent text-[var(--text-primary)] text-xs cursor-pointer hover:bg-[var(--bg-surface)]"
            }
          >
            <input type="checkbox" checked={on} onChange={() => toggle(option)} className="accent-blue-500" />
            <span>{option}</span>
          </label>
        );
      })}
      {other && (
        <OtherOption
          variant="checkbox"
          active={other.draft.active}
          text={other.draft.text}
          onActiveChange={other.onActiveChange}
          onTextChange={other.onTextChange}
        />
      )}
    </div>
  );
}
