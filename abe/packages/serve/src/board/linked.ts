/**
 * `abe story linked <id>` (#109 S1): Linked's nine rows for a story, composed from what the other
 * commands read (its card, its runs, your sessions, Sheets and boxes), GitHub (the spec issue,
 * the pull request and its reviews) and the pipelines (the branch's newest run, from GitHub
 * Actions or Azure Pipelines as the `pipelines` setting says). Each part is read on its
 * own and a failure stays on its row: the answer never fails whole. The rows are `ui`'s
 * `linkedOf`. `--part` (#341) reads one part only, the other rows `Reading…`: the popup asks for
 * each at once and draws each as it lands; the runs and sessions the parts share are read once
 * while one is out and no event came since (`sharing`).
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  type BoxData,
  type CardShowData,
  type FactoryRunData,
  type PipelineRun,
  cardBranch,
  githubRepoOf,
  type Handlers,
  isHere,
  LINKED_KEYS,
  type LinkedKey,
  type LinkedPart,
  type Outcome,
  parseCardId,
  parseRef,
  parseRepo,
  refused,
  storeRepoName,
  type Repo,
  type SessionData,
  type SheetSummary,
  type Tracking,
} from '@abe/core';
import { originUrl } from '@abe/ports';
import { type LinkedParts, linkedOf, linkedSession, type Read } from '@abe/ui';
import { readOrgPrototype } from '../sheets/org';
import { orgAt } from '../local-mode/local-mode';
import { boxesHandlers } from '../box/boxes';
import { realPathAt } from '../contract/here';
import { type FactoryCtx, factoryHandlers } from '../factory/factory';
import { newestRunOn, type PipelinesCtx } from './pipelines';
import { sessionHandlers } from '../session/sessions';
import { cardShow, type SheetsCtx, sheetsHandlers } from '../sheets/sheets';
import { type TrackingCtx } from './tracking';
import { checkoutOf } from '../layer/settings';

export type LinkedCtx = FactoryCtx &
  SheetsCtx &
  TrackingCtx &
  PipelinesCtx & {
    serve: {
      /** The newest event's number (`Journal.last`): a read from before it is an old answer. */
      lastEvent: () => number;
    };
  };

/** Where Linked's parts come from: the other commands' reads, GitHub, the spec's file. */
export type LinkedSources = {
  /**
   * The card as the board of `repo` (the run's checkout: a card worktree's own settings may name
   * no board) has it; none: where Linked was asked.
   */
  card: (id: number, repo?: string) => Promise<Outcome<CardShowData>>;
  /** The story's runs: the shown ones, or (`cleared`) those History keeps. */
  runs: (id: number, cleared: boolean) => Promise<Outcome<FactoryRunData[]>>;
  sessions: () => Promise<Outcome<SessionData[]>>;
  sheets: (id: number) => Promise<Outcome<SheetSummary[]>>;
  boxes: () => Promise<Outcome<BoxData[]>>;
  /** The worktree's `origin` URL. */
  origin: (worktree: string) => Promise<Outcome<string>>;
  tracking: Pick<Tracking, 'issueShow' | 'prShow' | 'prFind' | 'prReviews'>;
  /**
   * The branch's newest run, from the provider in force here; on GitHub in `github` (the repo the
   * story's work is on, or why that is not known; none: the checkout's origin's).
   */
  pipeline: (q: {
    branch: string;
    github: Read<Repo> | undefined;
  }) => Promise<Outcome<PipelineRun | null>>;
  /**
   * The newest version of the card's prototype in the org store (#351); null: none there. `repo`:
   * its name in the store (a run's reference names it); else the checkout's.
   */
  prototype: (id: number, repo?: string) => Promise<Outcome<number | null>>;
  /** A spec report's text, or null when it cannot be read here. */
  report: (path: string) => Promise<string | null>;
};

const read = <T>(o: Outcome<T> | { ok: false; error: { message: string } }): Read<T> =>
  o.ok ? o : { ok: false, error: o.error.message };

/** The spec's first line of prose: its first non-empty line, a heading's `#`s taken off. */
export const firstLine = (text: string): string | null => {
  const line = text
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l !== '');

  if (line === undefined) return null;

  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
};

const newest = (runs: readonly FactoryRunData[]): FactoryRunData | null =>
  runs.reduce<FactoryRunData | null>(
    (best, r) => (best === null || r.startedAt > best.startedAt ? r : best),
    null,
  );

/** The story's newest run: a shown one, else the newest History keeps (`cleared`). */
const runOf = async (
  s: LinkedSources,
  id: number,
): Promise<{ run: Read<FactoryRunData | null>; cleared?: true }> => {
  const shown = await s.runs(id, false);

  if (!shown.ok) return { run: read(shown) };
  const run = newest(shown.data);

  if (run !== null) return { run: { ok: true, data: run } };
  const cleared = await s.runs(id, true);

  if (!cleared.ok) return { run: read(cleared) };
  const kept = newest(cleared.data);

  return kept === null
    ? { run: { ok: true, data: null } }
    : { run: { ok: true, data: kept }, cleared: true };
};

/** The GitHub repo the story's work is on: its pull request's, its session's, else its origin's. */
const repoOf = async (
  s: LinkedSources,
  run: FactoryRunData | null,
  session: SessionData | undefined,
): Promise<Read<Repo> | undefined> => {
  const named = parseRepo(run?.pr?.repo ?? '') ?? parseRepo(session?.repo ?? '');

  if (named !== undefined) return { ok: true, data: named };
  const worktree = run !== null && run.worktree !== '' ? run.worktree : session?.worktree;

  if (worktree === undefined || worktree === '' || session?.box !== undefined) return undefined;
  const origin = await s.origin(worktree);

  if (!origin.ok) return read(origin);
  const repo = githubRepoOf(origin.data);

  return repo === undefined
    ? { ok: false, error: `origin is not a repo on GitHub: ${origin.data}` }
    : { ok: true, data: repo };
};

const prOf = async (
  t: LinkedSources['tracking'],
  repo: Repo,
  run: FactoryRunData | null,
  branch: string | undefined,
): Promise<NonNullable<LinkedParts['pr']>> => {
  const known = run?.pr ?? null;

  if (known === null && branch === undefined) return { ok: true, data: null };
  const found =
    known === null
      ? await t.prFind({ repo, head: branch ?? '' })
      : await t.prShow({ repo, number: known.number });

  if (!found.ok) return read(found);
  if (found.data === null) return { ok: true, data: null };
  const reviews = await t.prReviews({ repo, number: found.data.number });

  return reviews.ok ? { ok: true, data: { pr: found.data, reviews: reviews.data } } : read(reviews);
};

/** The store's name of the repo a run's prototype is in (`prototype://<repo>/<card>/v<n>`). */
const storeRepoOf = (run: FactoryRunData | null): string | undefined => {
  const ref = run?.reference?.prototype;

  return ref?.kind === 'store' ? /^prototype:\/\/([^/]+)\//.exec(ref.url)?.[1] : undefined;
};

/** A read that threw is that part's failure, never the whole answer's. */
const failure = <T>(err: unknown): Read<T> => ({
  ok: false,
  error: err instanceof Error ? err.message : String(err),
});
const settled = <T>(p: Promise<Read<T>>): Promise<Read<T>> => p.catch(failure<T>);

const NOT_READ = { ok: false, error: 'not read' } as const;
const NO_RUN = { run: { ok: true, data: null } } as const;

/**
 * Everything Linked shows for `story`, each part as read or why not; `part`: only that part (its
 * rows and those with nothing to read), the rest left out and `reading`.
 */
export const readLinked = async (
  s: LinkedSources,
  story: number,
  part?: LinkedPart,
): Promise<LinkedParts> => {
  const wants = (p: LinkedPart) => part === undefined || part === p;
  /** The story's card part alone: its run only for where the card is read, no session. */
  const cardOnly = part === 'card';
  const runRead = runOf(s, story).catch((err: unknown) => ({
    run: failure<FactoryRunData | null>(err),
  }));
  // in the run's checkout, as the run record reads it; no run: where Linked was asked
  const cardRead = async () => {
    const { run: r } = await runRead;

    return settled(
      s.card(story, r.ok && r.data !== null ? checkoutOf(r.data) : undefined).then(read),
    );
  };
  const [card, ran, sessions, sheets] = await Promise.all([
    wants('card') ? cardRead() : NOT_READ,
    cardOnly ? NO_RUN : runRead,
    cardOnly ? { ok: true as const, data: [] } : settled(s.sessions().then(read)),
    wants('card') ? settled(s.sheets(story).then(read)) : { ok: true as const, data: [] },
  ]);
  const { run } = ran;
  const cleared = 'cleared' in ran ? ran.cleared : undefined;
  const theRun = run.ok ? run.data : null;
  // the session the card is on (#335), as its Board card, Chat, ⌃W and the rows read it
  const session = linkedSession({
    story,
    run,
    sessions,
    ...(cleared === undefined ? {} : { cleared }),
  })?.session;
  // A run whose session is not listed here (cleared, a teammate's) is still on its card's branch.
  const branch =
    session?.branch ??
    (theRun === null || theRun.prototype ? undefined : cardBranch(String(story), theRun.title));
  const boxed = session?.box !== undefined;
  const specRef = theRun?.reference === null ? undefined : parseRef(theRun?.reference?.spec ?? '');
  // the written spec's first line says the Spec row only when no spec issue is named
  // (a prototype's reference names no spec issue since #351: its run's own Spec writes it)
  const specReport =
    theRun === null || specRef !== undefined
      ? null
      : (theRun.stages.findLast((x) => x.stage === 'spec')?.report ?? null);
  const asksPr = (theRun?.pr ?? null) !== null || branch !== undefined;
  const readsGitHub = (wants('pr') && asksPr) || (wants('pipelines') && branch !== undefined);
  const repo = readsGitHub ? await repoOf(s, theRun, session).catch(failure<Repo>) : undefined;
  /** A GitHub read once the repo is known; its failure to be known is the read's. */
  const onGithub = <T>(then: (repo: Repo) => Promise<Read<T>>): Promise<Read<T>> | undefined => {
    if (repo === undefined) return undefined;

    return repo.ok ? then(repo.data) : Promise.resolve(repo);
  };
  // Each row is one part's: its own read's, else the run part's (nothing more to read for it),
  // which every part but the card's says too: a part always says its own row, whatever another
  // part's read found when it was read (a branch since, a box since), so none stays Reading….
  const owners: Readonly<Record<LinkedKey, LinkedPart>> = {
    story: 'card',
    prototype: 'run',
    sheets: 'card',
    spec: specRef === undefined ? 'run' : 'spec',
    sessions: 'run',
    worktree: 'run',
    pr: asksPr ? 'pr' : 'run',
    pipelines: branch === undefined ? 'run' : 'pipelines',
    box: boxed ? 'box' : 'run',
  };
  const says = (k: LinkedKey) =>
    part === undefined || owners[k] === part || (owners[k] === 'run' && !cardOnly);
  // the store's newest version (#351): beside a run built from one, or a card with no run
  const readsPrototype =
    says('prototype') && (theRun === null || theRun.reference?.prototype.kind === 'store');
  const [specIssue, specText, pr, pipeline, boxes, prototype] = await Promise.all([
    specRef === undefined || !wants('spec')
      ? undefined
      : settled(s.tracking.issueShow(specRef).then(read)),
    specReport === null || !says('spec') ? undefined : s.report(specReport).catch(() => null),
    !asksPr || !wants('pr')
      ? undefined
      : onGithub((r) => settled(prOf(s.tracking, r, theRun, branch))),
    branch === undefined || !wants('pipelines')
      ? undefined
      : settled(s.pipeline({ branch, github: repo }).then(read)),
    boxed && wants('box') ? settled(s.boxes().then(read)) : undefined,
    readsPrototype && run.ok
      ? settled(s.prototype(story, storeRepoOf(theRun)).then(read))
      : undefined,
  ]);
  const reading = LINKED_KEYS.filter((k) => !says(k));

  return {
    ...(reading.length === 0 ? {} : { reading }),
    story,
    ...(branch === undefined ? {} : { branch }),
    card,
    run,
    ...(cleared === undefined ? {} : { cleared }),
    sessions,
    sheets,
    ...(specIssue === undefined ? {} : { specIssue }),
    ...(specText === undefined ? {} : { specLine: specText === null ? null : firstLine(specText) }),
    ...(pr === undefined ? {} : { pr }),
    ...(pipeline === undefined ? {} : { pipeline }),
    ...(boxes === undefined ? {} : { boxes }),
    ...(prototype === undefined ? {} : { prototype }),
  };
};

/**
 * One read of a key at a time: a caller while one is out gets its answer, the next after it a new
 * read (#341: the parts asked at once share the runs and sessions; `sharing` keys them by the
 * newest event, so a part an event asked for never gets an answer from before it).
 */
export const oneAtATime = <T>() => {
  const out = new Map<string, Promise<T>>();

  return (key: string, read: () => Promise<T>): Promise<T> => {
    const was = out.get(key);

    if (was !== undefined) return was;
    const now = read().finally(() => out.delete(key));

    out.set(key, now);

    return now;
  };
};

/** The reads the parts share, one at a time each. */
export type Shared = {
  runs: ReturnType<typeof oneAtATime<Outcome<FactoryRunData[]>>>;
  sessions: ReturnType<typeof oneAtATime<Outcome<SessionData[]>>>;
};

export const sharedReads = (): Shared => ({ runs: oneAtATime(), sessions: oneAtATime() });

/**
 * `s` with the runs and sessions the parts share read once (#341): a part asked while a read is
 * out joins it, unless an event came since it started (`seen`: the newest event's number), which
 * asked for the part again: then a read of its own, never an answer from before the event.
 * `where`: what the lists depend on.
 */
export const sharing = (
  s: LinkedSources,
  shared: Shared,
  where: string,
  seen: () => number,
): LinkedSources => ({
  ...s,
  runs: (id, cleared) =>
    shared.runs(`${where}\0${seen()}\0${id}\0${cleared}`, () => s.runs(id, cleared)),
  sessions: () => shared.sessions(`${where}\0${seen()}`, () => s.sessions()),
});

/** The sources over a request's own context: the same reads the other commands answer with. */
const sourcesOf = (ctx: LinkedCtx): LinkedSources => {
  const factory = factoryHandlers<LinkedCtx>();
  // the row's own answer type, wider than what the handler is seen to build
  const sessions: Pick<Handlers<LinkedCtx>, 'session list'> = sessionHandlers<LinkedCtx>();
  const sheets = sheetsHandlers<LinkedCtx>();
  const boxes = boxesHandlers<LinkedCtx>();

  return {
    card: (id, repo) =>
      cardShow({ id: String(id) }, repo === undefined ? ctx : { ...ctx, cwd: repo }),
    runs: async (id, cleared) => {
      const o = await factory['factory status']({ card: String(id), cleared }, ctx);

      return o.ok ? { ok: true, data: o.data.runs.filter((r) => isHere(o.data.here, r.repo)) } : o;
    },
    sessions: async () => {
      const o = await sessions['session list']({}, ctx);

      return o.ok
        ? { ok: true, data: o.data.sessions.filter((x) => isHere(o.data.here, x.repo)) }
        : o;
    },
    sheets: async (id) => {
      const o = await sheets['sheet list']({ card: String(id) }, ctx);

      return o.ok ? { ok: true, data: o.data.sheets } : o;
    },
    boxes: async () => {
      const o = await boxes['box list']({}, ctx);

      return o.ok ? { ok: true, data: o.data.boxes } : o;
    },
    // The URL only: `Git.origin` also asks the remote for its default branch.
    origin: async (worktree) => {
      const url = await originUrl(worktree);

      return url === undefined
        ? refused('no-origin', `${worktree} has no origin remote`)
        : { ok: true, data: url };
    },
    tracking: ctx.ports.tracking,
    pipeline: ({ branch, github }) => {
      const repo = github?.ok === false ? refused('no-github-repo', github.error) : github;

      return newestRunOn(ctx, realPathAt(ctx.cwd, '.'), branch, repo);
    },
    prototype: async (id, repo) => {
      const path = realPathAt(ctx.cwd, '.');
      const org = orgAt(ctx, path);

      if (org === undefined) return { ok: true, data: null };
      const name = repo ?? storeRepoName({ remote: (await originUrl(path)) ?? null, repo: path });
      const index = await readOrgPrototype(org, name, id);

      return index.ok
        ? { ok: true, data: index.data?.versions.at(-1)?.n ?? null }
        : refused(index.error.code, index.error.message);
    },
    // `stage-done --report` keeps the text in serve's own state (`keepReport`), not the worktree:
    // a box's run names its box's file, which is not here, and says `written ✓` alone.
    report: (path) => readFile(path, 'utf8').catch(() => null),
  };
};

export const linkedHandlers = () => {
  const shared = sharedReads();

  return {
    'story linked': async (args, ctx) => {
      const story = parseCardId(args.id);

      if (story === undefined) return refused('usage', `not a story id (2, AB#2): ${args.id}`, 2);
      // the story's runs and sessions in the repo it is read in, never another's same number
      // (#256): what the lists depend on is the folder asked in, and the session asking
      const where = `${ctx.session ?? ''}\0${ctx.cwd}`;
      const parts = await readLinked(
        sharing(sourcesOf(ctx), shared, where, ctx.serve.lastEvent),
        story,
        args.part,
      );
      const now = ctx.serve.clock.now();

      return {
        ok: true,
        data: linkedOf(parts, {
          now: new Date(now).toISOString(),
          home: homedir(),
        }),
      };
    },
  } satisfies Partial<Handlers<LinkedCtx>>;
};
