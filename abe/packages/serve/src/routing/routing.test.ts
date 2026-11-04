/**
 * Ports at a checkout, through `openRouting` on fakes and Local mode's held decorators: per
 * checkout and Local mode, which writes are held on this Mac and which go out, and as whom.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  type Aws,
  type BoardRef,
  type Git,
  type HeldWrite,
  type LayerPulls,
  Repo,
  type Tracking,
} from '@abe/core';
import {
  fakeClock,
  fakePipelines,
  fakeReview,
  refusingAws,
  refusingBoard,
  refusingSecrets,
  refusingTracking,
} from '@abe/testing';
import { type LocalMode, openLocalMode } from '../local-mode';
import { type SettingsService, startSettings } from '../settings';
import { openRouting, type Routing, type RunAt } from '.';

let root: string;
let settings: SettingsService;
let routing: Routing;
let held: HeldWrite[];
let localMode: LocalMode;
let runs: RunAt[];

const write = (path: string, text: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};

/** GitHub as `who`: every write refused naming who would have sent it. */
const githubOf = (who: string): Tracking => ({
  ...refusingTracking(),
  issueComment: () =>
    Promise.resolve({ ok: false, error: { code: 'gh-failed', message: `as ${who}` } }),
});
/** Serve's own AWS and yours on each profile, told apart by which they are. */
const awsBy = new Map<string, Aws>([['own', refusingAws()]]);
const awsOf = (profile: string): Aws => {
  const made = awsBy.get(profile) ?? refusingAws();

  awsBy.set(profile, made);

  return made;
};

/** Each write that went out, by port: a held one never reaches these. */
const sent: string[] = [];
const pipelines = fakePipelines();
const review = fakeReview();
const nothing = { ok: false, error: { code: 'gh-failed', message: 'no GitHub' } } as const;
const git: Git = {
  origin: () => Promise.resolve({ ok: true, data: { url: 'x', defaultBranch: 'main' } }),
  push: () => {
    sent.push('push');

    return Promise.resolve({ ok: true, data: null });
  },
  fetchOrigin: () => Promise.resolve({ ok: true, data: null }),
  onOrigin: () => Promise.resolve({ ok: true, data: true }),
  startAt: () => Promise.resolve({ ok: true, data: { moved: false } }),
  work: () => Promise.resolve({ ok: true, data: null }),
  remove: () => Promise.resolve({ ok: true, data: null }),
  tidyWriters: () => Promise.resolve({ ok: true, data: { removed: [], deleted: [] } }),
};
const layerPulls: LayerPulls = {
  base: () => Promise.resolve(nothing),
  show: () => Promise.resolve(nothing),
  propose: () => {
    sent.push('propose');

    return Promise.resolve({ ok: true, data: { number: 1, url: 'u' } });
  },
  open: () => Promise.resolve(nothing),
};

const BOARD: BoardRef = {
  organization: 'https://dev.azure.com/demo',
  project: 'Shop',
  team: 'Web',
  types: ['User Story'],
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-routing-')));
  for (const dir of ['held', 'plain', 'readonly', 'mine-gh', 'a', 'b'])
    mkdirSync(join(root, dir, '.git'), { recursive: true });
  // no repo at all: a Terminal elsewhere
  mkdirSync(join(root, 'elsewhere'));
  // a card's worktree beside the checkout in local mode
  write('held-wt/7/.git', `gitdir: ${join(root, 'held', '.git', 'worktrees', '7')}\n`);
  write('a-wt/7/.git', `gitdir: ${join(root, 'a', '.git', 'worktrees', '7')}\n`);
  write(
    'mine/settings.yaml',
    `localMode: [${['held', 'a', 'b'].map((d) => join(root, d)).join(', ')}]\nboardReadOnly: [${join(root, 'readonly')}]\n`,
  );
  // card 9's run is in the checkout in local mode; two checkouts (one board) each run card 7
  runs = [
    { card: 9, repo: join(root, 'held'), outcome: null },
    { card: 7, repo: join(root, 'a'), outcome: null },
    { card: 7, repo: join(root, 'b'), outcome: null },
  ];
  write('mine-gh/.abe/settings.local.yaml', 'logins.gh: me-work\nbox:\n  profile: shop\n');
  settings = startSettings({
    places: { configDir: join(root, 'mine'), home: root },
    emit: () => undefined,
    every: 3_600_000,
  });
  held = [];
  localMode = openLocalMode({
    stateDir: join(root, 'state'),
    clock: fakeClock(),
    settings,
    merge: undefined,
    emitHeld: (w) => held.push(w),
    emitPr: () => undefined,
  });

  routing = openRouting({
    settings,
    localMode,
    tracking: githubOf('gh'),
    githubAs: (account) => ({ tracking: githubOf(account) }),
    board: refusingBoard(),
    pipelines,
    review,
    layerPulls,
    gitOf: () => git,
    aws: awsOf('own'),
    secrets: refusingSecrets(),
    awsAs: (profile) => ({
      aws: awsOf(profile),
      secrets: refusingSecrets(),
      reach: () => ({ profile, region: null }),
    }),
    boxProfile: { own: null, pinned: false },
    runs: () => runs,
  });
});

afterAll(() => {
  settings.stop();
  rmSync(root, { recursive: true, force: true });
});

/** What became of a write: held here, or sent (and as whom). */
const fate = (r: { ok: boolean; error?: { code: string; message: string } }) => {
  if (r.ok) return 'held';

  return r.error?.message.startsWith('as ') === true ? r.error.message : 'sent';
};

type Fates = {
  issue: string;
  card: string;
  push: string;
  pipeline: string;
  review: string;
  propose: string;
  aws: string;
};

const ALL_HELD = { push: 'held', pipeline: 'held', review: 'held', propose: 'held' };
const ALL_SENT = { push: 'sent', pipeline: 'sent', review: 'sent', propose: 'sent' };

describe('which writes are held, per checkout and Local mode', () => {
  test.each<[string, string | undefined, number, Fates]>([
    [
      'a checkout in no local mode: all go out, as gh',
      'plain',
      4,
      { issue: 'as gh', card: 'sent', ...ALL_SENT, aws: 'own' },
    ],
    [
      'a checkout in local mode: all held',
      'held',
      4,
      { issue: 'held', card: 'held', ...ALL_HELD, aws: 'own' },
    ],
    [
      "a card's worktree beside it: its checkout's, held",
      'held-wt/7',
      4,
      { issue: 'held', card: 'held', ...ALL_HELD, aws: 'own' },
    ],
    [
      'a read-only board alone: the board held, the rest out',
      'readonly',
      4,
      { issue: 'as gh', card: 'held', ...ALL_SENT, aws: 'own' },
    ],
    [
      "a card whose run is in local mode, typed outside any checkout: its card's board held",
      'elsewhere',
      9,
      { issue: 'as gh', card: 'held', ...ALL_SENT, aws: 'own' },
    ],
    [
      'your gh login and box profile there: out as them',
      'mine-gh',
      4,
      { issue: 'as me-work', card: 'sent', ...ALL_SENT, aws: 'shop' },
    ],
    [
      'inside a workspace (no checkout): out as serve',
      undefined,
      4,
      { issue: 'as gh', card: 'sent', ...ALL_SENT, aws: 'own' },
    ],
  ])('%s', async (_, here, card, want) => {
    const ports = routing.at({
      here: here === undefined ? undefined : join(root, here),
      card: undefined,
      reviewAt: undefined,
    });
    const went = (port: string, before: number) =>
      sent.slice(before).includes(port) ? 'sent' : 'held';
    const writes = (n: number, then: () => number) => (then() > n ? 'sent' : 'held');
    const issue = await ports.tracking.issueComment(
      { repo: Repo.parse('acme/shop'), number: 3 },
      'hi',
    );
    const comment = await ports.board.comment(BOARD, card, 'hi');
    const before = sent.length;

    await ports.git?.(card).push('/w', 'card/4');
    const push = went('push', before);
    const ran = pipelines.writes.length;

    await ports.pipelines?.control(
      { provider: 'github-actions', repo: 'acme/shop' },
      '1',
      1,
      'rerun',
    );
    const pipeline = writes(ran, () => pipelines.writes.length);
    const reviewed = review.writes.length;

    await ports.review?.submit('acme/shop', {
      submission: 's',
      reconcileOnly: false,
      pr: 3,
      commit: 'c',
      verdict: 'Comment',
      comments: [],
    });
    const submitted = writes(reviewed, () => review.writes.length);
    const proposed = sent.length;

    await ports.layerPulls?.propose({
      repo: Repo.parse('acme/layer'),
      base: { branch: 'main', sha: 'a' },
      branch: 'b',
      title: 't',
      body: 'b',
      message: 'm',
      label: null,
      files: [],
    });
    expect({
      issue: fate(issue),
      card: fate(comment),
      push,
      pipeline,
      review: submitted,
      propose: went('propose', proposed),
      aws: [...awsBy].find(([, a]) => a === ports.aws)?.[0],
    }).toEqual(want);
  });
});

describe('a card with runs in two checkouts: each write held for the checkout it is for', () => {
  const at = (here: string) =>
    routing.at({ here: join(root, here), card: undefined, reviewAt: undefined });
  const runOf = (dir: string) => ({ card: 7, repo: join(root, dir) });

  test.each<[string, () => Promise<{ ok: boolean; error?: { message: string } }>, string]>([
    ['a comment typed in A: held for A', () => at('a').board.comment(BOARD, 7, 'hi'), 'a'],
    ["typed in A's card worktree: A's", () => at('a-wt/7').board.comment(BOARD, 7, 'hi'), 'a'],
    ['typed in B: held for B', () => at('b').board.comment(BOARD, 7, 'hi'), 'b'],
    [
      'typed in a checkout running no #7: its own, never a run elsewhere',
      () => at('plain').board.comment(BOARD, 7, 'hi'),
      'sent',
    ],
    [
      'typed outside any checkout: refused, held for neither',
      () => at('elsewhere').board.comment(BOARD, 7, 'hi'),
      'AB#7 has runs in <root>/a and <root>/b: type it in the checkout it is for',
    ],
    [
      "A's run moving its card: held for A",
      () => routing.run.board(runOf('a')).move(BOARD, 7, 'Active'),
      'a',
    ],
    ["B's run's push: held for B", () => routing.run.git(runOf('b')).push('/w', 'card/7'), 'b'],
    [
      "A's run's GitHub comment: held for A",
      () =>
        routing.run
          .tracking(runOf('a'))
          .issueComment({ repo: Repo.parse('acme/shop'), number: 3 }, 'hi'),
      'a',
    ],
  ])('%s', async (_, write, want) => {
    const before = held.length;
    const r = await write();
    const went = held.slice(before).map((w) => relative(root, w.checkout));

    const refusal = r.ok ? undefined : r.error?.message;
    const refused =
      refusal?.startsWith('AB#') === true ? refusal.replaceAll(root, '<root>') : 'sent';

    // a held move answers the card as it would be, read from a board that has none: still held
    expect(went.length > 0 ? went.join(', ') : refused).toBe(want);
  });

  test("Discard local changes in B drops B's board writes only, A's stay", () => {
    const b = localMode.discardBoard(join(root, 'b'));
    const a = localMode.discardBoard(join(root, 'a'));

    expect([b.ok && b.data.writes, a.ok && a.data.writes]).toEqual([1, 3]);
  });
});
