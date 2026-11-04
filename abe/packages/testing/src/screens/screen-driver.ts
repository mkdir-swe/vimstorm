/**
 * One driver for a screen or a layer, routed the way serve's bridge routes them. A screen's
 * menus, confirms and dialogs go to Command mode mounted over it, and the rows Command mode hands
 * back go to the screen. Keys, clicks and text go to the top layer while one is up, and `:` or `?`
 * opens Command mode on what the screen's `here` says. A test sees the trees, the commands and the
 * shell effects, never the state, and answers a read by the argv the screen sent, so a screen can
 * rename its read ids without breaking a test.
 */
import {
  type Answer,
  answerQuery,
  askQuery,
  type Command,
  commandMode,
  type Here,
  type Input,
  type JumpTo,
  type LayerScreen,
  mount,
  mountLayer,
  withLive,
  type Node,
  noQueries,
  opensCommandMode,
  opensKeyHelp,
  queryKey,
  type Refused,
  type Screen,
  type ShellEffect,
  type ViewSize,
  type Word,
  WORDS,
} from '@abe/ui';

/** What a screen's tests read, so a test needs no import past its own folder's interface. */
export type { Answer, Command, Input, Refused, ShellEffect } from '@abe/ui';
/** The closed component set, a type and its schema, so a test can check a node it builds. */
export { Node } from '@abe/ui';

/** Every node of `tree`, depth first, the tree itself first. */
export const nodesOf = (tree: Node | undefined): Node[] =>
  tree === undefined
    ? []
    : [tree, ...('children' in tree ? (tree.children ?? []).flatMap((c) => nodesOf(c)) : [])];

/** The node with `id` in `tree`. Throws when there is none, so a test reads what it names. */
export const nodeById = (tree: Node | undefined, id: string): Node => {
  const found = nodesOf(tree).find((n) => n.id === id);

  if (found === undefined) throw new Error(`no ${id} in the tree`);

  return found;
};

/** A read, `abe <argv> --json`, asked and not answered yet. */
export type Asked = { readonly id: string; readonly argv: readonly string[] };

/** The answer to a read, picked by its argv. The driver gives it the read's id. Undefined leaves it asked. */
export type Replies = (asked: Asked) => Answer | Refused | undefined;

/**
 * One reply per command, keyed by the argv's first words, like `pipeline list`. The longest key
 * wins.
 */
export const repliesBy = (table: Readonly<Record<string, Answer | Refused | Replies>>): Replies => {
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);

  return (asked) => {
    const said = asked.argv.join(' ');
    const key = keys.find((k) => said === k || said.startsWith(`${k} `));
    const reply = key === undefined ? undefined : table[key];

    return typeof reply === 'function' ? reply(asked) : reply;
  };
};

export type Drive<T extends Node | undefined> = {
  /** The driven screen's tree, or the driven layer's top layer. */
  readonly tree: T;
  /** Command mode's top layer over the screen, undefined while none is up. */
  readonly layer: Node | undefined;
  /**
   * What the screen and Command mode asked since the last `take`, in order. Answered reads drop
   * out.
   */
  readonly commands: Command[];
  /** The shell effects among `commands`. */
  readonly effects: readonly ShellEffect[];
  /** The reads among `commands`. */
  readonly asked: readonly Asked[];
  /** What `:` and `?` start from on the screen, its `Screen.here`. */
  readonly here: Here | undefined;
  send: (...inputs: Input[]) => Drive<T>;
  keys: (...keys: string[]) => Drive<T>;
  click: (id: string) => Drive<T>;
  /** Each character as a key, and a space as `<Space>`. */
  type: (text: string) => Drive<T>;
  /** Answers every read asked with `replies`, the driver's by default, until none is left. */
  answer: (replies?: Replies) => Drive<T>;
  /**
   * A jump (Open workspace, Open card, ⌃L) as the bridge hands it on: on the story of the layer up, else the screen's
   * `linked`, to Command mode first, then to the screen unless it is ⌃L.
   */
  jump: (to: JumpTo) => Drive<T>;
  /** Returns `commands` and clears them. */
  take: () => Command[];
};

export type DriveOptions = {
  params?: Readonly<Record<string, string>>;
  size?: ViewSize;
  /** A `tick` at this time right after the screen opens. */
  now?: string;
  /** A `focus` right after it opens, so the screen has the keys. */
  focused?: boolean;
  /** What `answer()` answers by default. */
  replies?: Replies;
  /** Reads answered the moment they are asked. They never show in `commands`. */
  instant?: Replies;
  /** Command mode's words. Defaults to every screen's. */
  words?: readonly Word[];
};

const SIZE: ViewSize = { width: 1400, height: 760 };

type Target = {
  readonly tree: Node | undefined;
  readonly send: (input: Input) => Command[];
  /** The story its focus belongs to, `Screen.linked`. */
  readonly linked?: () => number | undefined;
};

/** A command held until answered; a kept read with its query's key (its argv where it was asked). */
type Held = { command: Command; by: Target; key?: string | undefined };

const personal = (input: Input) =>
  input.kind === 'key' || input.kind === 'click' || input.kind === 'text';

/**
 * Commands handed to Command mode, which draws and keys them. What it hands back goes to the
 * screen.
 */
const toLayer = (c: Command) =>
  c.kind === 'menu' ||
  c.kind === 'dialog' ||
  c.kind === 'confirm' ||
  c.kind === 'ask' ||
  c.kind === 'comment' ||
  c.kind === 'launch' ||
  c.kind === 'newcard';

const drive = <T extends Node | undefined>(
  target: Target,
  screen: (Target & { here: () => Here | undefined; typing: () => boolean }) | undefined,
  layer: Target | undefined,
  opening: readonly Command[],
  o: DriveOptions,
): Drive<T> => {
  let held: Held[] = [];
  /** The screen has the keys. Command mode takes them while a layer is up. */
  let focused = false;
  let under = false;
  /** The shown folder, as the bridge runs a read in it: a kept read's query is its argv there. */
  let root = o.params?.root;
  /** The kept reads' answers (`run` with `keep`), as the bridge holds them. */
  let queries = noQueries<Answer, Held>();

  const replyTo = (asked: Asked, replies: Replies | undefined): Answer | Refused | undefined => {
    const reply = replies?.(asked);

    return reply === undefined ? undefined : { ...reply, id: asked.id };
  };
  /** A read's answer landed: to its asker; a kept read's to everyone waiting on it, as the bridge does. */
  const land = (h: Held, reply: Answer | Refused) => {
    const key = h.key;

    if (key === undefined || h.command.kind !== 'run') {
      perform(h.by, h.by.send(reply));

      return;
    }
    const settled = answerQuery(
      queries,
      key,
      reply.command !== null && reply.reply.ok ? reply : undefined,
    );

    queries = settled.queries;
    for (const w of settled.waiting)
      if (w.command.kind === 'run') perform(w.by, w.by.send({ ...reply, id: w.command.id }));
    if (reply.command !== null)
      for (const w of settled.joined)
        if (w.command.kind === 'run')
          perform(w.by, w.by.send({ ...reply, id: w.command.id, cached: true }));
    // read again for those who asked while it was out: asked anew, under the first one's id
    const next = settled.again ? queries.byKey[key]?.waiting[0] : undefined;

    if (next !== undefined) held.push(next);
  };
  const perform = (by: Target, commands: readonly Command[]) => {
    for (const command of commands) {
      if (command.kind === 'run' && command.keep === true) {
        const h = { command, by, key: queryKey(command.argv, root) };
        const asked = askQuery(queries, h.key, h);

        queries = asked.queries;
        if (asked.held !== undefined)
          perform(by, by.send({ ...asked.held, id: command.id, cached: true }));
        if (!asked.read) continue;
        const now = o.instant?.(command);

        if (now !== undefined) land(h, { ...now, id: command.id });
        else held.push(h);
        continue;
      }
      if (command.kind === 'run') {
        const now = replyTo(command, o.instant);

        if (now !== undefined) {
          perform(by, by.send(now));
          continue;
        }
      }
      // a row Command mode hands back goes to the screen and, like an answer, leaves no trace. A
      // word's row for another `slot` is no screen's here.
      if (command.kind === 'choice' && by === layer && command.slot === undefined) {
        perform(target, target.send(command));
        continue;
      }
      held.push({ command, by });
      if (layer !== undefined && toLayer(command)) perform(layer, layer.send(command));
    }
  };
  /** As the bridge tells a screen where the keys went when a layer opened or closed over it. */
  const keysMoved = () => {
    const up = layer?.tree !== undefined;

    if (screen === undefined || layer === undefined) return;
    if (up && focused && !under) {
      under = true;
      perform(screen, screen.send({ kind: 'focus', focused: false, layer: true }));
    } else if (!up && under) {
      under = false;
      perform(screen, screen.send({ kind: 'focus', focused: true }));
    }
  };
  const one = (input: Input) => {
    if (input.kind === 'result') {
      // an answer sent by hand answers its read
      const at = held.findIndex((h) => h.command.kind === 'run' && h.command.id === input.id);
      const h = held[at];

      held = held.filter((_, i) => i !== at);
      if (h === undefined) perform(target, target.send(input));
      else land(h, input);

      return;
    }
    if (input.kind === 'root') root = input.root;
    // the window's measure of a dialog's page is Command mode's, which keeps the scroll within it
    if (input.kind === 'extent' && layer !== undefined) {
      perform(layer, layer.send(input));

      return;
    }
    if (input.kind === 'focus' && input.layer !== true) focused = input.focused;
    if (layer !== undefined && personal(input)) {
      const opens = (opensCommandMode(input) || opensKeyHelp(input)) && screen?.typing() !== true;

      if (layer.tree !== undefined || opens) {
        if (layer.tree === undefined)
          perform(layer, layer.send({ kind: 'here', here: screen?.here() ?? {}, serving: true }));
        perform(layer, layer.send(input));

        return;
      }
    }
    // the clock and `abe watch` reach an open layer too
    if (layer !== undefined && (input.kind === 'tick' || input.kind === 'event'))
      perform(layer, layer.send(input));
    perform(target, target.send(input));
  };

  const d: Drive<T> = {
    get tree() {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a screen's tree is a Node and a layer's may be none. `T` says which
      return target.tree as T;
    },
    get layer() {
      return layer?.tree;
    },
    get commands() {
      return held.map((h) => h.command);
    },
    get effects() {
      return held.flatMap((h) => (h.command.kind === 'shell' ? [h.command.effect] : []));
    },
    get asked() {
      return held.flatMap((h) =>
        h.command.kind === 'run' ? [{ id: h.command.id, argv: h.command.argv }] : [],
      );
    },
    get here() {
      return screen?.here();
    },
    send: (...inputs) => {
      for (const input of inputs) {
        one(input);
        keysMoved();
      }

      return d;
    },
    keys: (...keys) => d.send(...keys.map((key): Input => ({ kind: 'key', key }))),
    click: (id) => d.send({ kind: 'click', id }),
    type: (text) => d.keys(...Array.from(text, (c) => (c === ' ' ? '<Space>' : c))),
    answer: (replies = o.replies) => {
      for (let round = 0; round < 50; round += 1) {
        const answers = held.flatMap((h) => {
          if (h.command.kind !== 'run') return [];
          const reply = replyTo(h.command, replies);

          return reply === undefined ? [] : [{ h, reply }];
        });

        if (answers.length === 0) return d;
        held = held.filter((h) => !answers.some((a) => a.h === h));
        for (const { h, reply } of answers) {
          land(h, reply);
          keysMoved();
        }
      }

      return d;
    },
    jump: (to) => {
      const story = layer?.linked?.() ?? screen?.linked?.();

      if (story === undefined) return d;
      const jump: Input = { kind: 'jump', to, story };

      if (layer !== undefined) {
        perform(layer, layer.send(jump));
        keysMoved();
      }
      if (to !== 'linked') d.send(jump);

      return d;
    },
    take: () => {
      const out = held.map((h) => h.command);

      held = [];

      return out;
    },
  };

  perform(target, opening);
  if (o.now !== undefined) d.send({ kind: 'tick', at: o.now });
  if (o.focused !== undefined) d.send({ kind: 'focus', focused: o.focused });

  return d;
};

/**
 * `screen` opened with `o.params` at `o.size`, with Command mode over it. Then the clock at
 * `o.now` and the keys from `o.focused`, as the bridge tells a screen it just opened.
 */
export const driveScreen = <S>(screen: Screen<S>, o: DriveOptions = {}): Drive<Node> => {
  // the screen's live facts read and fed as the bridge does
  const opened = mount(withLive(screen), o.params ?? {}, o.size ?? SIZE);
  const m = opened.mounted;
  const layer = mountLayer(commandMode(o.words ?? WORDS));
  const target = {
    get tree(): Node {
      return m.tree;
    },
    send: m.send,
    here: m.here,
    typing: m.typing,
    linked: m.linked,
  };

  return drive<Node>(target, target, layer, opened.commands, o);
};

/** A layer, such as Command mode or the Settings dialog, mounted alone. Its view is the tree. */
export const driveLayer = <S>(
  layer: LayerScreen<S>,
  o: Omit<DriveOptions, 'words' | 'params' | 'size' | 'focused'> = {},
): Drive<Node | undefined> => {
  return drive<Node | undefined>(mountLayer(layer), undefined, undefined, [], o);
};
