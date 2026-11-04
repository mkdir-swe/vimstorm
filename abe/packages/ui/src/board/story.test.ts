/**
 * The story's look, the Card page's and the story dialog's: its facts line, the Linked block at
 * its end (Session · PR · Box, dim while not there yet) and the dialog's one primary from
 * `nextStep` (none on a teammate's card: only `⌘⏎ more`), as rule tables.
 */
import { describe, expect, test } from 'bun:test';
import type { BoxData, FactoryRunData, SessionData } from '@abe/core';
import { factoryRun, listCard, minutes, session, X_BOXES } from '@abe/testing';
import { type CardFacts, imagesToRead, storyDialog, type StoryFacts, storyLinks } from './index';

const ROOT = '/home/me/projects/demo-shop';
const CART = listCard(2, 'The cart total ignores quantity', 'Active', 'Ada Example', {
  type: 'Bug',
  tags: ['api', 'cart'],
  description: 'The cart adds up each line’s price and ignores its quantity.',
  acceptanceCriteria: '- The total is the sum of price × quantity over every line.',
  points: 3,
});
const PR: NonNullable<FactoryRunData['pr']> = {
  repo: 'mkdir-swe/demo-shop',
  number: 10,
  url: 'https://github.com/mkdir-swe/demo-shop/pull/10',
  title: 'AB#2 Count each line’s quantity in the cart total',
  state: 'open',
  merge: 'person',
  checks: 'success',
  mergeCommit: null,
  deploy: null,
  branch: null,
};
const runOn = (
  stage: FactoryRunData['stage'],
  state: FactoryRunData['state'] = 'running',
  rest: Partial<FactoryRunData> = {},
) => factoryRun(2, CART.title, stage, state, { since: minutes(1), ...rest });

/** Card 2's facts: yours, its run and session as given. */
const facts = (
  run?: FactoryRunData,
  s?: SessionData['state'],
  more: Partial<StoryFacts> = {},
): StoryFacts => ({
  card: CART,
  mine: true,
  root: ROOT,
  sprint: 'Sprint 1',
  ...(run === undefined ? {} : { run }),
  ...(s === undefined ? {} : { session: session('s2', s, 2) }),
  ...more,
});
const onBox = (f: StoryFacts, box = 'demo-shop'): StoryFacts =>
  f.session === undefined ? f : { ...f, session: { ...f.session, box } };
const SAMS: CardFacts['card'] = {
  ...CART,
  assignee: { name: 'Sam Sample', email: 'sam@example.test' },
};

/** The Linked block as `label words` lines, a dim one `(dim)`. */
const linked = (f: StoryFacts): string[] =>
  storyLinks(f).map(
    (l) =>
      `${l.label} ${l.words}${l.state === undefined ? '' : ` ${l.state}`}${l.dim ? ' (dim)' : ''}`,
  );

describe('the story dialog’s head', () => {
  test('Story · the project, #id and title, the facts line', () => {
    const p = storyDialog(facts(runOn('build'), 'working')).dialog.props;

    expect(p).toMatchObject({
      heading: 'Story · demo-shop',
      card: 2,
      title: 'The cart total ignores quantity',
      meta: ['Bug', 'Active', 'AE', '3 pt', 'Sprint 1', 'tags api, cart'],
    });
    expect(p.sections.map((s) => s.title)).toEqual(['Description', 'Acceptance criteria']);
  });

  test('the facts in their colours: Bug rose, the points blue, the tags gold after a dim tags', () => {
    const p = storyDialog(facts(runOn('build'), 'working')).dialog.props;

    expect(p.facts).toEqual([
      { text: 'Bug', tone: 'bug' },
      { text: 'Active' },
      { text: 'AE' },
      { text: '3 pt', tone: 'points' },
      { text: 'Sprint 1' },
      { text: 'api, cart', tone: 'tags', label: 'tags' },
    ]);
    // a story's type in the story hue, as its card on the Board
    const us = storyDialog({ ...facts(), card: { ...CART, type: 'User Story' } }).dialog.props;

    expect(us.facts?.[0]).toEqual({ text: 'US', tone: 'story' });
  });

  test('no project folder, no sprint, no one’s, no tags: what is known', () => {
    const p = storyDialog({
      card: { ...CART, assignee: null, tags: [], points: null },
      mine: false,
    }).dialog.props;

    expect(p.heading).toBe('Story');
    expect(p.meta).toEqual(['Bug', 'Active', 'unassigned']);
  });
});

describe('Linked: Session · PR · Box, dim while not there yet, no Run row', () => {
  test.each([
    ['', {}, 'Box none · Local sandbox (dim)'],
    [', your boxes off: no box comes', { boxesOff: true }, 'Box off · runs on this machine (dim)'],
  ])('a local session running in Build%s: Session shown, PR and Box dim', (_, o, box) => {
    expect(linked({ ...facts(runOn('build'), 'working'), ...o })).toEqual([
      'Session Local sandbox',
      'PR none yet (dim)',
      box,
    ]);
  });

  test('no run: every row dim', () => {
    expect(linked(facts())).toEqual([
      'Session none yet (dim)',
      'PR none yet (dim)',
      'Box none yet (dim)',
    ]);
    expect(storyLinks(facts()).every((l) => l.opens === null)).toBe(true);
  });

  test('on a box with a pull request: the box with its state, the pull request', () => {
    const f = onBox(facts(runOn('pr', 'running', { pr: PR }), 'working'), 'demo-shop');

    expect(linked(f)).toEqual([
      'Session demo-shop',
      'PR #10 AB#2 Count each line’s quantity in the cart total',
      'Box ☁ demo-shop #2 · running',
    ]);
    // a pull request read before its title was kept: its number and state
    expect(
      linked(
        onBox(facts(runOn('pr', 'running', { pr: { ...PR, title: undefined } }), 'working')),
      )[1],
    ).toBe('PR #10 · open');
    expect(linked({ ...f, boxes: { 'demo-shop': 'stopped' } }).at(-1)).toBe(
      'Box ☁ demo-shop #2 · asleep',
    );
  });

  test.each<[string, Partial<BoxData>, number, string]>([
    [
      'a booting box the list names: starting, booting',
      { card: 2, serve: 'silent' },
      1,
      'Box demo-5 · booting',
    ],
    [
      'the card’s tagged box asleep',
      { state: 'stopped', card: 2, serve: null },
      0,
      'Box demo-5 · asleep',
    ],
  ])('no session, its box by its card tag in box list: %s', (_, o, up, box) => {
    const listed = X_BOXES.box('demo-5', { launchedAt: minutes(up), costToday: null, ...o });

    expect(
      linked({
        ...facts(),
        boxList: { boxes: [listed], queued: [] },
        now: Date.parse(minutes(6)),
      }).at(-1),
    ).toBe(box);
  });

  test('an ended session says so', () => {
    expect(linked(facts(runOn('build'), 'ended'))[0]).toBe('Session Local sandbox · ended');
  });

  test('a session you stopped: stopped on the Session row', () => {
    const f = facts(runOn('build', 'needs-you'), 'ended');
    const stopped = {
      ...f,
      ...(f.session === undefined ? {} : { session: { ...f.session, stopped: true } }),
    };

    expect(linked(stopped)[0]).toBe('Session Local sandbox · stopped');
  });

  test('a run under your Override: the Session row says which', () => {
    const run = runOn('build', 'running', {
      personal: [
        { key: 'autoMerge', value: true, shown: 'on', reason: 'my sandbox', since: null },
        { key: 'checks', value: ['tests'], shown: 'tests', reason: 'spike', since: null },
      ],
    });

    expect(linked(facts(run, 'working'))[0]).toBe(
      'Session Local sandbox Override · autoMerge on · +1',
    );
    expect(storyLinks(facts(run, 'working'))[0]).toMatchObject({ hue: 'accent' });
  });

  test('a merged pull request on Done: good', () => {
    const done = runOn('done', 'done', { pr: { ...PR, state: 'merged' } });

    expect(storyLinks(facts(done, 'ended'))[1]).toMatchObject({
      // its title; merged is the hue's to say
      words: '#10 AB#2 Count each line’s quantity in the cart total',
      hue: 'good',
      dim: false,
    });
  });

  test('a click opens what a row names: the session, the page, the box', () => {
    const f = onBox(facts(runOn('pr', 'running', { pr: PR }), 'working'));

    expect(storyLinks(f).map((l) => l.opens)).toEqual([
      { kind: 'sessions', ids: ['s2'] },
      { kind: 'url', url: PR.url },
      { kind: 'box', name: 'demo-shop', card: 2 },
    ]);
  });

  test('drawn as the dialog’s linked chips, a dim one with no click', () => {
    const p = storyDialog(facts(runOn('build'), 'working')).dialog.props;

    expect(p.linked).toEqual([
      { id: 'dialog:linked:session', label: 'Session', words: 'Local sandbox' },
      { id: 'dialog:linked:pr', label: 'PR', words: 'none yet', dim: true },
      { id: 'dialog:linked:box', label: 'Box', words: 'none · Local sandbox', dim: true },
    ]);
  });
});

describe('one primary from nextStep, `⌘⏎ more` always', () => {
  const primary = (f: StoryFacts) => {
    const p = storyDialog(f).dialog.props;

    expect(p.hint).toEndWith('⌘⏎ more');

    return p.buttons.filter((b) => b.primary === true).map((b) => `${b.label} ${b.keys ?? ''}`);
  };

  test.each([
    ['your card, no session', facts(), ['Launch agent ⏎']],
    ['a session running', facts(runOn('build'), 'working'), ['Open workspace ⏎']],
    ['a session needing you', facts(runOn('build', 'needs-you'), 'waiting'), ['Open workspace ⏎']],
    // ⏎ on any ended session of yours reopens it
    ['ended before Done', facts(runOn('build'), 'ended'), ['Reopen ⏎']],
    ['its run failed (#221)', facts(runOn('build', 'needs-you'), 'ended'), ['Reopen ⏎']],
    [
      'Done with a pull request',
      facts(runOn('done', 'done', { pr: PR }), 'ended'),
      ['Open pull request ⏎'],
    ],
    ['Done with none', facts(runOn('done', 'done'), 'ended'), ['Reopen ⏎']],
    ['a teammate’s card', facts(undefined, undefined, { card: SAMS, mine: false }), []],
    [
      'a card no one has',
      facts(undefined, undefined, { card: { ...SAMS, assignee: null }, mine: false }),
      ['Assign to me and launch ⏎'],
    ],
    [
      'a card no one has on a read-only board',
      facts(undefined, undefined, {
        card: { ...SAMS, assignee: null },
        mine: false,
        readOnly: true,
      }),
      [],
    ],
    [
      'a teammate’s running card',
      facts(runOn('build'), 'working', { card: SAMS, mine: false }),
      [],
    ],
  ])('%s', (_, f, want) => {
    expect(primary(f)).toEqual(want);
  });

  test('no primary: why, in the dialog, before `⌘⏎ more`', () => {
    expect(
      storyDialog(facts(undefined, undefined, { card: SAMS, mine: false })).dialog.props.hint,
    ).toBe('assigned to Sam Sample · ⌘⏎ more');
  });

  test('the footer has no More button: `⌘⏎ more` is the hint', () => {
    expect(storyDialog(facts()).dialog.props.buttons.map((b) => b.id)).toEqual(['dialog:primary']);
  });
});

describe('Linked on a run that never got a box', () => {
  const never = (f: StoryFacts): StoryFacts =>
    f.session === undefined ? f : { ...f, session: { ...f.session, neverPlaced: true } };

  test('Session never got a box · ended; Box none, dim, opening nothing', () => {
    const f = never(onBox(facts(runOn('spec', 'needs-you'), 'ended')));
    const links = storyLinks(f);

    expect(linked(f)).toEqual([
      'Session never got a box · ended',
      'PR none yet (dim)',
      'Box none · never got a box (dim)',
    ]);
    expect(links[2]?.opens).toBeNull();
  });
});

describe('the images to read, and the Comments once card show answers', () => {
  const A = 'https://dev.azure.com/demo-org/Shop/_apis/wit/attachments/a';
  const B = 'https://dev.azure.com/demo-org/Shop/_apis/wit/attachments/b';

  test('the text’s and the comments’ images, each once, not those answered', () => {
    expect(
      imagesToRead({
        text: { description: `![](${A})`, acceptanceCriteria: `![x](${B}) ![](/local.png)` },
        comments: [{ id: 1, by: 'Sam', at: '2026-10-20T09:00:00.000Z', text: `again ![](${A})` }],
        images: { [B]: null },
      }),
    ).toEqual([A]);
  });

  test('no read yet: the Comments are not drawn at all (the Sessions screen reads none)', () => {
    expect(storyDialog(facts()).dialog.props.comments).toBeUndefined();
  });
});
