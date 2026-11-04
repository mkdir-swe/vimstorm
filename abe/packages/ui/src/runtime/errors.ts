/**
 * How an error goes away (#348), the one rule for every balloon and status line a screen says,
 * applied by the bridge (`serve/src/process/bridge.ts`) as they go to the shell:
 *
 * - **Its cause gone, it goes at once.** An error said on a run's answer is that run's (its `key`:
 *   the argv); the same run answered ok later (a retry, a read again) drops it: `drop-balloon`,
 *   and the status line saying it clears.
 * - **Otherwise it fades**: after `errorFadeMs` (8 s, longer for longer text), or at the next key
 *   or click once it has been up `INPUT_GRACE_MS`. The shell's balloon host keeps a hovered one
 *   and counts the same time (`app/src/popups/balloon.rs`, `reading_time`).
 * - **Only what needs you stays**: a refusal whose code is in `NEEDS_YOU` (a login, a policy, a box
 *   that cannot start) stays, with its action, until it is closed or its cause is gone: `Retry`
 *   runs it again, and after `Log in…` the bridge runs it again once a terminal ends (Settings' fix
 *   strip logging in); answered ok, it goes.
 * - **Nothing is lost**: the shell keeps every error balloon in its history (the status bar's
 *   `⚠ N`), with when and where (`where`, the screen that said it).
 */
import type { ShellEffect } from './protocol';

/** An error's least time on screen. */
export const ERROR_FADE_MS = 8_000;
/** Reading time per word on top (~240 words a minute). */
export const PER_WORD_MS = 250;
/** The longest an error that fades stays. */
export const MAX_FADE_MS = 30_000;
/** A key or a click this soon after an error came takes nothing away (it may be the one before). */
export const INPUT_GRACE_MS = 1_000;

/** How long an error that fades stays: 8 s and the time to read it, 30 s at most. */
export const errorFadeMs = (text: string): number =>
  Math.min(
    ERROR_FADE_MS + PER_WORD_MS * text.split(/\s+/).filter((w) => w !== '').length,
    MAX_FADE_MS,
  );

/** What a balloon that needs you offers: Settings' Logins, the run again, the Boxes tab. */
export const NEEDS_YOU_ACTIONS = ['login', 'retry', 'boxes'] as const;
export type NeedsYouAction = (typeof NEEDS_YOU_ACTIONS)[number];

/** The action's link in the balloon. */
export const ACTION_LABEL: Readonly<Record<NeedsYouAction, string>> = {
  login: 'Log in…',
  retry: 'Retry',
  boxes: 'Boxes…',
};

/**
 * The refusals that need you (by code), each with its action, null for none (it stays until
 * closed): an expired or missing login, a policy that refused, a box that cannot start or be
 * reached. Every other error fades.
 */
export const NEEDS_YOU: ReadonlyMap<string, NeedsYouAction | null> = new Map<
  string,
  NeedsYouAction | null
>([
  ['no-login', 'login'],
  ['auth', 'login'],
  ['aws-auth', 'login'],
  ['aws-refused', null],
  ['model-not-allowed', null],
  ['product-owner-never-launches', null],
  ['box-limit', 'boxes'],
  ['box-unreachable', 'retry'],
]);

/** A refusal's code as its balloon ends with it: `… (login-expired)`. */
export const codeOf = (text: string): string | undefined =>
  /\(([a-z][a-z0-9-]*)\)\s*$/.exec(text)?.[1];

/**
 * Whether an error needs you, and its action (null: none): by the refused run's code, else by the
 * code its words end with.
 */
export const needsYou = (
  text: string,
  code?: string,
): { action: NeedsYouAction | null } | undefined => {
  const named = code ?? codeOf(text);
  const action = named === undefined ? undefined : NEEDS_YOU.get(named);

  return action === undefined ? undefined : { action };
};

/** A run's key: what the same run again names. */
export const runKey = (argv: readonly string[]): string => `run:${argv.join('\u0000')}`;

/** The click on a balloon's action: `balloon:<key>`. */
export const BALLOON_CLICK = 'balloon:';

/** The status line, as the bridge holds it: an error's carries its key and its fade. */
export type SaidLine = {
  text: string;
  at: string;
  error?: { key: string; fadeMs: number } | undefined;
};

/** An error balloon a screen said, in the rule's terms. */
export type ErrorSaid = {
  /** What it is about: the run's key, else its words'. */
  key: string;
  /** The effect to send: its key, whether it stays, its action's label, where it was said. */
  balloon: Extract<ShellEffect, { kind: 'balloon' }>;
  /** Its action when it needs you (null: it stays with none), undefined when it fades. */
  action: NeedsYouAction | null | undefined;
  /** The status line saying it too (#280): there once its balloon is closed, fading as it does. */
  line: SaidLine;
};

/**
 * An error balloon a screen said, keyed by the run whose answer said it (else by its words: the
 * same words again replace it), where = the screen.
 */
export const errorSaid = (
  text: string,
  cause: { key?: string | undefined; where?: string | undefined; code?: string | undefined },
  at: string,
): ErrorSaid => {
  const key = cause.key ?? `said:${text}`;
  const needs = needsYou(text, cause.code);
  const action = needs?.action;
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' · ');

  return {
    key,
    balloon: {
      kind: 'balloon',
      tone: 'error',
      text,
      key,
      ...(needs === undefined ? {} : { stays: true }),
      ...(action === undefined || action === null ? {} : { action: ACTION_LABEL[action] }),
      ...(cause.where === undefined ? {} : { where: cause.where }),
    },
    action,
    line: { text: line, at, error: { key, fadeMs: errorFadeMs(line) } },
  };
};

/** How long a status line that is no error stays (#204): then it fades, as WebStorm's do. */
export const STATUS_FADE_MS = 30_000;

/**
 * Whether the status line has faded by `now`: an error's after its fade, any other after
 * `STATUS_FADE_MS`; one still under way (`Make card: writing…`, ending in `…`) stays until it is
 * replaced.
 */
export const lineFaded = (line: SaidLine, now: string): boolean =>
  line.text !== '' &&
  !line.text.endsWith('…') &&
  Date.parse(now) - Date.parse(line.at) >= (line.error?.fadeMs ?? STATUS_FADE_MS);

/** Whether a key or a click at `now` takes the status line away: an error's, once up a second. */
export const lineGoesOnInput = (line: SaidLine, now: string): boolean =>
  line.error !== undefined && Date.parse(now) - Date.parse(line.at) >= INPUT_GRACE_MS;
