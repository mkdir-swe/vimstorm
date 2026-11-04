/**
 * The Run place at the screen's seam: what it reads, the steps and the focus pane it draws from
 * `factory record`'s answer, its keys and clicks, and which events read it again.
 */
import { describe, expect, test } from 'bun:test';
import { type Event, Event as EventSchema, type RunRecordData } from '@abe/core';
import {
  driveRun,
  recordReplies,
  RUN_NEEDS_YOU,
  RUN_RECORD_DONE,
  RUN_RECORD_NEEDS_YOU,
  RUN_RECORD_PLAYBOOK,
  RUN_RECORD_READY,
  RUN_SESSION,
  RUN_RECORD_LIVE,
  RUN_WORKTREE,
  type Replies,
  type RunDrive,
  runAt,
} from '@abe/testing';
import { type Command, type Kind, type Node, RUN_VIEW_MENU } from '../index';
import type { RunPart } from './run-components';

const all = (n: Node): Node[] => [n, ...('children' in n ? (n.children ?? []).flatMap(all) : [])];
const find = <K extends Kind>(n: Node, kind: K): Extract<Node, { kind: K }> | undefined =>
  all(n).find((x): x is Extract<Node, { kind: K }> => x.kind === kind);
const list = (n: Node) => find(n, 'RunSteps')?.props;
const focus = (n: Node) => find(n, 'RunFocus')?.props;
const bar = (n: Node) => find(n, 'RunBar')?.props;
/** The rows as words: `✓ build round 2`, `● review 1 finding ↩`. */
const rows = (n: Node) =>
  (list(n)?.rows ?? []).map((r) =>
    [r.mark.glyph, r.name, r.outcome, r.back ? '↩' : ''].filter((w) => w !== '').join(' '),
  );
const detail = (n: Node, kind: string) => focus(n)?.details.find((d) => d.kind === kind);
/** The parts of `kind` on one side of the focus pane, in order. */
const parts = <K extends RunPart['kind']>(
  n: Node,
  side: 'read' | 'made',
  kind: K,
): Extract<RunPart, { kind: K }>[] =>
  (focus(n)?.[side].blocks ?? [])
    .flatMap((b) => b.parts)
    .filter((p): p is Extract<RunPart, { kind: K }> => p.kind === kind);
/** A side's block titles, a boxed one with its verdict. */
const titles = (n: Node, side: 'read' | 'made') =>
  (focus(n)?.[side].blocks ?? []).map((b) =>
    [b.title, b.verdict?.text ?? ''].filter((w) => w !== '').join(' '),
  );
const reads = (cs: readonly Command[]) =>
  cs.flatMap((c) => (c.kind === 'run' ? [c.argv.join(' ')] : []));

describe('what it reads and draws', () => {
  test('opened on #2: one `factory record 2`, Reading… until it answers', () => {
    const d = driveRun();

    expect(reads(d.commands)).toEqual(['factory record 2']);
    expect(find(d.tree, 'Empty')?.props.title).toBe('Reading the run…');
    expect(bar(d.tree)).toEqual({
      card: '#2',
      title: '',
      on: false,
      context: 'demo-shop',
      linked: false,
    });
  });

  test('no run of yours: says why', () => {
    const d = driveRun().answer(
      recordReplies({ code: 'no-run', message: 'AB#2 has no Factory run of yours' }),
    );

    expect(find(d.tree, 'Empty')?.props).toEqual({
      title: 'No run to show for #2',
      line: 'AB#2 has no Factory run of yours',
    });
  });

  test.each([
    ['the card named', { card: '2' }, 'factory record 2'],
    [
      'the shown workspace’s branch',
      { root: '/wt/7', branch: 'card/7-saved-carts' },
      'factory record 7',
    ],
  ])('opened on %s', (_, params, argv) => {
    expect(reads(driveRun({ params }).commands)).toEqual([argv]);
  });

  test('another workspace shown: its card’s run', () => {
    const d = driveRun()
      .answer()
      .send({ kind: 'root', root: '/wt/7', branch: 'card/7-saved-carts' });

    expect(reads(d.commands)).toEqual(['factory record 7']);
    expect(find(d.tree, 'Empty')?.props.title).toBe('Reading the run…');
  });

  describe('another workspace and back: its last record at once, read anew behind it', () => {
    const SEVEN: RunRecordData = { ...RUN_RECORD_DONE, card: 7, title: 'Saved carts' };
    const both: Replies = (a) => recordReplies(a.argv[2] === '7' ? SEVEN : RUN_RECORD_LIVE)(a);
    const refused = recordReplies({ code: 'down', message: 'serve did not answer' });
    const to = (card: 2 | 7) =>
      card === 2
        ? { kind: 'root' as const, root: RUN_WORKTREE, branch: 'card/2-cart-total' }
        : { kind: 'root' as const, root: '/wt/7', branch: 'card/7-saved-carts' };
    const there = () => driveRun().answer(both).send(to(7));

    test.each<[string, () => RunDrive, string, string[]]>([
      ['a card never read: Reading the run…', there, '', ['factory record 7']],
      [
        'back to #2: its record at once, its read out',
        () => there().answer(both).send(to(2)),
        RUN_RECORD_LIVE.title,
        ['factory record 2'],
      ],
      [
        'its read answered: the record anew',
        () => there().answer(both).send(to(2)).answer(both),
        RUN_RECORD_LIVE.title,
        [],
      ],
      [
        'its read refused: the record stays',
        () => there().answer(both).send(to(2)).answer(refused),
        RUN_RECORD_LIVE.title,
        [],
      ],
      [
        'away before #7 answered, back: #7 drawn at once',
        () => there().send(to(2)).answer(both).send(to(7)),
        SEVEN.title,
        ['factory record 7'],
      ],
    ])('%s', (_, drive, title, out) => {
      const d = drive();

      expect(bar(d.tree)?.title).toBe(title);
      expect(find(d.tree, 'Empty')?.props.title === 'Reading the run…').toBe(title === '');
      expect(reads(d.commands)).toEqual(out);
    });
  });

  test('no card (the main checkout): nothing to read', () => {
    const d = driveRun({ params: {} });

    expect(reads(d.commands)).toEqual([]);
    expect(find(d.tree, 'Empty')?.props.title).toBe('Run');
  });

  test('live: the run in time order, the keys on the live step, the steps not reached dim', () => {
    const d = driveRun().answer();

    expect(rows(d.tree)).toEqual([
      '✓ create-specification',
      '✓ build',
      '● checks failed ↩',
      '● build',
      'checks',
      'review',
      'verify',
      'playbook',
      'pr',
    ]);
    expect(list(d.tree)?.selected).toBe('build:2');
    expect(bar(d.tree)).toMatchObject({
      card: '#2',
      title: 'The cart total ignores quantity',
      context: 'demo-shop · Feature run · Local sandbox · 19 min so far',
    });
  });

  test('a round: its skill, ⟲ fresh, its round, who sent it back and with what', () => {
    const d = driveRun({ now: runAt(50) })
      .answer(recordReplies(RUN_RECORD_DONE))
      .click('run:step:build:3');

    expect(focus(d.tree)).toMatchObject({
      name: 'build',
      skill: 'implement',
      state: { text: '✓ done', hue: 'good' },
      fresh: true,
      round: 'round 3 of 3',
      back: 'sent back from review · round 1',
      carried: {
        head: 'Sent back with · from review · round 1',
        items: [
          '1. api/src/cart.ts:14 · The total sums floats: 3 × 24.99 gives 74.97000000000001 → sum in cents, then divide once',
        ],
      },
      did: 'Summed in cents; a test for 3 × 24.99 added.',
    });
    expect(parts(d.tree, 'read', 'decisions')[0]?.rows).toHaveLength(3);
    expect(parts(d.tree, 'made', 'lanes')[0]?.lanes[0]).toMatchObject({
      label: 'Fix',
      cards: [{ ref: 'finding 1', title: 'Review round 1', time: '3 min' }],
    });
    // the first round started fresh only on its loop back: not fresh
    expect(focus(d.click('run:step:build:1').tree)).toMatchObject({ fresh: false, back: '' });
  });

  test('waiting on you: its row, the keys on it, its question and answers; a skipped gate a row', () => {
    const d = driveRun({ now: runAt(38) }).answer(recordReplies(RUN_RECORD_NEEDS_YOU));

    expect(rows(d.tree).slice(-4)).toEqual([
      '✓ review no findings',
      '✓ verify 3 of 3',
      '– playbook skipped',
      '◆ pr needs you',
    ]);
    expect(list(d.tree)?.selected).toBe('pr:1');
    expect(focus(d.tree)).toMatchObject({
      meta: '09:34 · waiting 2 min',
      state: { text: '◆ needs you', hue: 'needs-you' },
      ask: { question: RUN_NEEDS_YOU.reason ?? '', options: ['Pushed, go on'] },
      actions: [{ id: 'run:chat:pr:1', label: 'Answer in Chat', primary: true }],
    });
    const skipped = d.click('run:step:skipped:playbook:0').tree;

    expect(focus(skipped)).toMatchObject({
      name: 'playbook',
      state: { text: '– skipped', hue: 'dim' },
    });
    expect(parts(skipped, 'read', 'text')[0]?.text).toContain(
      'No: The diff changes cartTotal() and its tests; nothing to run by hand.',
    );
    expect(titles(skipped, 'made')).toEqual(['Skipped – skipped']);
    // no `g` jump to it (`gg` / `G` only): `:`'s Go to Needs you is the way back
    expect(list(d.keys('g', 'g', 'g', 'n').tree)?.selected).toBe('spec:1');
  });

  test('done: the last Verify reads the criteria, makes the kit; the merge the result', () => {
    const d = driveRun({ now: runAt(50) }).answer(recordReplies(RUN_RECORD_DONE));

    expect(focus(d.tree)).toMatchObject({
      name: 'merge',
      actions: [{ id: 'run:pr', label: 'Open PR #57', primary: true }],
    });
    expect(parts(d.tree, 'made', 'facts')[0]?.rows).toEqual([
      { label: 'Result', value: 'Merged, on test: 3 of 3 criteria verified.' },
      { label: 'Changed', value: '3 files · +37 −9' },
    ]);
    const verify = d.click('run:step:verify:1').tree;

    expect(parts(verify, 'read', 'criteria')[0]?.rows.map((c) => c.mark.glyph)).toEqual([
      '✓',
      '✓',
      '✓',
    ]);
    expect(parts(verify, 'made', 'kit')[0]?.features.map((f) => f.verdict)).toEqual([
      'Pass',
      'Pass',
      'Not driven',
    ]);
    expect(detail(verify, 'report')).toBeUndefined();
  });

  test.each<[string, string, string[], string[]]>([
    [
      'build: one lane per writer by wave, the milestone, the checks it ran itself',
      'build:1',
      ['', 'Spec #41', 'Decisions it took'],
      ['', 'Checks run itself ✗ red', 'Files changed · 2'],
    ],
    [
      'checks: abe.yaml’s checks and the env, each result, lint red',
      'checks:1',
      ['abe.yaml · checks', 'Env it ran with'],
      ['Checks ✗ red · 1 failed'],
    ],
    [
      'review: the diff and the round, its finding fixed in build #3, one noted, the risk',
      'review:1',
      ['Diff since the merge base', 'Spec', 'Round'],
      ['Findings · 1 ● sent back', 'Noted · 1', 'Risk', 'Recorded'],
    ],
    [
      'the second review: the earlier finding found fixed, the regression named',
      'review:2',
      ['Diff since the merge base', 'Spec', 'Round'],
      ['Findings · 0 ✓ clean', 'Earlier findings · 1', 'Risk · regression', 'Recorded'],
    ],
    [
      'pr: the branch, its commits, the notes; the ladder, the pull request, its body',
      'pr:1',
      ['Branch', 'Commits · 4', 'Review notes', 'Verify · for the pull request'],
      ['', '', 'AB#2 Count each line’s quantity in the cart total ✓ merged', ''],
    ],
  ])('%s', (_, step, read, made) => {
    const t = driveRun({ now: runAt(50) })
      .answer(recordReplies(RUN_RECORD_DONE))
      .click(`run:step:${step}`).tree;

    expect([titles(t, 'read'), titles(t, 'made')]).toEqual([read, made]);
  });

  test('review: each finding where it is, what is wrong, its fix and its state', () => {
    const t = driveRun({ now: runAt(50) })
      .answer(recordReplies(RUN_RECORD_DONE))
      .click('run:step:review:1').tree;

    expect(parts(t, 'made', 'findings')[0]?.rows).toEqual([
      {
        axis: { text: 'Standards', hue: 'accent' },
        loc: 'api/src/cart.ts:14',
        what: 'The total sums floats: 3 × 24.99 gives 74.97000000000001',
        fix: 'sum in cents, then divide once',
        state: { text: '✓ fixed in build #3 · f6b2d09', hue: 'good' },
      },
    ]);
    expect(focus(t)?.loop).toEqual({
      head: '↩ back to build',
      words: [
        'loop review → build',
        'review.findings > 0',
        'round 1 of max 2',
        'carries review.findings',
      ],
    });
  });

  test('checks: a red check’s output tail, the env by name only', () => {
    const t = driveRun({ now: runAt(50) })
      .answer(recordReplies(RUN_RECORD_DONE))
      .click('run:step:checks:1').tree;
    const lint = parts(t, 'made', 'checks')[0]?.rows.find((r) => r.name === 'lint');

    expect(lint).toMatchObject({ red: true, exit: 'exit 1', command: 'npm run lint' });
    expect(lint?.output).toContain(
      "  3:10  error  'formatPrice' is defined but never used  no-unused-vars",
    );
    expect(parts(t, 'read', 'text')[0]?.text).toBe(
      'the dev env file · CI · DATABASE_URL · HOME · PATH · TMPDIR · USER',
    );
  });
});

describe('its keys and clicks', () => {
  const live = () => driveRun().answer();
  const done = () => driveRun({ now: runAt(50) }).answer(recordReplies(RUN_RECORD_DONE));

  test.each<[string, string[], string | undefined]>([
    ['l up from the live step', ['l'], 'checks:1'],
    ['ö at the end stays (the steps not reached take no keys)', ['ö'], 'build:2'],
    ['gg the first', ['g', 'g'], 'spec:1'],
    ['G the last', ['l', 'l', 'G'], 'build:2'],
    ['l on the first: onto #2', ['g', 'g', 'l'], undefined],
    ['ö from #2: the first again', ['g', 'g', 'l', 'ö'], 'spec:1'],
  ])('%s', (_, keys, selected) => {
    expect(list(live().keys(...keys).tree)?.selected).toBe(selected);
  });

  test('#2 opens the full card: ⏎ with the keys on it, or a click', () => {
    const d = live().keys('g', 'g', 'l');

    expect(bar(d.tree)?.on).toBe(true);
    expect(d.keys('<CR>').commands.at(-1)).toEqual({ kind: 'jump', to: 'story', story: 2 });
    expect(live().click('run:card').commands.at(-1)).toEqual({
      kind: 'jump',
      to: 'story',
      story: 2,
    });
  });

  test('⏎ on a step unfolds its details, again folds them; a click flips one', () => {
    const d = done().click('run:step:verify:1');
    const open = () => focus(d.tree)?.details.map((x) => x.open);

    expect(open()).toEqual([false, false]);
    expect((d.keys('<CR>'), open())).toEqual([true, true]);
    expect((d.keys('<CR>'), open())).toEqual([false, false]);
    expect((d.click('run:detail:verify:1:scratch'), open())).toEqual([true, false]);
  });

  test('Open in Chat: Chat at the step’s point, beside the run', () => {
    const d = live().click('run:chat:checks:1');

    expect(d.commands).toEqual([
      {
        kind: 'open',
        screen: 'chat',
        slot: 'chat',
        params: { card: '2', session: RUN_SESSION, at: 'a6' },
      },
      { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
    ]);
  });

  test.each<[string, number, string, 'row' | 'column']>([
    ['wide: the steps beside the step, the spec beside it', 1400, '<C-s>', 'row'],
    ['Chat docked in a narrow window: the steps over the step', 264, '', 'column'],
    ['the spec leaving the step too little: each under the other', 900, '<C-s>', 'column'],
  ])('the Run pane by its own width: %s', (_, width, key, direction) => {
    const d = driveRun({ size: { width, height: 800 }, now: runAt(50) }).answer(
      recordReplies(RUN_RECORD_DONE),
    );
    const t = key === '' ? d.tree : d.keys(key).tree;
    const body = all(t).find(
      (n) => n.kind === 'Stack' && n.children.some((c) => c.kind === 'RunSteps'),
    );

    expect(body?.kind === 'Stack' ? body.props.direction : undefined).toBe(direction);
  });

  test('⌃S the spec beside the focus pane, Esc closes it', () => {
    const d = done().keys('<C-s>');

    expect(find(d.tree, 'RunSpecPane')?.props.title).toBe("Cart total counts each line's quantity");
    expect(find(d.tree, 'RunSpecPane')?.props.body).not.toContain('Acceptance criteria');
    expect(find(d.keys('<Esc>').tree, 'RunSpecPane')).toBeUndefined();
  });

  test('expand: the shell maximizes the main area; Esc with the spec shut is the shell’s', () => {
    const d = live().click('run:expand');

    expect(d.commands.at(-1)).toEqual({ kind: 'shell', effect: { kind: 'expand' } });
    d.keys('<Esc>');
    expect(d.commands.at(-1)).toEqual({
      kind: 'shell',
      effect: { kind: 'unhandled', slot: 'main', key: '<Esc>' },
    });
  });

  test('a criterion’s proof: the last Verify, its evidence on its Made side', () => {
    const t = done().click('run:proof:2').tree;

    expect(list(t)?.selected).toBe('verify:1');
    expect(parts(t, 'made', 'kit')).toHaveLength(1);
  });

  test('`:` on Run (#11): Ask about its card; its rows, each chosen as its key or click', () => {
    const d = done();
    const choose = (row: string) => d.send({ kind: 'choice', menu: RUN_VIEW_MENU, row });

    expect(d.here?.subject).toMatchObject({ label: '#2', ask: ['--card', '2'] });
    expect(d.here?.view?.menu.rows.map((r) => [r.text, r.key])).toEqual([
      ['Open #2', undefined],
      ['Spec', '⌃S'],
      ['Open PR #57', undefined],
      ['Linked', '⌃L'],
      ['Expand', '⌥⌘⏎'],
    ]);
    expect(choose('card').commands.at(-1)).toEqual({ kind: 'jump', to: 'story', story: 2 });
    expect(find(choose('spec').tree, 'RunSpecPane')).toBeDefined();
    expect(choose('linked').commands.at(-1)).toEqual({ kind: 'jump', to: 'linked', story: 2 });
    expect(choose('expand').commands.at(-1)).toEqual({ kind: 'shell', effect: { kind: 'expand' } });
    const waits = driveRun({ now: runAt(38) })
      .answer(recordReplies(RUN_RECORD_NEEDS_YOU))
      .keys('g', 'g');

    expect(waits.here?.view?.menu.rows.map((r) => r.id)).toContain('needs-you');
    expect(
      list(waits.send({ kind: 'choice', menu: RUN_VIEW_MENU, row: 'needs-you' }).tree)?.selected,
    ).toBe('pr:1');
  });

  test('Linked ▾: the card’s Linked popup (a jump), the button up until the keys come back', () => {
    const d = live().click('run:linked');

    expect(d.commands.at(-1)).toEqual({ kind: 'jump', to: 'linked', story: 2 });
    expect(bar(d.tree)?.linked).toBe(true);
    expect(bar(d.send({ kind: 'focus', focused: true }).tree)?.linked).toBe(false);
  });

  test('a file’s diff on click, off on the next', () => {
    const d = live().click('run:step:build:1').click('run:file:build:1:0');
    const lines = () => parts(d.tree, 'made', 'files')[0]?.rows[0]?.lines;

    expect(lines()?.[0]).toBe(' export const cartTotal = (lines: Line[]) =>');
    d.click('run:file:build:1:0');
    expect(lines()).toBeUndefined();
  });

  test('a scratch file opens in the Editor', () => {
    const d = done().click('run:scratch:verify:1:1');

    expect(d.commands).toEqual([
      {
        kind: 'shell',
        effect: { kind: 'open-file', path: `${RUN_WORKTREE}/verify/evidence/after-2.png` },
      },
    ]);
  });

  test('a recording with its GIF plays and pauses in place; one without opens in the player', () => {
    const recording = (n: Node, f: number) =>
      parts(n, 'made', 'kit')[0]?.features[f]?.parts.find((p) => p.kind === 'recording');
    const verify = () => done().click('run:step:verify:1');
    const paused = verify().click('run:recording:verify:1:0:1');

    expect(paused.commands).toEqual([]);
    expect(recording(paused.tree, 0)).toMatchObject({ playing: false, control: '▶ Play' });
    expect(recording(paused.click('run:recording:verify:1:0:1').tree, 0)).toMatchObject({
      playing: true,
      control: '❚❚ Pause',
    });
    expect(recording(verify().tree, 1)).toMatchObject({
      playing: false,
      control: '▶ Open in player',
      openVideo: false,
    });
    // a GIF too big to play still opens its video, a click on it or Open video
    expect(recording(verify().tree, 0)).toMatchObject({
      videoId: 'run:shot:verify:1:0:1:0',
      openVideo: true,
    });
    expect(done().click('run:shot:verify:1:0:1:0').commands).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'open-url',
          url: `file://${RUN_WORKTREE}/.scratch/2/verify/evidence/cart/drive.webm`,
        },
      },
    ]);
    expect(done().click('run:recording:verify:1:1:1').commands).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'open-url',
          url: `file://${RUN_WORKTREE}/.scratch/2/verify/evidence/checkout/drive.webm`,
        },
      },
    ]);
  });

  test('a shot opens full size, its page in the browser; each says its page and account', () => {
    const tree = done().click('run:step:verify:1').tree;
    const feature = (f: number) => parts(tree, 'made', 'kit')[0]?.features[f];
    const open = (url: string) => [{ kind: 'shell', effect: { kind: 'open-url', url } } as const];

    expect(feature(0)?.env).toBe('local');
    expect(feature(1)?.parts[0]).toMatchObject({
      kind: 'shot',
      shot: {
        id: 'run:shot:verify:1:1:0:0',
        url: 'http://localhost:5173/checkout',
        urlId: 'run:url:verify:1:1:0:0',
        account: 'buyer',
      },
    });
    expect(done().click('run:shot:verify:1:0:0:1').commands).toEqual(
      open(`file://${RUN_WORKTREE}/.scratch/2/verify/evidence/cart/after.png`),
    );
    expect(done().click('run:url:verify:1:1:0:0').commands).toEqual(
      open('http://localhost:5173/checkout'),
    );
    expect(done().click('run:url:verify:1:0:1:0').commands).toEqual(
      open('http://localhost:5173/cart'),
    );
  });

  test('its PR’s checks running: the pr step says so, as the Board does, never needs you', () => {
    const r = RUN_RECORD_READY;
    const pr =
      r.run.pr === null
        ? null
        : { ...r.run.pr, merge: 'person' as const, checks: 'pending' as const };
    const waiting: RunRecordData = {
      ...r,
      run: { ...r.run, state: 'needs-you', reason: 'merge waits for a person', pr },
      steps: r.steps.map((x) =>
        x.kind === 'stage' && x.stage === 'pr' ? { ...x, mark: 'needs-you', endedAt: null } : x,
      ),
    };
    const d = driveRun({ now: runAt(36) }).answer(recordReplies(waiting));

    expect(focus(d.tree)).toMatchObject({
      name: 'pr',
      state: { text: '● checks running', hue: 'warn' },
    });
    expect(parts(d.tree, 'made', 'facts')[0]?.rows).toMatchObject([
      { label: 'Result', value: 'Checks running: 3 of 3 criteria verified.' },
      { label: 'Changed' },
    ]);
    expect(JSON.stringify(d.tree)).not.toContain('needs you');
  });

  test('a PR to review: Review changes checks it out, then VimStorm’s review; Open PR the page', () => {
    const d = driveRun({ now: runAt(36) }).answer(recordReplies(RUN_RECORD_READY));

    expect(parts(d.tree, 'made', 'facts')[0]?.rows).toEqual([
      { label: 'Result', value: 'Ready for review: 3 of 3 criteria verified.' },
      { label: 'Changed', value: '3 files · +37 −9' },
    ]);
    expect(focus(d.tree)).toMatchObject({
      name: 'pr',
      actions: [
        { id: 'run:review', label: 'Review changes', primary: true },
        { id: 'run:pr', label: 'Open PR #57', primary: false },
      ],
    });
    d.click('run:review');
    expect(reads(d.commands)).toEqual([`review open 57 --path=${RUN_WORKTREE}`]);
    d.send({
      kind: 'result',
      id: 'run:review:2',
      command: 'review open',
      reply: {
        ok: true,
        data: { repo: 'mkdir-swe/demo-shop', number: 57, path: RUN_WORKTREE, unchecked: null },
      },
    });
    expect(d.commands).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'review-open',
          path: RUN_WORKTREE,
          repo: 'mkdir-swe/demo-shop',
          number: 57,
          unchecked: null,
        },
      },
    ]);
    expect(d.click('run:pr').commands.at(-1)).toEqual({
      kind: 'shell',
      effect: { kind: 'open-url', url: 'https://github.com/mkdir-swe/demo-shop/pull/57' },
    });
  });

  test('the spec’s page opens in the browser', () => {
    expect(done().click('run:spec:page').commands.at(-1)).toEqual({
      kind: 'shell',
      effect: { kind: 'open-url', url: 'https://github.com/mkdir-swe/demo-shop/issues/41' },
    });
  });
});

describe('live from abe watch: which events read it again', () => {
  const ev = (e: Pick<Event, 'type' | 'data'>): Event =>
    EventSchema.parse({ seq: 9, at: runAt(21), ...e });
  const stage = (card: number) =>
    ev({
      type: 'factory.stage',
      data: {
        card,
        session: RUN_SESSION,
        stage: 'checks',
        from: 'build',
        state: 'running',
        reason: null,
        since: runAt(21),
        cause: 'stage-done',
        outcome: null,
      },
    });
  const words = (session: string) =>
    ev({ type: 'session.transcript', data: { session, from: 3, entries: [] } });

  const summary = (card: number) =>
    ev({
      type: 'factory.summary',
      data: { card, session: RUN_SESSION, stage: 'checks', startedAt: runAt(17), brief: false },
    });

  test.each<[string, Event, number]>([
    ['its card’s stage move', stage(2), 1],
    ['its card’s step summary landing', summary(2), 1],
    ['another card’s summary', summary(3), 0],
    ['another card’s', stage(3), 0],
    // (read by the clock once the burst is a moment old, below)
    ['its session’s words: none at once', words(RUN_SESSION), 0],
    ['another session’s', words('9-ffff'), 0],
  ])('%s', (_, e, n) => {
    const d = driveRun().answer();

    d.send({ kind: 'event', event: e });
    expect(reads(d.commands)).toHaveLength(n);
  });

  test('its session’s words in a burst: one read a second after the first, never one per entry', () => {
    const d = driveRun().answer();
    const tick = (ms: number) => ({
      kind: 'tick' as const,
      at: new Date(Date.parse(runAt(21)) + ms).toISOString(),
    });
    const burst = Array.from({ length: 5 }, () => ({
      kind: 'event' as const,
      event: words(RUN_SESSION),
    }));

    d.take();
    d.send(...burst, tick(500));
    expect(reads(d.take())).toEqual([]);
    d.send(tick(1000));
    expect(reads(d.take())).toEqual(['factory record 2']);
    d.answer();
    d.send(tick(2000));
    expect(reads(d.take())).toEqual([]);
  });

  test('one read out at a time: an event meanwhile reads once more after', () => {
    const d = driveRun()
      .answer()
      .send({ kind: 'event', event: stage(2) }, { kind: 'event', event: stage(2) });

    expect(reads(d.commands)).toHaveLength(1);
    let answered = 0;

    d.answer((a) => (answered++ === 0 ? recordReplies()(a) : undefined));
    expect(reads(d.commands)).toEqual(['factory record 2']);
  });
});

describe('its Playbook', () => {
  const opened = (cs: readonly Command[]) =>
    cs.flatMap((c) => (c.kind === 'shell' && c.effect.kind === 'open-file' ? [c.effect.path] : []));
  const done = () => driveRun({ now: runAt(50) }).answer(recordReplies(RUN_RECORD_PLAYBOOK));

  test('a run whose playbook step wrote one, none of its step in sight: on the result’s step', () => {
    expect(focus(done().tree)?.actions).toContainEqual({
      id: 'run:playbook',
      label: 'Playbook · 3 steps · 2 for you',
      primary: false,
    });
  });

  test('one that wrote none: no Playbook, none in `:`', () => {
    const d = driveRun({ now: runAt(50) }).answer(recordReplies(RUN_RECORD_DONE));

    expect(focus(d.tree)?.actions.map((a) => a.id)).not.toContain('run:playbook');
    expect(d.here?.view?.menu.rows.map((r) => r.id)).not.toContain('playbook');
    expect(done().here?.view?.menu.rows.map((r) => r.id)).toContain('playbook');
  });

  test.each<[string, (d: ReturnType<typeof done>) => ReturnType<typeof done>]>([
    ['its action', (d) => d.click('run:playbook')],
    ['Playbook in `:`', (d) => d.send({ kind: 'choice', menu: RUN_VIEW_MENU, row: 'playbook' })],
  ])('%s opens it in the Editor, from the shown worktree', (_, act) => {
    expect(opened(act(done()).commands)).toEqual([`${RUN_WORKTREE}/.abe/playbooks/2.md`]);
  });
});
