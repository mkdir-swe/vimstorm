/**
 * Chats in the Sessions list: a live Abe chat (`Abe · <repo>`) or prototype session is a row of
 * its own, beside the cards' sessions; ⏎ is Chat pinned on it, ⌘⏎ Open Chat and Stop… (its card's
 * story rows only when it has one), no workspace; it counts as nothing in the pill; an ended one
 * is gone.
 */
import { describe, expect, test } from 'bun:test';
import type { SessionData } from '@abe/core';
import { cardsAnswer, F_SESSIONS, runsAnswer, session, sessionsAnswer } from '@abe/testing';
import { type Command, type Input, step } from '../runtime/runtime';
import { sessionRows } from '../board/session-rows';
import { sessionsScreen, type SessionsState } from './sessions';
import { withLive } from '../live';

/** Sessions with its live facts, as the bridge feeds them. */
const LIVE_SESSIONS = withLive(sessionsScreen);

const SIZE = { width: 1020, height: 280 };

const hub = (id: string, state: SessionData['state']): SessionData => ({
  ...session(id, state, 0),
  card: null,
  kind: 'abe',
  title: 'Abe · shop',
  abe: { repo: '/r/shop' },
});

/** A prototype session, its card's when it has one. */
const proto = (id: string, card: number | null): SessionData => ({
  ...session(id, 'waiting', 0),
  card,
  kind: 'prototype',
  title: 'Prototype · VAT line',
  prototype: { id: 'proto-1a2b3c', card },
});

const drive = (sessions: SessionData[]) => {
  let held = step(LIVE_SESSIONS, LIVE_SESSIONS.init, { kind: 'open', params: {}, size: SIZE });
  const d = {
    get state(): SessionsState {
      return held.state.screen;
    },
    get commands(): Command[] {
      return held.commands;
    },
    send(...inputs: Input[]) {
      for (const input of inputs) held = step(LIVE_SESSIONS, held.state, input);

      return d;
    },
    keys: (...keys: string[]) => d.send(...keys.map((key): Input => ({ kind: 'key', key }))),
  };

  return d.send(
    sessionsAnswer(sessions),
    runsAnswer(F_SESSIONS.runs),
    { ...cardsAnswer(F_SESSIONS.cards, false, 'Sprint 1'), id: 'cards' },
    { kind: 'tick', at: F_SESSIONS.now },
  );
};

describe('Chats in Sessions', () => {
  test('a live Abe chat is a row of its own, counted as nothing; an ended one is gone', () => {
    const rows = sessionRows({
      sessions: [hub('a1', 'waiting'), hub('a2', 'ended')],
      runs: [],
      now: F_SESSIONS.now,
    });

    expect(rows.map((r) => [r.session.id, r.title, r.chat, r.counted])).toEqual([
      ['a1', 'Abe · shop', true, 'none'],
    ]);
  });

  test('the Abe chat (the main checkout) is always the top row, over what needs you', () => {
    const rows = sessionRows({
      sessions: [...F_SESSIONS.sessions, proto('p1', null), hub('a1', 'working')],
      runs: F_SESSIONS.runs,
      now: F_SESSIONS.now,
    });

    expect(rows[0]?.session.id).toBe('a1');
    expect(rows.slice(1).some((r) => r.counted === 'needs-you')).toBe(true);
  });

  test('⏎: Chat pinned on the Abe chat and shown', () => {
    const d = drive([hub('a1', 'waiting')]);

    d.keys('<CR>');
    expect(d.commands).toEqual([
      { kind: 'open', screen: 'chat', params: { session: 'a1' }, slot: 'chat' },
      { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
      { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } },
    ]);
  });

  test('⌘⏎: Open Chat and Stop…; Open story and Linked only on a card', () => {
    const rowsOf = (d: ReturnType<typeof drive>) => {
      const menu = d.keys('<D-CR>').commands.find((c) => c.kind === 'menu');

      return menu?.kind === 'menu' ? menu.rows.map((r) => r.id) : [];
    };

    expect(rowsOf(drive([hub('a1', 'waiting')]))).toEqual(['resume', 'stop']);
    expect(rowsOf(drive([proto('p1', 2)]))).toEqual(['resume', 'stop', 'story', 'linked']);
  });

  test('`:` on the Abe chat tells it', () => {
    const d = drive([hub('a1', 'waiting')]);
    const here = sessionsScreen.here?.(d.state);

    expect(here?.subject).toMatchObject({
      caption: 'Abe · shop',
      ask: ['--session', 'a1'],
      tell: { session: 'a1' },
    });
  });
});
