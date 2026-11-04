/**
 * `abe session override` and the held permission (#114 S4) in a real `serve` in this test: the
 * fake `claude` in a real `tmux` runs its hooks through the real `abe hook`, an in-memory board
 * that must get no comment, a fake `gh` holds the open pull request, and the fake clock runs the
 * 600 s hold out.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  EXPIRED_TEXT,
  NOT_COMMENTED,
  PERMISSION_HOLD_MS,
  type Reply,
  SessionAnswerData,
  SessionAsksData,
  SessionData,
  SessionOverrideData,
} from '@abe/core';
import { ghTrackingFrom } from '@abe/ports';
import {
  card,
  claudeOutput,
  type FakeBoard,
  fakeGh,
  type FakeGh,
  ghPrView,
  ghPull,
  heldEvents,
  type RepoScenario,
  repoScenario,
  scriptClaude,
  type ServeScenario,
  until,
} from '@abe/testing';
import { z } from 'zod';

const REPO = 'acme/demo';
/** The repo's environments, after its board in `abe.yaml`. */
const ENVIRONMENTS = [
  'environments:',
  '  test:',
  '    account: "111111111111"',
  '    region: eu-west-1',
  '',
].join('\n');

const data = <T extends z.ZodType>(schema: T, reply: Reply): z.output<T> => {
  const read = z
    .object({ ok: z.literal(true), data: z.unknown() })
    .safeParse(JSON.parse(reply.stdout));

  if (!read.success) throw new Error(reply.stdout);

  return schema.parse(read.data.data);
};
const refusal = (reply: Reply) =>
  z
    .object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) })
    .parse(JSON.parse(reply.stdout)).error;

const Hooks = z.array(
  z.looseObject({ event: z.string(), stdout: z.string(), ms: z.number().optional() }),
);
const permissionHooks = (worktree: string) =>
  Hooks.parse(claudeOutput(worktree).hooks).filter((h) => h.event === 'PermissionRequest');

const ALLOW = {
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
};
/** A read of the test database: its command names the Reach name `db read test` lowers. */
const read = (table: string) => `psql "$ABE_DB_READ_URL_TEST" -c 'select * from ${table}'`;
const psql = (table: string) => ({
  hook: 'PermissionRequest',
  payload: { tool_name: 'Bash', tool_input: { command: read(table) } },
});
const REASON = 'Read the price list for the Before check';

describe('session override', () => {
  let world: RepoScenario;
  let repo: string;
  let gh: FakeGh;
  let board: FakeBoard;
  let s: ServeScenario;

  const override = (id: string, what: string, reason = REASON) =>
    s.request('session', 'override', id, '--what', what, '--reason', reason, '--json');
  const asks = async (id: string) =>
    data(SessionAsksData, await s.request('session', 'asks', id, '--json')).cards;

  beforeAll(async () => {
    gh = fakeGh();
    world = await repoScenario({
      cards: [card(2, 'Cart total')],
      settings: ENVIRONMENTS,
      origin: REPO,
      serve: { tracking: ghTrackingFrom({ PATH: gh.path }) },
    });
    ({ repo, board, s } = world);
  }, 30_000);
  afterAll(async () => {
    await world.close();
    gh.remove();
  });

  test(
    'an Override: refusals, then recorded, noted in the open PR (the story not commented), and held permissions',
    { timeout: 60_000 },
    async () => {
      scriptClaude(s.state.dir, [], {
        fetch: [psql('prices')],
        again: [psql('prices')],
        // Claude Code's own dialog shows, its Notification comes, then the turn ends.
        late: [
          psql('other'),
          {
            hook: 'Notification',
            payload: {
              notification_type: 'permission_prompt',
              message: 'Claude needs your permission to use Bash',
            },
          },
          { sleep: 3000 },
        ],
        tui: [psql('tui')],
        // its dialog up a while before the turn ends: the card shows until its Stop
        npm: [
          {
            hook: 'PermissionRequest',
            payload: { tool_name: 'Bash', tool_input: { command: 'npm ci' } },
          },
          { sleep: 2000 },
        ],
      });
      const session = data(
        SessionData,
        await s.request('session', 'launch', '--card', '2', '--repo', repo, '--json'),
      );

      await until('its first turn', () =>
        Hooks.parse(claudeOutput(session.worktree).hooks).some((h) => h.event === 'Stop')
          ? true
          : undefined,
      );

      // Without an Override Claude Code's own dialog answers it: its card names the tool and
      // the command, its answer pressed in the dialog while it is up (none here: refused).
      await s.request('session', 'send', session.id, 'npm', '--json');
      await until('npm asked', () =>
        permissionHooks(session.worktree).length === 1 ? true : undefined,
      );
      expect(permissionHooks(session.worktree)[0]?.stdout).toBe('');
      const [npm] = await until('the npm card', async () => {
        const open = await asks(session.id);

        return open.length === 1 ? open : undefined;
      });

      expect(npm).toMatchObject({
        kind: 'permission',
        title: 'Allow Bash: npm ci?',
        expired: null,
        dialog: true,
        prompt: { tool: 'Bash', input: 'npm ci' },
      });
      expect(
        refusal(
          await s.request(
            'session',
            'answer',
            session.id,
            '--card',
            npm?.id ?? '',
            '--option',
            '1',
            '--json',
          ),
        ).code,
      ).toBe('card-expired');
      await until('cleared at its Stop', async () =>
        (await asks(session.id)).length === 0 ? true : undefined,
      );

      // Refusals: an unknown area (with the list), no reason, a write on a local session.
      const unknown = refusal(await override(session.id, 'sudo'));

      expect(unknown.code).toBe('not-an-area');
      expect(unknown.message).toContain('db write <env>');
      expect(unknown.message).not.toContain('network <host>');
      expect(unknown.message).toContain('environments: test');
      expect(refusal(await override(session.id, 'db read test', ' ')).code).toBe('no-reason');
      const write = refusal(await override(session.id, 'db write test'));

      expect(write.code).toBe('writes-only-on-box');
      expect(write.message).toContain('Move to cloud');

      // The pull request open on the card's branch gets the note now.
      gh.answer([
        [`head=acme:${session.branch}`, { json: [ghPull(REPO, 9)] }],
        [`pr view 9 -R`, { json: ghPrView(REPO, 9, { head: session.branch }) }],
        [`-X PATCH repos/${REPO}/pulls/9`, { json: ghPull(REPO, 9) }],
      ]);
      const made = data(SessionOverrideData, await override(session.id, 'db read test'));

      expect(made.override).toMatchObject({
        what: 'db read test',
        words: 'Test DB read',
        reason: REASON,
      });
      expect(made.story).toBe(NOT_COMMENTED);
      expect(made.pr).toBe(`noted on https://github.com/${REPO}/pull/9`);
      const note = `- Override on session ${session.id}: Test DB read · reason: ${REASON}`;
      const patch = gh.calls().find((c) => c.argv.includes('PATCH'));

      expect(JSON.parse(patch?.stdin ?? '{}')).toEqual({
        body: `Body of pull 9.\n\n## Notes\n\n${note}\n`,
      });
      expect(
        board
          .cards()
          .find((c) => c.id === 2)
          ?.comments.map((c) => c.text),
      ).toEqual([]);
      // session show carries it.
      const shown = data(SessionData, await s.request('session', 'show', session.id, '--json'));

      expect(shown.overrides.map((o) => o.words)).toEqual(['Test DB read']);

      // A PermissionRequest in its area is held for a card; Allow for this session answers it.
      await s.request('session', 'send', session.id, 'fetch', '--json');
      const [held] = await until('the permission card', async () => {
        const open = await asks(session.id);

        return open.length === 1 ? open : undefined;
      });

      expect(held).toMatchObject({
        kind: 'permission',
        title: `Allow Bash: ${read('prices')}?`,
        why: `Reach: Test DB read, overridden for this session: ${REASON}`,
        where: "Local sandbox · the command runs in Claude Code's sandbox",
        options: [
          { n: 1, label: 'Allow once', recommended: true },
          { n: 2, label: 'Allow for this session', recommended: false },
          { n: 3, label: 'Deny', recommended: false },
        ],
        own: 'Tell it what to do instead…',
      });
      expect((await s.request('session', 'show', session.id, '--json')).stdout).toContain(
        '"state":"waiting"',
      );
      const answered = data(
        SessionAnswerData,
        await s.request(
          'session',
          'answer',
          session.id,
          '--card',
          held?.id ?? '',
          '--option',
          '2',
          '--json',
        ),
      );

      expect(answered.sent).toBe('Allow for this session');
      await until('allowed', () =>
        permissionHooks(session.worktree).length === 2 ? true : undefined,
      );
      expect(JSON.parse(permissionHooks(session.worktree)[1]?.stdout ?? '')).toEqual(ALLOW);

      // The same prompt again: allowed at once, no card.
      await s.request('session', 'send', session.id, 'again', '--json');
      await until('allowed again', () =>
        permissionHooks(session.worktree).length === 3 ? true : undefined,
      );
      expect(JSON.parse(permissionHooks(session.worktree)[2]?.stdout ?? '')).toEqual(ALLOW);

      // Another one held past 600 s: the hook answers nothing (Claude Code's dialog stays) and
      // the card says to answer in Terminal mode; its dialog's Notification keeps it, it goes
      // once the turn ends.
      await s.request('session', 'send', session.id, 'late', '--json');
      const [late] = await until('the late card', async () => {
        const open = await asks(session.id);

        return open.length === 1 ? open : undefined;
      });

      s.clock.tick(PERMISSION_HOLD_MS + 1);
      await until('given back', () =>
        permissionHooks(session.worktree).length === 4 ? true : undefined,
      );
      expect(permissionHooks(session.worktree)[3]?.stdout).toBe('');
      await until('its Notification', () =>
        Hooks.parse(claudeOutput(session.worktree).hooks).some((h) => h.event === 'Notification')
          ? true
          : undefined,
      );
      expect((await asks(session.id)).map((c) => [c.id, c.expired])).toEqual([
        [late?.id ?? '', EXPIRED_TEXT],
      ]);
      await until('cleared', async () =>
        (await asks(session.id)).length === 0 ? true : undefined,
      );

      // Answered in Claude Code's own dialog first: the tool ran, the card and its hold go.
      await s.request('session', 'send', session.id, 'tui', '--json');
      const [tui] = await until('the tui card', async () => {
        const open = await asks(session.id);

        return open.length === 1 ? open : undefined;
      });
      const ran = await s.requestAs(
        session.id,
        session.worktree,
        'hook',
        'PostToolUse',
        '--payload',
        JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: read('tui') },
        }),
        '--json',
      );

      expect(ran.exit).toBe(0);
      await until('let go', () =>
        permissionHooks(session.worktree).length === 5 ? true : undefined,
      );
      expect(permissionHooks(session.worktree)[4]?.stdout).toBe('');
      expect(await asks(session.id)).toEqual([]);
      const events = await heldEvents(s.state.socket);
      const asked = events.filter((e) => e.type === 'session.ask');

      // Allowed for the session: answered at once, never Needs you on the way.
      expect(
        events.filter(
          (e) =>
            e.type === 'session.state' &&
            JSON.stringify(e.data).includes('"cause":"PermissionRequest"'),
        ),
      ).toHaveLength(4);
      expect(asked).toHaveLength(5);
      expect(JSON.stringify(asked[3]?.data)).toContain(EXPIRED_TEXT);
      expect(events.filter((e) => e.type === 'session.answered').map((e) => e.data)).toEqual([
        { id: session.id, card: 2, cards: [npm?.id], answer: null },
        { id: session.id, card: 2, cards: [held?.id], answer: 'Allow for this session' },
        { id: session.id, card: 2, cards: [late?.id], answer: null },
        { id: session.id, card: 2, cards: [tui?.id], answer: null },
      ]);
      expect(events.filter((e) => e.type === 'session.override')).toHaveLength(1);

      // No pull request open on a plain session: nothing opens one later, so none is promised (#187).
      gh.answer([[`head=acme:${session.branch}`, { json: [] }]]);
      const plain = data(SessionOverrideData, await override(session.id, 'aws read test'));

      expect(plain.pr).toBe(
        'no pull request open: not noted (no Factory run on this session, so none opens one)',
      );
      await s.request('session', 'stop', session.id, '--json');
    },
  );
});
