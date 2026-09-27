import { z } from 'zod';
import { parseOperatorAttachmentProjection, type OperatorAttachmentProjection } from './attachments';
import { parseOperatorPackageResourceProjection, type OperatorPackageResourceProjection } from './package-resources';

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const PATH = z.string().min(1).max(1024).refine(value => !value.startsWith('/')
  && !/[\\%\x00-\x1f\x7f]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..'
    && !['__proto__', 'constructor', 'prototype'].includes(part)));
const source = z.strictObject({ kind: z.enum(['attachment', 'resource']), reference: PATH, target: PATH });
const task = z.strictObject({ id: ID, instruction: PATH, reads: z.array(PATH).min(1).max(20), output: PATH });
const initialization = z.strictObject({ schemaVersion: z.literal(1), profileId: ID,
  contextPath: PATH, context: z.string().min(1).max(4096),
  inputs: z.array(source).min(1).max(20), tasks: z.array(task).min(1).max(8) });
export type OperatorPiInitialization = z.infer<typeof initialization>;

export function parseOperatorPiInitializationShape(value: unknown): OperatorPiInitialization {
  return initialization.parse(value);
}

/** Check only bounded filesystem authority; the installed package owns task semantics. */
export function parseOperatorPiInitialization(value: unknown, owner: {
  profileId: string; attachments: OperatorAttachmentProjection;
  resources: OperatorPackageResourceProjection | null;
}): OperatorPiInitialization {
  const parsed = initialization.parse(value);
  const attachments = parseOperatorAttachmentProjection(owner.attachments);
  const resources = owner.resources ? parseOperatorPackageResourceProjection(owner.resources) : null;
  const prefix = parsed.contextPath.split('/')[0];
  if (!ID.safeParse(owner.profileId).success || parsed.profileId !== owner.profileId
    || !parsed.contextPath.includes('/') || prefix === 'reports'
    || new TextEncoder().encode(parsed.context).byteLength > 4096) throw Error('Operator Pi initialization denied');
  const readable = new Set([parsed.contextPath]);
  const instructions = new Set<string>();
  const referenced = new Set<string>();
  let size = 0;
  for (const item of parsed.inputs) {
    if (!item.target.startsWith(`${prefix}/`) || readable.has(item.target)) throw Error('Operator Pi input denied');
    readable.add(item.target);
    const key = `${item.kind}:${item.reference}`;
    if (referenced.has(key)) throw Error('Operator Pi input conflict');
    referenced.add(key);
    const declared = item.kind === 'attachment'
      ? attachments.files.find(file => file.name === item.reference)
      : resources?.files.find(file => file.destination === item.reference);
    if (!declared) throw Error('Operator Pi input undeclared');
    size += declared.size;
    if (item.kind === 'resource') instructions.add(item.target);
  }
  if (size > 8 * 1024 * 1024 || attachments.files.some(file => !referenced.has(`attachment:${file.name}`))) {
    throw Error('Operator Pi input set incomplete');
  }
  const ids = new Set<string>();
  const outputs = new Set<string>();
  for (const item of parsed.tasks) {
    if (ids.has(item.id) || outputs.has(item.output)
      || !item.output.startsWith('reports/') || item.output.split('/').length !== 2
      || readable.has(item.output) || !instructions.has(item.instruction)
      || new Set(item.reads).size !== item.reads.length
      || !item.reads.includes(parsed.contextPath) || !item.reads.includes(item.instruction)
      || item.reads.some(read => !readable.has(read))) throw Error('Operator Pi task denied');
    ids.add(item.id);
    outputs.add(item.output);
  }
  return parsed;
}
