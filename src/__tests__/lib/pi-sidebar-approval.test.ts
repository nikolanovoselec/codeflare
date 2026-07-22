import { createHash } from 'node:crypto';
import { renameSync, watch } from 'node:fs';
import { mkdir, mkdtemp, readFile as readFsFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SIDEBAR_APPROVAL_SOURCE,
  createSidebarApprovalTools,
  registerSidebarApproval,
  type SidebarApprovalDecision,
  type SidebarApprovalDependencies,
  type SidebarApprovalRequest,
  type SidebarApprovalTools,
} from '../../../preseed/agents/pi/extensions/sidebar-approval';

const WORKSPACE = '/home/user/workspace';
const TARGET = `${WORKSPACE}/project/file.ts`;
const OPAQUE_ID = '8e58ce46-4e9c-4ea8-a34e-fd2ec5c4460a';

type ToolContext = Parameters<SidebarApprovalTools['edit']['execute']>[4];
type ToolResult = Awaited<ReturnType<SidebarApprovalTools['edit']['execute']>>;
type ToolCallDecision = { block: boolean; reason?: string } | undefined;
type ToolHandler = (event: Record<string, unknown>, ctx: ToolContext) => ToolCallDecision | Promise<ToolCallDecision>;
type RegisteredTool = SidebarApprovalTools[keyof SidebarApprovalTools];
type ApprovalResponder = (request: SidebarApprovalRequest, harness: Harness) => SidebarApprovalDecision | Promise<SidebarApprovalDecision>;

interface Harness {
  files: Map<string, string>;
  events: string[];
  approvals: SidebarApprovalRequest[];
  dependencies: SidebarApprovalDependencies;
  setNow(value: number): void;
  setApproval(next: ApprovalResponder): void;
}

function sha256(content: Buffer | string): string {
  let value = 0;
  for (const byte of Buffer.from(content)) value = ((value * 31) + byte) >>> 0;
  return value.toString(16).padStart(64, '0');
}

function text(result: ToolResult): string {
  return result.content.flatMap((item) => item.type === 'text' ? [item.text] : []).join('\n');
}

function context(options: { hasUI?: boolean; mode?: 'rpc' | 'tui' | 'json' | 'print' } = {}): ToolContext {
  return {
    cwd: WORKSPACE,
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? 'rpc',
    ui: {},
  } as unknown as ToolContext;
}

function makeHarness(initial: Record<string, string> = { [TARGET]: 'before\n' }): Harness {
  const files = new Map(Object.entries(initial));
  const events: string[] = [];
  const approvals: SidebarApprovalRequest[] = [];
  let now = 1_000;
  let approve: ApprovalResponder = (request) => ({ id: request.id, approved: true });
  const harness = {} as Harness;
  Object.assign(harness, {
    files,
    events,
    approvals,
    setNow: (value: number) => { now = value; },
    setApproval: (next: ApprovalResponder) => { approve = next; },
  });
  harness.dependencies = {
    workspaceRoot: WORKSPACE,
    now: () => now,
    randomUUID: () => OPAQUE_ID,
    sha256,
    inspectPath: async (path) => ({ absolutePath: path, canonicalPath: path, exists: files.has(path), symbolicLink: false }),
    readFile: async (path) => Buffer.from(files.get(path) ?? ''),
    editOperations: {
      access: async (path) => { events.push(`access:${path}`); if (!files.has(path)) throw new Error('missing'); },
      readFile: async (path) => { events.push(`read:${path}`); if (!files.has(path)) throw new Error('missing'); return Buffer.from(files.get(path)!); },
      writeFile: async (path, content) => { events.push(`edit-write:${path}:${content}`); files.set(path, content); },
    },
    writeOperations: {
      mkdir: async (path) => { events.push(`mkdir:${path}`); },
      writeFile: async (path, content) => { events.push(`write:${path}:${content}`); files.set(path, content); },
    },
    bashOperations: {
      exec: async (command, cwd, options) => {
        events.push(`exec:${cwd}:${command}`);
        options.onData(Buffer.from('command output\n'));
        return { exitCode: 0 };
      },
    },
    requestApproval: async (request) => {
      approvals.push(request);
      events.push(`approval:${request.toolName}`);
      return approve(request, harness);
    },
  };
  return harness;
}

function tools(harness: Harness): SidebarApprovalTools {
  return createSidebarApprovalTools(harness.dependencies);
}

class FakePi {
  readonly registered = new Map<string, RegisteredTool>();
  readonly handlers = new Map<string, ToolHandler[]>();
  readonly sources = new Map<string, Record<string, unknown>>();

  registerTool(tool: RegisteredTool): void {
    this.registered.set(tool.name, tool);
    this.sources.set(tool.name, { path: SIDEBAR_APPROVAL_SOURCE, source: SIDEBAR_APPROVAL_SOURCE, scope: 'user', origin: 'top-level' });
  }
  on(event: string, handler: ToolHandler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  getAllTools(): Array<Record<string, unknown>> {
    return [...this.registered.values()].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, sourceInfo: this.sources.get(tool.name) }));
  }
  setSource(name: string, sourceInfo: Record<string, unknown>): void { this.sources.set(name, sourceInfo); }
  async emit(event: Record<string, unknown>, ctx = context()): Promise<ToolCallDecision> {
    let result: ToolCallDecision = undefined;
    for (const handler of this.handlers.get('tool_call') ?? []) result = await handler(event, ctx);
    return result;
  }
}

function registered(harness = makeHarness()): { harness: Harness; pi: FakePi } {
  const pi = new FakePi();
  registerSidebarApproval(pi as unknown as Parameters<typeof registerSidebarApproval>[0], harness.dependencies);
  return { harness, pi };
}

describe('REQ-IDE-007: Pi sidebar guarded approvals', () => {
  it('REQ-IDE-007 AC1: previews an edit diff before the first mutation', async () => {
    const h = makeHarness();
    h.setApproval((request) => {
      expect(h.events.some((event) => event.startsWith('edit-write:'))).toBe(false);
      expect(request.preview).toMatchObject({ kind: 'diff', path: TARGET });
      if (request.preview.kind !== 'diff') throw new Error('expected diff');
      expect(request.preview.diff).toContain('-before');
      expect(request.preview.diff).toContain('+after');
      return { id: request.id, approved: true };
    });
    await tools(h).edit.execute('edit-1', { path: TARGET, edits: [{ oldText: 'before', newText: 'after' }] }, undefined, undefined, context());
    expect(h.files.get(TARGET)).toBe('after\n');
  });

  it('REQ-IDE-007 AC1: previews a write diff before mkdir or write', async () => {
    const target = `${WORKSPACE}/new/created.ts`;
    const h = makeHarness({});
    h.setApproval((request) => {
      expect(h.events.some((event) => /^(mkdir|write):/.test(event))).toBe(false);
      expect(request.preview).toMatchObject({ kind: 'diff', path: target });
      if (request.preview.kind !== 'diff') throw new Error('expected diff');
      expect(request.preview.diff).toContain('+created');
      return { id: request.id, approved: true };
    });
    await tools(h).write.execute('write-1', { path: target, content: 'created\n' }, undefined, undefined, context());
    expect(h.files.get(target)).toBe('created\n');
  });

  it('REQ-IDE-007 AC2: rejection leaves targets unchanged and does not mkdir', async () => {
    const target = `${WORKSPACE}/rejected/new.ts`;
    const h = makeHarness();
    h.setApproval((request) => ({ id: request.id, approved: false }));
    const result = await tools(h).write.execute('write-rejected', { path: target, content: 'forbidden\n' }, undefined, undefined, context());
    expect(text(result)).toMatch(/rejected|denied/i);
    expect(h.files.get(TARGET)).toBe('before\n');
    expect(h.files.has(target)).toBe(false);
    expect(h.events.some((event) => /^(mkdir|write):/.test(event))).toBe(false);
  });

  it('REQ-IDE-007 AC2: preview failure denies without approval or mutation', async () => {
    const h = makeHarness();
    h.dependencies.editOperations = { ...h.dependencies.editOperations!, readFile: async () => { throw new Error('preview unavailable'); } };
    const result = await tools(h).edit.execute('edit-preview-failed', { path: TARGET, edits: [{ oldText: 'before', newText: 'after' }] }, undefined, undefined, context());
    expect(text(result)).toMatch(/preview/i);
    expect(h.approvals).toHaveLength(0);
    expect(h.files.get(TARGET)).toBe('before\n');
  });

  it('REQ-IDE-007 AC1: host approval request carries the serialized manifest digest', async () => {
    const h = makeHarness();
    delete h.dependencies.requestApproval;
    const ctx = {
      ...context(),
      ui: {
        confirm: async (_title: string, message: string | undefined) => {
          const manifestPath = `/tmp/codeflare-sidebar/pi/approvals/${OPAQUE_ID}.json`;
          const serialized = await readFsFile(manifestPath, 'utf8');
          const digest = createHash('sha256').update(serialized).digest('hex');
          expect(message).toBe(`${OPAQUE_ID}:${digest}`);
          return false;
        },
      },
    } as unknown as ToolContext;

    const result = await tools(h).write.execute(
      'write-digest-bound',
      { path: TARGET, content: 'after\n' },
      undefined,
      undefined,
      ctx,
    );

    expect(text(result)).toMatch(/rejected|denied/i);
    expect(h.files.get(TARGET)).toBe('before\n');
  });

  it('REQ-IDE-007 AC2: an oversized serialized preview is denied before approval or mutation', async () => {
    const before = `${'a'.repeat(600 * 1024)}\n`;
    const after = `${'b'.repeat(600 * 1024)}\n`;
    const h = makeHarness({ [TARGET]: before });

    const result = await tools(h).write.execute('write-oversized-preview', { path: TARGET, content: after }, undefined, undefined, context());

    expect(text(result)).toMatch(/preview.*size|size.*preview/i);
    expect(h.approvals).toHaveLength(0);
    expect(h.files.get(TARGET)).toBe(before);
    expect(h.events.some((event) => event.startsWith('write:'))).toBe(false);
  });

  it('REQ-IDE-007 AC2: stale content after approval is not overwritten', async () => {
    const h = makeHarness();
    h.setApproval((request) => { h.files.set(TARGET, 'newer\n'); return { id: request.id, approved: true }; });
    const result = await tools(h).edit.execute('edit-stale', { path: TARGET, edits: [{ oldText: 'before', newText: 'after' }] }, undefined, undefined, context());
    expect(text(result)).toMatch(/stale|changed/i);
    expect(h.files.get(TARGET)).toBe('newer\n');
    expect(h.events.some((event) => event.startsWith('edit-write:'))).toBe(false);
  });

  it('REQ-IDE-007 AC2: expired approval cannot mutate', async () => {
    const h = makeHarness();
    h.setApproval((request, harness) => { harness.setNow(request.expiresAt + 1); return { id: request.id, approved: true }; });
    const result = await tools(h).write.execute('write-expired', { path: TARGET, content: 'after\n' }, undefined, undefined, context());
    expect(text(result)).toMatch(/expired/i);
    expect(h.files.get(TARGET)).toBe('before\n');
  });

  it('REQ-IDE-007 AC2: approval is bound to an opaque generated ID', async () => {
    const h = makeHarness();
    h.setApproval(() => ({ id: 'forged-readable-id', approved: true }));
    const result = await tools(h).write.execute('write-forged', { path: TARGET, content: 'after\n' }, undefined, undefined, context());
    expect(h.approvals[0]?.id).toBe(OPAQUE_ID);
    expect(h.approvals[0]?.id).not.toContain(TARGET);
    expect(text(result)).toMatch(/approval|id|invalid/i);
    expect(h.files.get(TARGET)).toBe('before\n');
  });

  it('REQ-IDE-007 AC2: symlink target is denied before approval', async () => {
    const h = makeHarness();
    h.dependencies.inspectPath = async (path) => ({ absolutePath: path, canonicalPath: TARGET, exists: true, symbolicLink: true });
    const result = await tools(h).write.execute('write-symlink', { path: TARGET, content: 'after\n' }, undefined, undefined, context());
    expect(text(result)).toMatch(/symbolic link|symlink/i);
    expect(h.approvals).toHaveLength(0);
    expect(h.files.get(TARGET)).toBe('before\n');
  });

  it('REQ-IDE-007 AC2: a failed staged replacement leaves the approved existing file intact', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'pi-sidebar-atomic-'));
    const project = join(workspace, 'project');
    const movedProject = join(workspace, 'project-moved');
    const target = join(project, 'file.ts');
    await mkdir(project);
    await writeFile(target, 'before\n');
    let moved = false;
    const watchState: { watcher?: ReturnType<typeof watch> } = {};

    try {
      const guarded = createSidebarApprovalTools({
        workspaceRoot: workspace,
        requestApproval: async (request) => {
          watchState.watcher = watch(project, { encoding: 'utf8' }, (_event, filename) => {
            if (!moved && filename?.startsWith('.codeflare-file.ts-')) {
              moved = true;
              renameSync(project, movedProject);
            }
          });
          return { id: request.id, approved: true };
        },
      });

      const result = await guarded.write.execute(
        'write-staging-race',
        { path: target, content: `${'after'.repeat(100_000)}\n` },
        undefined,
        undefined,
        { ...context(), cwd: workspace },
      );

      watchState.watcher?.close();
      expect(moved).toBe(true);
      expect(text(result)).toMatch(/denied|failed|changed/i);
      expect(await readFsFile(join(movedProject, 'file.ts'), 'utf8')).toBe('before\n');
    } finally {
      watchState.watcher?.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('REQ-IDE-007 AC2: mutation boundary cannot follow a parent symlink swapped in after approval', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'pi-sidebar-workspace-'));
    const outside = await mkdtemp(join(tmpdir(), 'pi-sidebar-outside-'));
    const project = join(workspace, 'project');
    const movedProject = join(workspace, 'project-approved');
    const target = join(project, 'file.ts');
    const outsideTarget = join(outside, 'file.ts');
    await mkdir(project);
    await writeFile(target, 'before\n');
    await writeFile(outsideTarget, 'before\n');
    let inspections = 0;

    try {
      const guarded = createSidebarApprovalTools({
        workspaceRoot: workspace,
        inspectPath: async (path) => {
          inspections += 1;
          if (inspections === 2) {
            await rename(project, movedProject);
            await symlink(outside, project);
          }
          return {
            absolutePath: path,
            canonicalPath: path,
            exists: true,
            symbolicLink: false,
            regularFile: true,
            hardLinked: false,
            safeAncestors: true,
          };
        },
        requestApproval: async (request) => ({ id: request.id, approved: true }),
      });

      const result = await guarded.edit.execute(
        'edit-symlink-swap',
        { path: target, edits: [{ oldText: 'before', newText: 'after' }] },
        undefined,
        undefined,
        { ...context(), cwd: workspace },
      );

      expect(text(result)).toMatch(/denied|failed|changed|symbolic/i);
      expect(await readFsFile(outsideTarget, 'utf8')).toBe('before\n');
      expect(await readFsFile(join(movedProject, 'file.ts'), 'utf8')).toBe('before\n');
    } finally {
      await Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    }
  });

  it('REQ-IDE-007 AC2: target outside workspace is denied before approval', async () => {
    const h = makeHarness();
    h.dependencies.inspectPath = async (path) => ({ absolutePath: path, canonicalPath: '/tmp/escaped.ts', exists: true, symbolicLink: false });
    const result = await tools(h).edit.execute('edit-outside', { path: TARGET, edits: [{ oldText: 'before', newText: 'after' }] }, undefined, undefined, context());
    expect(text(result)).toMatch(/outside.*workspace/i);
    expect(h.approvals).toHaveLength(0);
    expect(h.files.get(TARGET)).toBe('before\n');
  });

  it('REQ-IDE-007 AC2: mutation is denied outside sidebar RPC owner mode', async () => {
    const h = makeHarness();
    const result = await tools(h).write.execute('write-mode', { path: TARGET, content: 'after\n' }, undefined, undefined, context({ mode: 'tui' }));
    expect(text(result)).toMatch(/rpc|sidebar|mode/i);
    expect(h.approvals).toHaveLength(0);
    expect(h.files.get(TARGET)).toBe('before\n');
  });

  it('REQ-IDE-007 AC2: same-file approval windows serialize', async () => {
    const h = makeHarness();
    let ordinal = 0;
    h.setApproval(async (request) => {
      const current = ++ordinal;
      h.events.push(`approval-start:${current}`);
      await Promise.resolve();
      h.events.push(`approval-end:${current}`);
      return { id: request.id, approved: true };
    });
    const write = tools(h).write;
    await Promise.all([
      write.execute('serial-1', { path: TARGET, content: 'one\n' }, undefined, undefined, context()),
      write.execute('serial-2', { path: TARGET, content: 'two\n' }, undefined, undefined, context()),
    ]);
    expect(h.events.filter((event) => event.startsWith('approval-'))).toEqual(['approval-start:1', 'approval-end:1', 'approval-start:2', 'approval-end:2']);
    expect(h.files.get(TARGET)).toBe('two\n');
  });

  it('REQ-IDE-007 AC1: successful mutation reports the post-write hash', async () => {
    const h = makeHarness();
    const result = await tools(h).write.execute('write-hash', { path: TARGET, content: 'after\n' }, undefined, undefined, context());
    expect(h.files.get(TARGET)).toBe('after\n');
    expect(result.details).toMatchObject({ approvalId: OPAQUE_ID, postWriteSha256: sha256('after\n') });
  });

  it('REQ-IDE-007 AC1: Bash preserves the exact approved command and cwd', async () => {
    const h = makeHarness();
    const command = 'printf "%s" "$HOME" && pwd';
    h.setApproval((request) => {
      expect(request.preview).toEqual({ kind: 'bash', command, cwd: WORKSPACE });
      return { id: request.id, approved: true };
    });
    const result = await tools(h).bash.execute('bash-approved', { command }, undefined, undefined, context());
    expect(h.events).toContain(`exec:${WORKSPACE}:${command}`);
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('command output') })]));
  });

  it('REQ-IDE-007 AC2: rejected Bash starts no process', async () => {
    const h = makeHarness();
    h.setApproval((request) => ({ id: request.id, approved: false }));
    const result = await tools(h).bash.execute('bash-rejected', { command: 'touch should-not-exist' }, undefined, undefined, context());
    expect(text(result)).toMatch(/rejected|denied/i);
    expect(h.events.some((event) => event.startsWith('exec:'))).toBe(false);
  });

  it('REQ-IDE-007 AC2: guarded-name replacement by another source is blocked', async () => {
    const fixture = registered();
    fixture.pi.setSource('edit', { path: '/tmp/untrusted.ts', source: 'third-party', scope: 'project', origin: 'package' });
    const decision = await fixture.pi.emit({ type: 'tool_call', toolName: 'edit', toolCallId: 'replacement', input: { path: TARGET } });
    expect(decision).toMatchObject({ block: true });
    expect(String(decision?.reason)).toMatch(/owner|provenance|replacement/i);
    expect(fixture.harness.approvals).toHaveLength(0);
    expect(fixture.harness.files.get(TARGET)).toBe('before\n');
  });

  it('REQ-IDE-007 AC1: unknown and MCP tools use generic approval', async () => {
    for (const toolName of ['third_party_action', 'mcp__example__mutate']) {
      const fixture = registered();
      fixture.harness.setApproval((request) => {
        expect(request.preview).toEqual({ kind: 'generic', toolName, input: { value: 'exact' } });
        return { id: request.id, approved: false };
      });
      const decision = await fixture.pi.emit({ type: 'tool_call', toolName, toolCallId: `${toolName}-1`, input: { value: 'exact' } });
      expect(decision, toolName).toMatchObject({ block: true });
      expect(fixture.harness.approvals).toHaveLength(1);
    }
  });

  it('REQ-IDE-007 AC2: no-UI and nested approval attempts fail closed', async () => {
    const fixture = registered();
    const noUi = await fixture.pi.emit({ type: 'tool_call', toolName: 'mcp__example__mutate', toolCallId: 'no-ui', input: {} }, context({ hasUI: false, mode: 'json' }));
    expect(noUi).toMatchObject({ block: true });
    expect(fixture.harness.approvals).toHaveLength(0);

    let nested: ToolCallDecision = undefined;
    fixture.harness.setApproval(async (request) => {
      nested = await fixture.pi.emit({ type: 'tool_call', toolName: 'another_unknown_tool', toolCallId: 'nested', input: {} });
      return { id: request.id, approved: true };
    });
    await fixture.pi.emit({ type: 'tool_call', toolName: 'mcp__example__mutate', toolCallId: 'outer', input: {} });
    expect(nested).toMatchObject({ block: true });
    const nestedDecision = nested as { block: boolean; reason?: string } | undefined;
    expect(String(nestedDecision?.reason)).toMatch(/nested|pending|approval/i);
    expect(fixture.harness.approvals).toHaveLength(1);
  });
});
