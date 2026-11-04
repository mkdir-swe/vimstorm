/** What a command answers: its exit code, its refusal's body, a handler's outcome. */
import { z } from 'zod';

/** 0 ok, 1 refused or failed, 2 usage, 3 `serve` unreachable. */
export const EXIT = { ok: 0, failed: 1, usage: 2, unreachable: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const exitCode = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

/** How a launch onto a short box goes on (`--short`): resized first, or launched as it is. */
export const SHORT_ANSWERS = ['resize', 'anyway'] as const;
export type ShortAnswer = (typeof SHORT_ANSWERS)[number];

/** One answer of the ask: its `--short` (`cancel`: none, the launch is left), words, why. */
export const BoxShortChoice = z.object({
  answer: z.enum([...SHORT_ANSWERS, 'cancel']),
  label: z.string(),
  note: z.string().optional(),
  recommended: z.boolean().optional(),
});
export type BoxShortChoice = z.infer<typeof BoxShortChoice>;

/** A launch's `box-short` refusal (ADR 0022): what its question shows, the choices in order. */
export const BoxShortAsk = z.object({
  box: z.string(),
  short: z.enum(['memory', 'disk']),
  line: z.string(),
  /** The size Resize goes to; null: no Resize (none within `limits.maxBoxSize`, or disk short). */
  resize: z.string().nullable(),
  choices: z.array(BoxShortChoice),
});
export type BoxShortAsk = z.infer<typeof BoxShortAsk>;

/** A failure's code is kebab-case (`unknown-command`, `serve-unreachable`). */
export const ErrorBody = z.object({
  code: z.string().regex(/^[a-z]+(-[a-z]+)*$/),
  message: z.string(),
  /** `aws-auth`: the profile to log in again with (`aws sso login --profile <it>`), if not the default. */
  profile: z.string().min(1).optional(),
  /** `aws-auth`: the profile signs in with an IAM user's keys (`aws configure --profile <it>`). */
  keys: z.boolean().optional(),
  /** `box-short`: the launch's question, its choices in order (ADR 0022). */
  boxShort: BoxShortAsk.optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** What a handler answers: its data, or a refusal with its code (exit 1 unless it says 2 or 3). */
export type Outcome<T> =
  { ok: true; data: T } | { ok: false; error: ErrorBody; exit?: Exclude<ExitCode, 0> };

/** What the CLI prints and exits with: the socket's reply carries exactly this. */
export type Printed = { exit: ExitCode; stdout: string; stderr: string };

export const refused = (code: string, message: string, exit?: 1 | 2 | 3): Outcome<never> =>
  exit === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message }, exit };
