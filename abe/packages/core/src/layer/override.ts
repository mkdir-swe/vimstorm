/**
 * `/override` (#114 S4): a session limit lowered for one session only, explicit, reasoned and
 * tracked. Sessions run in auto always; an Override names a Reach area (`db write <env>`,
 * `aws write <env>`, their read forms), and with its reason it is kept in the session's meta (it
 * dies with the session) and noted in the pull request's Notes (never commented on the story:
 * `NOT_COMMENTED`). While it lives, a PermissionRequest in its area is held for a
 * permission card (`inArea`) instead of being answered by 2.0's rules.
 *
 * A write area is a box's only: write names exist only there (ADR 0016), so on a local session it
 * is refused `writes-only-on-box`. A session's network is open (ADR 0029), so `network <host>` is
 * no area: it is refused saying so, and one an older serve kept in a session's meta is dropped on
 * read (`readOverrides`). Pure: serve records, notes and holds.
 */
import { z } from 'zod';
import { NOTES_HEADING } from '../factory/factory-pr';
import { type Outcome, refused } from '../command';
import { profileName } from './reach';
import { promptInput } from '../session/ask';
import { ENVIRONMENT_NAME, reachName } from './settings/reach';

export const OverrideArea = z.object({
  kind: z.literal('reach'),
  service: z.enum(['db', 'aws']),
  access: z.enum(['read', 'write']),
  environment: z.string(),
});
export type OverrideArea = z.infer<typeof OverrideArea>;

/** One Override on a session: `what` as typed (normalized), its words, its area, why, when. */
export const SessionOverride = z.object({
  what: z.string(),
  words: z.string(),
  area: OverrideArea,
  reason: z.string(),
  at: z.iso.datetime(),
});
export type SessionOverride = z.infer<typeof SessionOverride>;

const title = (word: string) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;

const wordsOf = (area: OverrideArea): string =>
  `${title(area.environment)} ${area.service === 'db' ? 'DB' : 'AWS'} ${area.access}`;

const whatOf = (area: OverrideArea): string => `${area.service} ${area.access} ${area.environment}`;

/**
 * A session's Overrides as its meta holds them: one an older serve kept for `network <host>`
 * (retired: the network is open, ADR 0029) is dropped, the rest read as they are.
 */
export const readOverrides = z.preprocess(
  (list) =>
    Array.isArray(list)
      ? list.filter((o) => {
          const area = z.object({ area: z.object({ kind: z.string() }) }).safeParse(o);

          return !(area.success && area.data.area.kind === 'network');
        })
      : list,
  z.array(SessionOverride),
);

/** Every area an Override may name, for a refusal. */
export const overrideAreasText = (environments: readonly string[]): string =>
  `db read <env>, db write <env>, aws read <env>, aws write <env> (environments: ${environments.length === 0 ? 'none in Reach' : environments.join(', ')})`;

const areaOf = (what: string, environments: readonly string[]): OverrideArea | undefined => {
  const [first, second, third, ...rest] = what.trim().toLowerCase().split(/\s+/);

  if (rest.length > 0) return undefined;
  if (
    (first === 'db' || first === 'aws') &&
    (second === 'read' || second === 'write') &&
    third !== undefined &&
    ENVIRONMENT_NAME.test(third) &&
    environments.includes(third)
  )
    return { kind: 'reach', service: first, access: second, environment: third };

  return undefined;
};

/**
 * `abe session override --what <area> --reason <text>` read: the Override, or why not. `where`:
 * where the session runs (a write area only on a box); `environments`: Reach's, in force there.
 */
export const parseOverride = (o: {
  what: string;
  reason: string;
  where: 'local' | 'cloud';
  environments: readonly string[];
  at: string;
}): Outcome<SessionOverride> => {
  const area = areaOf(o.what, o.environments);
  const typed = o.what.trim().toLowerCase();

  if (area === undefined && typed.split(/\s+/)[0] === 'network')
    return refused(
      'not-an-area',
      `${typed.replace(/\s+/g, ' ')}: a session's network is open (ADR 0029), so there is no host to override. Override one of: ${overrideAreasText(o.environments)}`,
      2,
    );
  if (area === undefined)
    return refused(
      'not-an-area',
      `not an area an Override lowers: ${o.what.trim() === '' ? '(none)' : o.what.trim()}. Override one of: ${overrideAreasText(o.environments)}`,
      2,
    );
  const reason = o.reason.trim();

  if (reason === '') return refused('no-reason', 'an Override needs its reason: --reason <why>', 2);
  const words = wordsOf(area);

  if (area.access === 'write' && o.where === 'local')
    return refused(
      'writes-only-on-box',
      `${words} is a write, and write names exist only on a box (ADR 0016): Move to cloud, then override it there`,
    );

  return { ok: true, data: { what: whatOf(area), words, area, reason, at: o.at } };
};

/** The pull request's Notes line. */
export const overrideNote = (o: SessionOverride, session: string): string =>
  `- Override on session ${session}: ${o.words} · reason: ${o.reason}`;

/** A held permission card's why line, in Reach's words. */
export const overrideWhy = (o: SessionOverride): string =>
  `Reach: ${o.words}, overridden for this session: ${o.reason}`;

const HEADING = /^#{1,6}\s/;
const BULLET = /^([-*+]|\d+[.)])\s/;

/**
 * The body with each note line in its `## Notes`, after the section's last bullet (the section
 * added at the end when there is none); a line already there is not added again.
 */
export const withOverrideNotes = (body: string, notes: readonly string[]): string => {
  const lines = body.split('\n');
  // A body edited on GitHub's web may end its lines in \r\n.
  const fresh = notes.filter((n) => !lines.some((l) => l.trimEnd() === n));

  if (fresh.length === 0) return body;
  const at = lines.findIndex((l) => l.trimEnd() === NOTES_HEADING);

  if (at === -1) return `${body.trimEnd()}\n\n${NOTES_HEADING}\n\n${fresh.join('\n')}\n`;
  const heading = lines.findIndex((l, i) => i > at && HEADING.test(l));
  const end = heading === -1 ? lines.length : heading;
  let last = at;

  for (let i = at + 1; i < end; i += 1) if (BULLET.test(lines[i] ?? '')) last = i;
  const after = last === at ? at + 1 : last + 1;
  const next = lines[after];
  // A paragraph right after would read as the last bullet's continuation.
  const gap = next !== undefined && next.trim() !== '' && !BULLET.test(next) ? [''] : [];

  return [
    ...lines.slice(0, after),
    ...(last === at ? ['', ...fresh] : fresh),
    ...gap,
    ...lines.slice(after),
  ].join('\n');
};

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `text` names `word` whole (a Reach name, a profile). */
const namesWord = (text: string, word: string) =>
  new RegExp(`(^|[^A-Za-z0-9_-])${escaped(word)}($|[^A-Za-z0-9_-])`).test(text);

/**
 * Whether a PermissionRequest is in the Override's area, so serve holds it for a card: a Reach
 * area's when its command or input names the area's Reach name or AWS profile
 * (`$ABE_DB_WRITE_URL_TEST`, `--profile abe-write-test`).
 */
export const inArea = (o: SessionOverride, payload: unknown): boolean => {
  const { input } = promptInput(payload);

  if (input === '') return false;
  const area = o.area;
  const name = reachName(area.service, area.access, area.environment);

  return (
    namesWord(input, name) ||
    (area.service === 'aws' && namesWord(input, profileName(area.access, area.environment)))
  );
};

/** `abe session override`: the Override as recorded, and how its tracking went. */
export const SessionOverrideData = z.object({
  id: z.string(),
  override: SessionOverride,
  /** Why the story was not commented on (`NOT_COMMENTED`, `no story: a chat of yours`). */
  story: z.string(),
  /** `noted on <url>`, `noted at factory pr`, or why not. */
  pr: z.string(),
});
export type SessionOverrideData = z.infer<typeof SessionOverrideData>;

export const sessionOverrideText = (d: SessionOverrideData): string =>
  `${d.id}: ${d.override.words} overridden · reason: ${d.override.reason}\n  story  ${d.story}\n  PR     ${d.pr}\n`;
