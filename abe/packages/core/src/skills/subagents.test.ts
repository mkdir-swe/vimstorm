import { describe, expect, test } from 'bun:test';
import { CORE_SKILLS } from './skills';
import {
  type AgentHook,
  subagentRunning,
  agentFile,
  allowedModel,
  allows,
  oneLine,
  type SessionModels,
  sessionModels,
  sessionPlugin,
  type Subagents,
  subagentsAfter,
  subagentText,
} from './subagents';

test.each([
  [['opus'], ['opus', 'sonnet', 'haiku'], 'opus'],
  [['sonnet', 'haiku'], ['opus', 'sonnet', 'haiku'], 'sonnet'],
  [['sonnet', 'haiku'], ['opus', 'haiku'], 'haiku'],
  [['opus'], ['sonnet'], 'sonnet'],
  [['opus'], ['sonnet', 'haiku'], 'sonnet'],
  [['sonnet', 'haiku'], ['opus'], 'opus'],
  [['opus'], ['claude-sonnet-4-6', 'claude-opus-4-7'], 'claude-opus-4-7'],
])('allowedModel(%o, %o) → %s', (wants, allowed, model) => {
  expect(allowedModel(wants, allowed)).toBe(model);
});

test.each([
  [['sonnet'], 'sonnet', true],
  [['sonnet'], 'claude-sonnet-4-6', true],
  [['claude-sonnet-4-6'], 'sonnet', true],
  [['sonnet'], 'opus', false],
  [['sonnet', 'haiku'], 'claude-haiku-4-5', true],
  [['claude-opus-4-7'], 'claude-sonnet-4-6', false],
])('allows(%o, %s) → %p', (allowed, model, yes) => {
  expect(allows(allowed, model)).toBe(yes);
});

test('sessionModels: Opus for the coordinator and writers, Sonnet for readers; lowered to Sonnet, all Sonnet', () => {
  expect(sessionModels(['opus', 'sonnet', 'haiku'])).toEqual({
    coordinator: 'opus',
    reader: 'sonnet',
    writer: 'opus',
  });
  expect(sessionModels(['sonnet'])).toEqual({
    coordinator: 'sonnet',
    reader: 'sonnet',
    writer: 'sonnet',
  });
  expect(sessionModels(['haiku', 'opus'])).toMatchObject({ reader: 'haiku', writer: 'opus' });
});

test("sessionModels with the Layers' models.*: each asked one where allowed, else the first allowed (#350)", () => {
  const all = { coordinator: 'haiku', reader: 'haiku', writer: 'haiku' };

  expect(sessionModels(['opus', 'sonnet', 'haiku'], all)).toEqual(all);
  expect(
    sessionModels(['opus', 'sonnet'], { coordinator: 'sonnet', reader: 'haiku', writer: 'opus' }),
  ).toEqual({ coordinator: 'sonnet', reader: 'opus', writer: 'opus' });
  // a family name asked, a full id allowed: the allowed one
  expect(sessionModels(['claude-haiku-5-5'], all).coordinator).toBe('claude-haiku-5-5');
});

const frontmatter = (text: string) =>
  Object.fromEntries(
    (/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '')
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]),
  );

describe('the agent files', () => {
  test('reader: read-only tools, no editing tools, on its model', () => {
    const f = agentFile('reader', 'haiku');

    expect(f.path).toBe('agents/reader.md');
    expect(frontmatter(f.text)).toMatchObject({
      name: 'reader',
      model: 'haiku',
      tools: 'Read, Grep, Glob, Bash, WebFetch, WebSearch',
      disallowedTools: 'Edit, Write, NotebookEdit',
    });
    expect(f.text).toContain('Edit no file, commit nothing');
  });

  test('writer: its own worktree, on its model, replies with its branch and path', () => {
    const f = agentFile('writer', 'opus');

    expect(frontmatter(f.text)).toMatchObject({
      name: 'writer',
      model: 'opus',
      isolation: 'worktree',
    });
    expect(frontmatter(f.text)).not.toHaveProperty('tools');
    expect(f.text).toContain('your branch, your worktree path');
  });

  test('writer: says each check it ran with its exit, and one that could not run as not run (#151)', () => {
    const f = agentFile('writer', 'opus');

    expect(f.text).toContain('each command you ran with its exit code');
    expect(f.text).toContain('`not run`');
    expect(f.text).toContain('never as a pass');
  });

  test("the session's plugin: the manifest named abe, core's skills, both agents on the session's models", () => {
    const files = sessionPlugin({ coordinator: 'sonnet', reader: 'sonnet', writer: 'sonnet' });

    expect(files.map((f) => f.path)).toEqual([
      '.claude-plugin/plugin.json',
      ...CORE_SKILLS.map((f) => f.path),
      'agents/reader.md',
      'agents/writer.md',
    ]);
    expect(files.map((f) => f.path)).toContain('skills/factory/SKILL.md');
    expect(JSON.parse(files[0]?.text ?? '')).toMatchObject({ name: 'abe' });
    expect(frontmatter(files.at(-1)?.text ?? '').model).toBe('sonnet');
  });
});

describe('subagentRunning: a run the coordinator may wait on', () => {
  const run = (state: 'running' | 'done', startedAt: string) => ({
    id: 'a1',
    name: 'abe:writer',
    task: null,
    model: 'opus',
    state,
    startedAt,
    endedAt: null,
    result: null,
  });

  test.each<[string, ReturnType<typeof run>[], boolean]>([
    ['none', [], false],
    ['one running, started now', [run('running', '2026-10-23T03:00:00.000Z')], true],
    ['one done', [run('done', '2026-10-23T03:00:00.000Z')], false],
    // Its SubagentStop never came (a crash, a serve restart): it stops counting after an hour.
    ['running past SUBAGENT_RUN_MAX_MS', [run('running', '2026-10-23T01:59:59.000Z')], false],
  ])('%s', (_, runs, running) => {
    expect(subagentRunning(runs, '2026-10-23T03:00:00.000Z')).toBe(running);
  });
});

describe('subagentsAfter: runs from the hooks', () => {
  const models: SessionModels = { coordinator: 'opus', reader: 'sonnet', writer: 'opus' };
  const o = (at: string) => ({ at, models, allowed: ['opus', 'sonnet', 'haiku'] });
  const empty: Subagents = { calls: [], runs: [] };
  const agentCall = (input: Record<string, string>) => ({
    tool_name: 'Agent',
    tool_input: input,
  });

  const play = (steps: [string, AgentHook, string][], allowed?: string[]) => {
    let book = empty;
    const changed = [];

    for (const [event, doc, at] of steps) {
      const next = subagentsAfter(book, event, doc, {
        ...o(at),
        ...(allowed === undefined ? {} : { allowed }),
      });

      book = next.book;
      if (next.changed !== undefined) changed.push(next.changed);
    }

    return { book, changed };
  };

  const T1 = '2026-10-24T01:00:00.000Z';
  const T2 = '2026-10-24T01:02:00.000Z';

  test("a writer: start then stop, on its definition's model, with its task and result", () => {
    const { book, changed } = play([
      ['PreToolUse', agentCall({ subagent_type: 'abe:writer', description: 'Stock badge' }), T1],
      ['SubagentStart', { agent_id: 'a1', agent_type: 'abe:writer' }, T1],
      [
        'SubagentStop',
        {
          agent_id: 'a1',
          agent_type: 'abe:writer',
          last_assistant_message: '\nBranch worktree-a1, 2 commits.\nMore detail.',
        },
        T2,
      ],
    ]);

    expect(changed.map((r) => r.state)).toEqual(['running', 'done']);
    expect(book).toEqual({
      calls: [],
      runs: [
        {
          id: 'a1',
          name: 'abe:writer',
          task: 'Stock badge',
          model: 'opus',
          state: 'done',
          startedAt: T1,
          endedAt: T2,
          result: 'Branch worktree-a1, 2 commits.',
          tool: null,
          tools: 0,
          call: null,
          transcript: null,
        },
      ],
    });
  });

  test("a call's own model wins; one the allowed models lack runs on the coordinator's", () => {
    const { book } = play([
      ['PreToolUse', agentCall({ subagent_type: 'abe:reader', model: 'haiku' }), T1],
      ['PreToolUse', agentCall({ subagent_type: 'abe:writer', model: 'opus' }), T1],
      ['SubagentStart', { agent_id: 'a1', agent_type: 'abe:reader' }, T1],
      ['SubagentStart', { agent_id: 'a2', agent_type: 'abe:writer' }, T1],
    ]);

    expect(book.runs.map((r) => [r.id, r.model])).toEqual([
      ['a1', 'haiku'],
      ['a2', 'opus'],
    ]);
    const lowered = subagentsAfter(
      { calls: [{ type: 'abe:writer', model: 'opus', task: null }], runs: [] },
      'SubagentStart',
      { agent_id: 'a3', agent_type: 'abe:writer' },
      {
        at: T1,
        models: { coordinator: 'sonnet', reader: 'sonnet', writer: 'sonnet' },
        allowed: ['sonnet'],
      },
    );

    expect(lowered.changed?.model).toBe('sonnet');
  });

  test('another agent with no model named: its own model, unknown; a stop with no start still lists it', () => {
    const { book } = play([
      ['PreToolUse', agentCall({ subagent_type: 'Explore' }), T1],
      ['SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }, T1],
      [
        'SubagentStop',
        { agent_id: 'a9', agent_type: 'abe:reader', last_assistant_message: 'ok' },
        T2,
      ],
    ]);

    expect(book.runs.map((r) => [r.id, r.name, r.model, r.state])).toEqual([
      ['a1', 'Explore', null, 'running'],
      ['a9', 'abe:reader', 'sonnet', 'done'],
    ]);
  });

  test('a denied Agent call, or one a turn ended without, never lends its model to a later start', () => {
    const { book } = play([
      ['PreToolUse', agentCall({ subagent_type: 'abe:writer', model: 'haiku' }), T1],
      ['PermissionDenied', agentCall({ subagent_type: 'abe:writer', model: 'haiku' }), T1],
      ['PreToolUse', agentCall({ subagent_type: 'abe:reader', model: 'haiku' }), T1],
      ['Stop', { last_assistant_message: 'x' }, T1],
      ['PreToolUse', agentCall({ subagent_type: 'abe:writer', description: 'Real' }), T2],
      ['SubagentStart', { agent_id: 'a1', agent_type: 'abe:writer' }, T2],
      ['SubagentStart', { agent_id: 'a2', agent_type: 'abe:reader' }, T2],
    ]);

    expect(book.calls).toEqual([]);
    expect(book.runs.map((r) => [r.id, r.task, r.model])).toEqual([
      ['a1', 'Real', 'opus'],
      ['a2', null, 'sonnet'],
    ]);
  });

  test("Claude Code's own helpers (no agent type, no start) are no runs", () => {
    expect(
      play([
        [
          'SubagentStop',
          { agent_id: 'h1', agent_type: '', last_assistant_message: 'Adding a line' },
          T1,
        ],
        ['SubagentStart', { agent_id: 'h2', agent_type: '' }, T1],
      ]),
    ).toEqual({ book: empty, changed: [] });
  });

  test("a subagent's own tool calls: its last tool and count; its Agent call and transcript kept", () => {
    const { book, changed } = play([
      [
        'PreToolUse',
        {
          ...agentCall({ subagent_type: 'abe:reader', description: 'Read cart' }),
          tool_use_id: 'toolu_1',
        },
        T1,
      ],
      [
        'SubagentStart',
        { agent_id: 'a1', agent_type: 'abe:reader', transcript_path: '/p/s1.jsonl' },
        T1,
      ],
      [
        'PreToolUse',
        {
          agent_id: 'a1',
          agent_type: 'abe:reader',
          tool_name: 'Read',
          tool_input: { file_path: '/w/api/cart.ts' },
        },
        T1,
      ],
      [
        'PreToolUse',
        {
          agent_id: 'a1',
          agent_type: 'abe:reader',
          tool_name: 'Bash',
          tool_input: { command: 'git status\nls' },
        },
        T2,
      ],
      // the coordinator's own tool call is no subagent's
      ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, T2],
    ]);

    expect(book.runs.map((r) => [r.tool, r.tools, r.call, r.transcript])).toEqual([
      ['Bash git status', 2, 'toolu_1', '/p/s1/subagents/agent-a1.jsonl'],
    ]);
    expect(changed.map((r) => r.tool)).toEqual([null, 'Read cart.ts', 'Bash git status']);
    expect(subagentRunning(book.runs, T2)).toBe(true);
  });

  test('other hooks and other tools change nothing', () => {
    expect(
      play([
        ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, T1],
        ['Stop', { last_assistant_message: 'x' }, T1],
        ['SubagentStart', { agent_type: 'abe:reader' }, T1],
      ]),
    ).toEqual({ book: empty, changed: [] });
  });
});

test.each([
  ['one line', 'one line'],
  ['\n\n  first  \nsecond', 'first'],
  ['', null],
  ['x'.repeat(200), `${'x'.repeat(159)}…`],
])('oneLine(%j) → %j', (message, line) => {
  expect(oneLine(message)).toBe(line);
});

test('subagentText', () => {
  expect(
    subagentText({
      name: 'abe:reader',
      task: 'find the form',
      model: 'sonnet',
      state: 'done',
      result: 'web/src/Form.tsx',
    }),
  ).toBe('abe:reader on sonnet done (find the form): web/src/Form.tsx');
});
