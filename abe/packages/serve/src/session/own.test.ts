/**
 * What a session of each kind acts as (ADR 0020): a card's acts, a prototype is refused by name.
 * The Abe chat's requests are the person's (`ctx.session` undefined), never a session's.
 */
import { describe, expect, test } from 'bun:test';
import { SessionMeta } from '@abe/core';
import { ownSession } from './own';

const CARD = {
  v: 1,
  id: '4-ab12',
  card: 4,
  title: 'Sign in',
  repo: '/r/shop',
  worktree: '/r/shop-wt/card-4-sign-in',
  branch: 'card/4-sign-in',
  state: 'working',
  since: '2026-10-24T10:00:00.000Z',
  startedAt: '2026-10-24T10:00:00.000Z',
  transcriptPath: null,
  lastAssistantMessage: null,
  claudeSession: '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6',
  socket: '/s/4-ab12/session.sock',
};
const chat = { card: null, worktree: '/r/shop', branch: '' };

describe('ownSession', () => {
  test.each([
    ['a card session', CARD, { ok: true, data: { card: 4, branch: 'card/4-sign-in' } }],
    [
      'a prototype',
      { ...CARD, ...chat, prototype: { id: 'proto-1a2b3c', card: null } },
      'is a prototype',
    ],
  ])('%s', (_, doc, outcome) => {
    const meta = SessionMeta.parse(doc);
    const own = ownSession({ session: meta.id, serve: { sessions: { metaOf: () => meta } } });

    if (typeof outcome === 'string') {
      expect(own.ok ? undefined : own.error.code).toBe('not-your-session');
      expect(own.ok ? '' : own.error.message).toContain(outcome);
    } else expect(own).toMatchObject(outcome);
  });
});
