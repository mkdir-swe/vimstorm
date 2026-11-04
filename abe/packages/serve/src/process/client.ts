/**
 * The `abe` command as a client: check argv by the table, answer `help` here, run `serve` in the
 * foreground, and send everything else to the `serve` on the socket, starting one when none
 * answers.
 */
import { join } from 'node:path';
import { type z } from 'zod';
import {
  argsSchema,
  COMMANDS,
  commandNouns,
  COMMANDS_FILE,
  dispatch,
  EXIT,
  expandPersonal,
  help,
  type PersonalCommand,
  personalCommandProblem,
  personalCommandsOf,
  isSessionSocket,
  parse,
  PROTOCOL,
  type Printed,
  parseCard,
  printFailure,
  readEnvelope,
  Reply,
  splitOn,
  SessionAttachData,
  StatusData,
  BoxData,
  type BoxAws,
  type Answered,
  LOGIN_TOOLS,
  type LoginData,
  LoginStatusData,
  type LoginTool,
  usageText,
  Event,
  progressLine,
  progressNarrowed,
  progressOf,
  progressStep,
  type ProgressSubject,
  WatchFrame,
} from '@abe/core';
import {
  ask,
  type AttachWhat,
  follow,
  type Following,
  type Locations,
  readYamlFile,
} from '@abe/ports';
import { checkFilesHandlers } from '../install';
import { VERSION } from './version';

export type ClientOptions = {
  cwd: string;
  where: Locations;
  /**
   * Starts a detached `abe serve` with this environment. Absent inside a workspace: its `serve`
   * is the box's, reached through the mounted socket, and never started from in there.
   */
  startServe?: () => void;
  /** How long a started `serve` gets to answer. */
  startTimeoutMs?: number;
  /**
   * Whether a live serve holds the lock while nothing answers: starting, binding its socket again
   * or about to be ended by the one started now. The start then gets `HELD_START_TIMEOUT_MS`.
   */
  serveHeld?: () => boolean;
  /** Waits between tries while a started `serve` comes up. */
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /**
   * Your personal commands (`commands.yaml` in your Layer): `abe help` lists them, `abe <word>`
   * runs one.
   */
  personalCommands?: () => PersonalCommand[];
  /**
   * `abe login <tool>`: the tool's own device or browser login on this terminal (it writes the
   * login where the tool keeps it; `serve` then stores it). Absent inside a workspace.
   */
  login?: (tool: LoginTool, tenant?: string, profile?: string) => Promise<Answered<null>>;
  /**
   * `abe login az` on the Mac: `az`'s browser login, stored in your secret for your boxes; with
   * no boxes, kept in the az folder in force alone. Absent on a box and inside a workspace.
   */
  macLogin?: (tenant?: string) => Promise<Answered<LoginData>>;
  /**
   * `abe login aws --profile <p>` on the Mac: SSO's browser login for the profile, stored in your
   * secret for your boxes. Absent on a box and inside a workspace.
   */
  macAwsLogin?: (profile: string) => Promise<Answered<LoginData>>;
  /**
   * `abe login github|claude` on the Mac: the tool's own browser login, kept where it keeps it,
   * never stored. Absent on a box and inside a workspace.
   */
  macToolLogin?: (tool: 'github' | 'claude') => Promise<Answered<LoginData>>;
  /**
   * A terminal's stderr: told what a command waits on once `serve` takes `slowMs` (default 2 s)
   * to answer. Absent when nobody watches (not a terminal): nothing is said.
   */
  slow?: (line: string) => void;
  slowMs?: number;
  /**
   * Where a waiting command's progress line goes: stderr, redrawn in place each second on
   * a terminal, else one line per step. Absent: no line (inside a workspace, tests).
   */
  progress?: ProgressIo;
  /** This abe's build, compared with serve's (default `VERSION`). */
  version?: string;
};

export type ProgressIo = {
  write: (text: string) => void;
  tty: boolean;
  /** Runs `fn` every `ms` until stopped (default `setInterval`). */
  every?: (fn: () => void, ms: number) => () => void;
};

/** A wait longer than this says what it waits on (the UX budget). */
export const SLOW_MS = 2000;

/** Your personal commands in the Layer folder `dir`: those that read and run a command of the table. */
export const personalCommandsIn = (dir: string): PersonalCommand[] => {
  const file = readYamlFile(join(dir, COMMANDS_FILE));
  const read = personalCommandsOf('doc' in file ? file.doc : undefined);
  const nouns = commandNouns();

  return read.ok ? read.commands.filter((c) => personalCommandProblem(c, nouns) === undefined) : [];
};

const START_TIMEOUT_MS = 5000;
/** A held lock's serve rebinds within 5 s or is ended after 10 s (SIGKILL 5 s on), then one starts. */
const HELD_START_TIMEOUT_MS = 25_000;
const RETRY_MS = 25;

type Sent = { ok: true; reply: Reply } | { ok: false; unreachable: boolean; message: string };

/** One request to `serve` and its reply, or why there is none. */
export const send = async (
  argv: readonly string[],
  o: ClientOptions,
  /** Echoed on the request's `command.ran` (`Request.tag`). */
  tag?: string,
  /** No answer by then: given up, the connection closed. */
  timeoutMs?: number,
): Promise<Sent> => {
  const asked = await ask(
    o.where.socket,
    JSON.stringify({ v: PROTOCOL, argv, cwd: o.cwd, ...(tag === undefined ? {} : { tag }) }),
    timeoutMs,
  );

  if (!asked.ok) return asked;
  let doc: unknown;

  try {
    doc = JSON.parse(asked.line);
  } catch {
    return {
      ok: false,
      unreachable: false,
      message: 'abe serve answered something that is not JSON',
    };
  }
  const reply = Reply.safeParse(doc);

  return reply.success
    ? { ok: true, reply: reply.data }
    : { ok: false, unreachable: false, message: `abe serve's answer is not a v${PROTOCOL} reply` };
};

const fromReply = (reply: Reply): Printed => ({
  exit: reply.exit,
  stdout: reply.stdout,
  stderr: reply.stderr,
});

/** One try at `serve`: what it answered, or why not (`unreachable`: safe to try again). */
export type Tried<T> =
  { ok: true; value: T } | { ok: false; unreachable: boolean; message: string };

/**
 * Runs `once` against `serve`, and when nothing answers starts one (unless `start` is false) and
 * tries again until it answers or the start timeout passes. A failure comes back printed.
 */
export const withServe = async <T>(
  once: () => Promise<Tried<T>>,
  json: boolean,
  start: boolean,
  o: ClientOptions,
): Promise<{ ok: true; value: T } | { ok: false; printed: Printed }> => {
  const failed = (code: string, message: string, exit: 1 | 3) => ({
    ok: false as const,
    printed: printFailure({ code, message }, exit, json),
  });
  const first = await once();

  if (first.ok) return first;
  if (!first.unreachable) return failed('failed', first.message, EXIT.failed);
  if (!start || o.startServe === undefined)
    return failed(
      'serve-unreachable',
      `no abe serve answers on ${o.where.socket}`,
      EXIT.unreachable,
    );
  o.startServe();
  const timeoutMs =
    o.startTimeoutMs ?? (o.serveHeld?.() === true ? HELD_START_TIMEOUT_MS : START_TIMEOUT_MS);
  const deadline = o.now() + timeoutMs;

  for (;;) {
    const next = await once();

    if (next.ok) return next;
    if (!next.unreachable) return failed('failed', next.message, EXIT.failed);
    if (o.now() >= deadline) break;
    await o.sleep(RETRY_MS);
  }
  const seconds = timeoutMs / 1000;
  const why = `abe serve did not answer on ${o.where.socket} within ${seconds} s; its log is ${o.where.log}`;

  return failed('serve-unreachable', why, EXIT.unreachable);
};

const PROGRESS_FIRST_MS = 1000;

const everyMs = (fn: () => void, ms: number) => {
  const timer = setInterval(fn, ms);

  return () => {
    clearInterval(timer);
  };
};

/**
 * Sends argv asking for progress: the line comes a second after asking, says what it waits
 * for and how long, and moves on as `serve` streams the box's and session's events; the reply
 * then prints as any. A `serve` from before answers with the reply alone.
 */
const waited = async (
  argv: readonly string[],
  subject: ProgressSubject,
  start: boolean,
  o: ClientOptions,
  io: ProgressIo,
): Promise<Printed> => {
  const began = o.now();
  const got: {
    subject: ProgressSubject;
    words: string;
    shown: boolean;
    reply?: Reply;
    broken?: string;
    following?: Following;
  } = { subject, words: subject.words, shown: false };
  const draw = () => {
    const line = progressLine(subject, got.words, o.now() - began);

    io.write(io.tty ? `\r\x1b[K${line}` : `${line}\n`);
    got.shown = true;
  };
  const stop = (io.every ?? everyMs)(() => {
    if (got.reply === undefined && (io.tty || !got.shown)) draw();
  }, PROGRESS_FIRST_MS);
  const see = (text: string) => {
    if (got.reply !== undefined || got.broken !== undefined) return;
    let doc: unknown;

    try {
      doc = JSON.parse(text);
    } catch {
      got.broken = 'abe serve sent something that is not JSON';
      got.following?.close();

      return;
    }
    const frame = WatchFrame.safeParse(doc);

    if (frame.success) {
      const event = Event.safeParse(frame.data.event);
      const words = event.success ? progressStep(got.subject, event.data) : undefined;

      if (event.success) got.subject = progressNarrowed(got.subject, event.data);
      if (words === undefined || words === got.words) return;
      got.words = words;
      if (got.shown) draw();

      return;
    }
    const reply = Reply.safeParse(doc);

    if (reply.success) got.reply = reply.data;
    else got.broken = `abe serve's answer is not a v${PROTOCOL} reply`;
    got.following?.close();
  };
  const request = JSON.stringify({ v: PROTOCOL, argv, cwd: o.cwd, progress: true });

  try {
    const reached = await withServe(
      async (): Promise<Tried<Following>> => {
        const one = await follow(o.where.socket, request, see);

        return one.ok ? { ok: true, value: one.following } : one;
      },
      false,
      start,
      o,
    );

    if (!reached.ok) return reached.printed;
    got.following = reached.value;
    if (got.reply !== undefined || got.broken !== undefined) reached.value.close();
    const ended = await reached.value.done;

    if (got.reply !== undefined) return fromReply(got.reply);
    const why =
      got.broken ??
      (ended.by === 'error'
        ? `the answer from abe serve broke: ${ended.message}`
        : 'abe serve stopped before it answered (stopped or restarted); what was asked may still be going on: abe box list or abe session list says where it stands');

    return printFailure({ code: 'failed', message: why }, EXIT.failed, false);
  } finally {
    stop();
    if (got.shown && io.tty) io.write('\r\x1b[K');
  }
};

/**
 * Sends argv, starting `serve` first when nothing answers (unless `--no-start`); a terminal waiting
 * past `slowMs` is told on what (`waits`, else abe serve).
 */
const remote = async (
  argv: readonly string[],
  json: boolean,
  start: boolean,
  o: ClientOptions,
  waits?: string,
  /** Filled in once serve replied: `version`, its build when it sent one. */
  seen?: { replied?: boolean; version?: string },
) => {
  const subject = json || o.progress === undefined ? undefined : progressOf(argv);

  // A command that may wait on a box or a session draws its progress line instead.
  if (subject !== undefined && o.progress !== undefined)
    return waited(argv, subject, start, o, o.progress);
  const say = json ? undefined : o.slow;
  const slow =
    say === undefined
      ? undefined
      : setTimeout(() => {
          say(`abe: waiting on ${waits ?? "abe serve's answer"}…\n`);
        }, o.slowMs ?? SLOW_MS);

  try {
    const sent = await withServe(
      async (): Promise<Tried<Reply>> => {
        const one = await send(argv, o);

        if (one.ok && seen !== undefined) {
          seen.replied = true;
          if (one.reply.version !== undefined) seen.version = one.reply.version;
        }

        return one.ok ? { ok: true, value: one.reply } : one;
      },
      json,
      start,
      o,
    );

    return sent.ok ? fromReply(sent.value) : sent.printed;
  } finally {
    clearTimeout(slow);
  }
};

/** serve's build differs from this abe's: what to do, in one line; none when they match. */
export const serveVersionLine = (serve: string, mine: string): string | undefined =>
  serve === mine
    ? undefined
    : `abe serve is abe ${serve}, this abe is ${mine}: restart it once no session runs (abe serve stop; the next abe command starts it again)`;

/**
 * `printed` with the line saying serve's build is another one (`serveVersionLine`): last on
 * `abe status`, else on stderr. serve's from its reply, else (one from before) its `abe status`.
 */
const withServeVersion = async (
  id: string,
  printed: Printed,
  seen: { replied?: boolean; version?: string },
  o: ClientOptions,
): Promise<Printed> => {
  if (seen.replied !== true) return printed;
  const asked = seen.version === undefined ? await send(['status', '--json'], o) : undefined;
  let serve = seen.version;

  try {
    const status =
      asked?.ok === true ? readEnvelope(StatusData, JSON.parse(asked.reply.stdout)) : undefined;

    if (status?.ok === true) serve = status.data.version;
  } catch {
    // not a status document: nothing to compare
  }
  const line = serve === undefined ? undefined : serveVersionLine(serve, o.version ?? VERSION);

  if (line === undefined) return printed;

  return id === 'status'
    ? { ...printed, stdout: `${printed.stdout}${line}\n` }
    : { ...printed, stderr: `${printed.stderr}abe: ${line}\n` };
};

export type Client =
  | { kind: 'printed'; printed: Printed }
  /** `abe serve`: the caller runs it in the foreground. */
  | { kind: 'serve'; json: boolean }
  /** `abe watch` (and `abe fresh --follow`): the caller streams it (`runWatch`). */
  | { kind: 'watch'; json: boolean; start: boolean }
  /** `abe session attach` without `--json`: the caller runs `argv` on this terminal. */
  | { kind: 'attach'; argv: string[] }
  /**
   * `abe box attach`: the caller runs the attach loop on this terminal, on `aws` (the
   * running serve's box profile and region) when one answered, else its own environment.
   */
  | { kind: 'box-attach'; box: string; what: AttachWhat; aws?: BoxAws }
  /** `abe box forward`: the caller keeps the forward up until interrupted; `aws` as above. */
  | { kind: 'box-forward'; box: string; port: number; json: boolean; aws?: BoxAws }
  /** `abe ui render <screen>`: the caller prints the screen's tree (`runRender`). */
  | { kind: 'ui-render'; screen: string; page: string | undefined; json: boolean; start: boolean }
  /** `abe ui bridge`: the caller speaks the bridge's frames on stdio (`runBridge`). */
  | { kind: 'ui-bridge'; start: boolean };

/** A `--json` answer's envelope read with `data`, or undefined when it is none. */
const envelopeOf = <T extends z.ZodType>(data: T, stdout: string) => {
  try {
    return readEnvelope(data, JSON.parse(stdout));
  } catch {
    return undefined;
  }
};

/** `abe session attach`: `serve` names the command, this terminal runs it. */
const attachCommand = async (
  argv: readonly string[],
  start: boolean,
  o: ClientOptions,
): Promise<Client> => {
  const printed = await remote([...argv, '--json'], true, start, o);
  const doc = envelopeOf(SessionAttachData, printed.stdout);

  if (doc?.ok === true) return { kind: 'attach', argv: doc.data.argv };
  const error = doc?.ok === false ? doc.error : { code: 'failed', message: printed.stderr.trim() };

  return {
    kind: 'printed',
    printed: printFailure(error, printed.exit === 0 ? 1 : printed.exit, false),
  };
};

/** How long `abe box attach` waits on serve's box profile before it goes on its own environment. */
const BOX_AWS_WAIT_MS = 2000;
/** How long a box's own lookup may take (serve asks EC2 for it on each profile). */
const BOX_STATUS_WAIT_MS = 15_000;

/**
 * The AWS profile and region the running serve reaches your boxes on: VimStorm runs
 * `abe box attach` with its own environment, which has none when it was opened from the Dock.
 * Undefined when no serve answers in time (none is started for it) or an older one does not say.
 */
const serveBoxAws = async (o: ClientOptions, box: string): Promise<BoxAws | undefined> => {
  // the profile serve finds the box on, by name across every one your checkouts name (ADR 0025)
  const found = await send(['box', 'status', box, '--json'], o, undefined, BOX_STATUS_WAIT_MS);
  const named = found.ok ? envelopeOf(BoxData, found.reply.stdout) : undefined;

  if (named?.ok === true && named.data.aws !== undefined) return named.data.aws;
  const sent = await send(['status', '--json'], o, undefined, BOX_AWS_WAIT_MS);
  const doc = sent.ok ? envelopeOf(StatusData, sent.reply.stdout) : undefined;

  return doc?.ok === true ? doc.data.boxAws : undefined;
};

/**
 * `abe box attach <box> [--session <id>] [[--shared] -- <argv>]`: one of the three, the command
 * only after `--` (so a word of it is never read as a flag of abe's); `--shared` only with one.
 */
const boxAttach = (argv: readonly string[], args: unknown, json: boolean): Client => {
  const { box, session, card, shared, command } = argsSchema(COMMANDS['box attach'].args).parse(
    args,
  );
  const dashed = argv.includes('--');
  const usage = (message: string): Client => ({
    kind: 'printed',
    printed: printFailure({ code: 'usage', message }, EXIT.usage, json),
  });

  if (json) return usage('abe box attach takes this terminal: no --json');
  if (command.length > 0 && !dashed)
    return usage('the command goes after --: abe box attach <box> -- <argv>');
  if (session !== undefined && command.length > 0)
    return usage('abe box attach takes --session or a command, not both');
  if (dashed && command.length === 0) return usage('no command after --');
  if (shared && command.length === 0)
    return usage('--shared goes with a command: abe box attach <box> --shared -- <argv>');
  if (card !== undefined && (session !== undefined || command.length > 0))
    return usage("--card opens that card's workspace's shell: not with --session or a command");
  if (card !== undefined && parseCard(card) === undefined)
    return usage(`--card ${card} is not a card id`);
  if (session !== undefined) return { kind: 'box-attach', box, what: { session } };

  return {
    kind: 'box-attach',
    box,
    what:
      command.length === 0
        ? { shell: true, ...(card === undefined ? {} : { card }) }
        : { command, ...(shared ? { shared: true } : {}) },
  };
};

const isLoginTool = (t: unknown): t is LoginTool => LOGIN_TOOLS.some((l) => l === t);

/**
 * `abe login <tool>`: `serve` first says it keeps logins (a secret is named), then the tool's own
 * login runs on this terminal, then `serve` stores what it wrote. The value never crosses the
 * socket: `serve` reads it where the tool put it, on the same machine.
 */
const loginCommand = async (
  argv: readonly string[],
  tool: LoginTool,
  tenant: string | undefined,
  profile: string | undefined,
  json: boolean,
  start: boolean,
  o: ClientOptions,
): Promise<Client> => {
  const failure = (code: string, message: string, exit: 1 | 2 | 3 = 1): Client => ({
    kind: 'printed',
    printed: printFailure({ code, message }, exit, json),
  });
  const failedAs = (exit: number) => (exit === 2 || exit === 3 ? exit : 1);

  if (o.login === undefined)
    return failure('not-here', 'abe login runs on the box itself, not inside a workspace');
  if (tenant !== undefined && tool !== 'az')
    return {
      kind: 'printed',
      printed: printFailure(
        { code: 'usage', message: `--tenant is for az only, not abe login ${tool}` },
        EXIT.usage,
        json,
        usageText('login'),
      ),
    };
  if ((profile !== undefined) !== (tool === 'aws'))
    return {
      kind: 'printed',
      printed: printFailure(
        {
          code: 'usage',
          message:
            tool === 'aws'
              ? 'abe login aws needs --profile <the SSO profile the repo names>'
              : `--profile is for aws only, not abe login ${tool}`,
        },
        EXIT.usage,
        json,
        usageText('login'),
      ),
    };
  const status = await remote(['login', 'status', '--json'], true, start, o);
  const doc = (() => {
    try {
      return readEnvelope(LoginStatusData, JSON.parse(status.stdout));
    } catch {
      return undefined;
    }
  })();

  if (doc === undefined)
    return failure(
      'failed',
      status.stderr.trim() || 'abe serve gave no login status',
      failedAs(status.exit),
    );
  if (!doc.ok) return failure(doc.error.code, doc.error.message, failedAs(status.exit));
  // The Mac: az signs in here for your boxes, where Entra may refuse a box's device code.
  if (doc.data.secret === null && tool === 'az' && o.macLogin !== undefined) {
    const macLogin = o.macLogin;

    return {
      kind: 'printed',
      printed: await dispatch(argv, { login: () => macLogin(tenant) }, null),
    };
  }
  // The Mac: aws signs in to your own SSO profile here, and it is stored for your boxes.
  if (
    doc.data.secret === null &&
    tool === 'aws' &&
    profile !== undefined &&
    o.macAwsLogin !== undefined
  ) {
    const macAwsLogin = o.macAwsLogin;

    return {
      kind: 'printed',
      printed: await dispatch(argv, { login: () => macAwsLogin(profile) }, null),
    };
  }
  // The Mac: GitHub and Claude Code sign in with their own login, kept where they keep it.
  if (
    doc.data.secret === null &&
    (tool === 'github' || tool === 'claude') &&
    o.macToolLogin !== undefined
  ) {
    const macToolLogin = o.macToolLogin;

    return {
      kind: 'printed',
      printed: await dispatch(argv, { login: () => macToolLogin(tool) }, null),
    };
  }
  if (doc.data.secret === null)
    return failure(
      'no-logins-secret',
      "this abe serve keeps no logins: no $ABE_LOGINS_SECRET (a box's service sets it to your secret)",
    );
  const ran = await o.login(tool, tenant, profile);

  if (!ran.ok) return failure(ran.error.code, ran.error.message);

  return { kind: 'printed', printed: await remote(argv, json, start, o) };
};

/** What runs on this terminal or as this `serve` itself: never sent to a box with `--on`. */
const HERE_ONLY = new Set([
  'serve',
  'ui render',
  'ui bridge',
  'login',
  'box attach',
  'box forward',
]);

/**
 * `abe --on <box> …`: sent as typed to this Mac's `serve`, which forwards it to the box, so
 * a command only a newer box knows still goes. `watch` streams and `session attach` attaches as
 * they do here.
 */
const onBox = async (argv: readonly string[], box: string, o: ClientOptions): Promise<Client> => {
  const parsed = parse(argv);
  const { json, noStart } = parsed.global;
  const start = !noStart && !isSessionSocket(o.where.socket);

  if (parsed.ok && parsed.global.help)
    return { kind: 'printed', printed: { exit: 0, stdout: usageText(parsed.id), stderr: '' } };
  if (parsed.ok && HERE_ONLY.has(parsed.id))
    return {
      kind: 'printed',
      printed: printFailure(
        { code: 'not-on-box', message: `abe ${parsed.id} runs here, not --on ${box}` },
        EXIT.usage,
        json,
      ),
    };
  if (parsed.ok && parsed.id === 'watch') return { kind: 'watch', json, start };
  if (parsed.ok && parsed.id === 'session attach' && !json) return attachCommand(argv, start, o);

  return { kind: 'printed', printed: await remote(argv, json, start, o) };
};

export const runClient = async (argv: readonly string[], o: ClientOptions): Promise<Client> => {
  const on = splitOn(argv);

  if (on.ok && on.on !== undefined) return onBox(argv, on.on, o);
  const parsed = parse(argv);
  const personal = o.personalCommands?.() ?? [];

  if (!parsed.ok && parsed.code === 'unknown-command') {
    const expanded = expandPersonal(argv, personal, commandNouns());

    // One step only: a personal command runs a command of the table.
    if (expanded !== undefined) return runClient(expanded, { ...o, personalCommands: () => [] });
  }
  if (!parsed.ok || parsed.global.help || parsed.id === 'help') {
    const local = await dispatch(
      argv,
      {
        help: (a) =>
          Promise.resolve(help(a.command, a.command.length === 0 ? personal : undefined)),
      },
      null,
    );

    return { kind: 'printed', printed: local };
  }
  // `abe check json|yaml` (ADR 0026): a pure parse, here in the client, serve-free: a repo's
  // static checks run the same on a box, in CI and with no serve up
  if (parsed.id === 'check json' || parsed.id === 'check yaml')
    return { kind: 'printed', printed: await dispatch(argv, checkFilesHandlers(), { cwd: o.cwd }) };
  const { json, noStart } = parsed.global;
  // Inside a session nothing starts a serve: its socket is the session's, kept by the serve that launched it.
  const start = !noStart && !isSessionSocket(o.where.socket);

  if (parsed.id === 'watch') return { kind: 'watch', json, start };
  // `abe fresh --follow` streams its changes as watch frames, so it is printed as watch's
  if (parsed.id === 'fresh' && argsSchema(COMMANDS.fresh.args).parse(parsed.args).follow)
    return { kind: 'watch', json, start };
  if (parsed.id === 'ui render') {
    const { screen, page } = argsSchema(COMMANDS['ui render'].args).parse(parsed.args);

    return { kind: 'ui-render', screen, page, json, start };
  }
  if (parsed.id === 'ui bridge') return { kind: 'ui-bridge', start };
  if (parsed.id === 'box attach') {
    const client = boxAttach(argv, parsed.args, json);

    if (client.kind !== 'box-attach') return client;
    const aws = await serveBoxAws(o, client.box);

    return { ...client, ...(aws === undefined ? {} : { aws }) };
  }
  if (parsed.id === 'box forward') {
    const { box, port } = argsSchema(COMMANDS['box forward'].args).parse(parsed.args);
    const aws = await serveBoxAws(o, box);

    return { kind: 'box-forward', box, port, json, ...(aws === undefined ? {} : { aws }) };
  }
  if (parsed.id === 'session attach' && !json) return attachCommand(argv, start, o);
  if (parsed.id === 'login' && isLoginTool(parsed.args.tool)) {
    const tenant = typeof parsed.args.tenant === 'string' ? parsed.args.tenant : undefined;
    const profile = typeof parsed.args.profile === 'string' ? parsed.args.profile : undefined;

    return loginCommand(argv, parsed.args.tool, tenant, profile, json, start, o);
  }
  if (parsed.id === 'serve') {
    const running = await send(['status', '--json'], o);

    if (!running.ok) return { kind: 'serve', json };
  }
  if (parsed.id === 'serve stop') {
    const sent = await send(argv, o);

    if (sent.ok) return { kind: 'printed', printed: fromReply(sent.reply) };
    if (sent.unreachable) {
      const nothing = () =>
        Promise.resolve({ ok: true as const, data: { stopped: false, pid: null } });

      return { kind: 'printed', printed: await dispatch(argv, { 'serve stop': nothing }, null) };
    }
  }

  const seen: { replied?: boolean; version?: string } = {};
  const out = await remote(argv, json, start, o, COMMANDS[parsed.id].waits, seen);

  // --json: the document alone (`abe status --json` has serve's version in it)
  return { kind: 'printed', printed: json ? out : await withServeVersion(parsed.id, out, seen, o) };
};
