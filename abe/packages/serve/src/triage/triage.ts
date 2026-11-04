/**
 * `abe triage` (ticket #76): verdicts for the backlog. `triage` reads the cards not running (Mine
 * this sprint, or the team's backlog with `--team`) and the repo's open GitHub issues, asks one
 * one-shot with core's triage skill, keeps the verdicts as the last triage and emits
 * `triage.done`; it writes nothing else. `triage apply` asks the last triage's needs-info cards
 * their question (one comment and the `needs-info` tag, once); `triage launch` runs `abe factory
 * run` for its ready cards, each placed as any launch is (core's `placeCard`: in your environment
 * Queued at the team's box limit, running and starting boxes counted). The rules are core's (`core/src/triage/triage.ts`).
 */
import {
  isHere,
  alreadyAsked,
  answersOf,
  askedCards,
  type CardComment,
  findItem,
  isCloudTarget,
  itemsToTriage,
  type Journal,
  mayWrite,
  NEEDS_INFO_TAG,
  needsInfoComment,
  type OpenIssue,
  type Outcome,
  parseRepo,
  readTriage,
  refused,
  runningCards,
  specIssuesOf,
  type SessionData,
  TRIAGE_SKILL,
  type TriageApplyData,
  triageCounts,
  type TriageData,
  type TriageLaunchData,
  triagePrompt,
  TriageRecord,
  type Handlers,
} from '@abe/core';
import { keepUnreadable, originRepo, readLastTriage, writeLastTriage } from '@abe/ports';
import { repoHere } from '../contract/here';
import { serveTargetIn } from '../layer/settings';
import { withBoard } from '../board/board';
import { type FactoryCtx, factoryHandlers } from '../factory/factory';
import { askOneShot, type OneShotCtx } from '../layer/one-shot';
import { sessionReach } from '../layer/reach';
import { cloudRepo } from '../session/sessions';

export type TriageCtx = FactoryCtx &
  OneShotCtx & {
    serve: {
      emit: Journal['emit'];
      /** Where the last triage is kept (serve's state directory); without it triage is refused. */
      triageDir: string | undefined;
    };
  };

const noTriage = () =>
  refused('no-sessions', 'this abe serve was started without a session runner');

/**
 * What runs now in the repo at `at`: every session as `list` settles it (gone ones ended) and the
 * Factory runs, only that repo's: another checkout's #4 may be another board's card 4.
 */
const runningNow = async (
  ctx: TriageCtx,
  at: string,
): Promise<
  Outcome<{
    sessions: (SessionData & { card: number })[];
    runs: { card: number; done: boolean; merged: boolean; specIssues: string[] }[];
  }>
> => {
  if (ctx.serve.sessions === undefined || ctx.serve.factory === undefined) return noTriage();
  const { factory } = ctx.serve;
  const sessions = await ctx.serve.sessions.list();

  if (!sessions.ok) return sessions;
  const { here } = await repoHere(at);

  return {
    ok: true,
    data: {
      // a card's sessions only: an Improve retro chat holds no card and no box
      sessions: sessions.data.filter(
        (x): x is SessionData & { card: number } => x.card !== null && isHere(here, x.repo),
      ),
      runs: factory
        .all()
        .filter((r) => isHere(here, r.repo))
        .map((r) => ({
          card: r.card,
          done: factory.data(r).state === 'done',
          merged: r.pr?.state === 'merged',
          specIssues: r.specIssues,
        })),
    },
  };
};

/** The GitHub repo whose issues are read: `--repo`, else the checkout's `origin` on GitHub. */
const repoOf = async (ctx: TriageCtx, given: string | undefined) => {
  if (given !== undefined) return parseRepo(given) ?? null;

  return originRepo(ctx.cwd);
};

/** The last triage, or why there is none. */
const lastTriage = (ctx: TriageCtx): Outcome<TriageRecord> => {
  if (ctx.serve.triageDir === undefined) return noTriage();
  const doc = TriageRecord.safeParse(readLastTriage(ctx.serve.triageDir));

  return doc.success
    ? { ok: true, data: doc.data }
    : refused('no-triage', 'no triage yet: run abe triage first');
};

/** How an answer names the item `text` names: its id in the triage (`AB#4` for `4`), else as typed. */
const idOf = (record: TriageRecord, text: string) => findItem(record.items, text)?.id ?? text;

/** Each id once, in the order given (`4` and `AB#4` are one). */
const distinct = (record: TriageRecord, ids: readonly string[]) => {
  const seen = new Set<string>();

  return ids.filter((text) => {
    const key = idOf(record, text);

    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
};

export const triageHandlers = <Ctx extends TriageCtx>() =>
  ({
    triage: (args, ctx) =>
      withBoard(ctx, async (board): Promise<Outcome<TriageData>> => {
        if (ctx.serve.triageDir === undefined) return noTriage();
        const { triageDir } = ctx.serve;
        const scope = args.team ? 'team' : 'mine';
        const repo = await repoOf(ctx, args.repo);

        if (repo === null) return refused('usage', `not <owner/repo>: ${args.repo ?? ''}`, 2);
        const sprint = scope === 'mine' ? await ctx.ports.board.currentSprint(board) : undefined;

        if (sprint !== undefined && !sprint.ok) return sprint;
        if (sprint?.data === null)
          return refused(
            'no-sprint',
            `${board.team} has no current sprint: abe triage --team reads the whole backlog`,
          );
        const iteration = sprint?.data.path;
        const cards = await ctx.ports.board.list(board, {
          mine: scope === 'mine',
          ...(iteration === undefined ? {} : { iteration }),
        });

        if (!cards.ok) return cards;
        let issues: OpenIssue[] = [];

        if (repo !== undefined) {
          const listed = await ctx.ports.tracking.issueList(repo);

          if (!listed.ok) return listed;
          issues = listed.data;
        }
        const now = await runningNow(ctx, ctx.cwd);

        if (!now.ok) return now;
        const running = runningCards(now.data);
        // An answered card's comments since triage asked (#77): the next verdict reads the answer.
        const last = TriageRecord.safeParse(readLastTriage(triageDir));
        const asked = askedCards(
          cards.data.filter((c) => !running.has(c.id)),
          last.success ? last.data.items : undefined,
        );
        const threads = new Map<number, CardComment[]>();

        await Promise.all(
          asked.map(async (id) => {
            const shown = await ctx.ports.board.show(board, id);

            // A thread that cannot be read leaves the card as its fields say.
            if (shown.ok) threads.set(id, answersOf(shown.data.comments));
          }),
        );
        const { items, skipped } = itemsToTriage({
          cards: cards.data,
          issues,
          running,
          specIssues: specIssuesOf(now.data.runs),
          threads,
          ...(board.notTag === undefined ? {} : { notTag: board.notTag }),
        });
        let verdicts: TriageData['items'] = [];
        let model = '';

        if (items.length > 0) {
          // A session's Reach (its read names), as a one-shot gets a session's environment.
          const reach = await sessionReach(ctx, 'local');

          if (!reach.ok) return reach;
          const asked = await askOneShot(ctx, {
            role: 'reader',
            reach: reach.data.env,
            cwd: ctx.cwd,
            prompt: triagePrompt(items),
            system: TRIAGE_SKILL,
          });

          if (!asked.ok) return asked;
          model = asked.data.model;
          const read = readTriage(asked.data.text, items);

          if (!read.ok)
            return refused(
              'triage-unreadable',
              `the one-shot's answer is no verdicts (${read.message}); kept as it came in ${keepUnreadable(triageDir, asked.data.text, ctx.serve.clock.now())}`,
            );
          verdicts = read.items;
        }
        const data: TriageData = {
          at: new Date(ctx.serve.clock.now()).toISOString(),
          scope,
          board: { organization: board.organization, project: board.project, team: board.team },
          sprint: sprint?.data.name ?? null,
          repo: repo ?? null,
          model,
          items: verdicts,
          skipped,
          counts: triageCounts(verdicts, skipped.length),
        };

        writeLastTriage(triageDir, { v: 1, checkout: ctx.cwd, ...data } satisfies TriageRecord);
        ctx.serve.emit('triage.done', { scope, items: verdicts.length, ...data.counts });

        return { ok: true, data };
      }),
    'triage apply': async (args, ctx) => {
      const last = lastTriage(ctx);

      if (!last.ok) return last;
      const record = last.data;

      // The board the triage read: the settings in force where it ran.
      return withBoard({ ...ctx, cwd: record.checkout }, async (board) => {
        const items: TriageApplyData['items'] = [];
        const refusedRow = (id: string, error: { code: string; message: string }) => {
          items.push({ id, result: 'refused', comment: null, tagged: false, ...error });
        };

        for (const text of distinct(record, args.id)) {
          const may = mayWrite(record.items, text, 'ask', record.skipped);

          if (!may.ok) {
            refusedRow(idOf(record, text), may.error);
            continue;
          }
          const { item, card } = may;
          const question = item.question ?? '';
          const shown = await ctx.ports.board.show(board, card);

          if (!shown.ok) {
            refusedRow(item.id, shown.error);
            continue;
          }
          const asked = alreadyAsked(shown.data.comments, question);
          const written = asked
            ? undefined
            : await ctx.ports.board.comment(
                board,
                card,
                needsInfoComment({ reason: item.reason, question }),
              );

          if (written?.ok === false) {
            refusedRow(item.id, written.error);
            continue;
          }
          const tagged = await ctx.ports.board.tag(board, card, {
            add: [NEEDS_INFO_TAG],
            remove: [],
          });
          const comment = written?.data.id ?? null;

          items.push({
            id: item.id,
            result: asked ? 'already-asked' : 'asked',
            comment,
            tagged: tagged.ok,
            code: tagged.ok ? null : tagged.error.code,
            message: tagged.ok
              ? `${asked ? 'asked already' : 'asked'}: ${question}`
              : `${asked ? 'asked already' : 'asked'}, but the tag was not added: ${tagged.error.message}`,
          });
        }

        return { ok: true, data: { items } };
      });
    },
    'triage launch': async (args, ctx) => {
      const last = lastTriage(ctx);

      if (!last.ok) return last;
      const record = last.data;

      if (ctx.settings === undefined)
        return refused('no-settings', 'no settings to read the box limit from');
      const values = ctx.settings.at(record.checkout).values;
      const limit = values['limits.maxBoxesPerPerson'];
      const now = await runningNow(ctx, record.checkout);

      if (!now.ok) return now;
      const running = runningCards(now.data);
      // In your environment each run is placed (and Queued) by the launch itself; asked first
      // without applying for the boxes counted. On this Mac a run holds no box.
      const cloud = isCloudTarget(serveTargetIn(ctx.settings, record.checkout, ctx.serve.onBox))
        ? ctx.serve.cloud
        : undefined;
      const repo =
        cloud === undefined ? undefined : await cloudRepo(record.checkout, record.checkout);

      if (repo?.ok === false) return repo;
      let inUse: number | undefined;
      const run = factoryHandlers<Ctx>()['factory run'];
      const items: TriageLaunchData['items'] = [];

      for (const text of distinct(record, args.id)) {
        const may = mayWrite(record.items, text, 'launch', record.skipped);

        if (!may.ok) {
          items.push({ id: idOf(record, text), result: 'refused', session: null, ...may.error });
          continue;
        }
        // Its run may wait on you with its session ended: it still holds the card and its box.
        if (running.has(may.card)) {
          items.push({
            id: may.item.id,
            result: 'refused',
            session: null,
            code: 'running',
            message: `${may.item.id} runs already: abe factory status ${may.card}`,
          });
          continue;
        }
        // Asked once, for the boxes counted; each run is placed (and refused) by its own launch.
        const at =
          cloud === undefined || repo === undefined || inUse !== undefined
            ? undefined
            : await cloud.place({
                repo: repo.data,
                card: may.card,
                title: may.item.title,
                where: record.checkout,
                apply: false,
              });

        if (at?.ok === false) {
          items.push({ id: may.item.id, result: 'refused', session: null, ...at.error });
          continue;
        }
        inUse ??= at?.data.boxes;
        const started = await run(
          {
            card: String(may.card),
            repo: record.checkout,
            prod: false,
            // a card's live session is never stopped for triage: refused card-has-session
            replace: false,
          },
          { ...ctx, cwd: record.checkout },
        );

        if (!started.ok) {
          items.push({ id: may.item.id, result: 'refused', session: null, ...started.error });
          continue;
        }
        const queued = started.data.state === 'queued';

        items.push({
          id: may.item.id,
          result: queued ? 'queued' : 'started',
          session: started.data.session,
          code: null,
          message: queued
            ? `Queued: ${at?.data.boxes ?? 0} of ${limit} boxes in use`
            : `started ${started.data.session}`,
        });
      }

      return { ok: true, data: { limit, inUse: inUse ?? 0, local: cloud === undefined, items } };
    },
  }) satisfies Partial<Handlers<Ctx>>;
