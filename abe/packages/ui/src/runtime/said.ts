/**
 * What a run says on the status line and in lists, in words (#204): an ISO time in local time, a
 * CLI's answer as a sentence.
 */
import type { SessionData } from '@abe/core';
import { screenWhen } from '@abe/core/when';

/** An RFC 3339 UTC time as the CLI prints one (`2026-10-24T11:33:08.330Z`). */
const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/g;

/**
 * `13:33` today (as of `now`), else `24 Oct 13:33`, in this Mac's time zone from its own instant
 * (core's `screenWhen`, #260: a DST change between it and `now` names its zone).
 */
export const localTime = (iso: string, now?: string): string => screenWhen(iso, now);

/** Every ISO time in `text` in local time. */
export const localTimes = (text: string, now?: string): string =>
  text.replace(ISO, (iso) => localTime(iso, now));

/** A first word that is a plain word (`commented`, `done:`), not a name (`demo-shop-3`, `src/a.ts`). */
const PLAIN_WORD = /^[a-z]+[.:,;!?]?(?:\s|$)/;

/** A CLI's answer line as a sentence: its first letter capital, unless it starts with a name (#217). */
export const sentence = (line: string): string =>
  PLAIN_WORD.test(line) ? `${line.charAt(0).toUpperCase()}${line.slice(1)}` : line;

/** Whose session a Stop… names: `#30's session`, or `this session` with no card. */
const whoseSession = (card: number | undefined) =>
  card === undefined ? 'this session' : `#${card}'s session`;

/**
 * Stop…'s question (#204): what stops, what stays. A Queued session has no Claude Code, worktree
 * or branch yet (#246): it only leaves the queue.
 */
export const stopSessionConfirm = (
  card: number | undefined,
  s: Pick<SessionData, 'state' | 'branch'>,
) => ({
  question: `Stop ${whoseSession(card)}?`,
  details: [
    s.state === 'queued'
      ? 'It is Queued: it leaves the queue, and no box is made for it. Nothing ran yet.'
      : `Its Claude Code stops; its worktree and its branch stay: ${s.branch}`,
  ],
  yes: 'Stop',
});

/** Stop…'s detail in a session's menu: what stays, or that a Queued one leaves the queue (#246). */
export const stopDim = (s: Pick<SessionData, 'state'>): string =>
  s.state === 'queued' ? 'takes it out of the queue' : 'its worktree and branch stay';

/** The status line once Stop… went through: `Stopped #30's session`. */
export const stoppedWords = (card: number | undefined): string => `Stopped ${whoseSession(card)}`;
