import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HUB_REOPENED_PROMPT } from './hub-prompts';
import {
  askedQuestions,
  entriesOfHook,
  entriesOfLine,
  INPUT_TEXT_MAX,
  interruptedAt,
  PATCH_LINES_MAX,
  RESULT_TEXT_MAX,
  type TranscriptEntry,
  TranscriptEntry as EntrySchema,
} from './transcript';

// Lines of one real local session (Claude Code 2.1.310, #113 t113a), paths and noise redacted.
const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')
    .split('\n')
    .filter((l) => l !== '');
const SESSION = fixture('transcript.jsonl');
const SUBAGENT = fixture('transcript-subagent.jsonl');
const HOOKS = fixture('transcript-hooks.jsonl').map((l): unknown => JSON.parse(l));

const entries = (lines: readonly string[]) => lines.flatMap(entriesOfLine);
const ofKind = <K extends TranscriptEntry['kind']>(all: readonly TranscriptEntry[], kind: K) =>
  all.filter((e): e is Extract<TranscriptEntry, { kind: K }> => e.kind === kind);
const result = (all: readonly TranscriptEntry[], id: string) => {
  const found = ofKind(all, 'tool-result').find((e) => e.id === id);

  if (found === undefined) throw new Error(`no result ${id}`);

  return found;
};

/** One short line per entry: what Chat would draw, in order. */
const outline = (e: TranscriptEntry): string => {
  switch (e.kind) {
    case 'user':
      return `user ${e.text.slice(0, 24)}`;
    case 'assistant-text':
      return `text ${e.text.slice(0, 24)}`;
    case 'tool-use':
      return `use ${e.tool}`;
    case 'tool-result':
      return `result ${e.ok ? 'ok' : 'failed'}${e.patch === null ? '' : ` ${e.patch.added}+ ${e.patch.removed}-`}`;
    case 'compact':
      return `compact ${e.trigger}`;
    case 'changes':
      return `changes ${e.files.length}`;
  }
};

const EDIT = 'toolu_01BcFRMTDmLETz6QoitqnAxN';
const WRITE = 'toolu_01PcTzV24sxBFVccu5eBWzsT';
const CURL = 'toolu_01Vz5JKSAfLYScjJDx93v8R4';
const NPM = 'toolu_01FL41TRU9VW7s2q3ewHnRCD';

describe('a real session transcript', () => {
  const all = entries(SESSION);

  test('reads as the turns Chat draws, everything else dropped', () => {
    expect(all.map(outline)).toEqual([
      'user Work on card AB#2: The c',
      'use Bash',
      'result ok',
      'use Bash',
      'result ok',
      'text The failure reproduces: ',
      'use Agent',
      'result ok',
      'text The writer is running. I',
      'use Bash',
      'result failed',
      'user Next, do these yourself ',
      'use Read',
      'result ok',
      'use Bash',
      'use Write',
      'result ok',
      'result ok 11+ 0-',
      'use Bash',
      'result ok',
      'use Edit',
      'use Bash',
      'result ok 6+ 1-',
      'result ok',
      'use AskUserQuestion',
      'result ok',
      'use AskUserQuestion',
      'result ok',
      'use Agent',
      'use Bash',
      'result ok',
      'result failed',
      'user /compact',
      'compact manual',
    ]);
  });

  test('every entry is the schema the event carries', () => {
    for (const e of all) expect(EntrySchema.parse(e)).toEqual(e);
  });

  test("an Edit's result carries its patch: path, line numbers, three lines of context", () => {
    const patch = result(all, EDIT).patch;

    expect(patch).toMatchObject({
      path: '/work/demo-shop-wt/2-the-cart-total-ignores-quantity/api/src/cart.ts',
      created: false,
      added: 6,
      removed: 1,
      cut: 0,
    });
    expect(patch?.hunks).toHaveLength(1);
    expect(patch?.hunks[0]).toMatchObject({
      oldStart: 14,
      oldLines: 7,
      newStart: 14,
      newLines: 12,
    });
    expect(patch?.hunks[0]?.lines.slice(2, 5)).toEqual([
      '   const subtotal = cart.lines.reduce(',
      '-    (sum, line) => sum + line.price * line.quantity,',
      '+    (sum, line) => {',
    ]);
  });

  test('a Write that created a file is one hunk of added lines', () => {
    const patch = result(all, WRITE).patch;

    expect(patch).toMatchObject({ created: true, added: 11, removed: 0 });
    expect(patch?.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 11 });
    expect(patch?.hunks[0]?.lines[0]).toBe('+import { test } from "node:test";');
  });

  test('a command the sandbox refused is a failed result saying why', () => {
    const curl = result(all, CURL);

    expect(curl.ok).toBe(false);
    expect(curl.text).toStartWith('Exit code 56\ncurl: (56) CONNECT tunnel failed');
    expect(curl.text).toContain('deny network-outbound example.com:443');
  });

  test("the tool's call and its result share the call's id", () => {
    const uses = ofKind(all, 'tool-use').map((e) => e.id);
    const results = ofKind(all, 'tool-result').map((e) => e.id);

    expect(results.toSorted()).toEqual(uses.toSorted());
  });

  test('ids are unique per kind', () => {
    const keys = all.map((e) => `${e.kind} ${e.id}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  test('the compaction says how it was asked and how big the conversation was', () => {
    expect(ofKind(all, 'compact')).toEqual([
      {
        kind: 'compact',
        id: '223fae08-9608-4cd0-9033-7b57179809f5',
        at: '2026-10-24T00:48:43.475Z',
        agent: null,
        trigger: 'manual',
        preTokens: 70118,
      },
    ]);
  });

  test('a compaction of a trigger this build does not know says none', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'c',
      timestamp: 't',
      compactMetadata: { trigger: 'scheduled', preTokens: -1 },
    });

    expect(entriesOfLine(line)).toMatchObject([
      { kind: 'compact', trigger: null, preTokens: null },
    ]);
  });

  test("the session's own lines name no subagent", () => {
    expect(all.every((e) => e.agent === null)).toBe(true);
  });
});

describe("a subagent's transcript", () => {
  const all = entries(SUBAGENT);

  test('names the subagent on every entry and keeps its ids apart from the session', () => {
    expect(all.map(outline)).toEqual(['user Card AB#2 "The cart tota', 'use Bash', 'result ok']);
    expect(all.every((e) => e.agent === 'ae61a6f2394984d52')).toBe(true);
    const sessionIds = new Set(entries(SESSION).map((e) => e.id));

    expect(all.some((e) => sessionIds.has(e.id))).toBe(false);
  });
});

describe('dropped quietly', () => {
  test.each([
    ['not JSON', 'not json'],
    ['an empty line', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['no type', '{"uuid":"u"}'],
    ['no uuid', '{"type":"user","timestamp":"t","message":{"content":"hi"}}'],
    ['a kind Chat does not draw', '{"type":"ai-title","uuid":"u","aiTitle":"t"}'],
    ['a kind no build knows', '{"type":"hologram","uuid":"u","message":{"content":"x"}}'],
    [
      'a content of another shape',
      '{"type":"user","uuid":"u","timestamp":"t","message":{"content":7}}',
    ],
    [
      'a system line',
      '{"type":"system","uuid":"u","timestamp":"t","subtype":"turn_duration","durationMs":3}',
    ],
    ['a line with no time', '{"type":"user","uuid":"u","message":{"content":"hi"}}'],
    [
      'a command wrapper',
      '{"type":"user","uuid":"u","timestamp":"t","message":{"content":"<command-name>/exit</command-name>"}}',
    ],
    [
      "a subagent's hand-back",
      '{"type":"user","uuid":"u","timestamp":"t","isMeta":true,"origin":{"kind":"peer"},"message":{"content":"done"}}',
    ],
    [
      "a background subagent's hand-back sent as a prompt (t113b's real run)",
      '{"type":"user","uuid":"u","timestamp":"t","promptId":"p","message":{"content":"<agent-message from=\\"af9c\\">\\n[Subagent hand-back]"}}',
    ],
    [
      'the compact summary',
      '{"type":"user","uuid":"u","timestamp":"t","isCompactSummary":true,"message":{"content":"This session is…"}}',
    ],
    [
      'thinking',
      '{"type":"assistant","uuid":"u","timestamp":"t","message":{"content":[{"type":"thinking","thinking":"","signature":"s"}]}}',
    ],
    [
      'an empty text block',
      '{"type":"assistant","uuid":"u","timestamp":"t","message":{"content":[{"type":"text","text":"  "}]}}',
    ],
  ])('%s', (_, line) => {
    expect(entriesOfLine(line)).toEqual([]);
  });

  test("of the session's 49 recorded lines, those that are neither words nor tools", () => {
    const Kind = z.object({ type: z.string() });
    const empty = SESSION.filter((l) => entriesOfLine(l).length === 0).map(
      (l) => Kind.parse(JSON.parse(l)).type,
    );

    expect(new Set(empty)).toEqual(
      new Set([
        'mode',
        'permission-mode',
        'attachment',
        'ai-title',
        'assistant',
        'system',
        'queue-operation',
        'user',
        'file-history-delta',
      ]),
    );
  });
});

describe('your message', () => {
  const line = (content: string, more: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'user',
      uuid: 'line-1',
      promptId: 'prompt-1',
      timestamp: '2026-10-24T09:00:00.000Z',
      origin: { kind: 'human' },
      message: { role: 'user', content },
      ...more,
    });

  test('is its prompt id, with the implicit context split off to its first line', () => {
    const text = [
      'Handle a zero quantity too',
      '',
      'Context: api/src/cart.ts lines 12–18',
      '```ts',
      'export function cartTotal(cart: Cart): number {',
      '```',
    ].join('\n');

    expect(entriesOfLine(line(text))).toEqual([
      {
        kind: 'user',
        id: 'prompt-1',
        at: '2026-10-24T09:00:00.000Z',
        agent: null,
        text: 'Handle a zero quantity too',
        context: 'api/src/cart.ts lines 12–18',
      },
    ]);
  });

  test('without context has none', () => {
    expect(entriesOfLine(line('Also run the linter'))).toMatchObject([
      { text: 'Also run the linter', context: null },
    ]);
  });

  test('blank lines before it are left out: a grill round’s answers read from their first', () => {
    expect(
      entriesOfLine(line('\n\n1. Answer to "Where?": 1 Here\n2. Answer to "When?": 2 Now\n')),
    ).toMatchObject([{ text: '1. Answer to "Where?": 1 Here\n2. Answer to "When?": 2 Now\n' }]);
  });

  test("the Abe chat's start and reopen prompts are Abe's, never the person's", () => {
    expect(entriesOfLine(line('/abe:abe'))).toMatchObject([{ text: '/abe:abe', abe: true }]);
    expect(entriesOfLine(line(HUB_REOPENED_PROMPT))).toMatchObject([{ abe: true }]);
    expect(entriesOfLine(line('/abe:install'))[0]).not.toHaveProperty('abe');
  });

  test("the first mark in #115's form splits, not one inside the selected lines", () => {
    const text = [
      'Fix the doc',
      '',
      'Context: docs/notes.md lines 1–4',
      '```md',
      'Intro',
      '',
      'Context: not a mark',
      '```',
    ].join('\n');

    expect(entriesOfLine(line(text))).toMatchObject([
      { text: 'Fix the doc', context: 'docs/notes.md lines 1–4' },
    ]);
  });

  test.each([
    ['a caret', 'Context: api/src/cart.ts, caret on line 16'],
    ['a card', 'Context: story #2 The cart total ignores quantity'],
  ])('the context of %s', (_, context) => {
    expect(entriesOfLine(line(`Why?\n\n${context}`))).toMatchObject([
      { text: 'Why?', context: context.slice('Context: '.length) },
    ]);
  });

  test('a message starting with < is still yours', () => {
    expect(entriesOfLine(line('<Button> renders twice'))).toMatchObject([
      { text: '<Button> renders twice' },
    ]);
  });

  test('a message with an image is its text blocks', () => {
    const blocks = JSON.stringify({
      type: 'user',
      uuid: 'line-2',
      promptId: 'prompt-2',
      timestamp: 't',
      origin: { kind: 'human' },
      message: {
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'This is what I see' },
        ],
      },
    });

    expect(entriesOfLine(blocks)).toMatchObject([
      { kind: 'user', id: 'prompt-2', text: 'This is what I see' },
    ]);
  });

  test.each([
    ['Esc mid-turn', '[Request interrupted by user for tool use]'],
    ['a reminder', '<system-reminder>x</system-reminder>'],
  ])('%s is not a message', (_, content) => {
    expect(entriesOfLine(line(content))).toEqual([]);
  });

  test("a peer's message is not yours", () => {
    expect(entriesOfLine(line('report', { origin: { kind: 'peer' } }))).toEqual([]);
  });

  // Claude Code runs no hook when you press Esc mid-turn: only this line says the turn stopped.
  test.each([
    ['Esc mid-turn', line('[Request interrupted by user]'), '2026-10-24T09:00:00.000Z'],
    [
      'Esc on a tool call, in text blocks',
      JSON.stringify({
        type: 'user',
        uuid: 'line-1',
        timestamp: '2026-10-24T09:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
        },
      }),
      '2026-10-24T09:00:00.000Z',
    ],
    ["a subagent's", line('[Request interrupted by user]', { isSidechain: true }), undefined],
    ['your message', line('Go on'), undefined],
    ['not JSON', 'nope', undefined],
  ])('%s: when the turn was interrupted', (_, text, at) => {
    expect(interruptedAt(text)).toBe(at);
  });

  // Claude Code 2.1.310 (#197): a message typed while a turn runs is taken at the next tool result
  // as a `queued_command` attachment (the session's real line, its text shortened), not a user line.
  const queued = (prompt: string, more: Record<string, unknown> = {}) =>
    JSON.stringify({
      parentUuid: '4f63b380',
      isSidechain: false,
      attachment: {
        type: 'queued_command',
        prompt,
        source_uuid: '3f7341f3',
        delivery_id: '4445a469',
        commandMode: 'prompt',
        origin: { kind: 'human' },
        timestamp: '2026-10-24T12:57:21.476Z',
        humanTurn: true,
        ...more,
      },
      type: 'attachment',
      uuid: 'd2dd3e97',
      timestamp: '2026-10-24T12:57:21.476Z',
    });

  test('taken mid-turn (#197): its queued_command is your message, under its own uuid', () => {
    expect(entriesOfLine(queued('Also: after echo one, run `echo extra` too.'))).toEqual([
      {
        kind: 'user',
        id: 'd2dd3e97',
        at: '2026-10-24T12:57:21.476Z',
        agent: null,
        text: 'Also: after echo one, run `echo extra` too.',
        context: null,
      },
    ]);
  });

  test.each([
    ['a task notice', { commandMode: 'task-notification', origin: { kind: 'task' } }],
    ["another's", { origin: { kind: 'peer' } }],
  ])('a queued_command that is %s: not yours', (_, more) => {
    expect(entriesOfLine(queued('<task-notification>done</task-notification>', more))).toEqual([]);
  });

  test("a long paste in Claude Code's pasted_content marks (#197): your words and context only", () => {
    const words = `${'filler '.repeat(150)}KIWI`;
    const pasted = `<pasted_content id="6551">\n${words}\n\nContext: README.md line 3\n\`\`\`md\nThe cart.\n\`\`\`\n</pasted_content id="6551">`;

    expect(entriesOfLine(queued(pasted))).toMatchObject([
      { text: words, context: 'README.md line 3' },
    ]);
    expect(entriesOfLine(line(pasted))).toMatchObject([
      { text: words, context: 'README.md line 3' },
    ]);
  });
});

describe('caps', () => {
  const resultLine = (content: string) =>
    JSON.stringify({
      type: 'user',
      uuid: 'u',
      timestamp: 't',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] },
    });

  test("a long output keeps its head and its tail (where a test run's summary is)", () => {
    const output = `${'x'.repeat(5000)}\nTests 1 failed | 10 passed`;
    const [entry] = ofKind(entriesOfLine(resultLine(output)), 'tool-result');

    expect(entry?.cut).toBe(output.length - RESULT_TEXT_MAX);
    expect(entry?.text).toStartWith('x'.repeat(1000));
    expect(entry?.text).toEndWith('Tests 1 failed | 10 passed');
    expect(entry?.text).toContain(`… ${output.length - RESULT_TEXT_MAX} characters cut …`);
  });

  test('a short output is kept whole', () => {
    expect(entriesOfLine(resultLine('ok'))).toMatchObject([{ text: 'ok', cut: 0, ok: true }]);
  });

  test("a call's long string inputs are cut, the rest kept", () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'u',
      timestamp: 't',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'Write',
            input: {
              file_path: '/w/a.ts',
              content: 'y'.repeat(9000),
              lines: [1, { deep: 'z'.repeat(3000) }],
            },
          },
        ],
      },
    });
    const [use] = ofKind(entriesOfLine(line), 'tool-use');

    expect(use?.input.file_path).toBe('/w/a.ts');
    expect(use?.input.content).toBe(`${'y'.repeat(INPUT_TEXT_MAX)}…`);
    expect(use?.input.lines).toEqual([1, { deep: `${'z'.repeat(INPUT_TEXT_MAX)}…` }]);
  });

  test("a patch's long line is cut like an input string", () => {
    const [entry] = entriesOfHook(
      {
        hook_event_name: 'PostToolUse',
        tool_use_id: 'toolu_4',
        tool_response: { filePath: '/w/min.js', type: 'create', content: 'q'.repeat(9000) },
      },
      't',
    );

    expect(entry?.kind === 'tool-result' ? entry.patch?.hunks[0]?.lines : null).toEqual([
      `+${'q'.repeat(INPUT_TEXT_MAX - 1)}…`,
    ]);
  });

  test('a patch keeps its first lines and counts every line', () => {
    const many = Array.from({ length: PATCH_LINES_MAX + 50 }, (_, i) => `+line ${i}`);
    const [entry] = entriesOfHook(
      {
        hook_event_name: 'PostToolUse',
        tool_use_id: 'toolu_3',
        tool_response: {
          filePath: '/w/big.ts',
          structuredPatch: [
            { oldStart: 1, oldLines: 0, newStart: 1, newLines: many.length, lines: many },
          ],
        },
      },
      't',
    );

    expect(entry).toMatchObject({ patch: { added: many.length, removed: 0, cut: 50 } });
    expect(entry?.kind === 'tool-result' ? entry.patch?.hunks[0]?.lines.length : 0).toBe(
      PATCH_LINES_MAX,
    );
  });
});

describe('hook payloads', () => {
  const at = '2026-10-24T00:40:07.743Z';
  const hooked = HOOKS.flatMap((p) => entriesOfHook(p, at));
  const lined = entries(SESSION);
  const sameAs = (e: TranscriptEntry) => lined.find((l) => l.kind === e.kind && l.id === e.id);

  test('give the running call, its result and your message, under the ids the JSONL uses', () => {
    expect(hooked.map(outline)).toEqual([
      'user Work on card AB#2: The c',
      'use Bash',
      'result ok',
      'result ok 6+ 1-',
      'result ok 11+ 0-',
      'result failed',
      'use AskUserQuestion',
      'use Bash',
    ]);
    // The subagent's call is in its own file, not the session's.
    for (const e of hooked.filter((h) => h.agent === null)) expect(sameAs(e)).toBeDefined();
  });

  test("PreToolUse's call is the JSONL's call", () => {
    const fromHook = hooked.find((e) => e.kind === 'tool-use' && e.id === NPM);
    const fromLine = lined.find((e) => e.kind === 'tool-use' && e.id === NPM);

    expect(fromHook).toEqual(fromLine === undefined ? undefined : { ...fromLine, at });
  });

  test("PostToolUse's patch is the JSONL's patch", () => {
    const fromHook = hooked.find((e) => e.kind === 'tool-result' && e.id === EDIT);
    const fromLine = result(lined, EDIT);

    expect(fromHook?.kind === 'tool-result' ? fromHook.patch : null).toEqual(fromLine.patch);
  });

  test("PostToolUseFailure is a failed result with the tool's error", () => {
    expect(hooked.find((e) => e.id === CURL && e.kind === 'tool-result')).toMatchObject({
      ok: false,
      patch: null,
    });
  });

  test("a subagent's call names it", () => {
    expect(hooked.at(-1)).toMatchObject({ kind: 'tool-use', agent: 'ae61a6f2394984d52' });
  });

  test('UserPromptSubmit splits the context off as the JSONL line does', () => {
    expect(
      entriesOfHook(
        {
          hook_event_name: 'UserPromptSubmit',
          prompt_id: 'p9',
          prompt: 'Why?\n\nContext: api/src/cart.ts, caret on line 16',
        },
        at,
      ),
    ).toEqual([
      {
        kind: 'user',
        id: 'p9',
        at,
        agent: null,
        text: 'Why?',
        context: 'api/src/cart.ts, caret on line 16',
      },
    ]);
  });

  test.each([
    ['Stop', { hook_event_name: 'Stop', last_assistant_message: 'done' }],
    ['Notification', { hook_event_name: 'Notification', notification_type: 'permission_prompt' }],
    ['a PreToolUse without its id', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }],
    ['not a payload', 'nope'],
  ])('%s gives none', (_, payload) => {
    expect(entriesOfHook(payload, at)).toEqual([]);
  });
});

describe('AskUserQuestion', () => {
  const asked = (id: string) => {
    const use = ofKind(entries(SESSION), 'tool-use').find((e) => e.id === id);

    return askedQuestions(use?.input);
  };

  test('one question: options in order, the recommended one marked and its label clean', () => {
    expect(asked('toolu_017F2HZyFcUQbLXoGbdf7FtZ')).toEqual([
      {
        question: 'Which market table should the cart total read for VAT?',
        header: 'VAT table',
        multiSelect: false,
        options: [
          {
            label: 'Existing MARKETS',
            note: 'Keep reading the MARKETS table in api/src/markets.ts through marketFor (se 25%, no 25%, fi 25.5%).',
            recommended: true,
          },
          {
            label: 'Separate VAT-rate table',
            note: 'Add a table that holds only VAT rates per market, kept apart from other market data.',
            recommended: false,
          },
          {
            label: 'Config file',
            note: 'Load market VAT rates from a JSON config file, so rates change without a code edit.',
            recommended: false,
          },
        ],
      },
    ]);
  });

  test('a grill round: several questions in one call, from the PreToolUse payload too', () => {
    const pre = HOOKS.find(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        'tool_name' in p &&
        p.tool_name === 'AskUserQuestion',
    );
    const fromHook = askedQuestions(
      typeof pre === 'object' && pre !== null && 'tool_input' in pre ? pre.tool_input : null,
    );

    expect(fromHook?.map((q) => q.header)).toEqual(['Location', 'Missing']);
    expect(fromHook?.map((q) => q.options.find((o) => o.recommended)?.label)).toEqual([
      'New api/src/vat.ts',
      'Throw an error',
    ]);
    expect(asked('toolu_01PQPfPABvnGVN6hkEGS2gYE')).toEqual(fromHook);
  });

  test.each([
    ['another tool', { command: 'ls' }],
    ['nothing', undefined],
  ])('%s is not a question', (_, input) => {
    expect(askedQuestions(input)).toBeNull();
  });
});
