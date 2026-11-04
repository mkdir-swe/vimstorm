/**
 * The install's status (#22, #71): what a client sees of a Factory install, built from its record
 * and its session's state, nothing else. `abe install status` and the install's verbs answer it,
 * and serve sends it as the `install.changed` event on every change: Chat's install strip draws
 * from this type only. Each part as its last check said it, the files it wrote; no env value is
 * ever in it.
 */
import { z } from 'zod';
import {
  type Install,
  INSTALL_PART_TABLE,
  installDone,
  InstallPart,
  partsOf,
  PartState,
} from './install';
import { SESSION_STATES, type SessionState } from '../session/session';
import { ReadFindings } from './install-read';
import { GateResult } from './install-gate';
import { PrototypeTry, prototypeTrySteps } from './install-prototype';

/** The running abe serve's version and the installed abe's (null: serve can't tell). */
export const InstallVersions = z.object({ serve: z.string(), installed: z.string().nullable() });
export type InstallVersions = z.infer<typeof InstallVersions>;

/** A version's numbers (`3.0.5-1a2b3c4d` → 3, 0, 5), for which of two is older. */
const versionNumbers = (v: string): number[] =>
  (/^\d+(?:\.\d+)*/.exec(v)?.[0] ?? '').split('.').map(Number);

/**
 * What to do when the abe serve answering is not the installed abe (install.sh replaced it while
 * a session ran): stop it once no session is live, the next abe command starts the installed
 * one. Null: the same, or the installed one not known.
 */
export const serveVersionNote = (v: InstallVersions): string | null => {
  if (v.installed === null || v.installed === v.serve) return null;
  const [a, b] = [versionNumbers(v.serve), versionNumbers(v.installed)];
  const n = Math.max(a.length, b.length);
  const at = Array.from({ length: n }, (_, k) => k).find((k) => (a[k] ?? 0) !== (b[k] ?? 0));
  const older = at === undefined || (a[at] ?? 0) < (b[at] ?? 0);

  return `serve is ${older ? 'older than' : 'not'} abe: \`abe serve stop\` once no session is live`;
};

/** One part as the status says it: its last check, and whether Done waits on it. */
export const InstallPartView = z.object({
  id: InstallPart,
  required: z.boolean(),
  state: PartState,
  /** One sentence: what passed, or what is missing and the fix; null: never checked. */
  line: z.string().nullable(),
  checkedAt: z.string().nullable(),
});
export type InstallPartView = z.infer<typeof InstallPartView>;

export const InstallView = z.object({
  repo: z.string(),
  /** The repo had an abe.yaml when the install began (a teammate's): the person's own parts alone. */
  join: z.boolean(),
  /** The install's session (its Chat) and its state; null: none launched. */
  session: z.object({ id: z.string(), state: z.enum(SESSION_STATES) }).nullable(),
  parts: z.array(InstallPartView),
  /** Every required part passes (or warns). */
  done: z.boolean(),
  /** The files the install wrote, from the top (Chat's install strip opens each): paths alone. */
  files: z.array(z.string()),
  /** What Read found (names, paths and keys, never a value); null: not read yet. */
  read: ReadFindings.nullable().optional(),
  /**
   * The last Prototype check (`abe install check prototype`), step by step: its URL, the start's
   * log and the screenshot kept (paths in serve's state); null: never tried.
   */
  prototype: PrototypeTry.nullable().optional(),
});
export type InstallView = z.infer<typeof InstallView>;

/** The install's status, as every client draws it; `session` its session's state now. */
export const installView = (i: Install, session: SessionState | null = null): InstallView => ({
  repo: i.repo,
  join: i.join,
  session: i.session === null ? null : { id: i.session, state: session ?? 'ended' },
  parts: partsOf(i).map((p) => ({
    id: p.id,
    required: INSTALL_PART_TABLE[p.id].required,
    state: p.state,
    line: p.line,
    checkedAt: p.checkedAt,
  })),
  done: installDone(i),
  files: i.files,
  read: i.read,
  prototype: i.prototypeTry,
});

const MARK: Readonly<Record<PartState, string>> = { pass: '✓', fail: '✗', todo: '○', warn: '!' };

/** One part in words: its mark, its title and its line. */
const partLine = (p: InstallPartView): string =>
  `  ${MARK[p.state]} ${INSTALL_PART_TABLE[p.id].title}${p.required ? '' : ' (optional)'}${p.line === null ? '' : `: ${p.line}`}`;

/** The status in words: the repo (a join said), its session, then each part. */
export const installViewText = (v: InstallView): string => {
  const required = v.parts.filter((p) => p.required);
  const passing = required.filter((p) => p.state === 'pass' || p.state === 'warn').length;

  return `${[
    `install ${v.repo}${v.join ? ' (join)' : ''}: ${v.done ? 'done' : `${passing} of ${required.length} required parts pass`}`,
    ...(v.session === null ? [] : [`session ${v.session.id} (${v.session.state})`]),
    ...v.parts.map(partLine),
  ].join('\n')}\n`;
};

/** `abe install gate`'s answer: its own result first (null: `--cannot-run`), then the status. */
export const InstallGateData = InstallView.extend({ gate: GateResult.nullable() });
export type InstallGateData = z.infer<typeof InstallGateData>;

/** The gate's result in words: passed or why not, the ways on and the warnings, then the status. */
export const installGateText = (d: InstallGateData): string => {
  const g = d.gate;
  const head =
    g === null
      ? []
      : [
          `gate ${g.passed ? 'passed' : 'not passed'}${g.url === '' ? ' (before the run)' : `: ${g.url}`}`,
          ...g.reasons.map((r) => `  ✗ ${r}`),
          ...g.warnings.map((w) => `  ! ${w}`),
          ...(g.options.length === 0 ? [] : ['ways on:', ...g.options.map((o) => `  - ${o}`)]),
          '',
        ];

  return `${head.join('\n')}${head.length === 0 ? '' : '\n'}${installViewText(d)}`;
};

/** `abe install check`'s answer: the status, and which parts it checked now. */
export const InstallCheckedData = InstallView.extend({ checked: z.array(InstallPart) });
export type InstallCheckedData = z.infer<typeof InstallCheckedData>;

/** Whether a part it checked now failed (a warning goes on): `abe install check` exits 1. */
export const installCheckFailed = (d: InstallCheckedData): boolean =>
  d.parts.some((p) => d.checked.includes(p.id) && p.state === 'fail');

/** The parts it checked, each in words; Prototype's steps under it, when it was checked alone. */
export const installCheckedText = (d: InstallCheckedData): string =>
  `${d.parts
    .filter((p) => d.checked.includes(p.id))
    .flatMap((p) => [
      partLine(p).trimStart(),
      ...(p.id === 'prototype' &&
      d.checked.length === 1 &&
      d.prototype !== undefined &&
      d.prototype !== null
        ? [
            ...prototypeTrySteps(d.prototype).map((l) => `  ${l}`),
            ...(d.prototype.log === null ? [] : [`  log ${d.prototype.log}`]),
            ...(d.prototype.screenshot === null ? [] : [`  screenshot ${d.prototype.screenshot}`]),
          ]
        : []),
    ])
    .join('\n')}\n`;
