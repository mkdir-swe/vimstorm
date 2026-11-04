/**
 * The PR review in the Git Log (the `review` slot): the PR under review in a checkout, read with
 * `abe review show`, its files pane's listing, folds, cursor and scope (`review-model.ts`), and
 * what its keys, its menu, the strip, the Submit review dialog and the diff's `,i` keys ask. The
 * writes are `abe review …` commands; what they say goes to the status line, and for the diff's
 * keys as a balloon in the diff (`review-said`). One screen holds every PR under review, by its
 * checkout and number; the app opens the shown one (`open {pr, path}`), and `open {pick}` the Git
 * Log's `PR ⌄` pick. VimStorm's Git tool window draws the `ReviewPane` it sends.
 */
import type {
  Drafts,
  Event,
  Marks,
  ReviewPr,
  ReviewPrsData,
  ReviewRead,
  ReviewShowData,
} from '@abe/core';
import { empty, type Node } from '../runtime/components';
import type { PrPickRow, ReviewAsk } from './review-asks';
import type { PaneLine, ReviewPaneNode, ReviewPaneProps, Strip } from './review-components';
import {
  CHANGES_START,
  type Change,
  changeAt,
  changesScreen,
  type ChangesScreen,
  type ChangesView,
  endOfChanges,
  type FileRow,
  markFocus,
  moveCursor,
  nextChange,
  nextListing,
  nextUnreviewed,
  NOTHING_LEFT,
  plural,
  pointAt,
  reveal,
  scopeTo,
  sideways,
  stepCommit,
  toggleFold,
} from './review-model';
import type { Answer, Command, Input, Refused, Screen } from '../runtime/runtime';

export type Tone = 'info' | 'ok' | 'warn' | 'error';

type Pane = {
  key: string;
  number: number;
  /** The checkout it is reviewed in (the main checkout when it could not be checked out). */
  path: string;
  /** Why it is not checked out: its files are GitHub's, ⏎ cannot open them. */
  unchecked: string | null;
  show: ReviewShowData | null;
  failed: string | null;
  view: ChangesView;
  /** The marks as last written here (shown at once), else as read. */
  marks: Marks | null;
  drafts: Drafts;
  /** What it said last, while no write runs. */
  said: { text: string; tone: Tone } | null;
  /** The run whose read is shown, and the newest mark asked: an older answer changes neither. */
  readAt: number;
  markAt: number;
  /** When it last asked GitHub what moved (the clock's ms; 0: not since it was opened). */
  polledAt: number;
  /** Comments GitHub had that were not shown, since the person last looked ("N new"). */
  unseen: number;
};

/** What a run's answer is for. */
type Run = {
  pane: string;
  what: 'show' | 'drafts' | 'mark' | 'write' | 'reread' | 'open' | 'prs' | 'poll';
  /** Its answer goes to the diff as a balloon too. */
  echo: boolean;
  /** A mark's marks before it, put back when it fails. */
  before?: Marks | null;
  /** An outdated draft a rewrite replaces: deleted once the new one is kept. */
  replaces?: number;
  /** Read the PR again once it answered (a write GitHub saw). */
  reread?: boolean;
  /** A read the poll asked: what it brings that was not shown counts as new. */
  polled?: boolean;
  /** Its place among the runs asked (1, 2, …). */
  n?: number;
};

export type ReviewState = {
  panes: Readonly<Record<string, Pane>>;
  current: string | null;
  /** By heat (else by folder), remembered across reviews. */
  heat: boolean;
  seq: number;
  runs: Readonly<Record<string, Run>>;
  /** The Git Log's PR pick asked, in this checkout. */
  pick: { path: string; repo: string | null } | null;
  /** The clock's last tick (RFC 3339): how long ago things were said. */
  now: string | null;
};

export const REVIEW_INIT: ReviewState = {
  panes: {},
  current: null,
  heat: true,
  seq: 0,
  runs: {},
  pick: null,
  now: null,
};

type Out = { state: ReviewState; commands: Command[] };

const keyOf = (path: string, number: number) => `${path}#${number}`;

const sha8 = (sha: string) => sha.slice(0, 8);
const short = (sha: string) => sha.slice(0, 7);

const status = (text: string): Command => ({ kind: 'shell', effect: { kind: 'status', text } });

/** A run with its context kept until it answers. */
const run = (s: ReviewState, r: Run, argv: string[]): Out => {
  const id = `review:${s.seq + 1}`;

  return {
    state: { ...s, seq: s.seq + 1, runs: { ...s.runs, [id]: { ...r, n: s.seq + 1 } } },
    commands: [{ kind: 'run', id, argv }],
  };
};

const withPane = (s: ReviewState, p: Pane): ReviewState => ({
  ...s,
  panes: { ...s.panes, [p.key]: p },
});

const and = (a: Out, more: (s: ReviewState) => Out): Out => {
  const b = more(a.state);

  return { state: b.state, commands: [...a.commands, ...b.commands] };
};

/** `pane` says `text` (the status line; the diff too when `echo`). */
const say = (s: ReviewState, p: Pane, text: string, tone: Tone, echo: boolean): Out => ({
  state: withPane(s, { ...p, said: { text, tone } }),
  commands: [
    status(text),
    ...(echo
      ? [
          {
            kind: 'shell' as const,
            effect: { kind: 'review-said' as const, root: p.path, text, tone },
          },
        ]
      : []),
  ],
});

const showArgv = (p: Pane) => [
  'review',
  'show',
  String(p.number),
  `--path=${p.path}`,
  ...(p.unchecked === null ? [] : [`--unchecked=${p.unchecked}`]),
];

const reading = (s: ReviewState, p: Pane, polled = false): Out =>
  run(
    s,
    { pane: p.key, what: 'show', echo: false, ...(polled ? { polled: true } : {}) },
    showArgv(p),
  );

/**
 * How often the shown PR asks GitHub what moved (`abe review pr`: one read, its `updatedAt`);
 * only a change reads it all again. Well inside gh's hourly limit.
 */
export const POLL_MS = 45_000;

/** The comments `next` has that `before` did not show (the "N new" mark): on lines and on the conversation. */
const newComments = (before: ReviewShowData, next: ReviewShowData): number => {
  const seen = new Set((before.threads ?? []).flatMap((t) => t.comments.map((c) => c.id)));
  const said = new Set((before.pr.conversation ?? []).map((c) => `${c.kind} ${c.author} ${c.at}`));

  return (
    (next.threads ?? []).flatMap((t) => t.comments).filter((c) => !seen.has(c.id)).length +
    (next.pr.conversation ?? []).filter((c) => !said.has(`${c.kind} ${c.author} ${c.at}`)).length
  );
};

/** The pane's runs still out: a poll waits for them. */
const busy = (s: ReviewState, key: string) => Object.values(s.runs).some((r) => r.pane === key);

/** The clock: the shown PR asks GitHub what moved, every `POLL_MS` (none while a run is out). */
const onTick = (s0: ReviewState, at: string): Out => {
  const s = { ...s0, now: at };
  const p = s.current === null ? undefined : s.panes[s.current];
  const now = Date.parse(at);

  if (p === undefined || p.show === null || Number.isNaN(now)) return { state: s, commands: [] };
  // the first tick since it was opened starts the count
  if (p.polledAt === 0) return { state: withPane(s, { ...p, polledAt: now }), commands: [] };
  if (now - p.polledAt < POLL_MS || busy(s, p.key)) return { state: s, commands: [] };

  return run(withPane(s, { ...p, polledAt: now }), { pane: p.key, what: 'poll', echo: false }, [
    'review',
    'pr',
    String(p.number),
    `--path=${p.path}`,
  ]);
};

/** Read Again (`r`, the strip's ⟳, the menu's): the PR read again, the "N new" mark seen. */
const readAgain = (s: ReviewState, p: Pane): Out => {
  const seen = { ...p, unseen: 0 };

  return reading(withPane(s, seen), seen);
};

// ---- the screen over a pane ----

const screenOf = (p: Pane): { read: ReviewRead; screen: ChangesScreen } | undefined =>
  p.show === null
    ? undefined
    : { read: p.show.read, screen: changesScreen(p.show.read, p.marks, p.view) };

const setView = (s: ReviewState, p: Pane, view: ChangesView): Out => ({
  state: withPane(s, { ...p, view }),
  commands: [],
});

/** The change in VimStorm's diff viewer: the files ⏎ walks, the scope's two sides, its line. */
const showChange = (s: ReviewState, p: Pane, change: Change): Out => {
  const at = screenOf(p);

  if (at === undefined || p.show === null) return { state: s, commands: [] };
  if (p.unchecked !== null)
    return say(s, p, 'Not checked out here: ⏎ cannot open the diff', 'warn', false);
  const { read, screen } = at;
  const commit = screen.commitIndex === null ? undefined : read.commits[screen.commitIndex];
  const through = screen.throughIndex === null ? undefined : read.commits[screen.throughIndex];
  const [base, head] =
    commit === undefined
      ? [read.base ?? '', read.head]
      : [`${commit.sha}^`, (through ?? commit).sha];
  const index = screen.steps.findIndex((r) => r.path === change.row.path);
  const next = withPane(s, { ...p, view: reveal(p.view, change.row, change.hunk) });

  return {
    state: next,
    commands: [
      {
        kind: 'shell',
        effect: {
          kind: 'show-diff',
          root: p.path,
          files: screen.steps.map((r) => ({
            path: r.diffPath,
            ...(r.diffPrevious === null ? {} : { oldPath: r.diffPrevious }),
            status: r.diffStatus,
          })),
          index: index < 0 ? 1 : index + 1,
          base,
          head,
          line: Math.max(1, change.line),
          pr: { number: p.number, head: read.head },
        },
      },
    ],
  };
};

/** ⏎ / ⇧⏎: the next or previous change, file after file. */
const step = (s: ReviewState, p: Pane, dir: 1 | -1, echo = false): Out => {
  const at = screenOf(p);

  if (at === undefined) return { state: s, commands: [] };
  const change = nextChange(at.screen, dir);

  return change === undefined
    ? say(s, p, endOfChanges(dir), 'info', echo)
    : showChange(s, p, change);
};

/** `n` / `p` (`,in`): the next or previous file not reviewed, by heat, at its first change. */
const byHeat = (s: ReviewState, p: Pane, dir: 1 | -1, echo = false): Out => {
  const at = screenOf(p);

  if (at === undefined) return { state: s, commands: [] };
  const row = nextUnreviewed(at.screen, dir);

  return row === undefined
    ? say(s, p, NOTHING_LEFT, 'ok', echo)
    : showChange(s, p, changeAt(row, 0));
};

/** Space (with copies): the cursor's marks written, shown at once, put back when it fails. */
const mark = (s: ReviewState, p: Pane, copies: boolean): Out => {
  const at = screenOf(p);

  if (at === undefined || p.show === null) return { state: s, commands: [] };
  const marking = markFocus(at.screen, at.read, copies);

  if (marking === undefined) return { state: s, commands: [] };
  const read = at.read;
  const kept: Marks['marks'] = {};

  for (const [path, m] of Object.entries(p.marks?.marks ?? {}))
    if (!marking.paths.includes(path)) kept[path] = m;
  if (marking.on)
    for (const f of read.files)
      if (marking.paths.includes(f.path)) kept[f.path] = { hash: f.hash, head: read.head };
  const shown: Marks = {
    ...p.marks,
    head: read.head,
    paths: read.files.map((f) => f.path),
    marks: kept,
  };
  const said = say(
    withPane(s, { ...p, marks: shown }),
    { ...p, marks: shown },
    marking.said,
    marking.tone,
    false,
  );

  return and(said, (next) =>
    run(markedAt(next, p.key), { pane: p.key, what: 'mark', echo: false, before: p.marks }, [
      'review',
      'mark',
      String(p.number),
      `--path=${p.path}`,
      ...marking.paths.flatMap((f) => [`--file=${f}`]),
      ...(marking.on ? [] : ['--off']),
      ...(p.unchecked === null ? [] : ['--unchecked']),
    ]),
  );
};

/** The pane's newest mark is the run about to be asked. */
const markedAt = (s: ReviewState, key: string): ReviewState => {
  const p = s.panes[key];

  return p === undefined ? s : withPane(s, { ...p, markAt: s.seq + 1 });
};

const reviewArgv = (p: Pane, verb: string, ...more: string[]) => [
  'review',
  verb,
  String(p.number),
  `--path=${p.path}`,
  ...more,
];

/** A write: its saying on the status line while it runs, its answer said when it comes. */
const write = (
  s: ReviewState,
  p: Pane,
  argv: string[],
  saying: string,
  o: { echo?: boolean; replaces?: number; reread?: boolean } = {},
): Out =>
  and(
    {
      state: withPane(s, { ...p, said: { text: saying, tone: 'info' } }),
      commands: [status(saying)],
    },
    (next) =>
      run(
        next,
        {
          pane: p.key,
          what: 'write',
          echo: o.echo === true,
          ...(o.replaces === undefined ? {} : { replaces: o.replaces }),
          ...(o.reread === true ? { reread: true } : {}),
        },
        argv,
      ),
  );

const VERDICT_WORD = {
  APPROVE: 'approve',
  REQUEST_CHANGES: 'request-changes',
  COMMENT: 'comment',
} as const;

const SAVED_VERDICT = {
  Approve: 'APPROVE',
  RequestChanges: 'REQUEST_CHANGES',
  Comment: 'COMMENT',
} as const;

/** The files pane's line of `path`, in the screen as it is. */
const lineOf = (screen: ChangesScreen, path: string) =>
  screen.lines.findIndex((l) => l.kind === 'file' && l.row.path === path);

/** The commits `dir` away from the strip's scope (‹ -1, › 1): none is all changes; out of range none. */
const stepped = (screen: ChangesScreen, read: ReviewRead, dir: 1 | -1): string[] | undefined => {
  const place = screen.throughIndex ?? screen.commitIndex;
  const to = (place === null ? 0 : place + 1) + dir;

  if (to < 0 || to > read.commits.length) return undefined;
  const sha = read.commits[to - 1]?.sha;

  return to === 0 || sha === undefined ? [] : [sha];
};

/** The PR's state that keeps a merge back, in a few words; none when it may merge. */
export const firstBlocker = (pr: ReviewPr): string | undefined => {
  if (pr.draft) return 'draft';
  if (pr.checks.failing.length > 0) return `checks failing: ${pr.checks.failing.join(', ')}`;
  if (pr.checks.running) return 'checks still running';
  if (pr.decision === 'changes') return 'changes asked';
  if (pr.decision === 'required') return 'not approved yet';
  if (pr.mergeable === 'conflicting' || pr.mergeState === 'dirty')
    return `conflicts with ${pr.base}`;
  if (pr.mergeState === 'behind') return `behind ${pr.base}: update branch first`;
  if (pr.mergeState === 'blocked') return 'blocked by branch rules';

  return undefined;
};

type Lifecycle = { id: string; title: string; reason: string | null };

const METHOD = {
  'merge-squash': 'squash',
  'merge-commit': 'merge',
  'merge-rebase': 'rebase',
} as const;

/** The PR's lifecycle rows, grey with why (the first reason that holds). */
export const lifecycleRows = (pr: ReviewPr): Lifecycle[] => {
  const ended = pr.state === 'open' ? null : pr.state;
  const row = (
    id: string,
    title: string,
    ...reasons: (string | null | undefined)[]
  ): Lifecycle => ({
    id,
    title,
    reason: [ended, ...reasons].find((r) => r !== null && r !== undefined) ?? null,
  });
  const approval = pr.decision === null || pr.decision === 'approved' ? null : 'needs approval';
  const merge = (id: keyof typeof METHOD, how: string) =>
    row(id, `Merge into ${pr.base} (${how})`, approval, firstBlocker(pr));

  return [
    row('review-ready', 'Mark ready for review', pr.draft ? null : 'already ready for review'),
    merge('merge-squash', 'squash'),
    merge('merge-commit', 'merge commit'),
    merge('merge-rebase', 'rebase'),
    row('pr-close', 'Close without merging'),
  ];
};

const lifecycle = (s: ReviewState, p: Pane, id: string): Out => {
  const pr = p.show?.pr;

  if (pr === undefined) return { state: s, commands: [] };
  const r = lifecycleRows(pr).find((x) => x.id === id);

  if (r === undefined) return { state: s, commands: [] };
  if (r.reason !== null) return say(s, p, r.reason, 'warn', false);
  const n = pr.number;

  if (id === 'review-ready')
    return write(s, p, reviewArgv(p, 'ready'), `Marking PR #${n} ready for review…`, {
      reread: true,
    });
  if (id === 'pr-close')
    return {
      state: s,
      commands: [
        {
          kind: 'confirm',
          argv: reviewArgv(p, 'close'),
          question: `Close PR #${n} without merging?`,
          details: [pr.title, `${pr.branch} → ${pr.base}`, 'It closes unmerged; its branch stays.'],
          yes: 'Yes, close',
          done: `PR #${n} closed without merging`,
        },
      ],
    };
  const method = Object.entries(METHOD).find(([k]) => k === id)?.[1];

  if (method === undefined) return { state: s, commands: [] };

  return {
    state: s,
    commands: [
      {
        kind: 'confirm',
        argv: ['pr', 'merge', `${pr.repo}#${n}`, '--method', method, '--sha', pr.head],
        question: `${r.title}: merge PR #${n}?`,
        details: [
          pr.title,
          `${pr.branch} → ${pr.base}`,
          `On its head ${short(pr.head)}; repository rules apply.`,
        ],
        yes: 'Merge',
        done: `PR #${n} merged into ${pr.base}`,
      },
    ],
  };
};

/** The files pane's right-click menu on the cursor's row: every pane key, grey where it can't. */
const menuRows = (p: Pane, screen: ChangesScreen | undefined, read: ReviewRead | undefined) => {
  const node = screen?.node !== null && screen?.node !== undefined;
  const since = read?.since !== null && read?.since !== undefined;
  const commits = (read?.commits.length ?? 0) > 0;
  const path = screen?.row?.path;
  const draft =
    path !== undefined && p.drafts.drafts.some((d) => d.sent === undefined && d.path === path);
  const item = (run: string, label: string, enabled = true) => ({
    run,
    key: run === '⏎' ? '⏎' : '',
    label,
    enabled,
  });

  return [
    item('⏎', node ? 'Expand / Collapse' : 'Next Change'),
    item('step-back', 'Previous Change'),
    item('next', 'Next File by Heat'),
    item('previous', 'Previous File by Heat'),
    item('select', 'Mark Reviewed'),
    item('with-copies', 'Mark Reviewed with Copies'),
    item('drop', 'Drop Draft', draft),
    item('toggle', 'Tree / Areas / Heat'),
    item('whole', p.view.whole ? 'Show Since Your Review' : 'Show the Whole PR', since),
    item('earlier', 'Previous Commit', commits),
    item('later', 'Next Commit', commits),
    item('browser', 'Open on GitHub'),
    item('refresh', 'Read Again'),
  ];
};

/** ⏎ on the cursor: a node folds, a file steps into its next change. */
const enter = (s: ReviewState, p: Pane): Out => {
  const at = screenOf(p);

  if (at === undefined) return { state: s, commands: [] };
  const node = at.screen.node;

  return node === null
    ? step(s, p, 1)
    : setView(s, p, { ...p.view, toggled: toggleFold(p.view, node.key) });
};

const onMenu = (s: ReviewState, p: Pane, name: string): Out => {
  const at = screenOf(p);

  if (at === undefined) return { state: s, commands: [] };
  const { read, screen } = at;

  switch (name) {
    case '⏎':
      return enter(s, p);
    case 'step-back':
      return step(s, p, -1);
    case 'next':
      return byHeat(s, p, 1);
    case 'previous':
      return byHeat(s, p, -1);
    case 'select':
      return mark(s, p, false);
    case 'with-copies':
      return mark(s, p, true);
    case 'drop': {
      const path = screen.row?.path;

      return path === undefined
        ? { state: s, commands: [] }
        : write(s, p, reviewArgv(p, 'drop-draft', `--file=${path}`), 'Dropping the draft…');
    }
    case 'toggle':
      return setView(s, p, { ...p.view, list: nextListing(p.view.list), node: null });
    case 'whole':
      return read.since === null
        ? { state: s, commands: [] }
        : setView(s, p, { ...p.view, whole: !p.view.whole });
    case 'earlier':
    case 'later': {
      const view = stepCommit(screen, read, p.view, name === 'later' ? 1 : -1);

      return typeof view === 'string' ? say(s, p, view, 'info', false) : setView(s, p, view);
    }
    case 'browser':
      return p.show === null
        ? { state: s, commands: [] }
        : {
            state: s,
            commands: [{ kind: 'shell', effect: { kind: 'open-url', url: p.show.pr.url } }],
          };
    case 'refresh':
      return readAgain(s, p);
    // the checks chip: the Pipelines tab on the PR branch's newest run (its jobs and log)
    case 'checks':
      return p.show === null
        ? { state: s, commands: [] }
        : {
            state: s,
            commands: [
              {
                kind: 'open',
                screen: 'pipelines',
                params: { runBranch: p.show.pr.branch },
                slot: 'pane',
              },
              { kind: 'shell', effect: { kind: 'show', place: 'pipelines' } },
            ],
          };
    default:
      return { state: s, commands: [] };
  }
};

const onKey = (s: ReviewState, p: Pane, key: string): Out => {
  const at = screenOf(p);

  if (at === undefined) return { state: s, commands: [] };
  const { screen } = at;
  const moved = (delta: number) => setView(s, p, moveCursor(screen, p.view, delta));

  switch (key) {
    case 'l':
    case '<Up>':
      return moved(-1);
    case 'ö':
    case '<Down>':
      return moved(1);
    case '<PageUp>':
      return moved(-10);
    case '<PageDown>':
      return moved(10);
    case 'k':
    case '<Left>':
      return setView(s, p, sideways(screen, p.view, -1));
    case 'ä':
    case '<Right>':
      return setView(s, p, sideways(screen, p.view, 1));
    case '<CR>':
      return enter(s, p);
    case '<S-CR>':
      return step(s, p, -1);
    case '<Space>':
      return mark(s, p, false);
    case 'r':
      return readAgain(s, p);
    default:
      return { state: s, commands: [] };
  }
};

const onAsk = (s: ReviewState, ask: ReviewAsk): Out => {
  if (ask.kind === 'pick') {
    const pick = s.pick;

    return pick === null
      ? { state: s, commands: [] }
      : run({ ...s, pick: null }, { pane: '', what: 'open', echo: false }, [
          'review',
          'open',
          String(ask.number),
          `--path=${pick.path}`,
        ]);
  }
  const p = s.current === null ? undefined : s.panes[s.current];

  if (p === undefined) return { state: s, commands: [] };
  const at = screenOf(p);

  switch (ask.kind) {
    case 'comment': {
      if (p.show === null) return { state: s, commands: [] };
      if (ask.body.trim() === '') return { state: s, commands: [] };
      const argv = reviewArgv(
        p,
        'draft',
        `--file=${ask.path}`,
        '--side',
        ask.side,
        '--line',
        String(ask.line),
        ...(ask.start === undefined ? [] : ['--start', String(ask.start)]),
        `--body=${ask.body}`,
        '--base',
        ask.base,
        '--head',
        ask.head,
        ...(ask.now === true ? ['--now'] : []),
      );

      return write(
        s,
        p,
        argv,
        ask.now === true ? 'Saving comment before checking PR revision…' : 'Saving the draft…',
        {
          echo: true,
          ...(ask.replaces === undefined ? {} : { replaces: ask.replaces }),
          ...(ask.now === true ? { reread: true } : {}),
        },
      );
    }
    case 'say':
      return ask.body.trim() === ''
        ? { state: s, commands: [] }
        : write(s, p, reviewArgv(p, 'say', `--body=${ask.body}`), 'Posting the comment…', {
            echo: false,
            reread: true,
          });
    case 'reply':
      return ask.body.trim() === ''
        ? { state: s, commands: [] }
        : write(
            s,
            p,
            reviewArgv(p, 'reply', '--thread', ask.thread, `--body=${ask.body}`),
            'Saving reply before publication…',
            {
              echo: true,
              reread: true,
            },
          );
    case 'resolve':
      return write(
        s,
        p,
        reviewArgv(p, 'resolve', '--thread', ask.thread, ...(ask.resolved ? [] : ['--reopen'])),
        'Updating discussion…',
        { echo: true, reread: true },
      );
    case 'edit':
      return write(
        s,
        p,
        reviewArgv(p, 'edit-draft', '--seq', String(ask.seq), `--body=${ask.body}`),
        'Saving the drafts…',
        {
          echo: true,
        },
      );
    case 'delete':
      return write(
        s,
        p,
        reviewArgv(p, 'drop-draft', '--seq', String(ask.seq)),
        'Saving the drafts…',
      );
    case 'verdict': {
      if (p.show === null) return { state: s, commands: [] };

      return write(
        s,
        p,
        reviewArgv(
          p,
          'submit',
          '--verdict',
          VERDICT_WORD[ask.verdict],
          `--body=${ask.body}`,
          '--read',
          p.show.read.head,
        ),
        `Reading PR #${p.number}'s head…`,
        { echo: true, reread: true },
      );
    }
    case 'next':
      return byHeat(s, p, 1, true);
    case 'at': {
      if (at === undefined) return { state: s, commands: [] };
      const next = setView(s, p, pointAt(at.screen, p.view, ask.line));
      const moved = next.state.panes[p.key];

      return ask.open === true && moved !== undefined ? and(next, (n) => enter(n, moved)) : next;
    }
    case 'scope':
      return at === undefined
        ? { state: s, commands: [] }
        : setView(s, p, scopeTo(at.read, p.view, ask.commits));
    case 'rescope': {
      if (at === undefined) return { state: s, commands: [] };
      const view = scopeTo(at.read, p.view, ask.commits);
      const scoped = { ...p, view };
      const there = screenOf(scoped);
      const line = there === undefined ? -1 : lineOf(there.screen, ask.path);

      if (there === undefined || line < 0) return setView(s, p, view);
      const pointed = { ...scoped, view: pointAt(there.screen, view, line) };

      return step(withPane(s, pointed), pointed, 1);
    }
    case 'step': {
      if (at === undefined) return { state: s, commands: [] };
      const commits = stepped(at.screen, at.read, ask.dir);

      return commits === undefined
        ? { state: s, commands: [] }
        : setView(s, p, scopeTo(at.read, p.view, commits));
    }
    case 'order': {
      const list = ask.heat ? 'ranked' : 'tree';
      const next = { ...s, heat: ask.heat };

      return list === p.view.list
        ? { state: next, commands: [] }
        : setView(next, p, { ...p.view, list, node: null });
    }
    case 'mark': {
      if (at === undefined) return { state: s, commands: [] };
      const line = lineOf(at.screen, ask.path);

      if (line < 0) return { state: s, commands: [] };
      const pointed = { ...p, view: pointAt(at.screen, p.view, line) };

      return mark(withPane(s, pointed), pointed, false);
    }
    case 'menu':
      return onMenu(s, p, ask.run);
    case 'lifecycle':
      return lifecycle(s, p, ask.id);
  }
};

/** The words the pane says over its files once read (1.x's: the count, where, what waits). */
const paneSaid = (p: Pane, show: ReviewShowData): string => {
  const read = show.read;
  const at = read.head === show.pr.head ? p.path : `${p.path} · checkout at ${short(read.head)}`;
  const note =
    p.unchecked === null
      ? at
      : `not checked out (${p.unchecked}): files from GitHub, ⏎ cannot open them`;
  const waiting = p.drafts.drafts.filter((d) => d.sent === undefined);
  const outdated = waiting.filter((d) => d.head !== read.head).length;

  return [
    `${plural(read.files.length, 'file')} · ${note}`,
    ...(show.pr.head === read.head
      ? []
      : [`New PR revision ${short(show.pr.head)} available; reviewing ${short(read.head)}`]),
    ...(outdated > 0 ? [`${outdated} outdated draft comments kept`] : []),
    ...(waiting.length > 0 ? [`✎ ${plural(waiting.length, 'draft')}`] : []),
  ].join(' · ');
};

const onResult = (s: ReviewState, input: Answer | Refused): Out => {
  const r = s.runs[input.id];

  if (r === undefined) return { state: s, commands: [] };
  const rest = {
    ...s,
    runs: Object.fromEntries(Object.entries(s.runs).filter(([id]) => id !== input.id)),
  };

  if (r.what === 'prs') {
    if (s.pick === null) return { state: rest, commands: [] };
    if (!input.reply.ok)
      return {
        state: { ...rest, pick: null },
        commands: [
          {
            kind: 'shell',
            effect: { kind: 'balloon', tone: 'error', text: input.reply.error.message },
          },
        ],
      };
    if (input.command !== 'review prs') return { state: rest, commands: [] };
    const data = input.reply.data;

    return {
      state: { ...rest, pick: { ...s.pick, repo: data.repo } },
      commands: [
        {
          kind: 'shell',
          effect: { kind: 'pr-pick', root: s.pick.path, repo: data.repo, rows: pickRows(data) },
        },
      ],
    };
  }
  if (r.what === 'open') {
    if (!input.reply.ok)
      return {
        state: rest,
        commands: [
          {
            kind: 'shell',
            effect: { kind: 'balloon', tone: 'error', text: input.reply.error.message },
          },
        ],
      };
    if (input.command !== 'review open') return { state: rest, commands: [] };
    const o = input.reply.data;

    return {
      state: rest,
      commands: [
        {
          kind: 'shell',
          effect: {
            kind: 'review-open',
            path: o.path,
            repo: o.repo,
            number: o.number,
            unchecked: o.unchecked,
          },
        },
        status(
          o.unchecked === null
            ? `PR #${o.number} · VimStorm ← ${o.path}`
            : `✗ PR #${o.number} not checked out: ${o.unchecked} · files from GitHub`,
        ),
      ],
    };
  }
  const p = rest.panes[r.pane];

  if (p === undefined) return { state: rest, commands: [] };
  if (r.what === 'show') {
    if (!input.reply.ok)
      return { state: withPane(rest, { ...p, failed: input.reply.error.message }), commands: [] };
    if (input.command !== 'review show') return { state: rest, commands: [] };
    // a read asked before the one shown answered late: the newer stays
    if ((r.n ?? 0) < p.readAt) return { state: rest, commands: [] };
    const show = input.reply.data;
    const fresh = r.polled === true && p.show !== null ? newComments(p.show, show) : 0;

    return {
      state: withPane(rest, {
        ...p,
        show,
        failed: null,
        marks: show.marks,
        drafts: show.drafts,
        readAt: r.n ?? 0,
        unseen: p.unseen + fresh,
      }),
      commands: [],
    };
  }
  if (r.what === 'poll') {
    if (!input.reply.ok || input.command !== 'review pr' || p.show === null)
      return { state: rest, commands: [] };
    const pr = input.reply.data.pr;
    const was = p.show.pr;
    const moved =
      pr.head !== was.head ||
      pr.updatedAt === undefined ||
      was.updatedAt === undefined ||
      pr.updatedAt !== was.updatedAt;

    // nothing moved: the checks as they are now; else the whole PR read again
    return moved
      ? reading(rest, p, true)
      : { state: withPane(rest, { ...p, show: { ...p.show, pr } }), commands: [] };
  }
  if (r.what === 'mark') {
    // a later mark asked meanwhile: its marks stay shown
    if ((r.n ?? 0) !== p.markAt) return { state: rest, commands: [] };
    if (input.reply.ok) {
      return input.command === 'review mark'
        ? { state: withPane(rest, { ...p, marks: input.reply.data.marks }), commands: [] }
        : { state: rest, commands: [] };
    }

    // the mark shown at once goes again
    return say(
      withPane(rest, { ...p, marks: r.before ?? null }),
      { ...p, marks: r.before ?? null },
      `✗ ${input.reply.error.message}`,
      'error',
      false,
    );
  }
  if (r.what === 'drafts' || r.what === 'reread') {
    if (!input.reply.ok || input.command !== 'review drafts') return { state: rest, commands: [] };

    return { state: withPane(rest, { ...p, drafts: input.reply.data.drafts }), commands: [] };
  }
  // a write's answer
  if (!input.reply.ok) {
    const tone: Tone = input.reply.error.code === 'review-refused' ? 'warn' : 'error';
    const said = say(rest, { ...p, said: null }, input.reply.error.message, tone, r.echo);

    // what it kept meanwhile (a draft posted now, a reply) is read again
    return and(said, (next) =>
      run(next, { pane: p.key, what: 'drafts', echo: false }, reviewArgv(p, 'drafts')),
    );
  }
  if (
    input.command === 'review resolve' ||
    input.command === 'review ready' ||
    input.command === 'review say'
  ) {
    const said = say(rest, p, input.reply.data.said, 'ok', r.echo);

    return r.reread === true ? and(said, (next) => reread(next, p.key)) : said;
  }
  if (
    input.command === 'review draft' ||
    input.command === 'review edit-draft' ||
    input.command === 'review drop-draft' ||
    input.command === 'review submit' ||
    input.command === 'review reply'
  ) {
    const grew = input.reply.data.drafts.drafts.length > p.drafts.drafts.length;
    const kept = { ...p, drafts: input.reply.data.drafts };
    let out = say(withPane(rest, kept), kept, input.reply.data.said, 'ok', r.echo);

    // a rewrite: the outdated draft goes once the new one is kept
    if (r.replaces !== undefined && grew) {
      const replaces = r.replaces;

      out = and(out, (next) =>
        run(
          next,
          { pane: p.key, what: 'write', echo: false },
          reviewArgv(p, 'drop-draft', '--seq', String(replaces)),
        ),
      );
    }

    return r.reread === true ? and(out, (next) => reread(next, p.key)) : out;
  }

  return { state: rest, commands: [] };
};

/** The pane's PR read again (a write GitHub saw), quietly: what is shown stays meanwhile. */
const reread = (s: ReviewState, key: string): Out => {
  const p = s.panes[key];

  return p === undefined ? { state: s, commands: [] } : reading(s, p);
};

const draftWord = (draft: boolean) => (draft ? 'Draft' : 'Open');

/** The PR pick's rows: mine first (with their branch), then the others (with their author). */
export const pickRows = (data: ReviewPrsData): PrPickRow[] => {
  const me = data.me;
  const prs = [...data.prs].sort((a, b) => b.number - a.number);
  const row = (p: ReviewPrsData['prs'][number], detail: string): PrPickRow => ({
    number: p.number,
    label: `#${p.number} ${p.title}   ${detail}`,
    note: me !== null && p.requested.includes(me) ? 'Review requested' : draftWord(p.draft),
  });
  const mine = prs.filter((p) => me !== null && p.author === me);
  const others = prs.filter((p) => !(me !== null && p.author === me));

  return [
    ...(mine.length === 0 ? [] : [{ caption: 'Mine' }, ...mine.map((p) => row(p, p.branch))]),
    ...(others.length === 0 ? [] : [{ caption: 'Others' }, ...others.map((p) => row(p, p.author))]),
  ];
};

const onOpen = (s: ReviewState, params: Readonly<Record<string, string>>): Out => {
  const pick = params.pick;

  if (pick !== undefined && pick !== '')
    return run({ ...s, pick: { path: pick, repo: null } }, { pane: '', what: 'prs', echo: false }, [
      'review',
      'prs',
      `--path=${pick}`,
    ]);
  const number = Number(params.pr ?? '');
  const path = params.path ?? '';

  if (!Number.isInteger(number) || number <= 0 || path === '')
    return { state: { ...s, current: null }, commands: [] };
  const key = keyOf(path, number);
  const heat = params.list === undefined ? s.heat : params.list === 'heat';
  const had = s.panes[key];
  const unchecked =
    params.unchecked === undefined || params.unchecked === '' ? null : params.unchecked;

  // shown again: what is kept stays shown, read again quietly (a push or a comment meanwhile)
  if (had?.unchecked === unchecked) {
    const back = { ...s, current: key };

    return busy(s, key) ? { state: back, commands: [] } : reading(back, had);
  }
  const p: Pane = {
    key,
    number,
    path,
    unchecked,
    show: null,
    failed: null,
    view: { ...CHANGES_START, list: heat ? 'ranked' : 'tree' },
    marks: null,
    drafts: { drafts: [] },
    said: null,
    readAt: 0,
    markAt: 0,
    polledAt: 0,
    unseen: 0,
  };

  return reading({ ...withPane(s, p), current: key, heat }, p);
};

export const reviewStep = (s: ReviewState, input: Input): Out => {
  switch (input.kind) {
    case 'open':
      return onOpen(s, input.params);
    case 'result':
      return onResult(s, input);
    case 'tick':
      return onTick(s, input.at);
    case 'review':
      return onAsk(s, input.ask);
    case 'key': {
      const p = s.current === null ? undefined : s.panes[s.current];

      if (p === undefined) return { state: s, commands: [] };
      // a key in the pane: what was new has been seen
      const seen = p.unseen === 0 ? p : { ...p, unseen: 0 };

      return onKey(p === seen ? s : withPane(s, seen), seen, input.key);
    }
    case 'event': {
      const e = input.event;
      const p = s.current === null ? undefined : s.panes[s.current];

      // a merge or a close Command mode ran on its yes: the PR read again
      if (
        p !== undefined &&
        e.type === 'command.ran' &&
        e.data.exit === 0 &&
        ((e.data.noun === 'pr' && e.data.verb === 'merge') ||
          (e.data.noun === 'review' && e.data.verb === 'close'))
      )
        return reading(s, p);

      return { state: s, commands: [] };
    }
    default:
      return { state: s, commands: [] };
  }
};

// ---- the view ----

/** Each reviewer's last verdict (a dismissal clears it), in the order they gave them. */
const reviewsOf = (pr: ReviewPr): Strip['reviews'] => {
  const last = new Map<string, 'approved' | 'changes'>();

  for (const c of pr.conversation ?? []) {
    if (c.kind === 'approved' || c.kind === 'changes') {
      last.delete(c.author);
      last.set(c.author, c.kind);
    } else if (c.kind === 'dismissed') last.delete(c.author);
  }
  if (last.size === 0) return null;
  const said = [...last].map(([who, v]) =>
    v === 'approved' ? `✓ ${who} approved` : `✗ ${who} requested changes`,
  );

  return {
    label: said.join(' · '),
    hue: [...last.values()].includes('changes') ? 'bad' : 'good',
  };
};

/** How long ago `at` was, from `now` (both RFC 3339): `just now`, `5 min ago`, `3 h ago`, `2 d ago`. */
export const ago = (at: string, now: string | null): string => {
  const t = Date.parse(at);
  const n = now === null ? NaN : Date.parse(now);

  if (Number.isNaN(t)) return '';
  if (Number.isNaN(n)) return at.slice(0, 10);
  const min = Math.floor((n - t) / 60_000);

  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`;

  return `${Math.floor(min / (24 * 60))} d ago`;
};

const checksOf = (pr: ReviewPr): Strip['checks'] => {
  const c = pr.checks;

  if (c.total === 0) return null;
  // a check still running is said beside a failure, never hidden by it
  if (c.failed > 0)
    return {
      label: `✗ ${c.failed} failed${c.running ? ` · ● ${c.total - c.passed - c.failed} running` : ''}`,
      hue: 'bad',
    };
  if (c.passed === c.total) return { label: `✓ ${plural(c.total, 'check')}`, hue: 'good' };

  return { label: `● ${c.passed}/${c.total} checks`, hue: 'warn' };
};

const stripOf = (
  show: ReviewShowData,
  screen: ChangesScreen,
  drafted: ReviewPaneProps['drafted'],
  unseen: number,
  now: string | null,
): Strip => {
  const { pr, read } = show;
  const n = read.commits.length;
  const commit = screen.commitIndex === null ? undefined : read.commits[screen.commitIndex];
  const through = screen.throughIndex === null ? undefined : read.commits[screen.throughIndex];
  let scope: Strip['scope'] = { kind: 'all' };
  let scopeLabel = 'All changes';
  let scopeSub = plural(n, 'commit');
  let switchLabel = 'All changes';

  if (
    commit !== undefined &&
    through !== undefined &&
    screen.commitIndex !== null &&
    screen.throughIndex !== null
  ) {
    const [from, to] = [screen.commitIndex + 1, screen.throughIndex + 1];

    scope = { kind: 'range', from, to, fromSha: commit.sha, toSha: through.sha };
    scopeLabel = `Commits ${from}–${to} of ${n}`;
    scopeSub = `${sha8(commit.sha)}…${sha8(through.sha)}`;
    switchLabel = scopeLabel;
  } else if (commit !== undefined && screen.commitIndex !== null) {
    const place = screen.commitIndex + 1;

    scope = { kind: 'commit', place, sha: commit.sha };
    scopeLabel = `Commit ${place}/${n}`;
    scopeSub = sha8(commit.sha);
    switchLabel = `Commit ${place}/${n} · ${sha8(commit.sha)}`;
  }
  const threads = show.threads ?? [];
  const unresolved = threads.filter((t) => !t.resolved).length;
  const outdated = drafted.filter((d) => d.outdated).length;
  const open: Strip['badge'] = pr.draft ? 'draft' : 'open';
  const badge: Strip['badge'] = pr.state === 'open' ? open : pr.state;
  const rows = screen.model.rows;
  const reviewed = rows.filter((r) => r.reviewed).length;
  const filesLabel =
    outdated > 0
      ? `✗ ${outdated} outdated draft${outdated === 1 ? '' : 's'} block${outdated === 1 ? 's' : ''} Submit review`
      : [
          `${plural(rows.length, 'file')} · ${reviewed} reviewed`,
          ...(drafted.length > 0 ? [plural(drafted.length, 'draft')] : []),
        ].join(' · ');

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    branch: pr.branch,
    base: pr.base,
    body: pr.body,
    badge,
    checks: checksOf(pr),
    threads:
      threads.length === 0
        ? null
        : {
            label: `${plural(threads.length, 'thread')} · ${unresolved} open`,
            open: unresolved > 0,
          },
    outdated,
    own: show.me !== null && show.me === pr.author,
    drafts: drafted.length,
    scope,
    scopeLabel,
    scopeSub,
    switchLabel,
    commits: read.commits.map((c) => ({
      sha: c.sha,
      subject: c.subject,
      author: c.author,
      date: ago(c.date, now) || c.date,
      files: c.files.map((f) => ({
        path: f.finalPath ?? f.path,
        additions: f.additions,
        deletions: f.deletions,
      })),
    })),
    baseSha: read.base ?? '',
    headSha: read.head,
    newRevision: pr.head === read.head ? null : pr.head,
    reviews: reviewsOf(pr),
    fresh: unseen > 0 ? `${unseen} new` : null,
    files: rows.length,
    reviewed,
    additions: rows.reduce((n, r) => n + r.additions, 0),
    deletions: rows.reduce((n, r) => n + r.deletions, 0),
    filesLabel,
    canSubmit: outdated === 0 && (badge === 'open' || badge === 'draft'),
  };
};

const linesOf = (
  p: Pane,
  screen: ChangesScreen,
  show: ReviewShowData,
  drafted: ReviewPaneProps['drafted'],
): PaneLine[] =>
  screen.lines.map((l): PaneLine => {
    if (l.kind === 'band' || l.kind === 'gap') return { kind: l.kind };
    if (l.kind === 'node') {
      const inPr = l.node.rows.filter((r) => r.inPr);
      const files = plural(l.node.rows.length, 'file');

      return {
        kind: 'node',
        key: l.node.key,
        node: l.node.node,
        label: l.node.label,
        depth: l.node.depth,
        open: l.node.open,
        count: l.node.node === 'group' ? `${files} · not ranked` : files,
        reviewed: inPr.length > 0 && inPr.every((r) => r.reviewed),
      };
    }
    const row: FileRow = l.row;
    const mine = drafted.filter((d) => d.path === row.path);

    return {
      kind: 'file',
      path: row.path,
      label: l.label,
      depth: l.depth,
      status: row.status,
      heat: row.score === null ? '·' : String(row.score),
      flat: p.view.list === 'ranked' && l.label === row.path,
      reviewed: row.reviewed,
      additions: row.additions,
      deletions: row.deletions,
      changes: row.heads.length,
      hunk: screen.row?.path === row.path ? screen.hunk : null,
      threads: (show.threads ?? []).filter((t) => t.path === row.path).length,
      drafts: mine.length,
      outdated: mine.some((d) => d.outdated),
    };
  });

const threadsNote = (show: ReviewShowData | null): string | null => {
  if (show === null) return 'Loading discussions…';

  return show.threads === null
    ? `Discussions unavailable: ${show.threadsError ?? 'not read'}`
    : null;
};

export const reviewView = (s: ReviewState): Node => {
  const p = s.current === null ? undefined : s.panes[s.current];

  if (p === undefined) return empty('PR review', 'No pull request under review');
  const show = p.show;
  const at = screenOf(p);
  const read = show?.read;
  const drafted = p.drafts.drafts
    .filter((d) => d.sent === undefined)
    .map((d) => ({
      seq: d.seq,
      path: d.path,
      side: d.line.side,
      line: d.line.line,
      body: d.body,
      head: d.head ?? null,
      outdated: d.head !== read?.head,
    }));
  const reply =
    p.drafts.reply !== undefined && !p.drafts.reply.confirmed ? p.drafts.reply : undefined;
  let said = `Reading PR #${p.number}…`;
  let tone: Tone = 'info';

  if (p.failed !== null && show === null) {
    said = p.failed;
    tone = 'error';
  } else if (show !== null) said = paneSaid(p, show);
  if (reply?.error !== null && reply?.error !== undefined) {
    said = `Reply retained in Discussions: ${reply.error}`;
    tone = 'error';
  }
  const props: ReviewPaneProps = {
    root: p.path,
    number: p.number,
    title: `PR #${p.number} · review`,
    said,
    tone,
    heat: p.view.list === 'ranked',
    since: at?.screen.scope.since ?? false,
    lines: at === undefined || show === null ? [] : linesOf(p, at.screen, show, drafted),
    at: at?.screen.at ?? null,
    drafted,
    threads: (show?.threads ?? []).map((t) => ({
      ...t,
      reply:
        reply?.thread === t.id
          ? { body: reply.body, unconfirmed: reply.attempted, error: reply.error ?? null }
          : null,
    })),
    threadsNote: threadsNote(show),
    saved:
      p.drafts.review === undefined
        ? null
        : {
            head: p.drafts.review.head,
            verdict: SAVED_VERDICT[p.drafts.review.verdict],
            body: p.drafts.review.body,
          },
    strip:
      at === undefined || show === null ? null : stripOf(show, at.screen, drafted, p.unseen, s.now),
    conversation: (show?.pr.conversation ?? []).map((c) => ({
      kind: c.kind,
      author: c.author,
      body: c.body,
      when: ago(c.at, s.now),
    })),
    menu: menuRows(p, at?.screen, read),
    lifecycle: show === null ? [] : lifecycleRows(show.pr),
  };
  const node: ReviewPaneNode = { kind: 'ReviewPane', id: 'review', props };

  return node;
};

/** The watch's events it takes: a write to its pull request; any other never re-views it. */
const REVIEW_EVENTS: ReadonlySet<Event['type']> = new Set(['command.ran']);

export const reviewScreen: Screen<ReviewState> = {
  events: REVIEW_EVENTS,
  name: 'review',
  init: REVIEW_INIT,
  step: reviewStep,
  view: reviewView,
};
