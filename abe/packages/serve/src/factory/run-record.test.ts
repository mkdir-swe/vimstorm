/**
 * `abe factory record <card>` (3.0 #21). `readRunRecord` over stand-in sources for where the run
 * is (here, on a box, in the store, nowhere); the store's read (`storedRun`) on a folder store,
 * a finished run's page after its session and box are gone; the CLI seam's refusals.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Event,
  type Outcome,
  type Reply,
  RunRecordData,
  logKey,
  refused,
  runData,
  verifyHtmlOf,
  verifyHtmlText,
} from '@abe/core';
import { fileLogStore } from '@abe/ports';
import {
  listCard,
  RUN_CRITERIA,
  RUN_DONE,
  RUN_ENTRIES,
  RUN_LIVE,
  RUN_RECORD_DONE,
  RUN_SPEC,
  RUN_STORED,
  RUN_STORED_TRANSCRIPT,
  RUN_VERIFY_HTML,
  RUN_VERIFY_REPORT,
  runAt,
  scenario,
  type ServeScenario,
} from '@abe/testing';
import { z } from 'zod';
import {
  type FoundRun,
  readRunRecord,
  recordParts,
  type RunRecordSources,
  storedRun,
  withParts,
} from './run-record';

const AT = runAt(50);
/** The worktree against its merge base, as serve reads it for a run held here. */
const CHANGED = { files: 4, added: 33, removed: 16 };
/** The card branch's commits since its merge base, read in its worktree. */
const COMMITS = [{ sha: 'a1f20c3', subject: 'Cart total counts each quantity' }];

const sources = (
  found: Outcome<FoundRun | null>,
  o: Partial<RunRecordSources> = {},
): RunRecordSources => ({
  find: () => Promise.resolve(found),
  forward: () => Promise.resolve({ ok: true, data: RUN_RECORD_DONE }),
  entries: () => Promise.resolve(RUN_ENTRIES.live),
  file: (_, path) =>
    Promise.resolve(path.endsWith('/verify/1-after.md') ? RUN_VERIFY_REPORT : null),
  card: () =>
    Promise.resolve({
      ...listCard(2, 'The cart total ignores quantity', 'Active', null, {
        acceptanceCriteria: RUN_CRITERIA,
        type: 'Bug',
      }),
      comments: [],
      sheets: [],
    }),
  session: () => Promise.resolve(null),
  changed: () => Promise.resolve(CHANGED),
  commits: () => Promise.resolve(COMMITS),
  issue: () =>
    Promise.resolve({
      ok: true,
      data: {
        repo: 'mkdir-swe/demo-shop',
        number: 41,
        title: RUN_SPEC.title,
        body: RUN_SPEC.body,
        state: 'open',
        url: RUN_SPEC.url ?? '',
        labels: ['spec'],
        parent: null,
        subIssues: [],
      },
    }),
  ...o,
});

describe('where the record is read', () => {
  test('a run held here: live, its transcript, card criteria and spec issue', async () => {
    const asked: string[] = [];
    const got = await readRunRecord(
      sources(
        {
          ok: true,
          data: {
            where: 'here',
            run: {
              ...RUN_STORED,
              stage: 'build',
              outcome: null,
              pr: null,
              verifications: [],
              reviews: [],
              visits: RUN_STORED.visits.slice(0, 5),
              since: runAt(18),
            },
            data: RUN_LIVE,
          },
        },
        {
          card: (_, repo) => {
            asked.push(repo);

            return sources({ ok: true, data: null }).card(2, repo);
          },
        },
      ),
      2,
      AT,
    );

    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // the card read in the run's checkout (its board), never where the page was asked from
    expect(asked).toEqual([RUN_STORED.repo]);
    expect(got.data.source).toBe('live');
    expect(got.data.spec?.ref).toBe('mkdir-swe/demo-shop#41');
    expect(got.data.type).toBe('Bug');
    expect(got.data.criteria.map((c) => c.mark)).toEqual(['todo', 'todo', 'todo']);
    expect(got.data.steps.at(-1)).toMatchObject({ id: 'build:2', live: true });
    // what the pull request carries, from its worktree
    expect(got.data.changed).toEqual(CHANGED);
    expect(got.data.commits).toEqual(COMMITS);
    expect(got.data.cardDetail).toMatchObject({ type: 'Bug', state: 'Active' });
  });

  test('the card is read where its run is: its checkout’s board, wherever the page was opened', async () => {
    const asked: (string | undefined)[] = [];
    const base = sources({ ok: true, data: { where: 'here', run: RUN_STORED, data: RUN_LIVE } });
    const got = await readRunRecord(
      {
        ...base,
        card: (card, repo) => {
          asked.push(repo);

          return base.card(card, repo);
        },
      },
      2,
      AT,
    );

    expect(asked).toEqual([RUN_STORED.repo]);
    expect(got.ok && got.data.criteria.length).toBe(3);
  });

  test('a run on one of your boxes: its box’s serve answers', async () => {
    const asked: string[] = [];
    const got = await readRunRecord(
      sources(
        { ok: true, data: { where: 'box', session: '2-a1b2' } },
        {
          forward: (session) => {
            asked.push(session);

            return Promise.resolve({ ok: true, data: RUN_RECORD_DONE });
          },
        },
      ),
      2,
      AT,
    );

    expect(asked).toEqual(['2-a1b2']);
    expect(got).toEqual({ ok: true, data: RUN_RECORD_DONE });
  });

  test.each<[string, Outcome<FoundRun | null>, string]>([
    ['none of yours anywhere', { ok: true, data: null }, 'no-run'],
    ['the store refusing', refused('store-down', 'no'), 'store-down'],
  ])('%s: refused', async (_, found, code) => {
    const got = await readRunRecord(sources(found), 2, AT);

    expect(got.ok ? 'ok' : got.error.code).toBe(code);
  });
});

describe('the outside parts held between reads: a slow board and GitHub never hold the page', () => {
  /** How long the slow board and gh take to answer; the record waits `WAIT` for a part never read. */
  const SLOW = 300;
  const WAIT = 40;
  const HERE: Outcome<FoundRun | null> = {
    ok: true,
    data: { where: 'here', run: RUN_STORED, data: RUN_LIVE },
  };
  const slowly = () => {
    const asked: string[] = [];
    const base = sources(HERE);
    const late = <T>(what: string, read: () => Promise<T>) => {
      asked.push(what);

      return new Promise<T>((done) => setTimeout(() => void read().then(done), SLOW));
    };

    return {
      asked,
      sources: {
        ...base,
        card: (card: number, repo: string) => late('card', () => base.card(card, repo)),
        issue: (ref, card) => late('spec', () => base.issue(ref, card)),
      } satisfies RunRecordSources,
    };
  };
  const timed = async (s: RunRecordSources) => {
    const t0 = performance.now();
    const got = await readRunRecord(s, 2, AT);

    if (!got.ok) throw new Error(got.error.message);

    return { ms: performance.now() - t0, r: got.data };
  };
  const event = (type: string, data: unknown) => Event.parse({ seq: 1, at: AT, type, data });

  test('first read: what is here, the card and spec unread; then held, answered at once and read anew past their age', async () => {
    let now = 0;
    const parts = recordParts({ now: () => now }, WAIT);
    const slow = slowly();
    const first = await timed(withParts(slow.sources, parts));

    // the run, its transcript and worktree, without waiting on the network
    expect(first.ms).toBeLessThan(SLOW);
    expect(first.r.unread).toEqual(['card', 'spec']);
    expect(first.r.cardDetail).toBeNull();
    expect(first.r.spec).toMatchObject({ ref: 'mkdir-swe/demo-shop#41', body: '' });
    expect(first.r.steps.length).toBeGreaterThan(0);
    await Bun.sleep(SLOW + 50);
    const second = await timed(withParts(slow.sources, parts));

    expect(second.ms).toBeLessThan(WAIT);
    expect(second.r.unread).toEqual([]);
    expect(second.r.cardDetail).toMatchObject({ type: 'Bug' });
    expect(second.r.spec?.title).toBe(RUN_SPEC.title);
    // one read each so far; past their age the held ones answer, each read anew behind them
    expect(slow.asked).toEqual(['card', 'spec']);
    now += 60_000;
    const third = await timed(withParts(slow.sources, parts));

    expect(third.ms).toBeLessThan(WAIT);
    expect(third.r.unread).toEqual([]);
    expect(slow.asked).toEqual(['card', 'spec', 'card', 'spec']);
  });

  test.each<[string, Event, RunRecordData['unread']]>([
    [
      'its card moved on the board',
      event('board.changed', {
        board: { organization: 'o', project: 'p', team: 't' },
        cards: [],
        gone: [2],
      }),
      ['card', 'spec'],
    ],
    [
      'its run moved a stage',
      event('factory.card', {
        card: 2,
        session: RUN_STORED.session,
        column: 'active',
        state: 'Active',
        error: null,
      }),
      ['card', 'spec'],
    ],
    [
      'another card moved',
      event('board.changed', {
        board: { organization: 'o', project: 'p', team: 't' },
        cards: [],
        gone: [3],
      }),
      [],
    ],
  ])('%s: its parts let go, read anew', async (_, e, unread) => {
    const parts = recordParts({ now: () => 0 }, WAIT);
    const slow = slowly();

    await timed(withParts(slow.sources, parts));
    await Bun.sleep(SLOW + 50);
    parts.hear(e);
    expect((await timed(withParts(slow.sources, parts))).r.unread).toEqual(unread);
  });
});

describe('a finished run read back from the log store, its session and box gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abe-store-'));
  const store = fileLogStore(dir);
  const put = (login: string, session: string, name: string, text: string) =>
    store.put(
      logKey({ repo: 'o/shop', login, session }, name),
      new TextEncoder().encode(text),
      'text/plain',
    );

  test('the newest session of the card under your own login; another person’s never', async () => {
    const meta = (since: string) => JSON.stringify({ card: 2, title: 'x', since });

    await put('me', 'old', 'meta.json', meta(runAt(-500)));
    await put('me', 'old', 'run.json', JSON.stringify({ ...RUN_STORED, session: 'old' }));
    await put('me', RUN_STORED.session, 'meta.json', meta(runAt(41)));
    await put('me', RUN_STORED.session, 'run.json', JSON.stringify(RUN_STORED));
    await put('me', RUN_STORED.session, 'transcript.jsonl', RUN_STORED_TRANSCRIPT);
    await put('me', RUN_STORED.session, 'verify/1-after.md', RUN_VERIFY_REPORT);
    // its HTML report as serve kept it, sanitised
    await put(
      'me',
      RUN_STORED.session,
      'verify/1-after.html',
      verifyHtmlText(verifyHtmlOf(RUN_VERIFY_HTML)),
    );
    // a teammate's newer run of the same card
    await put('ana', 'theirs', 'meta.json', meta(runAt(90)));
    await put('ana', 'theirs', 'run.json', JSON.stringify({ ...RUN_STORED, session: 'theirs' }));

    const found = await storedRun(store, { repo: 'o/shop', login: 'me' }, 2);

    expect(found.ok && found.data?.run.session).toBe(RUN_STORED.session);
    expect(found.ok ? [...(found.data?.files.keys() ?? [])].sort() : []).toEqual([
      'transcript.jsonl',
      'verify/1-after.html',
      'verify/1-after.md',
    ]);
    const none = await storedRun(store, { repo: 'o/shop', login: 'me' }, 3);

    expect(none).toEqual({ ok: true, data: null });

    // another clone of the same origin on this machine ran a newer one: that clone's, not here's
    const clone = mkdtempSync(join(tmpdir(), 'abe-clone-'));

    await put(
      'me',
      'clone',
      'meta.json',
      JSON.stringify({ card: 2, since: runAt(95), repo: clone }),
    );
    await put('me', 'clone', 'run.json', JSON.stringify({ ...RUN_STORED, session: 'clone' }));
    const here = { root: dir, checkouts: [dir], github: 'o/shop' };
    const there = { root: clone, checkouts: [clone], github: 'o/shop' };

    expect(
      await Promise.all(
        [here, there].map(async (at) => {
          const f = await storedRun(store, { repo: 'o/shop', login: 'me' }, 2, at);

          return f.ok ? f.data?.run.session : f.error.code;
        }),
      ),
    ).toEqual([RUN_STORED.session, 'clone']);

    const got = await readRunRecord(
      sources(found.ok ? { ok: true, data: found.data } : found),
      2,
      AT,
    );

    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data.source).toBe('record');
    // its worktree gone: Changed from its steps' files
    expect(got.data.changed).toBeNull();
    expect(got.data.run).toEqual(runData(RUN_STORED, undefined));
    expect(got.data.steps.map((s) => s.id)).toEqual(RUN_RECORD_DONE.steps.map((s) => s.id));
    expect(got.data.steps.find((s) => s.id === 'build:1')?.summary).toBe(
      'Line total = price × quantity; the API tests pass.',
    );
    expect(got.data.criteria.map((c) => [c.mark, c.chapter])).toEqual([
      ['pass', '0:03'],
      ['pass', '0:19'],
      ['pass', '0:33'],
    ]);
    // the After pass's verdicts and its HTML report, read back as the kit's parts
    expect(got.data.features.map((f) => [f.feature, f.verdict])).toEqual([
      ['cart', 'pass'],
      ['checkout', 'pass'],
      ['search', 'not-driven'],
    ]);
    expect(got.data.report).toEqual({
      features: RUN_RECORD_DONE.report?.features ?? [],
      stripped: [],
    });
    expect(RUN_DONE.stage).toBe('done');
  });
});

describe('abe factory record through the CLI seam', () => {
  let s: ServeScenario | undefined;
  const doc = (reply: Reply) =>
    z
      .union([
        z.object({ ok: z.literal(true), data: RunRecordData }),
        z.object({
          ok: z.literal(false),
          error: z.object({ code: z.string(), message: z.string() }),
        }),
      ])
      .parse(JSON.parse(reply.stdout));

  afterAll(async () => {
    await s?.close();
  });

  test('not a card: usage; a card with no run of yours: no-run', async () => {
    s = await scenario();
    const bad = await s.request('factory', 'record', 'x', '--json');

    expect(bad.exit).toBe(2);
    const none = doc(await s.request('factory', 'record', '2', '--json'));

    expect(none.ok ? 'ok' : none.error.code).toBe('no-run');
  });
});
