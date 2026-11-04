/**
 * The jumps' rules: what is linked from where the keyboard is, the shown workspace's
 * story, which session the workspace jump opens, where it lands, and the balloons.
 */
import { describe, expect, test } from 'bun:test';
import type { AttachSpec, SessionData } from '@abe/core';
import { factoryRun, HEADER_NOW, session } from '@abe/testing';
import {
  JUMP_WORKSPACE,
  jumpCommands,
  workspaceLanding,
  NOTHING_LINKED,
  noWorkspace,
  storyOfJump,
  workspaceJump,
  workspaceSession,
  workspaceStory,
} from './index';
import type { JumpFrom } from '../runtime/runtime';
import { workspaceLook } from './index';

const look = (s: SessionData) => {
  if (s.card === null) throw new Error('a card’s session');

  return workspaceLook({ ...s, card: s.card }, undefined, HEADER_NOW);
};

const LOCAL = { ...session('s2', 'working', 2), worktree: '/p/shop-wt/2-cart-total' };
const BOXED = { ...session('s7', 'waiting', 7), worktree: '/workspace/repo', box: 'shop-7' };
const LOOKS = [look(LOCAL), look(BOXED)];

const from = (place: JumpFrom['place'], view: JumpFrom['view'] = 'editor'): JumpFrom => ({
  place,
  view,
});

describe('what is linked', () => {
  const facts = { slots: { main: 2, chat: 3, pane: 4 }, workspace: 5 };

  test.each([
    ['a card on the Board', from('main', 'factory'), 2],
    ['Chat', from('chat'), 3],
    ['a pane row', from('pane'), 4],
    ['an editor split', from('editor'), 5],
    ['the tree', from('tree'), 5],
    ['the Git tab', from('git'), 5],
    ['the toolbar on the Editor', from('toolbar'), 5],
    ['the toolbar on the Factory view', from('toolbar', 'factory'), 2],
  ] as const)('%s', (_, at, story) => {
    expect(storyOfJump(at, facts)).toBe(story);
  });

  test('the layer up (Linked, the story dialog) before what is under it', () => {
    expect(storyOfJump(from('editor'), { ...facts, layer: 9 })).toBe(9);
  });

  test('a slot whose screen has no story, and the main checkout: nothing', () => {
    expect(storyOfJump(from('pane'), { slots: { main: 2 }, workspace: 5 })).toBeUndefined();
    expect(storyOfJump(from('editor'), { slots: { main: 2 } })).toBeUndefined();
  });
});

describe('the shown workspace’s story', () => {
  test('a local worktree by its folder, a slash at its end or not', () => {
    expect(workspaceStory(LOOKS, { root: '/p/shop-wt/2-cart-total/' })).toBe(2);
  });

  test('a box’s workspace by its box (its root is the last local folder)', () => {
    expect(workspaceStory(LOOKS, { root: '/p/shop', box: 'shop-7' })).toBe(7);
  });

  test('two cards’ workspaces on one box (ADR 0022): each by its branch’s card', () => {
    const other = { ...session('s8', 'working', 8), worktree: '/workspace/repo', box: 'shop-7' };
    const looks = [...LOOKS, look(other)];

    expect(workspaceStory(looks, { root: '/p/shop', box: 'shop-7', branch: 'card/8-x' })).toBe(8);
    expect(workspaceStory(looks, { root: '/p/shop', box: 'shop-7', branch: 'card/7-y' })).toBe(7);
  });

  test('no session known there yet: its branch’s card', () => {
    expect(workspaceStory(LOOKS, { root: '/p/shop-wt/9-x', branch: 'card/9-stock-on-cards' })).toBe(
      9,
    );
  });

  test('the main checkout has no story', () => {
    expect(workspaceStory(LOOKS, { root: '/p/shop', branch: 'main' })).toBeUndefined();
  });
});

describe('handing a jump on', () => {
  test('a story: the jump', () => {
    expect(jumpCommands('workspace', 2)).toEqual([{ kind: 'jump', to: 'workspace', story: 2 }]);
  });

  test('nothing linked: a balloon, nothing else', () => {
    expect(jumpCommands('linked', undefined)).toEqual([
      { kind: 'shell', effect: { kind: 'balloon', tone: 'info', text: NOTHING_LINKED } },
    ]);
    expect(NOTHING_LINKED).toBe('Nothing linked here');
  });
});

describe('the workspace jump', () => {
  const live = { ...session('new', 'working', 2), startedAt: '2026-10-01T10:00:00.000Z' };
  const old = { ...session('old', 'ended', 2), startedAt: '2026-10-01T11:00:00.000Z' };

  test('the story’s newest session not ended, before a newer ended one', () => {
    expect(workspaceSession([], [old, live], 2)?.id).toBe('new');
  });

  test('every session ended: the newest ended one', () => {
    const older = { ...old, id: 'older', startedAt: '2026-10-01T08:00:00.000Z' };

    expect(workspaceSession([], [older, old], 2)?.id).toBe('old');
  });

  test('its attach-spec, named by the session', () => {
    expect(workspaceJump([], [live], 2)).toEqual([
      {
        kind: 'run',
        id: `${JUMP_WORKSPACE}new`,
        argv: ['workspace', 'attach-spec', 'new'],
      },
    ]);
  });

  test('a run whose session is not listed yet: the run’s session, as its card reads it', () => {
    const run = factoryRun(2, 'Cart total', 'build', 'running', { session: 'r2' });

    expect(workspaceJump([run], [old], 2)).toEqual([
      { kind: 'run', id: `${JUMP_WORKSPACE}r2`, argv: ['workspace', 'attach-spec', 'r2'] },
    ]);
  });

  test('a run that is over, or a teammate’s, its session not listed: no workspace here', () => {
    const done = factoryRun(2, 'Cart total', 'done', 'done', { session: 'r2' });
    const theirs = factoryRun(2, 'Cart total', 'build', 'running', { session: 'r2' });

    expect(workspaceJump([done], [], 2)).toEqual([
      { kind: 'shell', effect: { kind: 'balloon', tone: 'info', text: noWorkspace(2) } },
    ]);
    expect(workspaceJump([theirs], [], 2, false)).toEqual([
      { kind: 'shell', effect: { kind: 'balloon', tone: 'info', text: noWorkspace(2, false) } },
    ]);
  });

  test('no session yet: no workspace, and how to start one', () => {
    expect(workspaceJump([], [live], 1)).toEqual([
      {
        kind: 'shell',
        effect: { kind: 'balloon', tone: 'info', text: noWorkspace(1) },
      },
    ]);
    expect(noWorkspace(1)).toBe('No workspace for #1 yet · ⌘⏎ Launch agent');
  });

  const spec: AttachSpec = {
    where: 'local',
    root: '/p/shop-wt/2-cart-total',
    nvim: ['nvim', '--embed'],
    shell: ['/bin/zsh', '-l'],
    exec: [],
    box: null,
    waking: false,
  };

  test('a local worktree lands as a project, Chat shown beside it', () => {
    expect(workspaceLanding(spec, 'download:new')).toEqual({
      kind: 'open-project',
      path: '/p/shop-wt/2-cart-total',
      chat: true,
    });
  });

  test('a box attaches, Waking while it is not known to run', () => {
    const cloud: AttachSpec = {
      ...spec,
      where: 'cloud',
      root: '/workspace/repo',
      exec: ['abe', 'box', 'attach', 'shop-7', '--'],
      box: { name: 'shop-7', region: 'eu-west-1' },
      waking: true,
    };

    expect(workspaceLanding(cloud, 'download:s7')).toEqual({
      kind: 'open-project',
      path: '/workspace/repo',
      attach: {
        nvim: cloud.nvim,
        shell: cloud.shell,
        exec: cloud.exec,
        box: { name: 'shop-7', region: 'eu-west-1' },
        waking: true,
        download: 'download:s7',
      },
      chat: true,
    });
  });
});

describe('the workspace jump on a run that never got a box', () => {
  const never: SessionData = {
    ...session('q', 'ended', 2),
    box: 'demo-shop-2',
    neverPlaced: true,
    startedAt: '2026-10-01T12:00:00.000Z',
  };
  const earlier: SessionData = {
    ...session('old', 'ended', 2),
    box: 'demo-shop-2',
    startedAt: '2026-10-01T09:00:00.000Z',
  };

  test('says so: no workspace, no attach asked', () => {
    expect(workspaceJump([], [never], 2)).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'balloon',
          tone: 'info',
          text: '#2’s run never got a box: no workspace to open',
        },
      },
    ]);
  });

  test('an earlier session on a box: still the newest run’s word, as the card menu has it', () => {
    expect(workspaceSession([], [never, earlier], 2)?.id).toBe('q');
  });
});
