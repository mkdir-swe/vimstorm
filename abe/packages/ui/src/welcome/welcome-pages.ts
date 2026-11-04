/**
 * Welcome's Sessions and Boxes pages (#212; the stripe's bottom items there, #3): the serve-wide lists, so
 * they need no project. Sessions: your live sessions, the ones that need you first; ⏎ opens its
 * workspace on its card (as Welcome's ⏎ on a card does). Boxes: your boxes and what each holds,
 * to look at (their actions are the bottom pane's, in a project).
 */
import type { BoxData, SessionData } from '@abe/core';
import { type Hue, type TableCell, type TableRow } from '../runtime/components';
import { countsOf, type Look, sessionOnlyLook, sessionRailRow } from '../board/flow';

/** A rail state's hue (the Board's marks). */
export const MARK_HUES: Readonly<Record<string, Hue>> = {
  'needs-you': 'needs-you',
  failed: 'bad',
  starting: 'dim',
  running: 'warn',
  ready: 'good',
  idle: 'dim',
  'on-test': 'good',
  merged: 'good',
  ended: 'dim',
};

const looked = (
  sessions: readonly SessionData[],
  now: string | undefined,
): { session: SessionData; look: Look }[] =>
  sessions.flatMap((session) => {
    const look = session.state === 'ended' ? undefined : sessionOnlyLook(session, now);

    return look === undefined ? [] : [{ session, look }];
  });

/** The Sessions page's rows: live sessions, the ones that need you first, then the newest. */
export const liveSessions = (
  sessions: readonly SessionData[],
  now: string | undefined,
  filter: string,
): { session: SessionData; look: Look }[] =>
  looked(sessions, now)
    .filter(
      ({ session: x }) =>
        filter === '' ||
        x.title.toLowerCase().includes(filter) ||
        (x.card !== null && `#${x.card}`.includes(filter)) ||
        x.repo.toLowerCase().includes(filter),
    )
    .sort(
      (a, b) =>
        Number(b.look.counted === 'needs-you') - Number(a.look.counted === 'needs-you') ||
        b.session.since.localeCompare(a.session.since),
    );

/** What the sessions say on the stripe (#3): who needs you, what runs, what failed. */
export const sessionsCounts = (
  sessions: readonly SessionData[] | undefined,
  now: string | undefined,
) => countsOf(looked(sessions ?? [], now).map((l) => l.look));

const shortRepo = (repo: string): string => repo.replace(/\/+$/, '').split('/').at(-1) ?? repo;

/** A session's row: `#id` · title · repo · state · time in state. */
export const sessionRow = (
  { session: x, look }: { session: SessionData; look: Look },
  now: string | undefined,
): TableRow => {
  const rail = sessionRailRow(x, look, { now });
  const cells: TableCell[] = [
    x.card === null ? { text: 'Ask', hue: 'dim' } : { accent: `#${x.card}` },
    { text: x.title, tooltip: x.title },
    { text: x.box ?? shortRepo(x.repo), hue: 'dim' },
    { mark: rail.glyph, text: rail.word, hue: MARK_HUES[rail.state] ?? 'dim' },
    { text: rail.time ?? '', hue: 'dim' },
  ];

  return { id: `session:${x.id}`, cells };
};

const BOX_WORDS: Readonly<Record<BoxData['state'], { mark: string; text: string; hue: Hue }>> = {
  pending: { mark: '◐', text: 'Starting', hue: 'dim' },
  running: { mark: '●', text: 'Running', hue: 'warn' },
  stopping: { mark: '◐', text: 'Going to sleep', hue: 'dim' },
  stopped: { mark: '○', text: 'Asleep', hue: 'dim' },
  'shutting-down': { mark: '◐', text: 'Removing', hue: 'dim' },
  terminated: { mark: '○', text: 'Removed', hue: 'dim' },
};

/** The Boxes page's rows: each box, what card it holds. */
export const boxRows = (boxes: readonly BoxData[], filter: string): TableRow[] =>
  boxes
    .filter(
      (b) =>
        filter === '' ||
        b.name.toLowerCase().includes(filter) ||
        (b.title?.toLowerCase().includes(filter) ?? false) ||
        (b.card !== null && `#${b.card}`.includes(filter)),
    )
    .map((b) => ({
      id: `box:${b.name}`,
      cells: [
        { text: b.name },
        b.card === null ? { text: '' } : { accent: `#${b.card}` },
        { text: b.title ?? '', hue: 'dim' },
        BOX_WORDS[b.state],
        { text: b.size ?? '', hue: 'dim' },
      ],
    }));
