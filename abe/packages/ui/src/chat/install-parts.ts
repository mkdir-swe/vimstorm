/**
 * The install's strip (#71): one dim line at the top of the repo's Abe chat, under its header,
 * the parts a set-up repo has, each as its last check said it (`abe install status`, then
 * `install.changed`): its mark and its name, then `Files N`, the files the install wrote. A part
 * clicked unfolds its last check's line under the strip with Re-check and Do again, which only
 * say so to the install's chat (serve checks a part, the session does it); `Files N` clicked
 * unfolds the files, each opened in the Editor on its click. Done: `✓ Done` and the files alone.
 * Rust draws it (`app/src/factory/install.rs`); this decides every word and hue.
 *
 * Clicks: `install:part:<part>` and `install:files` unfold (again: fold), `install:file:<n>` opens
 * the n-th file, a part's buttons `install:recheck:<part>`, `install:again:<part>`.
 */
import type { InstallPart, InstallView, PartState } from '@abe/core';
import { z } from 'zod';
import type { Hue } from '../runtime/components';

/** A part on the strip: its mark in its hue, its name; `open`: its line unfolded. */
export type InstallChip = {
  id: string;
  glyph: string;
  hue: Hue;
  name: string;
  open?: boolean | undefined;
};

/** A button under the strip: its click is its id. */
export type InstallAction = { id: string; label: string };

/**
 * What unfolds under the strip: a part (its mark, name, `optional` dim after it, the last
 * check's line, its two buttons), or the files the install wrote (each path, its click its id).
 */
export type InstallUnfold =
  | {
      kind: 'part';
      glyph: string;
      hue: Hue;
      name: string;
      tag?: string | undefined;
      line: string;
      actions: InstallAction[];
    }
  | { kind: 'files'; files: InstallAction[] };

/**
 * The strip: `Install`, its state (`3 of 7`, over every part drawn; `✓ Done`), `Join` on a teammate's install, a chip
 * per part, `Files N`, what is unfolded. `compact`: a narrow column, the marks without names.
 */
export type InstallParts = {
  kind: 'InstallParts';
  id?: string | undefined;
  props: {
    title: string;
    state: { text: string; hue: Hue };
    join?: { text: string; hue: Hue } | undefined;
    parts: InstallChip[];
    files?: { id: string; text: string; open?: boolean | undefined } | undefined;
    unfolded?: InstallUnfold | undefined;
    compact?: boolean | undefined;
  };
};

export type InstallNode = InstallParts;

export const INSTALL_KINDS = ['InstallParts'] as const;

/** The schema, on the set's own primitives (`components.ts` calls this). */
export const installSchemas = (d: { nodeId: z.ZodString; hue: z.ZodType<Hue> }) => {
  const tinted = z.strictObject({ text: z.string().min(1), hue: d.hue });
  const action = z.strictObject({ id: d.nodeId, label: z.string().min(1) });

  return [
    z.strictObject({
      kind: z.literal('InstallParts'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        title: z.string().min(1),
        state: tinted,
        join: tinted.optional(),
        parts: z.array(
          z.strictObject({
            id: d.nodeId,
            glyph: z.string().min(1),
            hue: d.hue,
            name: z.string().min(1),
            open: z.boolean().optional(),
          }),
        ),
        files: z
          .strictObject({ id: d.nodeId, text: z.string().min(1), open: z.boolean().optional() })
          .optional(),
        unfolded: z
          .discriminatedUnion('kind', [
            z.strictObject({
              kind: z.literal('part'),
              glyph: z.string().min(1),
              hue: d.hue,
              name: z.string().min(1),
              tag: z.string().optional(),
              line: z.string(),
              actions: z.array(action),
            }),
            z.strictObject({ kind: z.literal('files'), files: z.array(action) }),
          ])
          .optional(),
        compact: z.boolean().optional(),
      }),
    }),
  ] as const;
};

const MARKS: Readonly<Record<PartState, { glyph: string; hue: Hue }>> = {
  pass: { glyph: '✓', hue: 'good' },
  fail: { glyph: '✗', hue: 'bad' },
  todo: { glyph: '○', hue: 'dim' },
  warn: { glyph: '!', hue: 'warn' },
};

/** Each part's name, as core's part table titles it (ui takes only types from core). */
const PART_NAMES: Readonly<Record<InstallPart, string>> = {
  logins: 'Logins',
  board: 'Board',
  sources: 'Sources',
  'env-files': 'Env files',
  worktree: 'Worktree',
  checks: 'Checks',
  workflows: 'Workflows',
  skills: 'Skills',
  verify: 'Verify',
  prototype: 'Prototype',
  done: 'Done',
};

const isPart = (id: string): id is InstallPart => Object.hasOwn(PART_NAMES, id);

const RECHECK = 'install:recheck:';
const AGAIN = 'install:again:';
const PART = 'install:part:';
const FILES = 'install:files';
const FILE = 'install:file:';

/** The part a click names after `prefix`; undefined: none. */
const partAfter = (id: string, prefix: string): InstallPart | undefined => {
  const part = id.slice(prefix.length);

  return id.startsWith(prefix) && isPart(part) ? part : undefined;
};

/** What a part's button says to the install's chat; undefined: not one of the strip's. */
export const partMessage = (id: string): string | undefined => {
  const recheck = partAfter(id, RECHECK);
  const again = partAfter(id, AGAIN);

  if (recheck !== undefined) return `Re-check ${PART_NAMES[recheck]}`;

  return again === undefined ? undefined : `Do ${PART_NAMES[again]} again`;
};

/** What unfolds under the strip: a part's last check, or the files. */
export type InstallOpen = InstallPart | 'files';

/**
 * What a click on the strip asks besides its buttons: what to unfold (folded when it is), or
 * which file to open; undefined: not one of the strip's.
 */
export const stripClick = (id: string): { unfold: InstallOpen } | { file: number } | undefined => {
  const part = partAfter(id, PART);

  if (part !== undefined) return { unfold: part };
  if (id === FILES) return { unfold: 'files' };
  const n = id.startsWith(FILE) ? Number(id.slice(FILE.length)) : NaN;

  return Number.isInteger(n) && n >= 0 ? { file: n } : undefined;
};

/** What unfolds for `open`, from the status; undefined: nothing, or a part it lacks. */
const unfoldedOf = (v: InstallView, open: InstallOpen | undefined): InstallUnfold | undefined => {
  if (open === 'files')
    return { kind: 'files', files: v.files.map((path, n) => ({ id: `${FILE}${n}`, label: path })) };
  const p = v.parts.find((x) => x.id === open);

  if (p === undefined) return undefined;

  return {
    kind: 'part',
    ...MARKS[p.state],
    name: PART_NAMES[p.id],
    ...(p.required ? {} : { tag: 'optional' }),
    line: p.line ?? 'Not checked yet',
    actions: [
      { id: `${RECHECK}${p.id}`, label: 'Re-check' },
      { id: `${AGAIN}${p.id}`, label: 'Do again' },
    ],
  };
};

/**
 * The strip for the status (none read yet: `Reading`, its parts come once serve answers); `open`
 * what is unfolded under it. Done: `✓ Done` and the files, no part.
 */
export const installParts = (
  v: InstallView | undefined,
  o: { open?: InstallOpen | undefined; compact: boolean },
): InstallParts => {
  // over every part the strip draws a dot for, so `3 of 10` counts its dots
  const shown = v?.parts ?? [];
  const passing = shown.filter((p) => p.state === 'pass' || p.state === 'warn').length;
  const state = (() => {
    if (v === undefined) return { text: 'Reading', hue: 'dim' as const };
    if (v.done) return { text: '✓ Done', hue: 'good' as const };

    return { text: `${passing} of ${shown.length}`, hue: 'warn' as const };
  })();
  // Done shows no part to unfold
  const open = v?.done === true && o.open !== 'files' ? undefined : o.open;
  const unfolded = v === undefined ? undefined : unfoldedOf(v, open);
  const files = v?.files.length ?? 0;

  return {
    kind: 'InstallParts',
    id: 'install-parts',
    props: {
      title: 'Install',
      state,
      ...(v?.join === true ? { join: { text: 'Join', hue: 'accent' } } : {}),
      parts:
        v === undefined || v.done
          ? []
          : v.parts.map((p) => ({
              id: `${PART}${p.id}`,
              ...MARKS[p.state],
              name: PART_NAMES[p.id],
              ...(open === p.id ? { open: true } : {}),
            })),
      ...(files === 0
        ? {}
        : {
            files: {
              id: FILES,
              text: `Files ${files}`,
              ...(open === 'files' ? { open: true } : {}),
            },
          }),
      ...(unfolded === undefined ? {} : { unfolded }),
      ...(o.compact ? { compact: true } : {}),
    },
  };
};
