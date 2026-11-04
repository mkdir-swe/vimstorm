/**
 * `abe factory record <card>` (3.0 #21): a card's Run page as one record (core's `runRecordOf`),
 * read where the run is while it goes and from the log store (ADR 0019) once it is gone. In
 * order: the newest run of the card this serve holds (here, in the repo asked in; History's
 * cleared ones too), its transcript (`session transcript`'s entries), its last After report and
 * its spec stage's; else a run on one of your boxes, whose own serve answers (`forward`); else
 * the newest session of the card in the store under your own `<repo>/<login>/`: its `run.json`,
 * `transcript.jsonl` and `verify/` as shipped. Only your own runs: another person's run is never
 * read (the store's prefix is yours). The card, the spec (its issue, else its file on the card
 * branch, else the spec stage's report), the branch's commits, the last Before's report and the
 * report a step's `ends:` ended the run with are read too; a read that fails leaves its part empty,
 * never the page.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  type CardShowData,
  type Clock,
  entriesOfLine,
  type Event,
  type FactoryRunData,
  type Handlers,
  isHere,
  logSessions,
  logUserPrefix,
  type LogStore,
  type MadeCommit,
  type RepoHere,
  type Outcome,
  parseCardId,
  parseRef,
  refused,
  Run,
  runData,
  RunRecordData,
  runRecordOf,
  runCardOf,
  type RunChanged,
  runChangedOf,
  type RunSpec,
  type SessionData,
  StoredMeta,
  type IssueData,
  type Ref,
  type Tracked,
  type Tracking,
  type TranscriptEntry,
  type VerifyHtml,
  verifyHtmlOf,
} from '@abe/core';
import { repoRoot } from '@abe/ports';
import { z } from 'zod';
import { type Factory, type FactoryCtx } from './factory';
import { repoHere } from '../contract/here';
import { type LogsCtx } from '../improve/logs';
import { sessionHandlers } from '../session/sessions';
import { type TrackingCtx } from '../board/tracking';
import { cardShow } from '../sheets/sheets';
import { checkoutOf } from '../layer/settings';

export type RunRecordCtx = FactoryCtx &
  TrackingCtx &
  LogsCtx & {
    serve: {
      /** The record's outside parts held between reads; none: each read asks them anew. */
      recordParts?: RecordParts | undefined;
    };
  };

/** A part held: its value and when it was read (the clock's ms); a read of it out. */
type Held<T> = { value?: { v: T; at: number }; out?: Promise<T> };

/**
 * One kind of outside part, held by key: answered at once once held (read anew behind it past
 * `ttlMs`, stale while it revalidates); never held, waited for `waitMs` at most, then answered
 * `undefined` (not in yet) and held once it lands. Two reads of one key at once are one.
 */
export type Part<T> = {
  /** `whole`: never held, it is waited for in full (what the record cannot go without). */
  get: (key: string, read: () => Promise<T>, whole?: boolean) => Promise<{ v: T } | undefined>;
  /** The keys `drop` matches let go: read anew, waited for, next time. */
  drop: (drop: (key: string) => boolean) => void;
};

/** Parts held at most per kind; the oldest read go first. */
const PARTS_KEPT = 64;

const part = <T>(
  clock: Clock,
  ttlMs: number,
  waitMs: number,
  /** Whether an answer is held (a refusal of gh's login is not: it is asked again next time). */
  holds: (v: T) => boolean = () => true,
): Part<T> => {
  const held = new Map<string, Held<T>>();
  const start = (key: string, read: () => Promise<T>): Promise<T> => {
    const was = held.get(key);

    if (was?.out !== undefined) return was.out;
    const out = read().then(
      (v) => {
        if (!holds(v)) {
          held.delete(key);

          return v;
        }
        held.set(key, { value: { v, at: clock.now() } });
        for (const old of held.keys()) {
          if (held.size <= PARTS_KEPT) break;
          held.delete(old);
        }

        return v;
      },
      (err: unknown) => {
        const now = held.get(key);

        if (now?.value === undefined) held.delete(key);
        else held.set(key, { value: now.value });
        throw err;
      },
    );

    held.set(key, { ...(was?.value === undefined ? {} : { value: was.value }), out });

    return out;
  };

  return {
    get: async (key, read, whole = false) => {
      const was = held.get(key)?.value;

      if (was !== undefined) {
        // old: read anew behind it, this answer the one held
        if (clock.now() - was.at >= ttlMs) start(key, read).catch(() => undefined);

        return { v: was.v };
      }
      if (whole) return { v: await start(key, read) };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
        }, waitMs);
      });
      const got = await Promise.race([start(key, read).then((v) => ({ v })), late]).catch(
        () => undefined,
      );

      clearTimeout(timer);

      return got;
    },
    drop: (drop) => {
      for (const [key, h] of held)
        if (drop(key)) {
          if (h.out === undefined) held.delete(key);
          else held.set(key, { out: h.out });
        }
    },
  };
};

/**
 * The run record's parts read from outside, held by serve between reads so a Run page shown again
 * waits on no network: the board's card (by `<card>:<checkout>`), the spec's issue (by
 * `<card>:<ref>`), your GitHub login, the log store's newest run of a card (its login and refusals
 * never held). A card's events (`board.changed`, `factory.card`, `factory.stage`,
 * `factory.summary`) let its card and spec go; the rest go by their age alone
 * (`RECORD_PARTS_TTL_MS`).
 */
export type RecordParts = {
  card: Part<CardShowData | null>;
  spec: Part<Tracked<IssueData> | undefined>;
  me: Part<Awaited<ReturnType<Tracking['me']>>>;
  stored: Part<Outcome<Extract<FoundRun, { where: 'store' }> | null>>;
  /** An event heard: the parts it moved let go. */
  hear: (e: Event) => void;
};

/** How long a part held is answered before it is read anew behind it. */
export const RECORD_PARTS_TTL_MS = { card: 30_000, spec: 60_000, me: 600_000, stored: 60_000 };

/** How long a record waits for a part never read before it answers without it (`unread`). */
export const RECORD_WAIT_MS = 100;

export const recordParts = (clock: Clock, waitMs = RECORD_WAIT_MS): RecordParts => {
  const t = RECORD_PARTS_TTL_MS;
  const parts = {
    card: part<CardShowData | null>(clock, t.card, waitMs),
    spec: part<Tracked<IssueData> | undefined>(clock, t.spec, waitMs),
    me: part<Awaited<ReturnType<Tracking['me']>>>(clock, t.me, waitMs, (v) => v.ok),
    stored: part<Outcome<Extract<FoundRun, { where: 'store' }> | null>>(
      clock,
      t.stored,
      waitMs,
      (v) => v.ok,
    ),
  };
  const dropCards = (cards: readonly number[]) => {
    const of = (key: string) => cards.some((c) => key.startsWith(`${c}:`));

    parts.card.drop(of);
    parts.spec.drop(of);
  };

  return {
    ...parts,
    hear: (e) => {
      switch (e.type) {
        case 'board.changed':
          dropCards([...e.data.cards.map((c) => c.card.id), ...e.data.gone]);
          break;
        case 'factory.card':
        case 'factory.stage':
        case 'factory.summary':
          dropCards([e.data.card]);
          break;
        default:
          break;
      }
    },
  };
};

/** A run as found: held here, on a box (its session's id), or in the store with its files. */
export type FoundRun =
  | { where: 'here'; run: Run; data: FactoryRunData }
  | { where: 'box'; session: string }
  | {
      where: 'store';
      run: Run;
      /** The shipped files by their name in the store (`transcript.jsonl`, `verify/3-after.md`). */
      files: ReadonlyMap<string, string>;
    };

/** Where the record's parts come from: the other commands' reads, the store, the files. */
export type RunRecordSources = {
  /** The card's newest run here (null: none), else on a box, else in the store. */
  find: (card: number) => Promise<Outcome<FoundRun | null>>;
  /** A box's serve's own record of its run. */
  forward: (session: string, card: number) => Promise<Outcome<RunRecordData>>;
  entries: (session: string) => Promise<TranscriptEntry[]>;
  /** A file the run named (a report), as text; null when it cannot be read here. */
  file: (run: Run, path: string) => Promise<string | null>;
  /** The card as the board of `repo` (the run's checkout) has it. */
  card: (card: number, repo: string) => Promise<CardShowData | null>;
  session: (id: string) => Promise<SessionData | null>;
  /** What the run's worktree carries against its merge base; null when it cannot be read. */
  changed: (run: Run) => Promise<RunChanged | null>;
  /** The card branch's commits since its merge base, oldest first; null when they cannot be read. */
  commits: (run: Run) => Promise<MadeCommit[] | null>;
  /** The spec's issue on GitHub; undefined: still being read, the record answered without it. */
  issue: (ref: Ref, card: number) => Promise<Tracked<IssueData> | undefined>;
  /** The parts this read answered without, still being read (`RunRecordData.unread`). */
  unread?: () => RunRecordData['unread'];
};

/** The store's name of a report the run named in its worktree (`…/.scratch/2/verify/3.md`). */
const storedName = (path: string): string | undefined => {
  const at = path.lastIndexOf('/verify/');

  return at === -1 ? undefined : `verify/${path.slice(at + '/verify/'.length)}`;
};

/** A markdown text's first line, its heading marks off. */
const titleOf = (text: string): string | undefined =>
  text
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l !== '');

/** A spec kept as a file beside the code (`spec.where: file`), relative to the worktree. */
const specFile = (card: number) => `.abe/specs/${card}/spec.md`;

/**
 * The spec the run worked from: its issue on GitHub, else (a run here) its file on the card
 * branch read live in the worktree (`.abe/specs/<card>/spec.md`), else its spec stage's report.
 */
const specOf = async (
  s: RunRecordSources,
  run: Run,
  report: ((path: string) => Promise<string | null>) | undefined,
): Promise<RunSpec | null> => {
  const name = run.specIssues[0] ?? run.reference?.spec ?? null;
  const ref = name === null ? undefined : parseRef(name);

  if (name !== null && ref !== undefined) {
    const issue = await s.issue(ref, run.card);

    // still being read: its name now, its text on the next read
    if (issue === undefined) return { ref: name, url: null, title: name, body: '' };
    if (issue.ok)
      return { ref: name, url: issue.data.url, title: issue.data.title, body: issue.data.body };
  }
  if (report === undefined)
    return name === null ? null : { ref: name, url: null, title: name, body: '' };
  const path = specFile(run.card);
  const file = run.worktree === '' ? null : await report(path);

  if (file !== null)
    return { ref: name, url: null, title: titleOf(file) ?? 'Spec', body: file, path };
  const kept = run.visits.findLast((v) => v.stage === 'spec' && v.report !== null)?.report;
  const text = kept === undefined || kept === null ? null : await report(kept);

  if (text === null) return name === null ? null : { ref: name, url: null, title: name, body: '' };

  return { ref: name, url: null, title: titleOf(text) ?? 'Spec', body: text };
};

/** A transcript's text as the Run page shows it: its first lines. */
const TRANSCRIPT_LINES = 200;
const TRANSCRIPT_CHARS = 16 * 1024;

/**
 * The After pass's HTML report as serve kept it (sanitised when recorded), read into the verify
 * kit's parts, each transcript's text read from the run's Evidence; null when there is none.
 */
const htmlOf = async (
  run: Run,
  path: string | undefined,
  file: (path: string) => Promise<string | null>,
): Promise<VerifyHtml | null> => {
  const text = path === undefined ? null : await file(path);

  if (text === null) return null;
  const html = verifyHtmlOf(text);
  const scratch = `${run.worktree}/.scratch/${run.card}`;
  const features = await Promise.all(
    html.features.map(async (f) => ({
      ...f,
      parts: await Promise.all(
        f.parts.map(async (p) => {
          if (p.kind !== 'transcript') return p;
          const read = (await file(`${scratch}/${p.src}`)) ?? '';

          return {
            ...p,
            text: read.split('\n').slice(0, TRANSCRIPT_LINES).join('\n').slice(0, TRANSCRIPT_CHARS),
          };
        }),
      ),
    })),
  );

  return { ...html, features };
};

/** The record of `card`'s newest run, or why there is none. */
export const readRunRecord = async (
  s: RunRecordSources,
  card: number,
  at: string,
): Promise<Outcome<RunRecordData>> => {
  const found = await s.find(card);

  if (!found.ok) return found;
  if (found.data === null) return refused('no-run', `AB#${card} has no Factory run of yours`);
  const f = found.data;

  if (f.where === 'box') return s.forward(f.session, card);
  const run = f.run;
  const data = f.where === 'here' ? f.data : runData(run, undefined);
  const file = (path: string): Promise<string | null> => {
    if (f.where === 'here') return s.file(run, path);
    const name = storedName(path);

    return Promise.resolve(name === undefined ? null : (f.files.get(name) ?? null));
  };
  const after = run.verifications.findLast((v) => v.phase === 'after');
  const before = run.verifications.findLast((v) => v.phase === 'before');
  const said = run.reported?.report ?? null;
  const [entries, verify, html, shown, session, spec, changed] = await Promise.all([
    f.where === 'here'
      ? s.entries(run.session)
      : Promise.resolve(
          (f.files.get('transcript.jsonl') ?? '').split('\n').flatMap((l) => entriesOfLine(l)),
        ),
    after === undefined ? Promise.resolve(null) : file(after.report),
    htmlOf(run, after?.html, file),
    s.card(card, checkoutOf(run)),
    f.where === 'here' ? s.session(run.session) : Promise.resolve(null),
    specOf(s, run, f.where === 'here' ? (path) => s.file(run, path) : undefined),
    // merged, its merge base is its head: the steps' own files say it then
    f.where === 'here' && run.pr?.state !== 'merged' ? s.changed(run) : Promise.resolve(null),
  ]);
  const [commits, beforeText, beforeHtml, reported] = await Promise.all([
    // live only: a run from the store has no worktree to read
    f.where === 'here' ? s.commits(run) : Promise.resolve(null),
    before === undefined ? Promise.resolve(null) : file(before.report),
    htmlOf(run, before?.html, file),
    said === null ? Promise.resolve(null) : file(said),
  ]);
  const where = session === null ? null : whereOf(session);

  return {
    ok: true,
    data: runRecordOf({
      run: data,
      entries,
      criteria: shown?.acceptanceCriteria ?? '',
      verify,
      html,
      spec,
      source: f.where === 'here' ? 'live' : 'record',
      at,
      type: shown?.type ?? null,
      branch: session?.branch ?? null,
      where,
      changed,
      cardDetail: shown === null ? null : runCardOf(shown),
      commits,
      before: before === undefined ? null : { text: beforeText, html: beforeHtml },
      reported,
      unread: s.unread?.() ?? [],
    }),
  };
};

/** Where a session runs, in words (the ui's `whereOf`). */
const whereOf = (s: SessionData): string =>
  s.neverPlaced === true ? 'never got a box' : (s.box ?? 'Local sandbox');

const text = new TextDecoder();

const getText = async (store: LogStore, key: string): Promise<string | undefined> => {
  const got = await store.get(key);

  return got.ok ? text.decode(got.data) : undefined;
};

const json = (raw: string | undefined): unknown => {
  if (raw === undefined) return undefined;
  try {
    const doc: unknown = JSON.parse(raw);

    return doc;
  } catch {
    return undefined;
  }
};

/** What `storedRun` reads of a stored `meta.json`: also the checkout it ran in. */
const StoredWhere = StoredMeta.extend({ repo: z.string().optional() });

/**
 * The newest session of `card` in the store under your own prefix for its repo (`<repo>/<login>/`), with its
 * run and files; null when it has none. Only `meta.json`, `run.json`, `transcript.jsonl` and
 * `verify/` are read. Every clone of one origin ships there: one that ran in a checkout on this
 * machine other than `here`'s is that clone's, never this one's.
 */
export const storedRun = async (
  store: LogStore,
  who: { repo: string; login: string },
  card: number,
  here?: RepoHere,
): Promise<Outcome<Extract<FoundRun, { where: 'store' }> | null>> => {
  const prefix = logUserPrefix(who.repo, who.login);
  const listed = await store.list(prefix);

  if (!listed.ok) return refused(listed.error.code, listed.error.message);
  let best: { since: string; prefix: string; files: string[] } | undefined;

  for (const s of logSessions(listed.data.filter((o) => o.key.startsWith(prefix)))) {
    const at = `${s.repo}/${s.user}/${s.session}/`;

    if (!s.files.includes('run.json')) continue;
    const meta = StoredWhere.safeParse(json(await getText(store, `${at}meta.json`)));

    if (!meta.success || meta.data.card !== card) continue;
    const ran = meta.data.repo;

    if (ran !== undefined && isAbsolute(ran) && existsSync(ran) && !isHere(here, ran)) continue;
    if (best === undefined || meta.data.since > best.since)
      best = { since: meta.data.since, prefix: at, files: s.files };
  }
  if (best === undefined) return { ok: true, data: null };
  const run = Run.safeParse(json(await getText(store, `${best.prefix}run.json`)));

  if (!run.success) return { ok: true, data: null };
  const files = new Map<string, string>();

  for (const name of best.files.filter(
    (n) => n === 'transcript.jsonl' || n.startsWith('verify/'),
  )) {
    const read = await getText(store, `${best.prefix}${name}`);

    if (read !== undefined) files.set(name, read);
  }

  return { ok: true, data: { where: 'store', run: run.data, files } };
};

/**
 * A report a run named, as text: a stage report from serve's own state, a review or verify
 * report from the run's worktree; null when it cannot be read.
 */
export const runReportText = async (
  tree: Factory['tree'] | undefined,
  run: Run,
  path: string,
): Promise<string | null> => {
  if (path.startsWith('/') && !path.includes('/.scratch/'))
    return readFile(path, 'utf8').catch(() => null);
  if (tree === undefined) return null;
  const read = await tree(run.card).report(run.worktree, path);

  return read.ok ? read.data : null;
};

const newest = (runs: readonly Run[]): Run | undefined =>
  runs.reduce<Run | undefined>(
    (b, r) => (b === undefined || r.startedAt > b.startedAt ? r : b),
    undefined,
  );

const sourcesOf = (ctx: RunRecordCtx): RunRecordSources => {
  const sessions = sessionHandlers<RunRecordCtx>();
  const parts = ctx.serve.recordParts;
  /** A part the record cannot go without: held, else waited for in full. */
  const whole = async <T>(p: Part<T> | undefined, key: string, read: () => Promise<T>) =>
    (await p?.get(key, read, true))?.v ?? read();
  const plain: RunRecordSources = {
    find: async (card) => {
      const { here } = await repoHere(ctx.cwd);
      const held = newest(
        (ctx.serve.factory?.all() ?? []).filter((r) => r.card === card && isHere(here, r.repo)),
      );

      if (held !== undefined && ctx.serve.factory !== undefined)
        return { ok: true, data: { where: 'here', run: held, data: ctx.serve.factory.data(held) } };
      const boxed = (await ctx.serve.cloud?.runs(card)) ?? [];
      const onBox = boxed
        .filter((r) => isHere(here, r.repo))
        .reduce<FactoryRunData | undefined>(
          (b, r) => (b === undefined || r.startedAt > b.startedAt ? r : b),
          undefined,
        );

      if (onBox !== undefined) return { ok: true, data: { where: 'box', session: onBox.session } };
      // gone from here and from your boxes: the record in the log store, yours in this repo only
      const store = ctx.serve.logs?.storeAt(repoRoot(ctx.cwd) ?? ctx.cwd);
      const repo = here?.github ?? null;

      if (store === undefined || repo === null) return { ok: true, data: null };
      // (the login and the store's run: held by serve, waited for in full the first time)
      const login = await whole(parts?.me, 'me', () => ctx.ports.tracking.me());

      // plain words and what to do: gh's own answer can be a parse failure
      if (!login.ok)
        return refused(
          login.error.code,
          "This run's record is not here, and Abe could not look in the log store: gh did not say your GitHub login. Run gh auth status in a terminal (gh auth login if it says you are signed out), then open the run again.",
        );
      const who = { repo, login: login.data.login };

      return whole(parts?.stored, `${card}:${repo}:${who.login}:${here?.root ?? ''}`, () =>
        storedRun(store, who, card, here),
      );
    },
    forward: (session, card) =>
      ctx.serve.cloud === undefined
        ? Promise.resolve(refused('no-cloud', 'this abe serve reaches no boxes'))
        : ctx.serve.cloud.forward(session, RunRecordData, ['factory', 'record', String(card)]),
    entries: async (session) => {
      const read = await ctx.serve.transcripts?.read(session, 0);

      return read?.ok === true ? read.data.entries : [];
    },
    file: (run, path) => runReportText(ctx.serve.factory?.tree, run, path),
    // in the run's checkout: a card worktree's own settings may name no board
    card: async (card, repo) => {
      const shown = await cardShow({ id: String(card) }, { ...ctx, cwd: repo });

      return shown.ok ? shown.data : null;
    },
    session: async (id) => {
      const shown = await sessions['session show']({ id }, ctx);

      return shown.ok ? shown.data : null;
    },
    changed: async (run) => {
      const diff = await ctx.serve.factory?.tree(run.card).diff(run.worktree);
      // what the worktree got from its checkout is not the run's: the pull request carries none
      const copied = (await ctx.serve.worktreeCopies?.(run.repo)) ?? [];

      return diff?.ok === true
        ? runChangedOf(
            diff.patch,
            copied.map((c) => c.path),
          )
        : null;
    },
    commits: async (run) => {
      if (run.worktree === '') return null;
      const read = await ctx.serve.factory?.tree(run.card).commits(run.worktree);

      return read?.ok === true ? read.data : null;
    },
    issue: (ref) => ctx.ports.tracking.issueShow(ref),
  };

  return parts === undefined ? plain : withParts(plain, parts);
};

/**
 * `s` with its outside parts (the board's card, the spec's issue) through what serve holds of
 * them (`RecordParts`): held, answered at once; never read, answered without past the wait and
 * named `unread`, so the record comes from what is here (the run, its transcript, its worktree)
 * without waiting on the network.
 */
export const withParts = (s: RunRecordSources, parts: RecordParts): RunRecordSources => {
  const unread = new Set<RunRecordData['unread'][number]>();

  return {
    ...s,
    unread: () => [...unread],
    card: async (card, repo) => {
      const got = await parts.card.get(`${card}:${repo}`, () => s.card(card, repo));

      if (got === undefined) unread.add('card');

      return got?.v ?? null;
    },
    issue: async (ref, card) => {
      const got = await parts.spec.get(`${card}:${ref.repo}#${ref.number}`, () =>
        s.issue(ref, card),
      );

      if (got === undefined) unread.add('spec');

      return got?.v;
    },
  };
};

export const runRecordHandlers = () =>
  ({
    'factory record': async (args, ctx) => {
      const card = parseCardId(args.card);

      if (card === undefined) return refused('usage', `not a card id (4, AB#4): ${args.card}`, 2);

      return readRunRecord(sourcesOf(ctx), card, new Date(ctx.serve.clock.now()).toISOString());
    },
  }) satisfies Partial<Handlers<RunRecordCtx>>;
