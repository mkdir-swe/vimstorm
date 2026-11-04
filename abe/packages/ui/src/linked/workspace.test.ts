/**
 * The workspace jump on the Factory overview (#106, #105 S4; ⌃W and the `g w` of #74 before it): the story's session's
 * workspace in the Editor with Chat shown beside it. The screen asks `abe workspace attach-spec`;
 * a local one opens its worktree as a plain project, a cloud one opens with the argv the shell
 * spawns through, Chat saying Waking while its box is not known to run.
 */
import { describe, expect, test } from 'bun:test';
import type { AttachSpec, FactoryRunData, SessionData } from '@abe/core';
import {
  cardsAnswer,
  factoryRun,
  listCard,
  minutes,
  runsAnswer,
  session,
  sessionsAnswer,
} from '@abe/testing';
import { factoryScreen } from '../board/factory';
import { withLive } from '../live';
import { type Command, type Input, step } from '../runtime/runtime';

/** The Board with its live facts, as the bridge feeds them. */
const BOARD = withLive(factoryScreen);

const SIZE = { width: 1440, height: 846 };
const MINE = [
  listCard(4, 'Cart total includes shipping', 'Active'),
  listCard(5, 'Saved carts survive sign-out', 'New'),
];
const RUNS: FactoryRunData[] = [
  factoryRun(4, 'Cart total includes shipping', 'build', 'running', { since: minutes(2) }),
];
const SESSIONS: SessionData[] = [{ ...session('s4', 'working', 4), box: 'shop-4' }];

const drive = () => {
  let held = step(BOARD, BOARD.init, { kind: 'open', params: {}, size: SIZE });
  const send = (...inputs: Input[]): Command[] => {
    let commands: Command[] = [];

    for (const input of inputs) {
      held = step(BOARD, held.state, input);
      commands = held.commands;
    }

    return commands;
  };

  send(
    cardsAnswer(MINE, true),
    cardsAnswer(MINE, false),
    runsAnswer(RUNS),
    sessionsAnswer(SESSIONS),
  );

  send({ kind: 'click', id: 'card:4' });

  return {
    send,
    /** The workspace jump on a story, as the bridge hands it on. */
    jump: (story = 4) => send({ kind: 'jump', to: 'workspace', story }),
  };
};

const answer = (id: string, data: AttachSpec): Input => ({
  kind: 'result',
  id,
  command: 'workspace attach-spec',
  reply: { ok: true, data },
});

const CLOUD: AttachSpec = {
  where: 'cloud',
  root: '/workspace/repo',
  nvim: ['abe', 'box', 'attach', 'shop-4', '--', 'env', '-C', '/workspace/repo', 'nvim', '--embed'],
  shell: ['abe', 'box', 'attach', 'shop-4', '--', 'env', '-C', '/workspace/repo', 'bash', '-l'],
  exec: ['abe', 'box', 'attach', 'shop-4', '--'],
  box: { name: 'shop-4', region: 'eu-west-1' },
  waking: true,
};

const shells = (commands: Command[]) =>
  commands.flatMap((c) => (c.kind === 'shell' ? [c.effect] : []));

describe('the workspace jump: the story’s workspace in the Editor, Chat beside it', () => {
  test('pressed before the runs and sessions are read: their answers go on to it (#335)', () => {
    let held = step(BOARD, BOARD.init, { kind: 'open', params: {}, size: SIZE });

    held = step(BOARD, held.state, cardsAnswer(MINE, true));
    held = step(BOARD, held.state, { kind: 'jump', to: 'workspace', story: 4 });
    // nothing asked, nothing said yet
    expect(
      held.commands.filter(
        (c) => c.kind === 'run' || (c.kind === 'shell' && c.effect.kind === 'balloon'),
      ),
    ).toEqual([]);
    held = step(BOARD, held.state, sessionsAnswer(SESSIONS));
    // a run may stand for the card: the runs first
    expect(held.commands.filter((c) => c.kind === 'run')).toEqual([]);
    held = step(BOARD, held.state, runsAnswer(RUNS));
    expect(held.commands.filter((c) => c.kind === 'run')).toEqual([
      { kind: 'run', id: 'jump-workspace:s4', argv: ['workspace', 'attach-spec', 's4'] },
    ]);
  });

  test('the / filter types every key, ? too: the screen says it is typing', () => {
    let held = step(BOARD, BOARD.init, { kind: 'open', params: {}, size: SIZE });

    expect(BOARD.typing?.(held.state)).toBe(false);
    held = step(BOARD, held.state, { kind: 'key', key: '/' });
    expect(BOARD.typing?.(held.state)).toBe(true);
  });

  test('asks attach-spec for the selected card’s session', () => {
    const d = drive();

    expect(d.jump().filter((c) => c.kind === 'run')).toEqual([
      { kind: 'run', id: 'jump-workspace:s4', argv: ['workspace', 'attach-spec', 's4'] },
    ]);
  });

  test('a cloud session opens with its attach: the argv, its box, waking; Chat says Waking', () => {
    const d = drive();

    d.jump();
    const commands = d.send(answer('jump-workspace:s4', CLOUD));

    expect(commands.filter((c) => c.kind === 'open')).toEqual([
      { kind: 'open', screen: 'chat', params: { session: 's4', waking: 'shop-4' }, slot: 'chat' },
    ]);
    expect(shells(commands)).toContainEqual({
      kind: 'open-project',
      path: '/workspace/repo',
      attach: {
        nvim: CLOUD.nvim,
        shell: CLOUD.shell,
        exec: CLOUD.exec,
        box: { name: 'shop-4', region: 'eu-west-1' },
        waking: true,
        download: 'download:s4',
      },
      chat: true,
    });
  });

  test('a local session opens its worktree as a plain project', () => {
    const d = drive();

    d.jump();
    const local: AttachSpec = {
      where: 'local',
      root: '/r/shop-wt/4-cart',
      nvim: ['nvim', '--embed'],
      shell: ['/bin/zsh', '-l'],
      exec: [],
      box: null,
      waking: false,
    };

    expect(shells(d.send(answer('jump-workspace:s4', local)))).toContainEqual({
      kind: 'open-project',
      path: '/r/shop-wt/4-cart',
      chat: true,
    });
  });

  test('a refusal is a balloon; a card with no session says so', () => {
    const d = drive();

    d.jump();
    expect(
      shells(
        d.send({
          kind: 'result',
          id: 'jump-workspace:s4',
          command: 'workspace attach-spec',
          reply: { ok: false, error: { code: 'session-queued', message: 'session s4 is queued' } },
        }),
      ),
    ).toContainEqual({
      kind: 'balloon',
      tone: 'error',
      text: 'session s4 is queued (session-queued)',
    });
    // card 5 has no run
    expect(shells(d.jump(5))).toContainEqual({
      kind: 'balloon',
      tone: 'info',
      text: 'No workspace for #5 yet · ⌘⏎ Launch agent',
    });
  });
});
