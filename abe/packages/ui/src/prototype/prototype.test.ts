/**
 * A prototype's tile's page at the screen's seam: the tree it draws from `prototype list` and
 * `prototype show` per state and page, and what its keys run.
 */
import { describe, expect, test } from 'bun:test';
import type { PrototypeData } from '@abe/core';
import { minutes, prototype } from '@abe/testing';
import { type Command, type Input, step } from '../runtime/runtime';
import { prototypeScreen, type PrototypeState } from './prototype';
import type { PrototypePage } from './prototype-components';

const CODE = {
  session: 'prototype-a1b2',
  branch: 'proto/p7-cart-badge',
  worktree: '/w/proto-p7-cart-badge',
  box: null,
  spec: null,
  stored: null,
  commented: false,
  sent: null,
  made: null,
  ended: false,
};
const LIVE = prototype('live', { card: null, code: CODE, title: 'cart badge' });
/** On the repo's fixed ports: no proxy, its preview link the app's own (ADR 0039). */
const ON_PORTS = prototype('live', {
  card: null,
  code: CODE,
  url: 'http://localhost:4000',
  app: 'http://localhost:4000',
  ports: [4000, 8888],
});

/** The screen on `page` with `p` read, then `keys`: its tree and every command it asked. */
const drive = (page: string, p: PrototypeData, keys: string[] = []) => {
  const run = (s: PrototypeState, input: Input) => step(prototypeScreen, s, input);
  let held = run(prototypeScreen.init, {
    kind: 'open',
    params: { id: p.id, page },
    size: { width: 1180, height: 760 },
  });
  const commands: Command[] = [];
  const inputs: Input[] = [
    { kind: 'tick', at: minutes(10) },
    {
      kind: 'result',
      id: 'proto-list',
      command: 'prototype list',
      reply: { ok: true, data: { prototypes: [p] } },
    },
    ...keys.map((key): Input => ({ kind: 'key', key })),
  ];

  for (const input of inputs) {
    held = run(held.state, input);
    commands.push(...held.commands);
  }
  if (held.tree.kind !== 'PrototypePage') throw new Error(held.tree.kind);

  return { page: held.tree satisfies PrototypePage, commands };
};

const argvs = (commands: Command[]) =>
  commands.flatMap((c) => (c.kind === 'run' || c.kind === 'confirm' ? [c.argv.join(' ')] : []));

describe('a prototype tile’s page', () => {
  test.each([
    ['preview', LIVE, [], 'live', 'Fit', 1],
    ['preview', LIVE, ['v', 'v', 'v'], 'live', '390', 1],
    ['preview', ON_PORTS, [], 'live', 'Fit', 1],
    ['preview', prototype('starting', { code: CODE, step: 'start' }), [], 'starting', 'Fit', 0],
    [
      'preview',
      prototype('failed', { code: CODE, reason: 'start exited 1; its last lines:\nEADDRINUSE' }),
      [],
      'failed',
      'Fit',
      0,
    ],
    ['preview', prototype('stopped', { code: CODE, shot: '/s/1.png' }), [], 'stopped', 'Fit', 0],
    ['code', LIVE, [], 'code', undefined, 0],
    ['logs', LIVE, [], 'logs', undefined, 0],
  ] as const)('%s on %#: draws %s', (page, p, keys, body, viewport, browsers) => {
    const { page: tree } = drive(page, p, [...keys]);

    expect(tree.props.body.kind).toBe(body);
    expect(tree.props.bar?.viewports.find((v) => v.on)?.label).toBe(viewport);
    // the live app alone has its page, without the BrowserView's bar: in app mode behind the
    // proxy, open as a browser on its own ports (its URL as given: the sign-in comes back to it)
    expect(tree.children?.length ?? 0).toBe(browsers);
    if (browsers > 0)
      expect(tree.children?.[0]?.props).toMatchObject(
        p.ports.length > 0
          ? { mode: 'open', bare: true, url: 'http://localhost:4000' }
          : { mode: 'app', bare: true },
      );
    if (viewport === '390') expect(tree.props.body).toMatchObject({ width: 390, phone: true });
    if (body === 'stopped') expect(tree.props.body).toMatchObject({ shot: '/s/1.png' });
  });

  test.each([
    [
      '⏎ on a stopped one starts it',
      prototype('stopped', { code: CODE }),
      ['<CR>'],
      ['prototype restart --id proto-1a2b3c'],
    ],
    ['R restarts a live one', LIVE, ['R'], ['prototype restart --id proto-1a2b3c']],
    ['s stops it', LIVE, ['s'], ['prototype stop --id proto-1a2b3c']],
    ['d asks before discarding', LIVE, ['d'], ['prototype discard proto-1a2b3c']],
    [
      '⏎ on a failed one asks its session to fix it',
      prototype('failed', { code: CODE, reason: 'exited 1' }),
      ['<CR>'],
      [
        'session send prototype-a1b2 The app did not start. exited 1\nFix it so it starts, then say so.',
      ],
    ],
    ['⏎ on a live one gives it the keys, no command', LIVE, ['<CR>'], []],
  ] as const)('%s', (_, p, keys, want) => {
    const { commands } = drive('preview', p, [...keys]);

    expect(argvs(commands).filter((a) => !a.startsWith('prototype list'))).toEqual([...want]);
    if (keys[0] === 'd') expect(commands.some((c) => c.kind === 'confirm' && c.danger)).toBe(true);
  });
});
