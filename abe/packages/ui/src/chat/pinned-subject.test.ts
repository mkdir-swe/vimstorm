/**
 * `:` on Chat's session (#346): its ⌘⏎ rows then its slash commands, run as if typed in the field;
 * the Abe chat's ⌘⏎ has New conversation (`abe chat --new`), its answer pinned.
 */
import { describe, expect, test } from 'bun:test';
import type { SessionData } from '@abe/core';
import { runsAnswer, session, sessionsAnswer } from '@abe/testing';
import { type Command, type Input, type Menu, step } from '../runtime/runtime';
import { pinnedScreen, type PinnedState } from './pinned';
import { SESSION_MENU } from './rendered';
import { withLive } from '../live';

/** Chat with its live facts, as the bridge feeds them. */
const CHAT = withLive(pinnedScreen);

const SIZE = { width: 420, height: 800 };

const drive = (params: Record<string, string>, sessions: SessionData[]) => {
  let held = step(CHAT, CHAT.init, { kind: 'open', params, size: SIZE });
  const d = {
    get state(): PinnedState {
      return held.state.screen;
    },
    get commands(): Command[] {
      return held.commands;
    },
    send(...inputs: Input[]) {
      for (const input of inputs) held = step(CHAT, held.state, input);

      return d;
    },
  };

  return d.send(sessionsAnswer(sessions), runsAnswer([]));
};

const subjectMenu = (s: PinnedState): Menu | undefined => pinnedScreen.here?.(s).subject?.menu;

const HUB: SessionData = {
  ...session('abe-a1b2', 'waiting', 0),
  card: null,
  kind: 'abe',
  title: 'Abe · shop',
  repo: '/p/shop',
  worktree: '/p/shop',
  branch: '',
  abe: { repo: '/p/shop' },
};

describe('Chat’s Subject in `:` (#346)', () => {
  test('a card’s live session: its ⌘⏎ rows with /model, /compact, /override before the jumps', () => {
    const d = drive({ root: '/p/shop', card: '4', session: 's4' }, [session('s4', 'waiting', 4)]);
    const rows = subjectMenu(d.state)?.rows.map((r) => r.id) ?? [];

    // before the jumps along its story, within the Subject's six
    expect(rows.filter((r) => r.startsWith('slash:'))).toEqual([
      'slash:/model',
      'slash:/compact',
      'slash:/override',
    ]);
    expect(rows.slice(-3)).toEqual(['workspace', 'story', 'linked']);
    expect(rows.indexOf('slash:/override')).toBeLessThan(6);
    expect(subjectMenu(d.state)?.id).toBe(SESSION_MENU);
  });

  test('/compact chosen: sent to the session as typed', () => {
    const d = drive({ root: '/p/shop', card: '4', session: 's4' }, [session('s4', 'waiting', 4)]);

    d.send({ kind: 'choice', menu: SESSION_MENU, row: 'slash:/compact' });
    expect(d.commands.flatMap((c) => (c.kind === 'run' ? [c.argv.join(' ')] : []))).toEqual([
      'session send s4 /compact',
    ]);
  });

  test('an ended session has no slash rows', () => {
    const d = drive({ root: '/p/shop', card: '4', session: 's4' }, [session('s4', 'ended', 4)]);

    expect(subjectMenu(d.state)?.rows.some((r) => r.id.startsWith('slash:'))).toBe(false);
  });

  test('the Abe chat: New conversation first (abe chat --new), Stop…, no story jumps, no /override', () => {
    const d = drive({ root: '/p/shop' }, [HUB]);
    const rows = subjectMenu(d.state)?.rows ?? [];

    expect(rows.map((r) => r.id)).toEqual([
      'new-conversation',
      'stop',
      'slash:/model',
      'slash:/compact',
    ]);
    // back to Chat, which runs it as its + does: the answer pins the new tab, the keys in its input
    expect(rows[0]?.does).toEqual({ kind: 'back' });
    // the menu rests on it: ⌘⏎ ⏎ opens the tab (an idle one spends nothing)
    expect(rows[0]?.costly).toBeUndefined();
    d.send({ kind: 'choice', menu: SESSION_MENU, row: 'new-conversation' });
    expect(d.commands).toEqual([
      { kind: 'run', id: 'chat:hub', argv: ['chat', '--new', '--repo', '/p/shop'] },
    ]);
  });
});
