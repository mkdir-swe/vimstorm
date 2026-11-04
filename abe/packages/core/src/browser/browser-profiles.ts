/**
 * Browser profiles you define (#103): a named profile `{name, purpose}` in a Layer's
 * `browser.profiles`, the team's shared ones then yours, and the built-in `default` (empty: a
 * fresh profile every start, 2.0's verify browser). On the Mac a profile's sign-ins are made in
 * its Chrome folder `<config>/chrome/<name>`; 1.0's two fixed Chromes become `work` and
 * `work-admin` once (`migrationPlan`), with links left under their old names.
 */
import { z } from 'zod';
import type { Layer } from '../layer/settings/keys';

/** A profile's name: a folder name as 1.0's Chromes had (`a-z`, `0-9`, `-`). */
export const PROFILE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The built-in profile: empty, made anew every start. No Layer may name it. */
export const DEFAULT_PROFILE = 'default';

export const ProfileName = z
  .string()
  .regex(PROFILE_NAME, 'a profile is a name of a-z, 0-9 and -')
  .refine((n) => n !== DEFAULT_PROFILE, 'default is the built-in empty profile');

export const BrowserProfile = z.strictObject({
  name: ProfileName,
  purpose: z.string().trim().min(1, 'a purpose, one line'),
});
export type BrowserProfile = z.infer<typeof BrowserProfile>;

/**
 * A plain entry adds the profiles it names; a name already given above is the same profile, and
 * the upper purpose wins (the lower entry is dropped silently).
 */
export const addProfiles = (
  above: readonly BrowserProfile[],
  written: readonly BrowserProfile[],
): BrowserProfile[] => [
  ...above,
  ...written.filter(
    (w, i) =>
      !above.some((a) => a.name === w.name) && written.findIndex((x) => x.name === w.name) === i,
  ),
];

/** Where a profile comes from: the first Layer that names it, or built-in. */
export type ProfileSource = Layer | 'built-in';

export type SourcedProfile = BrowserProfile & { layer: ProfileSource };

/** One Layer's `browser.profiles` as its file writes it (explain's steps), top Layer first. */
export type ProfileStep = { layer: Layer; written: unknown };

/** Every profile with the Layer that first names it, top first. */
export const sourcedProfiles = (steps: readonly ProfileStep[]): SourcedProfile[] => {
  const out: SourcedProfile[] = [];

  for (const step of steps) {
    const read = z.array(BrowserProfile).safeParse(step.written);

    if (!read.success) continue;
    for (const p of read.data)
      if (!out.some((o) => o.name === p.name)) out.push({ ...p, layer: step.layer });
  }

  return out;
};

/** A folder in `<config>/chrome/` as the migration sees it. */
export type ChromeFolder = { name: string; link: boolean };

export type Migration = {
  /** Folders renamed, in order. */
  renames: { from: string; to: string }[];
  /** Links left under the old names (`from` → `to`). */
  links: { from: string; to: string }[];
  /** Profiles your Layer gets (only those it does not name yet). */
  profiles: BrowserProfile[];
  /** `browser.default` for your Layer, when it has none yet. */
  default: string | null;
};

const NO_MIGRATION: Migration = { renames: [], links: [], profiles: [], default: null };

/** 1.0's names after the migration. */
export const WORK = 'work';
export const WORK_ADMIN = 'work-admin';

/**
 * 1.0's two Chromes, once: exactly one folder `<x>` and its `<x>-admin` twin (real folders, no
 * `work`) are renamed `work` / `work-admin` with links under the old names, and your Layer gets
 * both with `work` as its default. Any other layout renames nothing. Run again it changes nothing:
 * the renamed folders are `work` now and the old names links.
 */
export const migrationPlan = (
  folders: readonly ChromeFolder[],
  yours: { profiles: readonly BrowserProfile[]; default: string | null },
): Migration => {
  const real = folders.filter((f) => !f.link).map((f) => f.name);

  if (real.includes(WORK) || real.length !== 2) return NO_MIGRATION;
  const base = real.find((n) => real.includes(`${n}-admin`));

  if (base === undefined || !PROFILE_NAME.test(base)) return NO_MIGRATION;
  const admin = `${base}-admin`;
  const wanted: BrowserProfile[] = [
    { name: WORK, purpose: 'app user' },
    { name: WORK_ADMIN, purpose: 'admin' },
  ];

  return {
    renames: [
      { from: base, to: WORK },
      { from: admin, to: WORK_ADMIN },
    ],
    links: [
      { from: base, to: WORK },
      { from: admin, to: WORK_ADMIN },
    ],
    profiles: wanted.filter((w) => !yours.profiles.some((p) => p.name === w.name)),
    default: yours.default === null ? WORK : null,
  };
};

/** Real Chrome folders no Layer names (`Not in a Layer: <name>`). */
export const unlistedFolders = (
  folders: readonly ChromeFolder[],
  profiles: readonly BrowserProfile[],
): string[] =>
  folders
    .filter((f) => !f.link && PROFILE_NAME.test(f.name))
    .map((f) => f.name)
    .filter((n) => n !== DEFAULT_PROFILE && !profiles.some((p) => p.name === n))
    .sort();

const iso = z.iso.datetime();

/** One row of `abe browser list`. */
export const ProfileRow = z.object({
  name: z.string(),
  purpose: z.string(),
  /** The Layer that names it, or `built-in` for `default`. */
  layer: z.union([z.enum(['core', 'feel', 'repo', 'individual']), z.literal('built-in')]),
  default: z.boolean(),
  /** When its sign-ins were last stored (`abe browser store`), `null` while not stored. */
  storedAt: iso.nullable(),
  /** Whether its Chrome folder is on this Mac; `null` where there are no Chromes (a box). */
  folder: z.boolean().nullable(),
  /** Whether its Chrome is open on that folder now; `null` where there are no Chromes. */
  open: z.boolean().nullable().default(null),
  /** How long ago `storedAt` was (`3 hours ago`), on serve's clock. */
  storedAgo: z.string().nullable().default(null),
  /** Why the last store when its Chrome closed (or its sign-ins changed) failed; `null`: none did. */
  storeFailed: z.string().nullable().default(null),
});
export type ProfileRow = z.infer<typeof ProfileRow>;

export const BrowserListData = z.object({
  profiles: z.array(ProfileRow),
  /** Real Chrome folders no Layer names. */
  unlisted: z.array(z.string()),
  /** What the 1.0 migration did on this read (empty when nothing). */
  migrated: z.array(z.object({ from: z.string(), to: z.string() })),
  /** `browser.default` naming a profile no Layer has. */
  missingDefault: z.string().nullable(),
});
export type BrowserListData = z.infer<typeof BrowserListData>;

export type ListInput = {
  profiles: readonly SourcedProfile[];
  default: string | null;
  folders: readonly ChromeFolder[] | null;
  stored: (name: string) => string | null;
  migrated: Migration['renames'];
  /** Whether a profile's Chrome is open now (none known: `null`). */
  open?: (name: string) => boolean | null;
  /** The last automatic store's failure, said. */
  failed?: (name: string) => string | null;
  /** How long ago a time was (`3 hours ago`), on serve's clock. */
  ago?: (at: string) => string;
};

/** The list, team's first then yours, the built-in `default` last. */
export const profileList = (o: ListInput): BrowserListData => {
  const known = o.profiles.some((p) => p.name === o.default);
  const effective = o.default !== null && known ? o.default : DEFAULT_PROFILE;
  const folder = (name: string) =>
    o.folders === null ? null : o.folders.some((f) => f.name === name);

  return {
    profiles: [
      ...o.profiles.map((p) => {
        const storedAt = o.stored(p.name);

        return {
          name: p.name,
          purpose: p.purpose,
          layer: p.layer,
          default: p.name === effective,
          storedAt,
          folder: folder(p.name),
          open: o.open?.(p.name) ?? null,
          storedAgo: storedAt === null ? null : (o.ago?.(storedAt) ?? null),
          storeFailed: o.failed?.(p.name) ?? null,
        };
      }),
      {
        name: DEFAULT_PROFILE,
        purpose: 'empty · a fresh profile every start',
        layer: 'built-in' as const,
        default: effective === DEFAULT_PROFILE,
        storedAt: null,
        folder: null,
        open: null,
        storedAgo: null,
        storeFailed: null,
      },
    ],
    unlisted: o.folders === null ? [] : unlistedFolders(o.folders, o.profiles),
    migrated: o.migrated,
    missingDefault: o.default !== null && !known ? o.default : null,
  };
};

const where = (layer: ProfileRow['layer']) => {
  if (layer === 'built-in') return 'built-in';

  return layer === 'individual' ? 'yours' : `from ${layer}`;
};

const storedText = (p: ProfileRow) => {
  if (p.name === DEFAULT_PROFILE) return '';

  return p.storedAt === null ? ' · not stored' : ` · stored ${p.storedAt.slice(0, 10)}`;
};

export const browserListText = (d: BrowserListData): string => {
  const width = Math.max(...d.profiles.map((p) => p.name.length));
  const rows = d.profiles.map((p) => {
    const stored = storedText(p);

    return `${p.name.padEnd(width)}  ${p.purpose} · ${where(p.layer)}${stored}${p.default ? ' · default' : ''}\n`;
  });
  const moved = d.migrated.map(
    (m) => `renamed ${m.from} → ${m.to} (a link is left under ${m.from})\n`,
  );
  const unlisted = d.unlisted.map(
    (n) => `Not in a Layer: ${n} · abe browser add ${n} --purpose …\n`,
  );
  const missing =
    d.missingDefault === null
      ? []
      : [`browser.default names ${d.missingDefault}, which no Layer has\n`];

  return [...moved, ...rows, ...unlisted, ...missing].join('');
};

/** What `add`, `rename`, `remove` and `default` answer: your Layer's file and the list after. */
export const BrowserWriteData = z.object({
  file: z.string(),
  done: z.string(),
  list: BrowserListData,
});
export type BrowserWriteData = z.infer<typeof BrowserWriteData>;
