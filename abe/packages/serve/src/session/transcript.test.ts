/**
 * Chat's transcript in `serve` (#113, slice t113b). `startTranscripts` on the real port
 * (`transcriptFiles` with `sh` and `git` on this machine): t113a's real session lines appended to
 * a transcript file as Claude Code writes them, its real hook payloads, and a real git worktree
 * whose files a Bash-style write changes. Then the CLI seam: a launched session (the fake
 * `claude` in a real `tmux`) through `abe watch`, `abe session transcript` and `abe session
 * revert`; and a box's events merged into the Mac's watch, tagged with the box.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type Box,
  type BoxLink,
  type Event,
  EventLine,
  type EventData,
  journal,
  type RunTree,
  SessionData,
  SessionMeta,
  SessionRevertData,
  SessionTranscriptData,
  type TranscriptEntry,
  type UiNode,
} from '@abe/core';
import { localExec, localRunTree, TAIL_BYTES_MAX, transcriptFiles } from '@abe/ports';
import {
  card,
  cli,
  type Cli,
  fakeAdo,
  type FakeAdo,
  fakeAz,
  type FakeAz,
  fakeBoard,
  fakeClaude,
  type FakeClaude,
  fakeClock,
  scenario,
  scriptClaude,
  type Streaming,
  tmuxPath,
  until,
  installDone,
} from '@abe/testing';
import { asTrees, BridgeFrame } from '@abe/ui';
import { startBoxFront } from '../box/boxes';
import { startTranscripts, type Transcripts } from './transcript';

// Lines of t113a's real local session (Claude Code 2.1.310), redacted: core's parser fixtures.
const FIXTURES = join(import.meta.dir, '..', '..', '..', 'core', 'src', 'session', 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((l) => l !== '');
const LINES = fixture('transcript.jsonl');
const HOOKS = fixture('transcript-hooks.jsonl').map((l) =>
  z.looseObject({ hook_event_name: z.string() }).parse(JSON.parse(l)),
);
const CLAUDE = '35ea9758-7b7c-4692-8c62-64d3cc96ea80';
const PROMPT = 'c45ad618-f20e-42a6-b60d-f8331eaf823a';
const NPM = 'toolu_01FL41TRU9VW7s2q3ewHnRCD';

const hookAt = (i: number) => {
  const h = HOOKS[i];

  if (h === undefined) throw new Error(`no hook fixture ${i}`);

  return h;
};

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

type Place = {
  root: string;
  home: string;
  stateDir: string;
  worktree: string;
  transcript: string;
  meta: SessionMeta;
  events: EventData<'session.transcript'>[];
  logs: string[];
  /** The interrupts the follower told, by session and the line's time. */
  interrupts: string[];
  start: () => Transcripts;
};

/** A session's place: its home with the transcript's folder, a worktree with one commit. */
const place = (): Place => {
  const root = mkdtempSync(join(tmpdir(), 'abe-t-'));
  const home = join(root, 'home');
  const worktree = join(root, 'wt');
  const transcript = join(home, '.claude', 'projects', '-work-demo', `${CLAUDE}.jsonl`);

  mkdirSync(join(home, '.claude', 'projects', '-work-demo'), { recursive: true });
  mkdirSync(join(worktree, 'api', 'src'), { recursive: true });
  git(worktree, 'init', '-q', '-b', 'main');
  writeFileSync(join(worktree, '.gitignore'), 'node_modules/\n');
  writeFileSync(
    join(worktree, 'api', 'src', 'cart.ts'),
    [
      'export const total = (lines) =>',
      '  lines.reduce((sum, line) => sum + line.price, 0);',
      '',
    ].join('\n'),
  );
  writeFileSync(join(worktree, 'README.md'), '# demo\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', 'first');
  const at = new Date(0).toISOString();
  const meta = SessionMeta.parse({
    v: 1,
    id: '2-a1b2',
    card: 2,
    title: 'The cart total ignores quantity',
    repo: worktree,
    worktree,
    branch: 'main',
    state: 'working',
    since: at,
    startedAt: at,
    transcriptPath: transcript,
    lastAssistantMessage: null,
    claudeSession: CLAUDE,
    socket: join(root, 'session.sock'),
  });
  const events: EventData<'session.transcript'>[] = [];
  const logs: string[] = [];
  const interrupts: string[] = [];
  const p: Place = {
    root,
    home,
    stateDir: join(root, 'state'),
    worktree,
    transcript,
    meta,
    events,
    logs,
    interrupts,
    start: () =>
      startTranscripts({
        stateDir: p.stateDir,
        files: () =>
          transcriptFiles(localExec({ PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: home })),
        home,
        meta: (id) => (id === p.meta.id ? p.meta : undefined),
        clock: fakeClock(),
        emit: (data) => events.push(data),
        log: (message) => logs.push(message),
        interrupted: (id, at) => interrupts.push(`${id} ${at}`),
        everyMs: 3_600_000,
      }),
  };

  writeFileSync(transcript, '');

  return p;
};

const append = (p: Place, ...lines: string[]) => {
  appendFileSync(p.transcript, lines.map((l) => `${l}\n`).join(''));
};

/** A user line as Claude Code writes one: its uuid, its turn's promptId, your words. */
const userLine = (uuid: string, promptId: string, at: string, text: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    promptId,
    timestamp: at,
    origin: { kind: 'human' },
    message: { role: 'user', content: text },
  });
/** The agent's words as Claude Code writes them. */
const textLine = (uuid: string, at: string, text: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: at,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

const line = (i: number) => {
  const l = LINES[i];

  if (l === undefined) throw new Error(`no line ${i}`);

  return l;
};

const outline = (e: TranscriptEntry) =>
  e.kind === 'tool-use' || e.kind === 'tool-result' || e.kind === 'user' || e.kind === 'changes'
    ? `${e.kind} ${e.id.slice(0, 13)}`
    : e.kind;

/** Every entry as the events built it: each put at its number, as a reader of the watch does. */
const replay = (events: readonly EventData<'session.transcript'>[]) => {
  const list: TranscriptEntry[] = [];

  for (const e of events) {
    expect(e.from).toBeLessThanOrEqual(list.length);
    list.splice(e.from, e.entries.length, ...e.entries);
  }

  return list;
};

const answered = async (t: Transcripts, id: string, since = 0) => {
  const read = await t.read(id, since);

  if (!read.ok) throw new Error(JSON.stringify(read.error));

  return read.data;
};

describe('the transcript file followed, with the hooks before it', () => {
  let p: Place;
  let t: Transcripts;

  beforeEach(() => {
    p = place();
    t = p.start();
  });

  const cleanUp = async () => {
    await t.close();
    rmSync(p.root, { recursive: true, force: true });
  };

  test("a hook's entries first, the JSONL's of the same kind and id in their place", async () => {
    try {
      await t.hook(p.meta.id, 'UserPromptSubmit', hookAt(0));
      // The JSONL has the turn's start (the user line, the agent's thinking) when the call starts.
      append(p, line(0), line(1), line(2), line(3), line(4), line(5));
      await t.hook(p.meta.id, 'PreToolUse', hookAt(1));
      expect(replay(p.events).map(outline)).toEqual([
        `user ${PROMPT.slice(0, 13)}`,
        `tool-use ${NPM.slice(0, 13)}`,
      ]);
      await t.hook(p.meta.id, 'PostToolUse', hookAt(2));
      // The same call and its result, written after the hooks.
      append(p, line(8), line(9));
      // Read on (here by a read, else the next hook or the timer): the JSONL's replace the hooks'.
      const read = await answered(t, p.meta.id);
      const list = replay(p.events);

      expect(read.entries).toEqual(list);

      expect(list.map(outline)).toEqual([
        `user ${PROMPT.slice(0, 13)}`,
        `tool-use ${NPM.slice(0, 13)}`,
        `tool-result ${NPM.slice(0, 13)}`,
      ]);
      // The user entry is the JSONL's now (its time), the call's input the JSONL's too.
      expect(list[0]?.at).toBe(
        z.object({ timestamp: z.string() }).parse(JSON.parse(line(2))).timestamp,
      );
      // `--since` answers the same numbers the events said.
      expect(await answered(t, p.meta.id, 1)).toEqual({
        session: p.meta.id,
        from: 1,
        entries: list.slice(1),
      });
      expect(await answered(t, p.meta.id, 9)).toEqual({ session: p.meta.id, from: 9, entries: [] });
    } finally {
      await cleanUp();
    }
  });

  test('Esc mid-turn (no hook comes): told once as read, never from before a restart', async () => {
    try {
      const esc = (uuid: string, at: string) =>
        JSON.stringify({
          type: 'user',
          uuid,
          promptId: PROMPT,
          timestamp: at,
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Request interrupted by user]' }],
          },
        });

      // followed from its start (its first hook), as a live session is
      await answered(t, p.meta.id);
      append(p, line(2), esc('esc-1', '2026-10-28T06:00:43.928Z'));
      await answered(t, p.meta.id);
      // read on again: the same line is not told twice
      await answered(t, p.meta.id);
      expect(p.interrupts).toEqual([`${p.meta.id} 2026-10-28T06:00:43.928Z`]);
      // a restart reads the whole file in: what happened before it is not told
      await t.close();
      t = p.start();
      await answered(t, p.meta.id);
      expect(p.interrupts).toHaveLength(1);
      append(p, esc('esc-2', '2026-10-28T06:05:00.000Z'));
      await answered(t, p.meta.id);
      expect(p.interrupts.at(-1)).toBe(`${p.meta.id} 2026-10-28T06:05:00.000Z`);
    } finally {
      await cleanUp();
    }
  });

  test('a partial last line waits for the rest of it', async () => {
    try {
      const whole = line(2);

      appendFileSync(p.transcript, whole.slice(0, 200));
      expect((await answered(t, p.meta.id)).entries).toEqual([]);
      appendFileSync(p.transcript, `${whole.slice(200)}\n`);
      expect((await answered(t, p.meta.id)).entries.map(outline)).toEqual([
        `user ${PROMPT.slice(0, 13)}`,
      ]);
      expect(replay(p.events).map(outline)).toEqual([`user ${PROMPT.slice(0, 13)}`]);
    } finally {
      await cleanUp();
    }
  });

  test("a line longer than one read (a big Edit's originalFile) is read whole, the tail goes on", async () => {
    try {
      const big = z.looseObject({}).parse(JSON.parse(line(9)));

      big.toolUseResult = { originalFile: 'x'.repeat(TAIL_BYTES_MAX + 1_000_000) };
      append(p, line(2), line(8), JSON.stringify(big));
      expect((await answered(t, p.meta.id)).entries.map(outline)).toEqual([
        `user ${PROMPT.slice(0, 13)}`,
        `tool-use ${NPM.slice(0, 13)}`,
        `tool-result ${NPM.slice(0, 13)}`,
      ]);
      // The lines after it are read on as before.
      append(p, line(10));
      expect((await answered(t, p.meta.id)).entries.length).toBeGreaterThan(3);
    } finally {
      await cleanUp();
    }
  });

  test('the whole session read, then read again after a restart from the file alone', async () => {
    try {
      append(p, ...LINES);
      const first = await answered(t, p.meta.id);

      expect(first.entries.length).toBeGreaterThan(20);
      expect(new Set(first.entries.map((e) => e.kind))).toEqual(
        new Set(['user', 'assistant-text', 'tool-use', 'tool-result', 'compact']),
      );
      await t.close();
      p.events.length = 0;
      t = p.start();
      expect(await answered(t, p.meta.id)).toEqual(first);
      // Read in silently: a watcher after a restart reads with --since.
      expect(p.events).toEqual([]);
    } finally {
      await cleanUp();
    }
  });

  test("a subagent's own file is read too, its entries tagged with it", async () => {
    try {
      const dir = join(p.transcript.replace(/\.jsonl$/, ''), 'subagents');

      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'agent-ae61a6f2394984d52.jsonl'),
        `${fixture('transcript-subagent.jsonl').join('\n')}\n`,
      );
      writeFileSync(join(dir, 'agent-ae61a6f2394984d52.meta.json'), '{}\n');
      const entries = (await answered(t, p.meta.id)).entries;

      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.agent !== null)).toBe(true);
    } finally {
      await cleanUp();
    }
  });

  test("a message sent mid-turn under the turn's prompt id (#185): the first prompt kept, the message once, where the JSONL has it", async () => {
    try {
      // As 103-9dbd's run had it (Claude Code 2.1.310): `/compact` and a message typed while the
      // first turn ran. The message's UserPromptSubmit came with the first turn's prompt_id; its
      // JSONL line, after the compaction, has a promptId of its own.
      const first = 'Work on card AB#103: Pin the Node version';
      const also = 'Also: when you are done, tell me which Node version you pinned and why.';

      await t.hook(p.meta.id, 'UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit',
        prompt: first,
        prompt_id: 'bf833825',
      });
      append(
        p,
        userLine('459042c3', 'bf833825', '2026-10-24T10:55:39.635Z', first),
        textLine('a1', '2026-10-24T10:55:42.000Z', 'Pinning it.'),
      );
      await t.hook(p.meta.id, 'UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit',
        prompt: also,
        prompt_id: 'bf833825',
      });
      append(
        p,
        userLine('4a3893a9', 'ac4eb67b', '2026-10-24T10:56:22.008Z', '/compact'),
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: '32527d0c',
          timestamp: '2026-10-24T10:56:44.746Z',
          compactMetadata: { trigger: 'manual', preTokens: 57835 },
        }),
        JSON.stringify({
          type: 'user',
          uuid: '970e39e9',
          promptId: '31c3d2e2',
          timestamp: '2026-10-24T10:56:44.393Z',
          isCompactSummary: true,
          message: {
            role: 'user',
            content: 'This session is being continued from a previous conversation',
          },
        }),
        userLine('2b29d7d2', '31c3d2e2', '2026-10-24T10:56:44.774Z', also),
      );
      const list = (await answered(t, p.meta.id)).entries;
      const users = list.flatMap((e) => (e.kind === 'user' ? [[e.id, e.text]] : []));

      // Where the JSONL has it (after the compaction), as a restart reads it too.
      expect(users).toEqual([
        ['bf833825', first],
        ['ac4eb67b', '/compact'],
        ['31c3d2e2', also],
      ]);
      expect(replay(p.events)).toEqual(list);
      await t.close();
      t = p.start();
      expect((await answered(t, p.meta.id)).entries).toEqual(list);
    } finally {
      await cleanUp();
    }
  });

  test("a message sent mid-turn whose line keeps the turn's prompt id (#185): both kept, in the JSONL's order", async () => {
    try {
      const first = 'Fix the cart';
      const also = 'And the badge.';

      await t.hook(p.meta.id, 'UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit',
        prompt: first,
        prompt_id: 'p1',
      });
      append(p, userLine('u1', 'p1', '2026-10-24T10:50:00.000Z', first));
      await t.hook(p.meta.id, 'UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit',
        prompt: also,
        prompt_id: 'p1',
      });
      append(
        p,
        textLine('m1', '2026-10-24T10:50:10.000Z', 'On it.'),
        userLine('u2', 'p1', '2026-10-24T10:50:20.000Z', also),
      );
      const list = (await answered(t, p.meta.id)).entries;

      expect(list.map((e) => (e.kind === 'user' ? e.text : e.id))).toEqual([first, 'm1', also]);
      expect(replay(p.events)).toEqual(list);
      await t.close();
      t = p.start();
      expect((await answered(t, p.meta.id)).entries).toEqual(list);
    } finally {
      await cleanUp();
    }
  });

  test('a mid-turn message whose line was read before its hook (#185): once', async () => {
    try {
      await t.hook(p.meta.id, 'UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Fix the cart',
        prompt_id: 'p1',
      });
      append(
        p,
        userLine('u1', 'p1', '2026-10-24T10:50:00.000Z', 'Fix the cart'),
        userLine('u2', 'p2', '2026-10-24T10:50:20.000Z', 'And the badge.'),
      );
      await t.hook(p.meta.id, 'UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'And the badge.',
        prompt_id: 'p1',
      });
      const list = (await answered(t, p.meta.id)).entries;

      expect(list.flatMap((e) => (e.kind === 'user' ? [[e.id, e.text]] : []))).toEqual([
        ['p1', 'Fix the cart'],
        ['p2', 'And the badge.'],
      ]);
      expect(replay(p.events)).toEqual(list);
    } finally {
      await cleanUp();
    }
  });

  test('a message typed mid-turn (#197): shown once, where Claude Code took it with the tool result, after a restart too', async () => {
    try {
      // As Claude Code 2.1.310 had it in tmux: the message's UserPromptSubmit as it is typed (the
      // turn's prompt_id), its queued_command line once the running tool's result is in, under the
      // time it was typed.
      const first = 'Run `sleep 10`, then `echo one`';
      const also = 'Also: after echo one, run `echo extra` too.';

      await t.hook(p.meta.id, 'UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit',
        prompt: first,
        prompt_id: 'p1',
      });
      append(
        p,
        userLine('u1', 'p1', '2026-10-24T12:57:10.371Z', first),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-10-24T12:57:12.447Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 10' } },
            ],
          },
        }),
      );
      await t.hook(p.meta.id, 'UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit',
        prompt: also,
        prompt_id: 'p1',
      });
      expect((await answered(t, p.meta.id)).entries.map(outline)).toEqual([
        'user p1',
        'tool-use toolu_1',
        'user p1',
      ]);
      append(
        p,
        JSON.stringify({
          type: 'queue-operation',
          operation: 'enqueue',
          timestamp: '2026-10-24T12:57:21.489Z',
          content: also,
        }),
        JSON.stringify({
          type: 'queue-operation',
          operation: 'remove',
          timestamp: '2026-10-24T12:57:22.565Z',
          content: also,
          reason: 'absorbed_mid_turn',
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'r1',
          promptId: 'p1',
          timestamp: '2026-10-24T12:57:22.561Z',
          message: {
            role: 'user',
            content: [
              { tool_use_id: 'toolu_1', type: 'tool_result', content: '', is_error: false },
            ],
          },
        }),
        JSON.stringify({
          type: 'attachment',
          uuid: 'q1',
          isSidechain: false,
          timestamp: '2026-10-24T12:57:21.476Z',
          attachment: {
            type: 'queued_command',
            prompt: also,
            commandMode: 'prompt',
            origin: { kind: 'human' },
          },
        }),
      );
      const list = (await answered(t, p.meta.id)).entries;

      expect(list.map(outline)).toEqual([
        'user p1',
        'tool-use toolu_1',
        'tool-result toolu_1',
        'user q1',
      ]);
      expect(list.filter((e) => e.kind === 'user' && e.text === also)).toHaveLength(1);
      expect(replay(p.events)).toEqual(list);
      await t.close();
      t = p.start();
      expect((await answered(t, p.meta.id)).entries).toEqual(list);
    } finally {
      await cleanUp();
    }
  });

  test("after a restart a subagent's entries go where they happened, as they did before it (#185)", async () => {
    try {
      const dir = join(p.transcript.replace(/\.jsonl$/, ''), 'subagents');
      const sub = join(dir, 'agent-a1.jsonl');
      const subLine = (uuid: string, at: string, text: string) =>
        JSON.stringify({
          type: 'assistant',
          uuid,
          timestamp: at,
          isSidechain: true,
          agentId: 'a1',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        });

      mkdirSync(dir, { recursive: true });
      append(
        p,
        userLine('u1', 'p1', '2026-10-24T10:50:00.000Z', 'Fix the cart'),
        textLine('m1', '2026-10-24T10:50:58.000Z', 'Handing it to the writer.'),
      );
      await answered(t, p.meta.id);
      writeFileSync(
        sub,
        `${subLine('s1', '2026-10-24T10:51:00.000Z', 'writing')}\n${subLine('s2', '2026-10-24T10:52:50.000Z', 'written')}\n`,
      );
      await answered(t, p.meta.id);
      append(p, textLine('m2', '2026-10-24T10:55:15.000Z', 'Verifying.'));
      const before = await answered(t, p.meta.id);

      expect(before.entries.map((e) => e.id)).toEqual(['p1', 'm1', 's1', 's2', 'm2']);
      await t.close();
      t = p.start();
      expect(await answered(t, p.meta.id)).toEqual(before);
    } finally {
      await cleanUp();
    }
  });

  test('only the newest entries are kept; an older --since answers from the oldest kept', async () => {
    try {
      await t.close();
      t = startTranscripts({
        stateDir: p.stateDir,
        files: () => transcriptFiles(localExec({ PATH: '/usr/bin:/bin', HOME: p.home })),
        home: p.home,
        meta: () => p.meta,
        clock: fakeClock(),
        emit: (data) => p.events.push(data),
        log: () => undefined,
        everyMs: 3_600_000,
        max: 5,
      });
      append(p, ...LINES);
      const all = await answered(t, p.meta.id);

      expect(all.entries).toHaveLength(5);
      expect(all.from).toBeGreaterThan(0);
      expect((await answered(t, p.meta.id, all.from + 3)).entries).toEqual(all.entries.slice(3));
    } finally {
      await cleanUp();
    }
  });

  test('a transcript not there, or not the one this session may name, is refused unreadable', async () => {
    try {
      unlinkSync(p.transcript);
      expect(await t.read(p.meta.id, 0)).toMatchObject({
        ok: false,
        error: { code: 'transcript-unreadable' },
      });
      p.meta = { ...p.meta, transcriptPath: join(p.home, '.netrc') };
      expect(await t.read(p.meta.id, 0)).toMatchObject({
        ok: false,
        error: { code: 'transcript-unreadable' },
      });
      expect(await t.read('9-ffff', 0)).toMatchObject({ ok: false, error: { code: 'no-session' } });
      // Not yet hooked: nothing to read yet, no refusal.
      p.meta = { ...p.meta, transcriptPath: null };
      expect(await answered(t, p.meta.id)).toEqual({ session: p.meta.id, from: 0, entries: [] });
    } finally {
      await cleanUp();
    }
  });
});

/** A hook payload for the git tests: a turn's prompt, a tool's result, its end. */
const prompt = (id: string) => ({
  hook_event_name: 'UserPromptSubmit',
  prompt: 'go',
  prompt_id: id,
});
const ran = (id: string) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_use_id: id,
  tool_input: { command: "sed -i '' 's/line.price/line.price * line.quantity/' api/src/cart.ts" },
  tool_response: { stdout: '', stderr: '' },
});
const stop = { hook_event_name: 'Stop', last_assistant_message: 'done' };

const changesOf = (events: readonly EventData<'session.transcript'>[], turn: string) =>
  replay(events).find(
    (e): e is Extract<TranscriptEntry, { kind: 'changes' }> =>
      e.kind === 'changes' && e.turn === turn,
  );

describe("a turn's changes from git, and its revert", () => {
  let p: Place;
  let t: Transcripts;
  const CART = 'api/src/cart.ts';

  beforeAll(async () => {
    p = place();
    t = p.start();
    await t.hook(p.meta.id, 'UserPromptSubmit', prompt('turn-1'));
    // What Bash does in auto mode: a `sed -i`, a new file, a commit, an ignored folder.
    writeFileSync(
      join(p.worktree, CART),
      [
        'export const total = (lines) =>',
        '  lines.reduce((sum, line) => sum + line.price * line.quantity, 0);',
        '',
      ].join('\n'),
    );
    git(p.worktree, 'commit', '-qam', 'quantity');
    writeFileSync(join(p.worktree, 'api', 'src', 'vat.ts'), 'export const VAT = 0.25;\n');
    mkdirSync(join(p.worktree, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(p.worktree, 'node_modules', 'x', 'index.js'), 'x\n');
    await t.hook(p.meta.id, 'PostToolUse', ran('toolu_sed'));
    await t.settled();
  });
  afterAll(async () => {
    await t.close();
    rmSync(p.root, { recursive: true, force: true });
  });

  test('a Bash write, a commit and an untracked file show; ignored files do not', () => {
    const changes = changesOf(p.events, 'turn-1');

    expect(
      changes?.files.map((f) => [
        f.path.slice(p.worktree.length + 1),
        f.created,
        f.added,
        f.removed,
      ]),
    ).toEqual([
      [CART, false, 1, 1],
      ['api/src/vat.ts', true, 1, 0],
    ]);
    expect(changes?.files[0]?.hunks[0]?.lines).toEqual([
      ' export const total = (lines) =>',
      '-  lines.reduce((sum, line) => sum + line.price, 0);',
      '+  lines.reduce((sum, line) => sum + line.price * line.quantity, 0);',
    ]);
  });

  test("a subagent's hand-back sent as a prompt mid-turn is no new turn: its merge is the turn's", async () => {
    // As Claude Code sends a background writer's hand-back (t113b's real run): its own
    // UserPromptSubmit, a new prompt id, then the coordinator's merge.
    await t.hook(p.meta.id, 'UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: '<agent-message from="af9c71177cb18213e">\n[Subagent hand-back]',
      prompt_id: 'hand-back',
    });
    writeFileSync(join(p.worktree, 'api', 'src', 'merged.ts'), 'export const merged = true;\n');
    await t.hook(p.meta.id, 'PostToolUse', ran('toolu_merge'));
    await t.settled();
    expect(
      changesOf(p.events, 'turn-1')?.files.map((f) => f.path.slice(p.worktree.length + 1)),
    ).toEqual([CART, 'api/src/merged.ts', 'api/src/vat.ts']);
    expect(changesOf(p.events, 'hand-back')).toBeUndefined();
    expect(replay(p.events).flatMap((e) => (e.kind === 'user' ? [e.id] : []))).toEqual(['turn-1']);
    rmSync(join(p.worktree, 'api', 'src', 'merged.ts'));
    await t.hook(p.meta.id, 'PostToolUse', ran('toolu_unmerge'));
    await t.settled();
  });

  test("the worktree's index and files are never written by a snapshot", () => {
    expect(git(p.worktree, 'status', '--porcelain')).toBe('?? api/src/vat.ts');
    expect(git(p.worktree, 'diff', '--cached', '--name-only')).toBe('');
  });

  test('the same changes again send nothing; Stop ends the turn', async () => {
    const before = p.events.length;

    await t.hook(p.meta.id, 'Stop', stop);
    await t.settled();
    expect(
      p.events
        .slice(before)
        .flatMap((e) => e.entries)
        .filter((e) => e.kind === 'changes'),
    ).toEqual([]);
    const turns = z
      .object({ turns: z.array(z.object({ turn: z.string(), end: z.string().nullable() })) })
      .parse(
        JSON.parse(readFileSync(join(p.stateDir, 'sessions', p.meta.id, 'turns.json'), 'utf8')),
      );

    expect(turns.turns.map((x) => [x.turn, x.end !== null])).toEqual([['turn-1', true]]);
  });

  test('a restart reads the turns back: their changes again, without events', async () => {
    await t.close();
    p.events.length = 0;
    t = p.start();
    const entries = (await answered(t, p.meta.id)).entries;

    expect(entries.filter((e) => e.kind === 'changes').map((e) => e.id)).toEqual(['turn-1']);
    expect(p.events).toEqual([]);
  });

  test('revert one file, then the rest: the start text back, a new file removed', async () => {
    const one = await t.revert(p.meta.id, 'turn-1', join(p.worktree, CART));

    expect(one).toEqual({
      ok: true,
      data: { session: p.meta.id, turn: 'turn-1', restored: [CART], removed: [] },
    });
    expect(readFileSync(join(p.worktree, CART), 'utf8')).toContain('sum + line.price, 0');
    // The whole turn now: the file reverted before is at its start already, so only the rest.
    expect(await t.revert(p.meta.id, 'turn-1')).toEqual({
      ok: true,
      data: { session: p.meta.id, turn: 'turn-1', restored: [], removed: ['api/src/vat.ts'] },
    });
    expect(existsSync(join(p.worktree, 'api', 'src', 'vat.ts'))).toBe(false);
    expect(existsSync(join(p.worktree, 'node_modules', 'x', 'index.js'))).toBe(true);
    // Still the commit the turn made: only the files moved, the index and history are as they were.
    expect(git(p.worktree, 'log', '--format=%s', '-1')).toBe('quantity');
  });

  test('changed after the turn: refused, naming the file, nothing reverted', async () => {
    await t.hook(p.meta.id, 'UserPromptSubmit', prompt('turn-2'));
    writeFileSync(join(p.worktree, 'README.md'), '# demo\n\nMore.\n');
    await t.hook(p.meta.id, 'PostToolUse', ran('toolu_readme'));
    await t.hook(p.meta.id, 'Stop', stop);
    await t.settled();
    writeFileSync(join(p.worktree, 'README.md'), '# demo\n\nMore, by hand.\n');
    expect(await t.revert(p.meta.id, 'turn-2')).toEqual({
      ok: false,
      error: {
        code: 'changed-since',
        message: 'changed since turn turn-2: README.md (nothing reverted)',
      },
    });
    expect(readFileSync(join(p.worktree, 'README.md'), 'utf8')).toBe('# demo\n\nMore, by hand.\n');
  });

  test('a turn still running, an unknown turn, a file the turn did not touch', async () => {
    await t.hook(p.meta.id, 'UserPromptSubmit', prompt('turn-3'));
    await t.settled();
    expect(await t.revert(p.meta.id, 'turn-3')).toMatchObject({
      ok: false,
      error: { code: 'turn-running' },
    });
    // Waiting on you mid-turn (a question) is still running.
    p.meta = { ...p.meta, state: 'waiting' };
    expect(await t.revert(p.meta.id, 'turn-3')).toMatchObject({
      ok: false,
      error: { code: 'turn-running' },
    });
    p.meta = { ...p.meta, state: 'working' };
    expect(await t.revert(p.meta.id, 'turn-9')).toMatchObject({
      ok: false,
      error: { code: 'no-turn' },
    });
    expect(await t.revert(p.meta.id, 'turn-2', 'api/src/cart.ts')).toMatchObject({
      ok: false,
      error: { code: 'not-in-turn' },
    });
  });
});

// ── Through the CLI seam: a launched session ────────────────────────────────────────────────

type World = { root: string; repo: string; ado: FakeAdo; az: FakeAz; claude: FakeClaude; abe: Cli };

const world = async (): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-tc-'));
  const repo = join(root, 'demo');
  const ado = await fakeAdo();
  const az = fakeAz({ tokens: ['token-one'] });
  const claude = fakeClaude();

  for (const dir of ['mine', 'demo/.abe']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(join(repo, 'abe.yaml'), `board: ${JSON.stringify(ado.board)}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  // yours for the repo, never committed
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
  const abe = cli({
    env: {
      PATH: `${claude.dir}:${az.dir}:/usr/bin:/bin`,
      ABE_CONFIG_DIR: join(root, 'mine'),
      ABE_TMUX: tmuxPath(),
      ...ado.env,
    },
    cwd: repo,
  });

  return { root, repo, ado, az, claude, abe };
};

const TranscriptEvent = z.object({
  type: z.literal('session.transcript'),
  data: z.object({ session: z.string(), from: z.number(), entries: z.array(z.unknown()) }),
});

describe('through the CLI: abe watch, session transcript, session revert', () => {
  let w: World;
  let s: SessionData;
  let watch: Streaming;

  beforeAll(async () => {
    w = await world();
    // The fake's first turn: a Bash-style write (no file tool) and its PostToolUse.
    scriptClaude(w.abe.state.dir, [
      { hook: 'PreToolUse' },
      { write: { path: 'notes.md', text: 'The cart total ignores quantity.\n' } },
      { hook: 'PostToolUse' },
      { say: 'Wrote notes.md.' },
    ]);
    await w.abe.run('status');
    await installDone(w.abe.state.dir, w.repo);
    watch = w.abe.spawn('watch', '--json');
    const out = await w.abe.json(SessionData, 'session', 'launch', '--card', '4', '--repo', w.repo);

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    s = out.doc.data;
  });
  afterAll(async () => {
    watch.signal('SIGKILL');
    await w.abe.close();
    await w.ado.stop();
    w.az.remove();
    w.claude.remove();
    rmSync(w.root, { recursive: true, force: true });
  });

  const transcript = async () => {
    const out = await w.abe.json(SessionTranscriptData, 'session', 'transcript', s.id);

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));

    return out.doc.data;
  };

  test("the turn's entries stream as session.transcript events and read back with --since", async () => {
    const seen: TranscriptEntry[] = [];

    await until(
      'the turn read in',
      async () => {
        const event = TranscriptEvent.safeParse(
          EventLine.parse(JSON.parse(await watch.next(15_000))),
        );

        if (event.success && event.data.data.session === s.id) {
          const data = SessionTranscriptData.parse(event.data.data);

          seen.splice(data.from, data.entries.length, ...data.entries);
        }

        return seen.some((e) => e.kind === 'changes') &&
          seen.some((e) => e.kind === 'assistant-text')
          ? true
          : undefined;
      },
      { ms: 20_000 },
    );
    const read = await transcript();

    expect(read.entries.map((e) => e.kind)).toEqual(seen.map((e) => e.kind));
    expect(read.entries.map((e) => e.kind)).toEqual([
      'user',
      'tool-use',
      'tool-result',
      'changes',
      'assistant-text',
    ]);
    const since = await w.abe.json(
      SessionTranscriptData,
      'session',
      'transcript',
      s.id,
      '--since',
      '3',
    );

    expect(since.doc).toMatchObject({
      ok: true,
      data: { from: 3, entries: read.entries.slice(3) },
    });
  });

  test("abe ui bridge: the chat screen on the session draws its turn from serve's transcript", async () => {
    const bridge = w.abe.spawn('ui', 'bridge');
    /** Its frames as the window takes them: a patch as the tree it gives. */
    const trees = asTrees();
    const send = (frame: unknown) => {
      bridge.write(`${JSON.stringify(frame)}\n`);
    };
    const parts = (n: UiNode): UiNode[] => [n, ...(n.children ?? []).flatMap(parts)];

    try {
      send({ v: 2, type: 'hello', size: { width: 1440, height: 846 }, version: 'test' });
      send({
        v: 2,
        type: 'open',
        slot: 'chat',
        screen: 'chat',
        params: { session: s.id },
      });
      const drawn = await (async () => {
        for (;;) {
          const f = trees(BridgeFrame.parse(JSON.parse(await bridge.next(15_000))));
          const all = f.type === 'tree' ? parts(f.tree) : [];

          if (
            all.some((n) => n.kind === 'ChangesBar') &&
            all.some((n) => n.kind === 'Prose' && JSON.stringify(n.props).includes('notes.md'))
          )
            return all;
        }
      })();

      // in R-Turn's order: your message, the changes bar, its diff card, the step, the prose
      expect(
        drawn
          .map((n) => n.kind)
          .filter((k) => ['ChatMessage', 'ChangesBar', 'DiffCard', 'StepRow', 'Prose'].includes(k)),
      ).toEqual(['ChatMessage', 'ChangesBar', 'DiffCard', 'StepRow', 'Prose']);
      expect(drawn.find((n) => n.kind === 'ChangesBar')?.props).toMatchObject({
        files: 1,
        added: 1,
      });
    } finally {
      bridge.end();
      await bridge.exited;
    }
  }, 30_000);

  test("the Bash-style write is the turn's change; revert removes it", async () => {
    const read = await transcript();
    const changes = read.entries.find((e) => e.kind === 'changes');

    if (changes?.kind !== 'changes') throw new Error('no changes entry');
    expect(changes.files.map((f) => [f.path, f.created])).toEqual([
      [join(s.worktree, 'notes.md'), true],
    ]);
    const user = read.entries[0];

    expect(changes.turn).toBe(user?.id ?? '');
    const text = await w.abe.run('session', 'transcript', s.id);

    expect(text.stdout).toContain('files  1 file changed · +1 −0');
    const reverted = await w.abe.json(
      SessionRevertData,
      'session',
      'revert',
      s.id,
      '--turn',
      changes.turn,
    );

    expect(reverted.doc).toEqual({
      ok: true,
      data: { session: s.id, turn: changes.turn, restored: [], removed: ['notes.md'] },
    });
    expect(existsSync(join(s.worktree, 'notes.md'))).toBe(false);
  });

  test('refusals: no session, a bad --since', async () => {
    const none = await w.abe.json(SessionTranscriptData, 'session', 'transcript', '9-ffff');

    expect(none.exit).toBe(1);
    expect(none.doc).toMatchObject({ ok: false, error: { code: 'no-session' } });
    const bad = await w.abe.json(
      SessionTranscriptData,
      'session',
      'transcript',
      s.id,
      '--since',
      '-1',
    );

    expect(bad.doc).toMatchObject({ ok: false, error: { code: 'usage' } });
  });
});

// ── A box's events, merged into the Mac's watch ─────────────────────────────────────────────

const BOX: Box = {
  id: 'i-0123456789abcdef0',
  name: 'demo-shop-4',
  owner: 'octocat',
  state: 'running',
  size: 'm8g.large',
  zone: 'eu-west-1a',
  privateIp: '10.0.0.4',
  vpc: null,
  subnet: null,
  repo: 'mkdir-swe/demo-shop',
  card: 4,
};

test("a box session's transcript events reach the Mac's watchers, tagged with the box", async () => {
  const clock = fakeClock();
  const events = journal(clock);
  const seen: Event[] = [];
  const unwatch = events.watch(undefined, (e) => {
    seen.push(e);
  });
  const AT = new Date(0).toISOString();
  const entry: TranscriptEntry = {
    kind: 'user',
    id: PROMPT,
    at: AT,
    agent: null,
    text: 'go',
    context: null,
  };
  const link: BoxLink = {
    run: () =>
      Promise.resolve({ exit: 0, stdout: '{"ok":true,"data":{"sessions":[]}}\n', stderr: '' }),
    follow: (_box, _argv, onLine) => {
      onLine(
        JSON.stringify({
          seq: 1,
          at: AT,
          type: 'session.transcript',
          data: { session: '4-a1b2', from: 0, entries: [entry] },
        }),
      );

      return { stop: () => undefined, ended: new Promise<number>(() => undefined) };
    },
    attach: () => [],
    forward: () =>
      Promise.resolve({ ok: false, error: { code: 'no-forward', message: 'not here' } }),
  };
  const front = startBoxFront({
    boxes: {
      list: () => Promise.resolve({ ok: true, data: [BOX] }),
      status: () => Promise.resolve({ ok: true, data: BOX }),
      up: () => Promise.resolve({ ok: true, data: BOX }),
      start: () => Promise.resolve({ ok: true, data: BOX }),
      stop: () => Promise.resolve({ ok: true, data: BOX }),
      terminate: () => Promise.resolve({ ok: true, data: BOX }),
      resize: () => Promise.resolve({ ok: true, data: BOX }),
    },
    link,
    clock,
    sleep: () => Promise.resolve(),
    emit: events.emit,
  });

  try {
    front.keep(BOX.name, 'cloud');
    await until('the transcript merged', () => (seen.length > 0 ? true : undefined));
    expect(seen.map((e) => [e.type, e.box, e.data])).toEqual([
      ['session.transcript', BOX.name, { session: '4-a1b2', from: 0, entries: [entry] }],
    ]);
  } finally {
    unwatch();
    front.close();
  }
});

test(
  "a turn's start snapshot that is slow still lands before the agent writes: its writes are the turn's",
  { timeout: 60_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'abe-slow-'));
    const repo = join(root, 'demo');
    const claude = fakeClaude();
    const env = { PATH: '/usr/bin:/bin', HOME: root };

    mkdirSync(join(root, 'mine'), { recursive: true });
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    mkdirSync(join(repo, '.abe'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    // yours for the repo is never committed
    writeFileSync(join(repo, '.gitignore'), '.fake-claude/\n.abe/settings.local.yaml\n');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    writeFileSync(
      join(repo, 'abe.yaml'),
      `board: ${JSON.stringify({ organization: 'https://dev.azure.com/demo-org', project: 'Shop', team: 'Web' })}\nenvironments: {}\n`,
    );
    writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    // Every snapshot takes 3 s: past any hook's own second and serve's former 2 s wait.
    const local = localRunTree({ USER: 'tester', ...env });
    const tree: RunTree = {
      ...local,
      transcript: {
        ...local.transcript,
        snapshot: async (worktree) => {
          await Bun.sleep(3000);

          return local.transcript.snapshot(worktree);
        },
      },
    };
    const s = await scenario({
      board: fakeBoard([card(2, 'Cart total')]),
      sessions: {
        env: {
          PATH: claude.path,
          GIT_AUTHOR_NAME: 'T',
          GIT_AUTHOR_EMAIL: 't@example.test',
          GIT_COMMITTER_NAME: 'T',
          GIT_COMMITTER_EMAIL: 't@example.test',
          ABE_CONFIG_DIR: join(root, 'mine'),
        },
        tree,
      },
    });

    try {
      scriptClaude(s.state.dir, [
        { write: { path: 'notes.md', text: 'The cart total ignores quantity.\n' } },
        { say: 'Wrote notes.md.' },
      ]);
      const launch = await s.request('session', 'launch', '--card', '2', '--repo', repo, '--json');
      const launched = SessionData.parse(
        z.object({ ok: z.literal(true), data: z.unknown() }).parse(JSON.parse(launch.stdout)).data,
      );
      const changes = await until(
        'the turn changes',
        async () => {
          const reply = await s.request('session', 'transcript', launched.id, '--json');
          const read = z
            .object({ ok: z.literal(true), data: SessionTranscriptData })
            .safeParse(JSON.parse(reply.stdout));
          const entry = read.success
            ? read.data.data.entries.find((e) => e.kind === 'changes')
            : undefined;

          return entry?.kind === 'changes' ? entry : undefined;
        },
        { ms: 30_000 },
      );

      expect(changes.files.map((f) => f.path)).toEqual([join(launched.worktree, 'notes.md')]);
      await s.request('session', 'stop', launched.id, '--json');
    } finally {
      await s.close();
      claude.remove();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
