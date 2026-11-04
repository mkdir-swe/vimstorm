/**
 * The `prototype` screen (Design B · Tiles): a prototype's tile's page in the main slot, opened by
 * the shell with `{id, page}` (⌃1 Preview, ⌃2 Code, ⌃3 Logs). It reads `prototype list` (its
 * state, preview link, last screenshot) and on Code and Logs `prototype show` (the diff by file,
 * the screenshots, the app's output, what the proxy refused), again as the prototype moves
 * (`prototype.state`, `prototype.refused`, a `prototype` command ran) and Logs on every tick.
 *
 * Preview draws the app live through its proxy (a BrowserView in `app` mode: it reaches that
 * origin and its WebSockets only), or on a repo's fixed ports the app itself as a browser would
 * (`open` mode, ADR 0041: its backend, its sign-in provider), at a viewport (Fit · 1280 · 768 ·
 * 390, a device frame at 390); ⏎ gives it the keys, Esc in it always gives them back (the shell's). Starting the app… lists
 * its steps; a failed start its last lines and ⏎ asks the prototype to fix it; a stopped one shows
 * its last screenshot and ⏎ starts it again. The keys: `r` reload, `R` restart the app, `v` the next
 * viewport, `o` open in the browser, `m` Make card… (asked of its session), `s` stop the app,
 * `d` Discard… (asked, Cancel the default), ⌘⏎ its menu; on Code `l ö` the files, ⏎ opens one.
 * The Chat column beside it is the prototype's session (the shell opens it).
 */
import { type Event, type PrototypeData, type PrototypeShowData } from '@abe/core';
import { type Node } from '../runtime/components';
import { type BrowserView } from '../runtime/browser';
import { type ViewSize } from '../runtime/protocol';
import { type Command, type Here, type Input, type Menu, type Screen } from '../runtime/runtime';
import { statusLine } from '../runtime/held';
import { lookState, prototypeName } from './prototype-look';
import {
  type ProtoAction,
  type ProtoBody,
  type PrototypePage,
  VIEWPORTS,
  type Viewport,
} from './prototype-components';

export const PROTOTYPE_SCREEN = 'prototype';

export const PAGES = ['preview', 'code', 'logs'] as const;
export type ProtoPage = (typeof PAGES)[number];

export type PrototypeState = {
  id?: string | undefined;
  page: ProtoPage;
  size?: ViewSize | undefined;
  now?: string | undefined;
  /** `prototype list`, and whether a read is out. */
  prototypes?: PrototypeData[] | undefined;
  listing: boolean;
  /** `prototype show` of `id` (Code, Logs), whether a read is out, why it failed. */
  show?: PrototypeShowData | undefined;
  showing: boolean;
  showFailed?: string | undefined;
  viewport: Viewport;
  /** Counted up by Reload: the page loads again. */
  reload: number;
  /** The page has the keys (⏎; Esc in it gives them back). */
  keys: boolean;
  /** The path the page last loaded (its `loaded` event). */
  path?: string | undefined;
  /** Code's selected file. */
  file: number;
};

const INIT: PrototypeState = {
  page: 'preview',
  listing: false,
  showing: false,
  viewport: 'fit',
  reload: 0,
  keys: false,
  file: 0,
};

type Out = { state: PrototypeState; commands: Command[] };

const LIST = 'proto-list';
const SHOW = 'proto-show';
const ACT = 'proto-act:';
const MENU = 'prototype';

const none = (state: PrototypeState): Out => ({ state, commands: [] });

/** The prototype the screen is on, as last read. */
export const shownOf = (s: Pick<PrototypeState, 'id' | 'prototypes'>): PrototypeData | undefined =>
  s.prototypes?.find((p) => p.id === s.id);

const readList = (s: PrototypeState): Out =>
  s.listing
    ? none(s)
    : {
        state: { ...s, listing: true },
        commands: [{ kind: 'run', id: LIST, argv: ['prototype', 'list'] }],
      };

const readShow = (s: PrototypeState): Out =>
  s.showing || s.id === undefined || s.page === 'preview'
    ? none(s)
    : {
        state: { ...s, showing: true },
        commands: [{ kind: 'run', id: SHOW, argv: ['prototype', 'show', '--id', s.id] }],
      };

const both = (s: PrototypeState): Out => {
  const a = readList(s);
  const b = readShow(a.state);

  return { state: b.state, commands: [...a.commands, ...b.commands] };
};

/** `abe <argv>` on the shown prototype, its refusal a balloon. */
const act = (s: PrototypeState, verb: string, argv: string[], said?: string): Out => ({
  state: s,
  commands: [
    ...(said === undefined ? [] : [statusLine(said)]),
    { kind: 'run', id: `${ACT}${verb}`, argv },
  ],
});

const idArgs = (s: PrototypeState): string[] => (s.id === undefined ? [] : ['--id', s.id]);

/** What its session is asked by Make card…: the prototype skill makes it. */
export const MAKE_CARD_ASK =
  'Make this prototype a card: a title and a description of what we tried and what it should do, then abe prototype make-card.';

/** What its session is asked by Ask the prototype to fix: why the app did not start. */
export const fixAsk = (reason: string | null): string =>
  `The app did not start. ${reason ?? ''}`.trim() + '\nFix it so it starts, then say so.';

const send = (s: PrototypeState, text: string, said: string): Out => {
  const session = shownOf(s)?.code?.session;

  return session === undefined
    ? { state: s, commands: [statusLine('This prototype has no session to ask')] }
    : act(s, 'send', ['session', 'send', session, text], said);
};

const restart = (s: PrototypeState): Out =>
  act(s, 'restart', ['prototype', 'restart', ...idArgs(s)], 'Starting the app…');

const stop = (s: PrototypeState): Out =>
  act(s, 'stop', ['prototype', 'stop', ...idArgs(s)], 'Stopping the app…');

const discard = (s: PrototypeState): Out => {
  const p = shownOf(s);

  if (p === undefined) return none(s);
  const db = p.database === null ? '' : ` and database ${p.database.name}`;

  return {
    state: s,
    commands: [
      {
        kind: 'confirm',
        question: `Discard “${prototypeName(p, {})}”?`,
        details: [
          `Removes branch ${p.code?.branch ?? p.branch}, its worktree${db}. Nothing was pushed. Screenshots go too.`,
        ],
        yes: 'Discard',
        no: 'Cancel',
        danger: true,
        argv: ['prototype', 'discard', p.id],
        done: 'Discarded',
      },
    ],
  };
};

const openInBrowser = (s: PrototypeState): Out => {
  const url = shownOf(s)?.url ?? null;

  return url === null
    ? { state: s, commands: [statusLine('Its app does not run: nothing to open')] }
    : {
        state: s,
        commands: [{ kind: 'shell', effect: { kind: 'open-url', url: `${url}${s.path ?? ''}` } }],
      };
};

const nextViewport = (v: Viewport): Viewport =>
  VIEWPORTS[(VIEWPORTS.indexOf(v) + 1) % VIEWPORTS.length] ?? 'fit';

/** ⏎ on the Preview: the live app takes the keys, a stopped one starts, a failed one is asked to fix. */
const enter = (s: PrototypeState): Out => {
  const p = shownOf(s);

  if (p === undefined) return none(s);
  if (s.page === 'code') return openFile(s);
  if (s.page !== 'preview') return none(s);
  if (p.state === 'live' && p.url !== null) return none({ ...s, keys: true });
  if (p.state === 'stopped') return restart(s);
  if (p.state === 'failed') return send(s, fixAsk(p.reason), 'Asked the prototype to fix it');

  return none(s);
};

/** ⏎ on a Code file: opened in the editor (a box's worktree is not here). */
const openFile = (s: PrototypeState): Out => {
  const p = shownOf(s);
  const f = s.show?.files[s.file];

  if (p?.code === undefined || p.code === null || f === undefined) return none(s);
  if (p.code.box !== null)
    return { state: s, commands: [statusLine(`${f.path} is on ${p.code.box}`)] };

  return {
    state: s,
    commands: [
      { kind: 'shell', effect: { kind: 'open-file', path: `${p.code.worktree}/${f.path}` } },
    ],
  };
};

/** The prototype's ⌘⏎ menu (and its tile's right-click, through its clicks). */
export const prototypeMenu = (s: PrototypeState): Menu | undefined => {
  const p = shownOf(s);

  if (p === undefined) return undefined;
  const back = { kind: 'back' } as const;
  const live = p.state === 'live' && p.url !== null;

  return {
    kind: 'menu',
    id: MENU,
    title: `Prototype · ${prototypeName(p, {})}`,
    rows: [
      ...(live
        ? [
            { id: 'preview', text: 'Preview', key: '⏎', does: back },
            { id: 'open', text: 'Open in browser', key: 'o', does: back },
            { id: 'reload', text: 'Reload', key: 'r', does: back },
          ]
        : []),
      { id: 'restart', text: live ? 'Restart app' : 'Start app', key: 'R', does: back },
      { id: 'make-card', text: 'Make card…', key: 'm', separator: true, does: back },
      ...(live ? [{ id: 'stop', text: 'Stop app', key: 's', separator: true, does: back }] : []),
      {
        id: 'discard',
        text: 'Discard…',
        key: 'd',
        risky: true,
        separator: !live,
        does: back,
      },
    ],
  };
};

/** A click or a menu row: what it names. */
const onAction = (s: PrototypeState, what: string): Out => {
  if (what.startsWith('viewport:')) {
    const v = what.slice('viewport:'.length);
    const viewport = VIEWPORTS.find((x) => x === v);

    return viewport === undefined ? none(s) : none({ ...s, viewport });
  }
  if (what.startsWith('file:')) {
    const n = Number(what.slice('file:'.length));

    return Number.isInteger(n) && n >= 0 ? none({ ...s, file: n }) : none(s);
  }
  switch (what) {
    case 'preview':
      return enter(s);
    case 'open':
      return openInBrowser(s);
    case 'reload':
      return none({ ...s, reload: s.reload + 1 });
    case 'restart':
    case 'start':
      return restart(s);
    case 'stop':
      return stop(s);
    case 'make-card':
      return send(s, MAKE_CARD_ASK, 'Asked the prototype to make a card · its answer is in Chat');
    case 'fix':
      return send(s, fixAsk(shownOf(s)?.reason ?? null), 'Asked the prototype to fix it');
    case 'discard':
      return discard(s);
    default:
      return none(s);
  }
};

const onKey = (s: PrototypeState, key: string): Out => {
  const files = s.show?.files.length ?? 0;

  switch (key) {
    case '<CR>':
      return enter(s);
    case '<Esc>':
      return s.keys
        ? none({ ...s, keys: false })
        : {
            state: s,
            commands: [{ kind: 'shell', effect: { kind: 'unhandled', slot: 'main', key } }],
          };
    case '<D-CR>': {
      const menu = prototypeMenu(s);

      return { state: s, commands: menu === undefined ? [] : [menu] };
    }
    case 'r':
      return none({ ...s, reload: s.reload + 1 });
    case 'R':
      return restart(s);
    case 'v':
      return none({ ...s, viewport: nextViewport(s.viewport) });
    case 'o':
      return openInBrowser(s);
    case 'm':
      return onAction(s, 'make-card');
    case 's':
      return stop(s);
    case 'd':
      return discard(s);
    case 'l':
    case '<Up>':
      return s.page === 'code' ? none({ ...s, file: Math.max(0, s.file - 1) }) : none(s);
    case 'ö':
    case '<Down>':
      return s.page === 'code'
        ? none({ ...s, file: Math.min(Math.max(0, files - 1), s.file + 1) })
        : none(s);
    default:
      return none(s);
  }
};

const opened = (s: PrototypeState, params: Readonly<Record<string, string>>, size: ViewSize) => {
  const id = params.id ?? s.id;
  const page = PAGES.find((p) => p === params.page) ?? 'preview';
  const same = id === s.id;
  const next: PrototypeState = {
    ...s,
    id,
    page,
    size,
    keys: false,
    ...(same ? {} : { path: undefined, file: 0, show: undefined, showFailed: undefined }),
  };

  return both(next);
};

const onAnswer = (s: PrototypeState, input: Extract<Input, { kind: 'result' }>): Out => {
  if (input.id === LIST) {
    const next = { ...s, listing: false };

    return input.command === 'prototype list' && input.reply.ok
      ? none({ ...next, prototypes: input.reply.data.prototypes })
      : none(next);
  }
  if (input.id === SHOW) {
    const next = { ...s, showing: false };

    if (input.command === 'prototype show' && input.reply.ok) {
      // another prototype's answer (the tile moved meanwhile) is not this one's
      if (input.reply.data.id !== s.id) return readShow(next);
      const file = Math.min(s.file, Math.max(0, input.reply.data.files.length - 1));

      return none({ ...next, show: input.reply.data, showFailed: undefined, file });
    }

    return none({
      ...next,
      showFailed: input.reply.ok ? undefined : input.reply.error.message,
    });
  }
  if (input.id.startsWith(ACT)) {
    const refusal = input.reply.ok
      ? []
      : [
          statusLine(''),
          {
            kind: 'shell' as const,
            effect: {
              kind: 'balloon' as const,
              tone: 'error' as const,
              text: `${input.reply.error.message} (${input.reply.error.code})`,
            },
          },
        ];
    const read = both(s);

    return { state: read.state, commands: [...refusal, ...read.commands] };
  }

  return none(s);
};

const step = (s: PrototypeState, input: Input): Out => {
  switch (input.kind) {
    case 'open':
      return opened(s, input.params, input.size);
    case 'resize':
      return none({ ...s, size: input.size });
    case 'tick':
      return s.page === 'logs' ? readShow({ ...s, now: input.at }) : none({ ...s, now: input.at });
    case 'result':
      return onAnswer(s, input);
    case 'event': {
      const e = input.event;

      if (e.type === 'prototype.state' || e.type === 'prototype.refused') return both(s);
      if (e.type === 'command.ran' && e.data.noun === 'prototype' && e.data.verb !== 'list')
        return e.data.verb === 'show' ? none(s) : both(s);

      return none(s);
    }
    case 'browser': {
      const ev = input.event;

      if (ev.kind === 'focus') return none({ ...s, keys: ev.focused });
      if (ev.kind === 'loaded') return none({ ...s, path: pathOf(ev.url) });

      return none(s);
    }
    case 'focus':
      return input.focused ? none(s) : none({ ...s, keys: false });
    case 'key':
      return onKey(s, input.key);
    case 'click':
      return input.id.startsWith('proto:') ? onAction(s, input.id.slice('proto:'.length)) : none(s);
    case 'choice':
      return input.menu === MENU ? onAction(s, input.row) : none(s);
    default:
      return none(s);
  }
};

/** `http://127.0.0.1:41207/products?x#y` → `/products?x#y`. */
export const pathOf = (url: string): string => {
  const m = /^[a-z]+:\/\/[^/?#]+(.*)$/i.exec(url);
  const rest = m?.[1] ?? '';

  return rest === '' ? '/' : rest;
};

const hostOf = (url: string | null): string => (url ?? '').replace(/^[a-z]+:\/\//i, '');

/** `12 min`, `2 h`, `3 days` since `at`, at `now`. */
export const agoText = (at: string, now: string | undefined): string => {
  const ms = Date.parse(now ?? at) - Date.parse(at);
  const min = Math.max(0, Math.round(ms / 60_000));

  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;

  return `${Math.round(min / (24 * 60))} days ago`;
};

const WIDTH: Readonly<Record<Viewport, number | null>> = {
  fit: null,
  '1280': 1280,
  '768': 768,
  '390': 390,
};

const LABEL: Readonly<Record<Viewport, string>> = {
  fit: 'Fit',
  '1280': '1280',
  '768': '768',
  '390': '390',
};

const action = (id: string, label: string, keys: string, primary = false): ProtoAction => ({
  id: `proto:${id}`,
  label,
  keys,
  ...(primary ? { primary: true } : {}),
});

/** A failed start's reason as its title's hint and its last lines. */
export const failedLines = (reason: string | null): { hint: string; lines: string[] } => {
  const [head = '', tail = ''] = (reason ?? '').split('; its last lines:\n');

  return { hint: head, lines: tail === '' ? [] : tail.split('\n') };
};

/** Where a start is, as Starting the app… lists it. */
export const startSteps = (p: PrototypeData): Extract<ProtoBody, { kind: 'starting' }>['steps'] => {
  const done = { mark: '✓', hue: 'good' } as const;
  const now = { mark: '●', hue: 'warn' } as const;
  const todo = { mark: '○', hue: 'dim' } as const;
  const atStart = p.step === 'start';
  const db =
    p.database === null
      ? 'its database'
      : `database ${p.database.name}${p.database.seeded ? ', seeded' : ''}`;

  if (p.code?.box !== null && p.code?.box !== undefined)
    return [
      { ...done, text: `workspace ${p.code.branch} on ${p.code.box}` },
      { ...now, text: 'its session starts the app · the port forwarded once it listens' },
      { ...todo, text: 'load the page' },
    ];

  return [
    { ...done, text: `worktree ${p.code?.branch ?? p.branch}` },
    { ...(atStart ? done : now), text: db },
    { ...(atStart ? now : todo), text: 'app starting · its start script' },
    { ...todo, text: 'load the page' },
  ];
};

const previewBody = (s: PrototypeState, p: PrototypeData): ProtoBody => {
  const name = prototypeName(p, {});

  switch (p.state) {
    case 'live':
      return p.url === null
        ? {
            kind: 'starting',
            title: 'Waiting for its port…',
            steps: startSteps(p),
            note: 'Its app runs on the box: the preview shows once its port is forwarded here.',
          }
        : { kind: 'live', width: WIDTH[s.viewport], phone: s.viewport === '390', keys: s.keys };
    case 'starting':
      return {
        kind: 'starting',
        title: 'Starting the app…',
        steps: startSteps(p),
        note: 'What you type in Chat waits for it.',
      };
    case 'failed': {
      const f = failedLines(p.reason);

      return {
        kind: 'failed',
        title: 'The app did not start',
        lines: f.lines,
        hint: f.hint === '' ? `${name}: its start failed` : f.hint,
        actions: [
          action('fix', 'Ask the prototype to fix', '⏎', true),
          action('restart', 'Restart', 'R'),
        ],
      };
    }
    case 'stopped':
      return {
        kind: 'stopped',
        title: `Stopped ${agoText(p.since, s.now)}`,
        shot: p.shot ?? '',
        line: [
          p.shot === null ? 'no screenshot yet' : 'last screenshot',
          ...(p.database === null ? [] : [`database ${p.database.name} kept`]),
        ].join(' · '),
        actions: [action('start', 'Start', '⏎', true), action('discard', 'Discard…', 'd')],
      };
  }
};

const codeBody = (s: PrototypeState): ProtoBody => {
  const show = s.show;

  if (show === undefined)
    return {
      kind: 'code',
      files: [],
      lines: [],
      shots: [],
      note: s.showFailed ?? 'Reading its changes…',
    };
  const files = show.files.map((f, n) => ({
    id: `proto:file:${n}`,
    path: f.path,
    added: f.added,
    removed: f.removed,
    selected: n === s.file,
  }));
  const more = show.cut === 0 ? [] : [`${show.cut} more files`];
  const note =
    show.noDiff ??
    (files.length === 0
      ? 'No changes yet · proto/… is never pushed'
      : [
          `${files.length + show.cut} files · never pushed`,
          ...more,
          'l ö the files · ⏎ opens one',
        ].join(' · '));

  return {
    kind: 'code',
    files,
    lines: show.files[s.file]?.lines ?? [],
    shots: show.screenshots.map((x) => ({
      id: `proto:shot:${x.n}`,
      path: x.path,
      what: x.what,
    })),
    note,
  };
};

const logsBody = (s: PrototypeState): ProtoBody => {
  const show = s.show;

  if (show === undefined)
    return { kind: 'logs', log: [], refused: [], note: s.showFailed ?? 'Reading its output…' };

  return {
    kind: 'logs',
    log: show.log,
    refused: show.refused.map((r) => `${r.at.slice(11, 19)}  ${r.method} ${r.host} · ${r.reason}`),
    note:
      show.log.length === 0
        ? 'No output yet · on a box its session keeps the app’s'
        : `its start script · its last ${show.log.length} lines`,
  };
};

const view = (s: PrototypeState): Node => {
  const p = shownOf(s);
  const page = (body: ProtoBody, extra: Partial<PrototypePage> = {}): PrototypePage => ({
    kind: 'PrototypePage',
    id: 'prototype-page',
    props: { page: s.page, body },
    ...extra,
  });

  if (p === undefined)
    return page(
      s.prototypes === undefined
        ? { kind: 'starting', title: 'Reading the prototype…', steps: [], note: '' }
        : {
            kind: 'stopped',
            title: 'This prototype is gone',
            shot: '',
            line: 'Discarded, or not this serve’s: its tile goes with the next read',
            actions: [],
          },
    );
  if (s.page === 'code') return page(codeBody(s));
  if (s.page === 'logs') return page(logsBody(s));
  const body = previewBody(s, p);
  const bar: PrototypePage['props']['bar'] = {
    host: hostOf(p.url ?? p.app),
    path: s.path ?? '/',
    viewports: VIEWPORTS.map((v) => ({
      id: `proto:viewport:${v}`,
      label: LABEL[v],
      on: v === s.viewport,
    })),
    reload: 'proto:reload',
    open: 'proto:open',
    actions: [action('make-card', 'Make card', 'm')],
  };
  const browser: BrowserView | undefined =
    body.kind === 'live' && p.url !== null
      ? {
          kind: 'BrowserView',
          id: 'prototype-preview',
          props: {
            key: `prototype:${p.id}`,
            url: p.url,
            // the person's own app on its ports opens as in their browser; the proxy's stays in
            mode: p.ports.length > 0 ? 'open' : 'app',
            bare: true,
            reload: s.reload,
            title: 'Preview',
            focused: s.keys,
          },
        }
      : undefined;

  return {
    ...page(body),
    props: { page: s.page, bar, body },
    ...(browser === undefined ? {} : { children: [browser] }),
  };
};

const here = (s: PrototypeState): Here => {
  const p = shownOf(s);
  const menu = prototypeMenu(s);

  return {
    keys: 'prototype',
    ...(p === undefined
      ? {}
      : {
          subject: {
            caption: `Prototype · ${prototypeName(p, {})}`,
            label: prototypeName(p, {}),
            ask: p.card === null ? [] : ['--card', String(p.card)],
            ...(menu === undefined ? {} : { menu }),
          },
        }),
  };
};

/** Its state word, as the tile's hover says it. */
export const stateWord = (p: Pick<PrototypeData, 'state'>): string => {
  const words = { running: 'Running', starting: 'Starting', failed: 'Failed', stopped: 'Stopped' };

  return words[lookState(p)];
};

/** The watch's events it takes: its prototype's moves; any other never re-views it. */
const PROTOTYPE_EVENTS: ReadonlySet<Event['type']> = new Set([
  'command.ran',
  'prototype.state',
  'prototype.refused',
]);

export const prototypeScreen: Screen<PrototypeState> = {
  events: PROTOTYPE_EVENTS,
  name: PROTOTYPE_SCREEN,
  init: INIT,
  step,
  view,
  linked: (s) => shownOf(s)?.card ?? undefined,
  // the viewport, the reload count and what was read stay for the next visit
  keep: (s) => ({ ...s, listing: false, showing: false, keys: false }),
  here,
};
