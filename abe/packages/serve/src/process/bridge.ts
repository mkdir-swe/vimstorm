/**
 * `abe ui render` and `abe ui bridge`: `ui`'s pure screens run against `serve` as any other client
 * would. A screen's `run` commands go to `serve` as `abe <argv> --json` (starting one when none
 * answers), their answers come back to the screen typed by the command table, and `abe watch`'s
 * events reach it as `event` inputs. `render` prints the tree once the screen asks for nothing
 * more; `bridge` keeps going on stdio (the frames in `ui/src/runtime/protocol.ts`), sending a tree only
 * when it changed.
 */
import { basename } from 'node:path';
import {
  argsSchema,
  type CommandId,
  COMMANDS,
  textOf,
  EXIT,
  type ExitCode,
  type Envelope,
  Event,
  Failure,
  help,
  type LookStage,
  openPage,
  type Outcome,
  PAGES,
  parse,
  type Printed,
  PROTOCOL,
  printFailure,
  readEnvelope,
  refused,
  Reply,
  type RepoMoved,
  repoMovedText,
  settingsDialogRules,
  type UiRenderData,
  uiRenderText,
  WatchFrame,
} from '@abe/core';
import { ask, follow, type Following, parseYaml } from '@abe/ports';
import {
  type Answer,
  type AppFrame,
  type Refused,
  type BridgeFrame,
  type Caret,
  type Command,
  commandMode,
  editorHere,
  type EditorHere,
  type Input,
  jumpCommands,
  type LiveInput,
  answerQuery,
  askQuery,
  forgetQueries,
  noQueries,
  queryKey,
  type QueryKey,
  mountLive,
  type Mounted,
  mountLayer,
  type Node,
  opensCommandMode,
  opensKeyHelp,
  patchOf,
  readAppLine,
  SCREENS,
  screenOf,
  SETTINGS_SCREEN,
  SETTINGS_WORD,
  settingsLayer,
  type Slot,
  type StripeGo,
  SLOTS,
  BALLOON_CLICK,
  errorSaid,
  lineFaded,
  lineGoesOnInput,
  type NeedsYouAction,
  runKey,
  type SaidLine,
  storyOfJump,
  SECOND_TICK_MS,
  TICK_MS,
  UI_CONTRACT,
  type UserInput,
  type ViewSize,
  WORDS,
  type WorkspaceLook,
  workspaceStory,
} from '@abe/ui';
import { type ClientOptions, send, withServe } from './client';
import { checkoutAt, realPathAt } from '../contract';

/** A screen's `run` command. */
type RunCommand = Extract<Command, { kind: 'run' }>;

/** How long the first stream's replay may last before it is taken as live all the same. */
const REPLAY_MS = 5_000;

/** Error balloons the bridge keeps a key of at most: the oldest go first. */
const ERRORS_KEPT = 64;

/** The screens kept for a reopen (`Mounted.reopen`), the oldest let go past it. */
const KEPT_SCREENS = 24;

/** What `abe ui render` lays a screen out for: it has no window. */
const RENDER_SIZE: ViewSize = { width: 1200, height: 800 };

/** A screen asking for more than this many reads while settling is looping. */
const SETTLE_LIMIT = 64;

/**
 * The app's shown folder as serve names its sessions' and runs': its symlinks followed once
 * as it comes in, so Chat's and the Board's matches and the `--repo` it sends need no resolving.
 */
export const withRealRoot = (frame: AppFrame): AppFrame =>
  (frame.type === 'hello' || frame.type === 'project') && frame.root !== undefined
    ? { ...frame, root: realPathAt(frame.root) }
    : frame;

const lastLine = (text: string) => text.trimEnd().split('\n').at(-1) ?? '';

const failed = (code: string, message: string): Failure => ({
  ok: false,
  error: { code, message },
});

/** A success's human text, as the command table words it (what `abe` prints without `--json`). */
const replyText = (
  command: CommandId,
  reply: Envelope<unknown>,
  now: number,
): string | undefined => {
  if (!reply.ok) return undefined;

  try {
    // readEnvelope read reply.data with the row's result schema, the data its text takes
    return textOf(COMMANDS[command], reply.data, { now });
  } catch {
    return undefined;
  }
};

/**
 * A screen's `run`, answered: its `--json` document read with the command's own result schema,
 * so the screen gets data the contract promises. `help` is the client's, as on a terminal: it
 * lists your personal commands too.
 */
export const answer = async (
  run: { id: string; argv: readonly string[] },
  start: boolean,
  o: ClientOptions,
): Promise<Answer | Refused> => {
  const parsed = parse(run.argv);

  // As on a terminal: a usage failure is the run's answer (Command mode shows it in a balloon).
  if (!parsed.ok)
    return {
      kind: 'result',
      id: run.id,
      command: null,
      reply: failed(parsed.code, `abe ${run.argv.join(' ')}: ${parsed.message}`),
    };
  const command: CommandId = parsed.id;

  if (parsed.id === 'help') {
    const asked = argsSchema(COMMANDS.help.args).parse(parsed.args).command;
    const listed = help(asked, asked.length === 0 ? (o.personalCommands?.() ?? []) : undefined);

    return {
      kind: 'result',
      id: run.id,
      command: 'help',
      reply: listed.ok ? listed : { ok: false, error: listed.error },
    };
  }
  const sent = await withServe(
    async () => {
      // Tagged with the run's id: its `command.ran` names it, so a screen knows its own.
      const one = await send([...run.argv, '--json'], o, run.id);

      return one.ok ? { ok: true as const, value: one.reply } : one;
    },
    true,
    start,
    o,
  );
  let reply: Envelope<unknown>;

  try {
    const doc: unknown = JSON.parse(lastLine(sent.ok ? sent.value.stdout : sent.printed.stdout));

    reply = sent.ok ? readEnvelope(COMMANDS[command].result, doc) : Failure.parse(doc);
  } catch (err) {
    reply = failed(
      'bad-answer',
      `abe ${run.argv.join(' ')} answered no --json document: ${String(err)}`,
    );
  }

  const text = replyText(command, reply, o.now());

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- readEnvelope checked reply against COMMANDS[command].result, so the pair is one of Answer's; the compiler cannot see that through the generic id
  return { kind: 'result', id: run.id, command, reply, text } as Answer;
};

/** Runs a screen's commands until it asks for nothing more; shell effects are left out. */
const settle = async (
  mounted: Pick<Mounted, 'name' | 'send'>,
  first: Command[],
  start: boolean,
  o: ClientOptions,
): Promise<void> => {
  const queue = [...first];

  for (let n = 0; queue.length > 0;) {
    const next = queue.shift();

    if (next?.kind !== 'run') continue;
    n += 1;
    if (n > SETTLE_LIMIT) throw new Error(`the ${mounted.name} screen keeps asking for reads`);
    queue.push(...mounted.send(await answer(next, start, o)));
  }
};

const unknownScreen = (name: string) =>
  `no screen ${JSON.stringify(name)}; the screens: ${[...Object.keys(SCREENS), SETTINGS_SCREEN].join(', ')}`;

/** The Settings dialog as the bridge mounts it, with core's rules. */
const mountSettings = () => mountLayer(settingsLayer(settingsDialogRules(parseYaml)));

/**
 * The Settings dialog, opened on `page` as ⌘, opens it (a tree node: a page, or a group's first
 * page), once its reads are in.
 */
const drawSettings = async (
  page: string | undefined,
  start: boolean,
  o: ClientOptions,
): Promise<Outcome<Node>> => {
  if (page !== undefined && openPage(page) === undefined)
    return refused(
      'unknown-page',
      `no Settings page ${JSON.stringify(page)}; the pages: ${PAGES.map((p) => p.id).join(', ')}`,
    );
  const settings = mountSettings();
  const params = page === undefined ? {} : { page };

  await settle(settings, settings.send({ kind: 'open', params, size: RENDER_SIZE }), start, o);
  const tree = settings.tree;

  // (never: an open dialog always draws)
  return tree === undefined
    ? refused('failed', 'the Settings dialog drew nothing')
    : { ok: true, data: tree };
};

/** A screen of `SCREENS`, once its reads are in. */
const drawScreen = async (
  name: string,
  start: boolean,
  o: ClientOptions,
): Promise<Outcome<Node>> => {
  const screen = screenOf(name);

  if (screen === undefined) return refused('unknown-screen', unknownScreen(name));
  const { mounted, commands } = screen.mountAlone({}, RENDER_SIZE);
  const ticked = mounted.send({ kind: 'tick', at: new Date().toISOString() });

  await settle(mounted, [...commands, ...ticked], start, o);

  return { ok: true, data: mounted.tree };
};

/**
 * `abe ui render <screen>`: the tree once the screen's reads are in, outlined or `--json`; the
 * Settings dialog's too (`settings`, on `--page`), though it is a layer over the screens.
 */
export const runRender = async (
  name: string,
  page: string | undefined,
  json: boolean,
  start: boolean,
  o: ClientOptions,
): Promise<Printed> => {
  const settings = name === SETTINGS_SCREEN;

  if (!settings && page !== undefined)
    return printFailure(
      {
        code: 'usage',
        message: `--page opens a Settings page: abe ui render ${SETTINGS_SCREEN} --page <page>`,
      },
      EXIT.usage,
      json,
    );
  let drawn: Outcome<Node>;

  try {
    drawn = settings ? await drawSettings(page, start, o) : await drawScreen(name, start, o);
  } catch (err) {
    return printFailure({ code: 'failed', message: String(err) }, EXIT.failed, json);
  }
  if (!drawn.ok) return printFailure(drawn.error, drawn.exit ?? EXIT.failed, json);
  const data: UiRenderData = { screen: name, tree: drawn.data };

  return {
    exit: EXIT.ok,
    stdout: json ? `${JSON.stringify({ ok: true, data })}\n` : uiRenderText(data),
    stderr: '',
  };
};

export type BridgeIo = {
  /** The app's lines (stdin), until it closes. */
  lines: AsyncIterable<string>;
  /** One frame line to the app (stdout). */
  write: (line: string) => void;
  /** What went wrong, for a person reading the app's log (stderr). */
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** The clock, RFC 3339 (default: the system's). */
  now?: () => string;
};

/** Waits between tries at `abe watch` while `serve` is down. */
const RECONNECT_MS = 250;
/** A stripe item's or its menu's click (`widget:stripe:…`, `widget:stripe-menu:…`). */
const STRIPE_WIDGET = 'widget:stripe';

/** The longest wait before `abe fresh --follow` is asked again after it kept ending. */
const FRESH_RETRY_MAX_MS = 30_000;

type Params = Readonly<Record<string, string>>;

/** `params` without these keys. */
const without = (params: Params, ...keys: string[]): Params =>
  Object.fromEntries(Object.entries(params).filter(([k]) => !keys.includes(k)));

/** `params` with the column's `mode` set to `mode`, or without one. */
const withMode = (params: Params, mode: string | undefined): Params => {
  const rest = without(params, 'mode');

  return mode === undefined ? rest : { ...rest, mode };
};

/** The same params but for `mode`. */
const sameButMode = (a: Params, b: Params): boolean => {
  const x = without(a, 'mode');
  const y = without(b, 'mode');
  const keys = Object.keys(x);

  return keys.length === Object.keys(y).length && keys.every((k) => x[k] === y[k]);
};

/**
 * The params a screen already open gets on the app's `open` (`was` what it holds, `fromApp` what
 * the app last opened it with): the app's, but when only the column's mode changed (⌃⌘→ /
 * ⌃⌘← in the Factory view) the screen keeps what it was opened on (a session a Sessions row
 * chose), in that mode.
 */
export const appOpenParams = (was: Params, fromApp: Params | undefined, next: Params): Params => {
  if (fromApp === undefined || fromApp.mode === next.mode || !sameButMode(fromApp, next))
    return next;
  // (a ⌃W landing's `waking` is said once, not again with a mode)
  return withMode(without(was, 'waking'), next.mode);
};

/**
 * The app's `open` param putting Chat on the repo's Abe chat (Boxes, Pipelines): its main
 * checkout, in place of the shown workspace's folder, box and branch.
 */
const ABE_PARAM = 'abe';

/**
 * The params a screen already open gets on a screen's `open`: those, in the column's mode, still
 * on the Abe chat's main checkout (a session chosen there).
 */
export const screenOpenParams = (was: Params, next: Params): Params => {
  const abe = was[ABE_PARAM];

  return withMode(abe === undefined ? next : { ...next, [ABE_PARAM]: abe }, was.mode);
};

/** The slot last told it has the keys, and the one a layer took them from. */
export type KeysTold = { told: Slot | null; under: Slot | null };

type FocusInput = Extract<Input, { kind: 'focus' }>;

/**
 * The keys at `now` (null: a layer, the Editor or another surface has them), `layer` while one
 * is up: what to tell which slot, in order. A slot a layer takes them from is told so (`layer`:
 * a list keeps its held order under a menu); as the layer closes they come back to it, or
 * it is told it lost them for real.
 */
export const keysMoved = (
  at: KeysTold,
  now: Slot | null,
  layer: boolean,
): { state: KeysTold; tell: [Slot, FocusInput][] } => {
  const tell: [Slot, FocusInput][] = [];
  let under = at.under;

  if (!layer && under !== null) {
    if (under !== now) tell.push([under, { kind: 'focus', focused: false }]);
    under = null;
  }
  if (now === at.told) return { state: { told: at.told, under }, tell };
  if (at.told !== null) {
    if (layer) under = at.told;
    tell.push([at.told, { kind: 'focus', focused: false, ...(layer ? { layer: true } : {}) }]);
  }
  if (now !== null) tell.push([now, { kind: 'focus', focused: true }]);

  return { state: { told: now, under }, tell };
};

/** `abe fresh --follow` as the bridge holds it: its folder, and the stream while open. */
type FreshHold = { cwd: string; closed: boolean; following?: Following };

/**
 * `abe ui bridge`: frames from the app on `io.lines`, frames to it through `io.write`, until the
 * app closes stdin. `abe watch` is followed from the start (which starts `serve` when none
 * answers); when the stream breaks the bridge follows it again and opens the screen anew, so a
 * restarted `serve` is read from the beginning.
 */
export const runBridge = async (
  start: boolean,
  o: ClientOptions,
  io: BridgeIo,
): Promise<ExitCode> => {
  /** A slot's mounted screen (one per slot, `main` the Factory view's). */
  type Open = {
    name: string;
    params: Readonly<Record<string, string>>;
    /** What the app last opened it with (none: a screen opened it). */
    fromApp?: Readonly<Record<string, string>>;
    mounted: Mounted;
    /** Its reads not answered yet. */
    pending: number;
    /** Opened anew after a break: no tree until its reads are in, so the view does not flicker. */
    quiet: boolean;
  };
  const held: {
    /** Each slot's size (`resize {slot}`); `main`'s is `hello`'s too. */
    sizes: Partial<Record<Slot, ViewSize>>;
    slots: Partial<Record<Slot, Open>>;
    rev: number;
    /** The last line logged, so a serve that keeps failing is logged once, not every try. */
    logged?: string;
    /** Each slot's last tree sent, as its screen's name and JSON. */
    /** Each slot's tree the app holds: what the next frame patches, by its screen and rev. */
    sentTrees: Partial<Record<Slot, { tree: Node; screen: string; rev: number }>>;
    /** The last whole-state effects sent (`widgets`, `selected`, …), as their JSON. */
    sent: Partial<
      Record<
        'widgets' | 'stripe' | `stripe-dot:${string}` | 'selected' | 'workspaces' | 'look' | 'feel',
        string
      >
    >;
    closed: boolean;
    following?: Following;
    /** The shown project's folder (`hello`, `project`): where commands run. */
    root?: string;
    /** The shown workspace's box and branch (`project`). */
    box?: string;
    branch?: string;
    /** The slot with the keyboard (`focus`). */
    focused: Slot | null;
    /** The Editor's last caret (`caret`), for a `chat` screen opened after it. */
    caret?: Caret;
    /** What the Editor said just before its `:` (`editor-here`): `:`'s Subject there, once. */
    editor?: EditorHere;
    /** Which slot's screen handed Command mode each menu or dialog (by id): its `choice`s go back there. */
    asked: Map<string, Slot>;
    /** The header's workspaces (the last `workspaces` effect): the shown one's story for a jump. */
    looks: readonly WorkspaceLook[];
    /**
     * Each screen another took the slot from, by the shown workspace and `slot/name`: opened
     * there again it starts from what it keeps (`Mounted.reopen`). A break clears them.
     */
    kept: Map<string, Mounted>;
    /** The Board's screen while the Run or Skills place has the main slot: the stripe's clicks. */
    boardBehind?: Mounted | undefined;
    /** The status line said last, and when: the clock fades it, an error's sooner. */
    status?: SaidLine | undefined;
    /**
     * The error balloons up by key (`errors.ts`): the screen that said each, the run whose
     * answer said it (Retry runs it again), its action when it needs you.
     */
    errors: Map<
      string,
      { asker: Pick<Mounted, 'send'>; run?: RunCommand; action?: NeedsYouAction | null }
    >;
    /** `abe watch` is connected to a serve now: an Ask can start. */
    serving: boolean;
    /** The window's view and whether it is active (`window`). */
    window?: { view: 'editor' | 'factory'; active: boolean; place?: string };
    /** The stripe's items as last sent: `:`'s Go to. */
    stripe?: readonly StripeGo[];
    /** `abe fresh --follow` held while the Factory view is shown, in that folder. */
    fresh?: FreshHold;
  } = {
    sizes: {},
    slots: {},
    rev: 0,
    closed: false,
    serving: false,
    sent: {},
    sentTrees: {},
    focused: null,
    asked: new Map(),
    looks: [],
    kept: new Map(),
    errors: new Map(),
  };
  /** Set by the stdin loop while `watch` awaits: read through a call so it is read anew. */
  const closed = () => held.closed;

  const log = (message: string) => {
    if (message === held.logged) return;
    held.logged = message;
    io.log(`abe ui bridge: ${message}`);
  };
  /**
   * Settles once the first try at `abe watch` is done: that try alone starts `serve` when none
   * answers, so the screens' reads never start one of their own (or three at once).
   */
  const firstTry = Promise.withResolvers<undefined>();

  const now = io.now ?? (() => new Date().toISOString());

  const out = (frame: BridgeFrame) => {
    io.write(`${JSON.stringify(frame)}\n`);
  };

  const sizeOf = (slot: Slot): ViewSize =>
    held.sizes[slot] ?? held.sizes.main ?? { width: 0, height: 0 };

  const showSlot = (slot: Slot) => {
    const open = held.slots[slot];

    if (open === undefined) return;
    if (open.quiet && (open.pending > 0 || facts.reading(open.mounted.follows()))) return;
    open.quiet = false;
    const tree = open.mounted.tree;
    const was = treesSeen.get(slot);

    // the very tree seen last (a screen that did not step, or stepped to the same state): nothing
    // to compare, nothing to send
    if (was?.tree === tree && was.name === open.name) return;
    treesSeen.set(slot, { tree, name: open.name });
    // The screen's name too: another screen with the same tree is still a new tree to draw.
    const sent = held.sentTrees[slot];
    const ops = sent?.screen === open.name ? patchOf(sent.tree, tree) : undefined;

    if (ops?.length === 0) return;
    const base = sent?.rev;

    held.rev += 1;
    held.sentTrees[slot] = { tree, screen: open.name, rev: held.rev };
    // `main`'s tree names no slot, as before slots
    const at = slot === 'main' ? {} : { slot };
    // the app holds this slot's tree: only what changed, keyed (one op at the root: the tree)
    if (
      ops !== undefined &&
      base !== undefined &&
      !(ops.length === 1 && ops[0]?.path.length === 0)
    ) {
      out({ v: UI_CONTRACT, type: 'patch', screen: open.name, rev: held.rev, base, ops, ...at });

      return;
    }
    const head = JSON.stringify({
      v: UI_CONTRACT,
      type: 'tree',
      screen: open.name,
      rev: held.rev,
      ...at,
    });

    io.write(`${head.slice(0, -1)},"tree":${JSON.stringify(tree)}}\n`);
  };
  /** Each slot's tree as last compared, by reference, with its screen's name. */
  const treesSeen = new Map<Slot, { tree: Node; name: string }>();

  const show = () => {
    syncFollows();
    for (const slot of SLOTS) showSlot(slot);
  };

  /** The live facts: mounted once, read for every screen open, handed to each as they move. */
  const facts = mountLive();

  /** A kept read's asker: its screen (counted while its slot's screen is it) and its run. */
  type KeptAsker = { asker: Asker; run: RunCommand; counted: boolean };

  /**
   * The kept reads' answers (`run` with `keep`), shared by every screen this bridge mounts: by
   * argv in the shown folder, the last one handed at once while it is read anew (`live/queries.ts`).
   */
  let queries = noQueries<Answer, KeptAsker>();
  /** The facts' rev each screen was last handed. */
  const handed = new WeakMap<Mounted, number>();
  /** The reads the open screens followed last, as told to live. */
  let followed = '';

  /** Every screen open (and the Board kept behind) given the facts it was not handed yet. */
  const handFacts = () => {
    const rev = facts.facts.rev;
    const screens = [
      ...SLOTS.flatMap((slot) => {
        const open = held.slots[slot];

        return open === undefined ? [] : [open.mounted];
      }),
      ...(held.boardBehind === undefined ? [] : [held.boardBehind]),
    ];

    for (const mounted of screens) {
      if (handed.get(mounted) === rev) continue;
      handed.set(mounted, rev);
      perform(mounted, mounted.send({ kind: 'live', facts: facts.facts }));
    }
  };

  /** Live told what the open screens follow now: it reads what none read yet. */
  function syncFollows() {
    const screens = [
      ...SLOTS.flatMap((slot) => {
        const open = held.slots[slot];

        return open === undefined ? [] : [open.mounted];
      }),
      ...(held.boardBehind === undefined ? [] : [held.boardBehind]),
    ];
    const reads = [...new Set(screens.flatMap((m) => m.follows()))].sort();
    const said = reads.join(' ');

    if (said === followed) return;
    followed = said;
    feedLive({ kind: 'follow', reads });
  }

  /** One input to live: its reads asked, its facts handed on when they moved. */
  function feedLive(input: LiveInput) {
    perform(facts, facts.send(input));
    handFacts();
  }

  /** Command mode: mounted once, over whichever view is shown; its tree is the top layer. */
  const layer = mountLayer(commandMode([...WORDS, SETTINGS_WORD]));
  /**
   * The Settings dialog: a layer mounted once beside Command mode, over every view. The
   * layer frame carries the top of the two: Command mode's while it is up, else the dialog.
   */
  const settings = mountSettings();
  /** The layer last sent (`null`: none), so an unchanged one is not sent again. */
  let sentLayer = 'null';

  /** The layer tree as last compared, by reference. */
  let layerSeen: Node | null | undefined;

  const showLayer = () => {
    const tree = layer.tree ?? settings.tree ?? null;

    if (tree === layerSeen) return;
    layerSeen = tree;
    const text = JSON.stringify(tree);

    if (text === sentLayer) return;
    sentLayer = text;
    held.rev += 1;
    out({ v: UI_CONTRACT, type: 'layer', rev: held.rev, tree });
    tellKeys();
  };

  /**
   * Command mode told the time now: a dialog's primary takes no ⏎ that comes too soon after it
   * opened or after the ⏎ before, so the clock goes in before each dialog and each ⏎.
   */
  const clockLayer = () => {
    perform(layer, layer.send({ kind: 'tick', at: now() }));
  };

  /**
   * One thing has the keys (docs/agents/native-architecture.md): the top layer while one
   * is up, else the slot the app says has the keyboard. A slot's screen draws active only while
   * it has them, so a Board under the story dialog or a menu goes grey like one under Chat.
   */
  const layerUp = (): boolean => layer.tree !== undefined || settings.tree !== undefined;
  /** The slot `slot`'s keys and clicks go to: `main`'s to the popup over it while one is open. */
  const over = (slot: Slot): Slot =>
    slot === 'main' && held.slots.popup !== undefined ? 'popup' : slot;
  const keysAt = (): Slot | null =>
    layerUp() || held.focused === null ? null : over(held.focused);
  /** The slot whose screen was last told it has the keys, and the one a layer took them from. */
  let keys: KeysTold = { told: null, under: null };

  /**
   * Tells the screens where the keys went when that moved (`keysMoved`): the one that lost them,
   * then the one that got them. A screen's `focus` answers no commands (no layer opens from it),
   * so nothing moves the keys again while it is told.
   */
  function tellKeys() {
    const moved = keysMoved(keys, keysAt(), layerUp());

    keys = moved.state;
    for (const [slot, input] of moved.tell) feedSlot(slot, input);
  }

  type Asker = Pick<Mounted, 'send'>;

  /** The slot whose screen `asker` is (undefined: Command mode, or a screen closed since). */
  const slotOf = (asker: Asker): Slot | undefined =>
    SLOTS.find((slot) => held.slots[slot]?.mounted === asker);

  /** Whether `asker` still takes answers: a slot's open screen, or a layer (always). */
  const live = (asker: Asker) =>
    asker === facts ||
    asker === layer ||
    asker === settings ||
    slotOf(asker) !== undefined ||
    asker === held.boardBehind;

  /**
   * The open params a screen gets: the app's folder (`--repo`), its box and branch; Chat on
   * Boxes or Pipelines (`abe`) the main checkout's Abe chat, never the shown card workspace's.
   */
  const withShown = (params: Readonly<Record<string, string>>) => {
    // the shown workspace is the bridge's to say: what an older open named of it is gone
    const rest = without(params, 'root', 'box', 'branch', ABE_PARAM);
    const abe = params[ABE_PARAM];

    if (abe !== undefined) return { ...rest, root: realPathAt(abe) };

    return {
      ...rest,
      ...(held.root === undefined ? {} : { root: held.root }),
      ...(held.box === undefined ? {} : { box: held.box }),
      ...(held.branch === undefined ? {} : { branch: held.branch }),
    };
  };

  /**
   * The look: the stage a Settings screen holds (null: none), and which ask is the
   * newest, so an older answer arriving late is dropped.
   */
  const look: { stage: LookStage | null; asked: number } = { stage: null, asked: 0 };

  /**
   * The tags of the bridge's own reads for shell effects (the look, the Feel): their `command.ran`
   * is no command a person ran, so no screen hears it (a screen reading again on it moved the
   * Factory view's ⌘⌥A landing, factory-ui.test.ts).
   */
  const ownReads = new Set<string>();
  /** Those reads one after the other once serve first answered (each is a command's run). */
  let shellReads: Promise<unknown> = firstTry.promise;

  /** Reads the look in force (with the stage over it) in the shown folder, and sends it. */
  const sendLook = () => {
    look.asked += 1;
    const n = look.asked;
    const argv = [
      'theme',
      'look',
      ...(look.stage === null ? [] : ['--stage', JSON.stringify(look.stage)]),
    ];
    const where = held.root === undefined ? o : { ...o, cwd: held.root };

    ownReads.add(`look:${n}`);
    shellReads = shellReads
      .then(() => answer({ id: `look:${n}`, argv }, false, where))
      .then(
        (got) => {
          if (n !== look.asked || held.closed) return;
          if (got.command !== 'theme look' || !got.reply.ok) {
            log(`no look: ${got.reply.ok ? 'not a look' : got.reply.error.message}`);

            return;
          }
          perform(layer, [{ kind: 'shell', effect: { kind: 'look', look: got.reply.data } }]);
        },
        (err: unknown) => {
          log(String(err));
        },
      );
  };

  /**
   * The layer a person's input in `slot` goes to: Command mode's while up, else the dialog's, else
   * `:`'s, or `?`'s key help from the Factory view's body; a slot's field types both (`typing`).
   */
  const topLayer = (slot: Slot, input: Input) => {
    if (layer.tree !== undefined) return layer;
    if (settings.tree !== undefined) return settings;

    // a field of the slot's screen types `:` and `?` (Chat's composer, the Board's `/` filter)
    const typing = held.slots[slot]?.mounted.typing() === true;

    return (opensCommandMode(input) || opensKeyHelp(input)) && !typing ? layer : undefined;
  };

  /**
   * Where `:` or `?` is pressed, told to Command mode just before the key: what the screen
   * with the keys says (its Subject, its view's rows, its keys; nothing when the Editor or another
   * surface has them), whether serve answers, the shown project's folder name. The Subject's and
   * the view's menus hand their rows back to that screen's slot, as its own menus do.
   */
  const hereNow = (): Extract<Input, { kind: 'here' }> => {
    const slot = held.focused === null ? null : over(held.focused);
    const editor = held.editor;
    const project = held.root === undefined ? undefined : basename(held.root);
    // a box's folder is not on this Mac: no install there
    const checkout =
      held.root === undefined || held.box !== undefined ? undefined : checkoutAt(held.root);
    // where the stripe stands, as the shell said with the window
    const place = held.window?.place;

    // the Editor's `:`: its caret's Subject and Neovim's Ex commands, said for this `:` only
    delete held.editor;
    if (slot === null && editor !== undefined)
      return editorHere(editor, {
        serving: held.serving,
        project,
        checkout,
        stripe: held.stripe,
        // a board is in force where the Board says so
        board: held.slots.main?.mounted.here()?.board === true,
      });
    const here = (slot === null ? undefined : held.slots[slot]?.mounted.here()) ?? {};

    if (slot !== null) {
      if (here.subject?.menu !== undefined) held.asked.set(here.subject.menu.id, slot);
      if (here.view !== undefined) held.asked.set(here.view.menu.id, slot);
    }

    return {
      kind: 'here',
      here,
      serving: held.serving,
      ...(project === undefined ? {} : { project }),
      ...(checkout === undefined ? {} : { checkout }),
      ...(place === undefined ? {} : { place }),
      ...(held.stripe === undefined ? {} : { stripe: held.stripe }),
    };
  };

  /** ⌘, and `:settings`: the dialog gets the `open` input (its page, row). */
  const openSettings = (params: Readonly<Record<string, string>>) => {
    const commands = settings.send({ kind: 'open', params, size: sizeOf('main') });

    showLayer();
    perform(settings, commands);
  };

  /** Which Feel read is the newest, so an older answer arriving late is dropped. */
  let feelAsked = 0;

  /** Reads the Feel's switches in force in the shown folder, and sends them. */
  const sendFeel = () => {
    feelAsked += 1;
    const n = feelAsked;
    const where = held.root === undefined ? o : { ...o, cwd: held.root };

    ownReads.add(`feel:${n}`);
    shellReads = shellReads
      .then(() => answer({ id: `feel:${n}`, argv: ['settings', 'feel'] }, false, where))
      .then(
        (got) => {
          if (n !== feelAsked || held.closed) return;
          if (got.command !== 'settings feel' || !got.reply.ok) {
            log(`no feel: ${got.reply.ok ? 'not a feel' : got.reply.error.message}`);

            return;
          }
          perform(layer, [{ kind: 'shell', effect: { kind: 'feel', feel: got.reply.data } }]);
        },
        (err: unknown) => {
          log(String(err));
        },
      );
  };

  /** Where an asker says things, for the error history: Command mode, Settings, its screen. */
  const whereOf = (asker: Asker): string | undefined => {
    if (asker === layer) return 'Command mode';
    if (asker === settings) return 'Settings';
    const slot = slotOf(asker);

    return slot === undefined ? undefined : held.slots[slot]?.name;
  };

  /** The status line cleared, when it says something. */
  const clearStatus = () => {
    if (held.status === undefined) return;
    held.status = undefined;
    out({ v: UI_CONTRACT, type: 'shell', effect: { kind: 'status', text: '' } });
  };

  /** The error with this key goes: its balloon, and the status line while it says it. */
  const dropError = (key: string) => {
    if (!held.errors.delete(key)) return;
    out({ v: UI_CONTRACT, type: 'shell', effect: { kind: 'drop-balloon', key } });
    if (held.status?.error?.key === key) clearStatus();
  };

  /**
   * A click on an error balloon's action: Settings' logins, the run again, the Boxes tab.
   * The balloon stays until its cause is gone: the run answered ok.
   */
  const balloonAction = (key: string) => {
    const said = held.errors.get(key);

    if (said === undefined) return;
    if (said.action === 'login') openSettings({ page: 'logins-tools' });
    else if (said.action === 'boxes')
      perform(layer, [{ kind: 'shell', effect: { kind: 'show', place: 'boxes' } }]);
    else if (said.action === 'retry' && said.run !== undefined && live(said.asker))
      perform(said.asker, [said.run]);
    show();
  };

  /**
   * What a screen asked for, done. `cause`: the run whose answer it is: an error balloon
   * said on a refusal is that run's, and goes once the same run is answered ok.
   */
  const perform = (
    asker: Asker,
    commands: readonly Command[],
    cause?: { run: RunCommand; ok: boolean; code?: string | undefined },
  ) => {
    for (const command of commands) {
      if (command.kind === 'shell') {
        if (command.effect.kind === 'stripe')
          held.stripe = command.effect.items.map((i) => ({
            id: i.id,
            label: i.label,
            group: i.group,
            ...(i.key === undefined ? {} : { key: i.key }),
            ...(i.workspaceOnly === true ? { workspaceOnly: true as const } : {}),
          }));
        // The whole-state effects go only when they changed.
        if (
          command.effect.kind === 'widgets' ||
          command.effect.kind === 'stripe' ||
          command.effect.kind === 'stripe-dot' ||
          command.effect.kind === 'selected' ||
          command.effect.kind === 'workspaces' ||
          command.effect.kind === 'look' ||
          command.effect.kind === 'feel'
        ) {
          const text = JSON.stringify(command.effect);
          // each item's dot is its own state (Pipelines' and a later one's never shadow each other)
          const key =
            command.effect.kind === 'stripe-dot'
              ? (`stripe-dot:${command.effect.id}` as const)
              : command.effect.kind;

          if (text === held.sent[key]) continue;
          held.sent[key] = text;
          if (command.effect.kind === 'workspaces') held.looks = command.effect.workspaces;
        }
        // an error goes by the one rule: its key, whether it stays, its action, where; said on
        // the status line too, there once its balloon is closed, fading as it does
        if (command.effect.kind === 'balloon' && command.effect.tone === 'error') {
          const at = now();
          const key = cause !== undefined && !cause.ok ? runKey(cause.run.argv) : undefined;
          const said = errorSaid(
            command.effect.text,
            { key, where: whereOf(asker), code: cause?.code },
            at,
          );
          const by = said.key;

          held.errors.delete(by);
          held.errors.set(by, {
            asker,
            ...(cause === undefined ? {} : { run: cause.run }),
            ...(said.action === undefined ? {} : { action: said.action }),
          });
          // (one that needs you is kept: its action still works)
          for (const [old, was] of held.errors) {
            if (held.errors.size <= ERRORS_KEPT) break;
            if (was.action === undefined) held.errors.delete(old);
          }
          out({ v: UI_CONTRACT, type: 'shell', effect: said.balloon });
          held.status = said.line;
          out({ v: UI_CONTRACT, type: 'shell', effect: { kind: 'status', text: said.line.text } });
          continue;
        }
        if (command.effect.kind === 'status')
          held.status = { text: command.effect.text, at: now() };
        out({ v: UI_CONTRACT, type: 'shell', effect: command.effect });
        continue;
      }
      if (
        command.kind === 'confirm' ||
        command.kind === 'menu' ||
        command.kind === 'dialog' ||
        command.kind === 'ask' ||
        command.kind === 'comment' ||
        command.kind === 'launch' ||
        command.kind === 'newcard'
      ) {
        // Command mode asks, then runs it (its ConfirmLayer and status line), or draws and keys
        // the screen's Action menu and card dialog; what it hands back goes to that screen.
        const from = slotOf(asker);

        if (
          from !== undefined &&
          (command.kind === 'menu' || command.kind === 'dialog' || command.kind === 'launch')
        )
          held.asked.set(command.id, from);
        // a dialog's primary, the Launch box and New card take no ⏎ just after they open
        if (
          (command.kind === 'dialog' && command.update !== true) ||
          command.kind === 'launch' ||
          command.kind === 'newcard'
        )
          clockLayer();
        const asked = layer.send(command);

        showLayer();
        perform(layer, asked);
        continue;
      }
      if (command.kind === 'choice') {
        // A row of a screen's menu Command mode handed back: the screen that asked does it; a
        // word's goes to the slot it names (`:override`: the Chat column's), else main's (`:show`)
        const screen = held.slots[command.slot ?? held.asked.get(command.menu) ?? 'main'];

        if (screen !== undefined) perform(screen.mounted, screen.mounted.send(command));
        show();
        continue;
      }
      if (command.kind === 'jump') {
        jump(command);
        continue;
      }
      if (command.kind === 'live') {
        feedLive({ kind: 'reread', reads: command.reads, ran: command.ran });
        continue;
      }
      if (command.kind === 'look') {
        look.stage = command.stage;
        sendLook();
        continue;
      }
      if (command.kind === 'open' && command.screen === SETTINGS_SCREEN) {
        openSettings(command.params ?? {});
        continue;
      }
      if (command.kind === 'open') {
        const slot = command.slot ?? 'main';

        // the screen already open keeps its state: it gets the `open` input (`:triage`'s params)
        const already = held.slots[slot];

        if (already?.name === command.screen) {
          // (the Board again from its popup's Esc: the popup closes)
          if (slot === 'main') closePopup();
          // a reopen after a break opens it on what it was last opened with, in the column's mode
          already.params =
            slot === 'chat'
              ? screenOpenParams(already.params, command.params ?? {})
              : (command.params ?? {});
          feedSlot(slot, { kind: 'open', params: withShown(already.params), size: sizeOf(slot) });
          continue;
        }
        // another screen there: the slot's screen is not this one's to change
        if (command.ifOpen === true) continue;
        if (!open(slot, command.screen, command.params ?? {}))
          log(`no screen ${JSON.stringify(command.screen)} to open`);
        continue;
      }
      if (command.keep === true) {
        askKept(asker, command);
        continue;
      }
      const screen = held.slots[slotOf(asker) ?? 'main'];
      const counted = screen?.mounted === asker;

      if (counted) screen.pending += 1;
      const done = () => {
        if (counted) screen.pending -= 1;
      };

      // `help` is answered here, as the client does: it waits for no serve
      const ready = command.argv[0] === 'help' ? Promise.resolve(undefined) : firstTry.promise;

      // In the shown project's folder: `--repo`, the settings and the board in force there.
      const where = held.root === undefined ? o : { ...o, cwd: held.root };

      void ready
        .then(() => answer(command, false, where))
        .then(
          (got) => {
            done();
            // The screen was closed or opened anew meanwhile: its answer is no one's.
            if (!live(asker)) return;
            perform(asker, asker.send(got), {
              run: command,
              ok: got.reply.ok,
              code: got.reply.ok ? undefined : got.reply.error.code,
            });
            if (asker === facts) handFacts();
            // the same run answered ok: an error it said before is gone with its cause
            if (got.reply.ok) dropError(runKey(command.argv));
            show();
            showLayer();
          },
          (err: unknown) => {
            done();
            log(String(err));
          },
        );
    }
  };

  /** A kept read asked: what is held of it at once (`cached`), the read itself or the one out joined. */
  function askKept(asker: Asker, run: RunCommand) {
    const key = queryKey(run.argv, held.root);
    const slot = held.slots[slotOf(asker) ?? 'main'];
    const counted = slot?.mounted === asker;
    const asked = askQuery(queries, key, { asker, run, counted });

    queries = asked.queries;
    if (counted) slot.pending += 1;
    if (asked.held !== undefined)
      perform(asker, asker.send({ ...asked.held, id: run.id, cached: true }));
    if (asked.read) readKept(key, run, held.root);
  }

  /** A kept read run in `root`; its answer to each asker waiting, read again for those who asked meanwhile. */
  function readKept(key: QueryKey, run: RunCommand, root: string | undefined) {
    const where = root === undefined ? o : { ...o, cwd: root };
    const settle = (got: Answer | Refused) => {
      const ok = got.command !== null && got.reply.ok;
      const settled = answerQuery(queries, key, got.command === null || !ok ? undefined : got);

      queries = settled.queries;
      for (const w of settled.waiting) {
        const slot = held.slots[slotOf(w.asker) ?? 'main'];

        if (w.counted && slot?.mounted === w.asker) slot.pending -= 1;
        if (!live(w.asker)) continue;
        perform(w.asker, w.asker.send({ ...got, id: w.run.id }), {
          run: w.run,
          ok: got.reply.ok,
          code: got.reply.ok ? undefined : got.reply.error.code,
        });
      }
      for (const w of settled.joined)
        if (live(w.asker) && got.command !== null)
          perform(w.asker, w.asker.send({ ...got, id: w.run.id, cached: true }));
      if (got.reply.ok) dropError(runKey(run.argv));
      if (settled.again) readKept(key, run, root);
      show();
      showLayer();
    };

    void firstTry.promise
      .then(() => answer(run, false, where))
      .then(settle, (err: unknown) => {
        log(String(err));
        settle({
          kind: 'result',
          id: run.id,
          command: null,
          reply: { ok: false, error: { code: 'failed', message: String(err) } },
        });
      });
  }

  /**
   * A jump handed on: Command mode takes each first (⌃L opens Linked there; ⌃W leaves every
   * layer for the workspace), then the Factory overview in `main`, which holds the cards and the
   * sessions, opens Open card's Card page or Open workspace's workspace.
   */
  function jump(command: Extract<Command, { kind: 'jump' }>) {
    const asked = layer.send(command);

    showLayer();
    perform(layer, asked);
    if (command.to === 'linked') return;
    // the Run or Skills place took `main`: the Board kept behind it answers (its cards, sessions)
    const board = held.slots.main?.name === 'factory' ? undefined : held.boardBehind;

    if (board === undefined) {
      feedSlot('main', command);

      return;
    }
    perform(board, board.send(command));
    show();
  }

  /** ⌃L from the app: the story of what had the keyboard, else `Nothing linked here`. */
  const jumpFrom = (frame: Extract<AppFrame, { type: 'jump' }>) => {
    const story = storyOfJump(frame.from, {
      layer: layer.tree === undefined ? undefined : layer.linked(),
      // the popup over main is what main's keys are on
      slots: Object.fromEntries(
        SLOTS.map((slot) => [slot, held.slots[over(slot)]?.mounted.linked()]),
      ),
      workspace: workspaceStory(held.looks, {
        root: held.root,
        box: held.box,
        branch: held.branch,
      }),
    });

    perform(layer, jumpCommands(frame.to, story));
    show();
    showLayer();
  };

  /** An input for one slot's screen, past the layers. */
  const feedSlot = (slot: Slot, input: Input) => {
    const open = held.slots[slot];

    if (open === undefined) return;
    perform(open.mounted, open.mounted.send(input));
    show();
  };

  /** An input every slot's screen gets (an event, the clock, the shown folder). */
  const feedAll = (input: Input) => {
    // the live facts move first: every screen takes the event on the facts it moved
    if (input.kind === 'event' || input.kind === 'tick' || input.kind === 'root') feedLive(input);
    // an open Linked follows `abe watch` and the clock
    if (input.kind === 'event' || input.kind === 'tick') {
      const commands = layer.send(input);

      showLayer();
      perform(layer, commands);
    }
    // the dialog reads its rows again on a write or a serve back, in the project shown; its fix
    // strip's terminal ending is its own too
    if (input.kind === 'event' || input.kind === 'root' || input.kind === 'exit') {
      const commands = settings.send(input);

      showLayer();
      perform(settings, commands);
    }
    for (const slot of SLOTS) {
      const open = held.slots[slot];

      if (open === undefined) continue;
      // the Abe chat stays on its main checkout whichever workspace is shown
      if (input.kind === 'root' && open.params[ABE_PARAM] !== undefined) continue;
      perform(open.mounted, open.mounted.send(input));
    }
    // the Board kept behind the Run or Skills place stays current: the strip and ⌃W read it
    const board = held.boardBehind;

    if (board !== undefined) perform(board, board.send(input));
    show();
  };

  /**
   * What the person did, in `slot` (main's to the popup over it): the top layer (or `:`) takes it
   * first, whichever slot.
   */
  const feedPerson = (at: Slot, input: UserInput) => {
    const slot = over(at);
    // Every key, click and text goes to the top layer while one is up; `:` opens Command mode.
    const top = topLayer(slot, input);

    if (top !== undefined) {
      if (top === layer && input.kind === 'key' && input.key === '<CR>') clockLayer();
      if (top === layer && (opensCommandMode(input) || opensKeyHelp(input))) layer.send(hereNow());
      const commands = top.send(input);

      // the layer first: a word that opens a screen draws it with the layer already gone
      showLayer();
      perform(top, commands);
      show();

      return;
    }
    // stamped: a screen goes by how soon a key came (a card that just came takes no digit)
    feedSlot(slot, { ...input, at: now() });
  };

  function open(
    slot: Slot,
    name: string,
    params: Readonly<Record<string, string>>,
    quiet = false,
  ): boolean {
    const screen = screenOf(name);

    if (screen === undefined) return false;
    // a screen opened in main closes the popup over it
    if (slot === 'main' && !quiet) closePopup();
    const was = held.slots[slot];
    // opened anew after a break (`quiet`): what it held may be another serve's, nothing is kept
    const kept = quiet ? undefined : held.kept.get(keptKey(slot, name));

    if (!quiet && was !== undefined && was.name !== name && was.mounted.keeps)
      keepScreen(keptKey(slot, was.name), was.mounted);
    held.kept.delete(keptKey(slot, name));
    // the Board kept behind a workspace's Card page or the Run place is the Board again, as it
    // was: it gets the `open` input on the state it holds
    const behind = slot === 'main' && name === 'factory' && !quiet ? held.boardBehind : undefined;

    if (slot === 'main' && name === 'factory') delete held.boardBehind;
    else if (slot === 'main' && was?.name === 'factory') held.boardBehind = was.mounted;
    const { mounted, commands } =
      (behind === undefined
        ? undefined
        : {
            mounted: behind,
            commands: behind.send({
              kind: 'open',
              params: withShown(params),
              size: sizeOf(slot),
            }),
          }) ??
      kept?.reopen(withShown(params), sizeOf(slot)) ??
      screen.mount(withShown(params), sizeOf(slot));

    held.slots[slot] = { name, params, mounted, pending: 0, quiet };
    const told: Input[] = [
      { kind: 'tick', at: now() },
      // whether it has the keys, either way: a screen draws active by default, so one
      // opened while the keys are elsewhere or nowhere (the window not active yet) is told; one
      // a layer took them from, as `keysMoved` says it
      {
        kind: 'focus' as const,
        focused: keys.told === slot,
        ...(keys.under === slot ? { layer: true } : {}),
      },
      ...(slot === 'chat' && held.caret !== undefined
        ? [{ kind: 'caret' as const, ...held.caret }]
        : []),
    ];

    perform(mounted, [...commands, ...told.flatMap((input) => mounted.send(input))]);
    syncFollows();
    handFacts();
    show();
    // the popup has main's keys
    if (slot === 'popup') tellKeys();

    return true;
  }

  /**
   * A screen another took the slot from, kept for its next open there; past `KEPT_SCREENS` the
   * oldest kept is let go (a long day of workspaces holds a bounded few).
   */
  function keepScreen(key: string, mounted: Mounted) {
    held.kept.delete(key);
    held.kept.set(key, mounted);
    for (const old of held.kept.keys()) {
      if (held.kept.size <= KEPT_SCREENS) break;
      held.kept.delete(old);
    }
  }

  /** `slot/name`'s key in `held.kept`, in the shown workspace. */
  function keptKey(slot: Slot, name: string): string {
    return `${held.root ?? ''}\u0000${held.box ?? ''}\u0000${slot}/${name}`;
  }

  /**
   * The popup over main closed (its Esc opened the Board again, a screen opened in main, the rail
   * moved): what it keeps kept for its next open, the app told, main's screen has the keys again.
   */
  function closePopup() {
    const was = held.slots.popup;

    if (was === undefined) return;
    if (was.mounted.keeps) keepScreen(keptKey('popup', was.name), was.mounted);
    delete held.slots.popup;
    delete held.sentTrees.popup;
    treesSeen.delete('popup');
    out({ v: UI_CONTRACT, type: 'closed', slot: 'popup' });
    tellKeys();
  }

  /**
   * A screen that opens on the main screen's card (`opensOnMainCard`: the pane's Sessions)
   * gets that card (the Board's selected one, its `linked`) unless the app named one; not under
   * the Editor (`view: editor`), where that card is hidden and the list follows the workspace.
   */
  const withBoardCard = (
    slot: Slot,
    screen: string,
    params: Readonly<Record<string, string>>,
  ): Readonly<Record<string, string>> => {
    if (
      slot === 'main' ||
      screenOf(screen)?.opensOnMainCard !== true ||
      params.card !== undefined ||
      params.view === 'editor'
    )
      return params;
    const card = held.slots.main?.mounted.linked();

    return card === undefined ? params : { ...params, card: String(card) };
  };

  const handle = (frame: AppFrame) => {
    switch (frame.type) {
      case 'hello':
        held.sizes.main = frame.size;
        if (frame.root !== undefined) {
          held.root = frame.root;
          feedLive({ kind: 'root', root: frame.root });
        }
        syncFresh();
        break;
      case 'project': {
        if (frame.root === held.root && frame.box === held.box && frame.branch === held.branch)
          break;
        // the caret was the other workspace's
        if (frame.root !== held.root || frame.box !== held.box) {
          delete held.caret;
          // the dots were the other workspace's: the shell clears them, the next read sends anew
          held.sent = Object.fromEntries(
            Object.entries(held.sent).filter(([key]) => !key.startsWith('stripe-dot:')),
          );
        }
        held.root = frame.root;
        if (frame.box === undefined) delete held.box;
        else held.box = frame.box;
        if (frame.branch === undefined) delete held.branch;
        else held.branch = frame.branch;
        feedAll({ kind: 'root', root: frame.root, box: frame.box, branch: frame.branch });
        // the shown folder's board and repo are the ones to keep fresh
        syncFresh();
        // the settings in force are that folder's (a repo Layer may name another theme or Feel)
        sendLook();
        sendFeel();
        break;
      }
      case 'open': {
        if (frame.screen === SETTINGS_SCREEN) {
          openSettings(frame.params ?? {});
          break;
        }
        const slot = frame.slot ?? 'main';
        const params = withBoardCard(slot, frame.screen, frame.params ?? {});

        // the screen already open keeps its state: it gets the `open` input (⌘⌥A's `from`)
        const already = held.slots[slot];

        if (already?.name === frame.screen) {
          if (slot === 'main') closePopup();
          already.params =
            slot === 'chat' ? appOpenParams(already.params, already.fromApp, params) : params;
          already.fromApp = params;
          feedSlot(slot, { kind: 'open', params: withShown(already.params), size: sizeOf(slot) });
          break;
        }
        if (!open(slot, frame.screen, params)) {
          out({
            v: UI_CONTRACT,
            type: 'error',
            error: { code: 'unknown-screen', message: unknownScreen(frame.screen) },
          });
          break;
        }
        const mounted = held.slots[slot];

        if (mounted !== undefined) mounted.fromApp = params;
        break;
      }
      case 'input': {
        const input = frame.input;

        // an error balloon's action: the bridge's, no screen's
        if (input.kind === 'click' && input.id.startsWith(BALLOON_CLICK)) {
          balloonAction(input.id.slice(BALLOON_CLICK.length));
          break;
        }
        // a key or a click that does something else takes an error's status line away
        if (
          (input.kind === 'key' || input.kind === 'click') &&
          held.status !== undefined &&
          lineGoesOnInput(held.status, now())
        )
          clearStatus();
        // the stripe's clicks are the Board's screen's, whatever the main slot holds (the Run
        // or Skills place took it: the Board is kept), so its menu and its items still act
        if (
          input.kind === 'click' &&
          input.id.startsWith(STRIPE_WIDGET) &&
          (frame.slot ?? 'main') === 'main' &&
          held.slots.main !== undefined &&
          held.slots.main.name !== 'factory'
        ) {
          const board = held.boardBehind;

          if (board !== undefined) {
            perform(board, board.send(input));
            show();
            break;
          }
        }
        feedPerson(frame.slot ?? 'main', input);
        break;
      }
      case 'resize': {
        const slot = frame.slot ?? 'main';

        held.sizes[slot] = frame.size;
        feedSlot(slot, { kind: 'resize', size: frame.size });
        break;
      }
      case 'focus':
        held.focused = frame.slot;
        tellKeys();
        break;
      case 'window': {
        const was = held.window;

        held.window = {
          view: frame.view,
          active: frame.active,
          ...(frame.place === undefined ? {} : { place: frame.place }),
        };
        // the Factory view shown: held (it looks at once); the window to the front, either view
        // (the Board and Linked follow from the Editor too): a look now, serve's first where
        // the next ones start
        syncFresh();
        if (frame.active && was?.active !== true) lookNow();
        break;
      }
      case 'caret': {
        const caret: Caret = {
          file: frame.file,
          line: frame.line,
          ...(frame.selection === undefined ? {} : { selection: frame.selection }),
        };

        held.caret = caret;
        feedSlot('chat', { kind: 'caret', ...caret });
        break;
      }
      case 'no-caret':
        delete held.caret;
        feedSlot('chat', { kind: 'no-caret' });
        break;
      case 'editor-here':
        held.editor = {
          ex: frame.ex,
          items: frame.items,
          ...(frame.caret === undefined ? {} : { caret: frame.caret }),
        };
        break;
      case 'exit':
        // a terminal's key is one slot's screen's: each looks at it
        feedAll({ kind: 'exit', key: frame.key, code: frame.code });
        // a login may be done (Settings' fix strip): what a login refused runs again
        for (const said of held.errors.values())
          if (said.action === 'login' && said.run !== undefined && live(said.asker))
            perform(said.asker, [said.run]);
        break;
      case 'browser':
        // what a page did: its screen's, never a layer's
        feedAll({ kind: 'browser', key: frame.key, event: frame.event });
        break;
      case 'jump':
        jumpFrom(frame);
        break;
      case 'again':
        // a patch the app could not apply: the slot's tree whole, the patches after on it
        held.sentTrees = Object.fromEntries(
          Object.entries(held.sentTrees).filter(([slot]) => slot !== frame.slot),
        );
        treesSeen.delete(frame.slot);
        showSlot(frame.slot);
        break;
      case 'run': {
        // the shell's own command (Create Draft PR): in the shown folder, its `--json` answered
        const where = held.root === undefined ? o : { ...o, cwd: held.root };
        const id = frame.id;

        void firstTry.promise
          .then(() => answer({ id, argv: frame.argv }, false, where))
          .then(
            (got) => {
              if (!held.closed) out({ v: UI_CONTRACT, type: 'answer', id, reply: got.reply });
            },
            (err: unknown) => {
              if (!held.closed)
                out({
                  v: UI_CONTRACT,
                  type: 'answer',
                  id,
                  reply: { ok: false, error: { code: 'serve-unreachable', message: String(err) } },
                });
            },
          );
        break;
      }
      case 'extent': {
        // the card dialog's page as drawn: Command mode keeps its scroll within it
        const commands = layer.send({ kind: 'extent', id: frame.id, lines: frame.lines });

        showLayer();
        perform(layer, commands);
        // the Card page's, the main slot's own or the popup's over it
        feedSlot(over('main'), { kind: 'extent', id: frame.id, lines: frame.lines });
        break;
      }
      case 'close':
        closePopup();
        break;
    }
  };

  /**
   * The first stream asks for what serve holds from its start (`--since 0`): until this bridge's
   * own mark (`command.ran` of its tagged `help`) comes by, what came before was said already,
   * and only a repo serve followed meanwhile (`repo.moved`) is heard from it. Unset: live.
   */
  let replay: string | undefined;

  /** A repo serve followed: said once, needing you when something did not follow; Recent told. */
  const repoMoved = (m: RepoMoved, live: boolean) => {
    const needsYou = m.to === null || m.problems.length > 0;

    if (live || needsYou)
      out({
        v: UI_CONTRACT,
        type: 'shell',
        effect: {
          kind: 'balloon',
          tone: needsYou ? 'error' : 'info',
          text: repoMovedText(m),
          key: `repo-moved:${m.from}`,
          ...(needsYou ? { stays: true } : {}),
        },
      });
    if (m.to !== null)
      out({
        v: UI_CONTRACT,
        type: 'shell',
        effect: { kind: 'repo-moved', from: m.from, to: m.to },
      });
  };

  const see = (line: string) => {
    let doc: unknown;

    try {
      doc = JSON.parse(line);
    } catch {
      return;
    }
    const frame = WatchFrame.safeParse(doc);

    if (!frame.success) return;
    const type = frame.data.event.type;

    if (replay !== undefined && type !== 'repo.moved' && type !== 'command.ran') return;
    // An event of a type this build does not know is no screen's.
    const event = Event.safeParse(frame.data.event);

    if (!event.success) return;
    if (replay !== undefined) {
      if (event.data.type === 'repo.moved') repoMoved(event.data.data, false);
      else if (event.data.type === 'command.ran' && event.data.data.tag === replay)
        replay = undefined;

      return;
    }
    // a Layer's or a theme file's change may move the look and the Feel's switches
    if (event.data.type === 'settings.changed') {
      sendLook();
      sendFeel();
    }
    if (event.data.type === 'repo.moved') repoMoved(event.data.data, true);
    if (
      event.data.type === 'command.ran' &&
      event.data.data.tag !== undefined &&
      ownReads.delete(event.data.data.tag)
    )
      return;
    feedAll({ kind: 'event', event: event.data });
  };

  const watch = async () => {
    for (let broke = false; !closed(); broke = true) {
      const mark = broke ? undefined : `watch-live:${String(Date.now())}`;
      const request = JSON.stringify({
        v: PROTOCOL,
        argv: mark === undefined ? ['watch'] : ['watch', '--since', '0'],
        cwd: o.cwd,
      });

      replay = mark;
      const reached = await withServe(
        async () => {
          const one = await follow(o.where.socket, request, see);

          return one.ok ? { ok: true as const, value: one.following } : one;
        },
        true,
        start,
        o,
      );

      // live once serve answered the mark sent after it: the screens' first reads, and what serve
      // says as it answers them (a repo it follows), come after; a mark never seen is let go
      if (reached.ok && mark !== undefined) {
        await ask(
          o.where.socket,
          JSON.stringify({ v: PROTOCOL, argv: ['help'], cwd: o.cwd, tag: mark }),
        );
        setTimeout(() => {
          if (replay === mark) replay = undefined;
        }, REPLAY_MS).unref();
      } else replay = undefined;
      firstTry.resolve(undefined);
      if (!reached.ok) {
        log(reached.printed.stdout.trim());
        await io.sleep(RECONNECT_MS);
        continue;
      }
      delete held.logged;
      held.following = reached.value;
      held.serving = true;
      if (closed()) reached.value.close();
      // Back after a break: what the screen read may be another serve's; read it again.
      if (broke) {
        held.kept.clear();
        // the kept reads' answers too: what is read again is this serve's
        queries = forgetQueries(queries);
        delete held.boardBehind;
        // one read of each fact for every screen opened anew; nothing of the serve before kept
        feedLive({ kind: 'reread', anew: true });
        for (const slot of SLOTS) {
          const was = held.slots[slot];

          if (was !== undefined) open(slot, was.name, was.params, true);
        }
        sendLook();
        sendFeel();
      }
      await reached.value.done;
      held.serving = false;
      if (!closed()) await io.sleep(RECONNECT_MS);
    }
  };

  /**
   * Fresh data: `abe fresh --follow` in the shown folder while the Factory view is shown
   * (serve looks at once, then every 2 min; its changes come on the watch), followed again after a
   * break, let go as the view or the folder changes.
   */
  const syncFresh = () => {
    const cwd = !closed() && held.window?.view === 'factory' ? (held.root ?? o.cwd) : undefined;

    if (held.fresh !== undefined && held.fresh.cwd === cwd && !held.fresh.closed) return;
    if (held.fresh !== undefined) {
      held.fresh.closed = true;
      held.fresh.following?.close();
      delete held.fresh;
    }
    if (cwd === undefined) return;
    const hold: FreshHold = { cwd, closed: false };
    const request = JSON.stringify({ v: PROTOCOL, argv: ['fresh', '--follow'], cwd });

    held.fresh = hold;
    void (async () => {
      // the first try at `abe watch` starts serve when none answers: never one of our own
      await firstTry.promise;
      // a serve that answers it with a reply (an older one, a refusal) is not asked again; one
      // that keeps dropping it is asked less and less often, at most every FRESH_RETRY_MAX_MS
      const said = { replied: false };
      // read through calls: the stream and `syncFresh` set them while this awaits
      const refused = () => said.replied;
      const goes = () => !hold.closed && !closed() && !refused();
      let wait = RECONNECT_MS;

      while (goes()) {
        // its frames are the watch's events too: the watch hands them to the screens
        const one = await follow(o.where.socket, request, (line) => {
          let doc: unknown;

          try {
            doc = JSON.parse(line);
          } catch {
            return;
          }
          if (Reply.safeParse(doc).success) said.replied = true;
        });
        const began = Date.now();

        if (one.ok) {
          hold.following = one.following;
          if (!goes()) one.following.close();
          await one.following.done;
        }
        if (refused())
          log(`abe fresh --follow refused in ${cwd}: outside changes show only after r`);
        // held a while: a break (serve went), followed again at once as the watch is
        wait =
          Date.now() - began > FRESH_RETRY_MAX_MS
            ? RECONNECT_MS
            : Math.min(wait * 2, FRESH_RETRY_MAX_MS);
        if (goes()) await io.sleep(wait);
      }
    })();
  };
  /** The window came to the front: a look now (one just asked: its answer). */
  let freshAsked = 0;
  const lookNow = () => {
    freshAsked += 1;
    const id = `fresh:${freshAsked}`;
    const where = held.root === undefined ? o : { ...o, cwd: held.root };

    ownReads.add(id);
    void firstTry.promise
      .then(() => answer({ id, argv: ['fresh'] }, false, where))
      .catch((err: unknown) => {
        log(String(err));
      });
  };

  const watching = watch();

  // The look and the Feel in force, once serve answers.
  sendLook();
  sendFeel();
  // The clock, for what a screen says of time (time in stage): every TICK_MS, and every second
  // while a screen open shows a clock by the second (a cloud launch's).
  let lastTick = Date.now();
  const ticker = setInterval(() => {
    const at = now();

    // a status line said a while ago fades, as WebStorm's do, an error's sooner
    if (held.status !== undefined && lineFaded(held.status, at)) clearStatus();
    const due = Date.now() - lastTick >= TICK_MS;
    const seconds = SLOTS.some((slot) => held.slots[slot]?.mounted.seconds() === true);

    if (!due && !seconds) return;
    lastTick = Date.now();
    feedAll({ kind: 'tick', at });
  }, SECOND_TICK_MS);

  for await (const line of io.lines) {
    if (line.trim() === '') continue;
    const read = readAppLine(line);

    if (read.ok) handle(withRealRoot(read.frame));
    else out({ v: UI_CONTRACT, type: 'error', error: read.error });
  }
  held.closed = true;
  clearInterval(ticker);
  held.following?.close();
  syncFresh();
  await watching;

  return EXIT.ok;
};
