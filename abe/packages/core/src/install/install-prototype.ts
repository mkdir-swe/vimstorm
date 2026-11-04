/**
 * The install's Prototype part (optional): the repo's prototype-start script (`hooks`) starts its app
 * for a prototype, and serve's check proves it step by step (`abe install check prototype`): the
 * script found, started in a throwaway worktree on its port base, ready on that port, its page
 * loaded, signed in when it says it signs in, a screenshot kept; then stopped again. A failure
 * names its step and its code. Pure: the record and its words; serve runs the steps. Its verdicts
 * are built here, not by `install.ts`'s helpers: that file reads `PrototypeTry` for its record.
 */
import { z } from 'zod';
import { type PartVerdict } from './install';

/** The check's steps, in order: each runs only once the one before passed. */
export const PROTOTYPE_TRY_STEPS = [
  'script',
  'start',
  'ready',
  'page',
  'login',
  'screenshot',
] as const;
export type PrototypeTryStepName = (typeof PROTOTYPE_TRY_STEPS)[number];

/**
 * Each step's refusal codes: `no-start-script`, `start-script-not-executable`,
 * `login-key-missing` (script); `env-not-ready`, `start-failed`, `start-timeout`, `no-url`
 * (start); `port-not-base`, `not-ready` (ready); `no-page` (page); `login-failed` (login);
 * `no-screenshot` (screenshot, a warning: the app runs).
 */
export const PROTOTYPE_TRY_REFUSALS = [
  'no-start-script',
  'start-script-not-executable',
  'login-key-missing',
  'env-not-ready',
  'start-failed',
  'start-timeout',
  'no-url',
  'port-not-base',
  'not-ready',
  'no-page',
  'login-failed',
  'no-screenshot',
] as const;
export const PrototypeTryRefusal = z.enum(PROTOTYPE_TRY_REFUSALS);
export type PrototypeTryRefusal = z.infer<typeof PrototypeTryRefusal>;

/** One step as it ran: passed with what it found, or refused with its code and why. */
export const PrototypeTryStep = z.object({
  step: z.enum(PROTOTYPE_TRY_STEPS),
  ok: z.boolean(),
  why: PrototypeTryRefusal.optional(),
  /** One line, key names only, never a value. */
  line: z.string(),
});
export type PrototypeTryStep = z.infer<typeof PrototypeTryStep>;

/**
 * The last `abe install check prototype`: its steps, the env it ran with, its port base, the URL
 * the script printed, the start's log (stdout; stderr beside it as `.err`) and the screenshot kept,
 * both files in serve's state; null where the check did not get that far.
 */
export const PrototypeTry = z.object({
  at: z.string(),
  steps: z.array(PrototypeTryStep),
  env: z.enum(['dev', 'test']).nullable(),
  portBase: z.number().int().positive().nullable(),
  url: z.string().nullable(),
  log: z.string().nullable(),
  screenshot: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
});
export type PrototypeTry = z.infer<typeof PrototypeTry>;

/** The fix said after each refusal. */
const FIX: Readonly<Record<PrototypeTryRefusal, string>> = {
  'no-start-script':
    "write the repo's prototype-start script (references/prototype.md), or leave the part: it is optional",
  'start-script-not-executable': 'chmod +x the script',
  'login-key-missing':
    'add the key to the Abe env file its # abe-env: line names, or change # abe-login:',
  'env-not-ready': 'fix the Abe env file or its aws login (abe install check env-files)',
  'start-failed': 'fix the script or the app (its log has the rest)',
  'start-timeout': 'the script must start the app in the background and end once it answers',
  'no-url': 'its last line must be the URL to open (http://127.0.0.1:$ABE_PORT_BASE/…)',
  'port-not-base':
    'the app must listen on $ABE_PORT_BASE (or the 10 ports from it): two prototypes never share a port',
  'not-ready': 'wait in the script until the app answers before printing its URL',
  'no-page': 'print the URL of a page that answers 2xx',
  'login-failed':
    "sign the account in from the script (seed it, the app's dev sign-in), or ask the person which account",
  'no-screenshot': 'Chrome or Chromium on this Mac takes it; the app itself ran',
};

const passed = (line: string): PartVerdict => ({ state: 'pass', line });
const failed = (why: string, line: string): PartVerdict => ({ state: 'fail', line, why });

/** The step lines in words, each with its mark: what `abe install check prototype` shows. */
export const prototypeTrySteps = (t: PrototypeTry): string[] =>
  t.steps.map((s) => {
    const mark = s.step === 'screenshot' ? '!' : '✗';

    return `${s.ok ? '✓' : mark} ${s.step} · ${s.line}`;
  });

/**
 * Prototype: nothing runs here passes (no app to prototype); else the last try's first refused
 * step fails it with its code (a screenshot not taken warns), every step passed passes it.
 */
export const prototypePart = (t: PrototypeTry | null, nothing: string | null): PartVerdict => {
  if (nothing !== null)
    return passed(`${nothing.charAt(0).toUpperCase()}${nothing.slice(1)}: no prototype app`);
  if (t === null)
    return failed('not-tried', 'Not tried yet: abe install check prototype starts it');
  const refused = t.steps.find((s) => !s.ok);

  if (refused === undefined) return passed(t.steps.map((s) => s.line).join('; '));
  const why = refused.why ?? 'start-failed';
  const line = `${refused.step}: ${refused.line} (${FIX[why]})`;

  return refused.step === 'screenshot' ? { state: 'warn', line, why } : failed(why, line);
};
