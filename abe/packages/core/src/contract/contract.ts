/**
 * The CLI contract every client sees: exit codes, the `--json` document, the socket's frames and
 * each command's result. VimStorm, agents and scripts read only these; `ui` imports only these.
 */
import { z } from 'zod';
import { PersonalCommand } from '../improve';
import { BoxIdleData, BoxLoad, WorkspaceData } from '../box';
import { ArgInfo, ErrorBody, exitCode } from '../command';

export const Failure = z.object({ ok: z.literal(false), error: ErrorBody });
export type Failure = z.infer<typeof Failure>;

/** What `--json` prints: exactly one of these documents on stdout. */
export const envelope = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data }), Failure]);

/** The protocol version this build speaks. */
export const PROTOCOL = 1;

/** One request per connection, one JSON line: the argv after `abe`, and where it was typed. */
export const Request = z.object({
  v: z.literal(PROTOCOL),
  argv: z.array(z.string()),
  cwd: z.string(),
  /** The client's own name for the request, echoed on its `command.ran` (`ui`'s run ids). */
  tag: z.string().optional(),
  /**
   * The client shows a progress line while it waits: `serve` streams the events that say
   * how a box or session comes along (`PROGRESS_EVENTS`, as `WatchFrame`s), then the reply. A
   * `serve` from before reads past it and answers with the reply alone.
   */
  progress: z.boolean().optional(),
});
export type Request = z.infer<typeof Request>;

/**
 * The answer, one JSON line: what the CLI prints and exits with. `error` is set only when the
 * request itself was refused (bad JSON, an unsupported `v`), so a client tells that apart from a
 * command that failed.
 */
export const Reply = z.object({
  v: z.literal(PROTOCOL),
  exit: exitCode,
  stdout: z.string(),
  stderr: z.string(),
  error: ErrorBody.optional(),
  /** The serve's build (`abe status`'s `version`); a serve from before sends none. */
  version: z.string().optional(),
});
export type Reply = z.infer<typeof Reply>;

/** The AWS profile and region boxes are reached on; null: aws's own. */
export const BoxAws = z.object({ profile: z.string().nullable(), region: z.string().nullable() });
export type BoxAws = z.infer<typeof BoxAws>;

/** `abe status`: what this `serve` holds. `startedAt` is RFC 3339 (UTC). */
export const StatusData = z.object({
  version: z.string(),
  /** The abe installed on this Mac now (install.sh may replace it while serve runs); absent: not known. */
  installed: z.string().optional(),
  pid: z.number().int().positive(),
  startedAt: z.iso.datetime(),
  socket: z.string(),
  sessions: z.number().int().nonnegative(),
  workspaces: z.number().int().nonnegative(),
  /** On a box: its first workspace (a 2.2 box's one), for a Mac from before ADR 0022. */
  workspace: WorkspaceData.optional(),
  /** On a box: every workspace on it, one per card (ADR 0022). */
  boxWorkspaces: z.array(WorkspaceData).optional(),
  /** On a box: what it has left (memory, CPU, disk; read at most every 10 min). */
  load: BoxLoad.optional(),
  /** On a box: when it stops itself if still idle. */
  idle: BoxIdleData.optional(),
  /**
   * The Mac's serve: the AWS profile and region it reaches your boxes on (null: aws's own).
   * `abe box attach` / `abe box forward` reach them the same way, never on the environment of
   * whoever started them (VimStorm opened from the Dock has no AWS_PROFILE).
   */
  boxAws: BoxAws.optional(),
});
export type StatusData = z.infer<typeof StatusData>;

export const CommandInfo = z.object({
  noun: z.string(),
  verb: z.string().nullable(),
  usage: z.string(),
  summary: z.string(),
  inSession: z.boolean(),
  /**
   * `session`: only from inside a session; `client`: only the `abe` client runs it; `shell`:
   * VimStorm's own (its Git Log's review), Command mode lists it not; else null.
   */
  only: z.enum(['session', 'client', 'shell']).nullable(),
  /** Command mode asks before it runs. */
  risky: z.boolean(),
  args: z.array(ArgInfo),
});
export type CommandInfo = z.infer<typeof CommandInfo>;

/**
 * `abe help`: every command (or the one asked for) and the flags every command takes; with no
 * command asked for, your personal commands too (`commands.yaml`), which Command mode lists.
 */
export const HelpData = z.object({
  commands: z.array(CommandInfo),
  globalFlags: z.array(ArgInfo),
  personal: z.array(PersonalCommand).optional(),
});
export type HelpData = z.infer<typeof HelpData>;

/** `abe serve stop`: whether a running `serve` was told to stop. */
export const StopData = z.object({ stopped: z.boolean(), pid: z.number().int().nullable() });
export type StopData = z.infer<typeof StopData>;

/** `abe serve`: printed once, when the foreground `serve` listens. */
export const ServeData = z.object({
  version: z.string(),
  pid: z.number().int().positive(),
  socket: z.string(),
});
export type ServeData = z.infer<typeof ServeData>;

export type Envelope<T> = { ok: true; data: T } | Failure;

const Succeeded = z.object({ ok: z.literal(true), data: z.unknown() });

/** A `--json` document read with its data's schema; throws a zod error when it is neither shape. */
export const readEnvelope = <T extends z.ZodType>(data: T, doc: unknown): Envelope<z.output<T>> => {
  const failed = Failure.safeParse(doc);

  if (failed.success) return failed.data;

  return { ok: true, data: data.parse(Succeeded.parse(doc).data) };
};
