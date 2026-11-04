/**
 * The Factory overview (`abe ui render factory`, `abe ui bridge`, ticket #70) through the CLI
 * seam: the real `abe` and its `serve`, the fake Azure DevOps for the cards, a real git checkout,
 * and the fake `claude` in a real `tmux` moving two runs from inside their sessions.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLine, FactoryRunData, UiRenderData, type UiNode } from '@abe/core';
import {
  cli,
  type Cli,
  fakeAdo,
  type FakeAdo,
  fakeAz,
  type FakeAz,
  fakeClaude,
  type FakeClaude,
  type FakeStep,
  scriptClaude,
  type Streaming,
  tmuxPath,
  installDone,
} from '@abe/testing';
import { asTrees, BridgeFrame } from '@abe/ui';
import { z } from 'zod';

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);
};

type World = { root: string; repo: string; ado: FakeAdo; az: FakeAz; claude: FakeClaude; abe: Cli };

const world = async (): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-fu-'));
  const repo = join(root, 'demo');
  const ado = await fakeAdo();
  const az = fakeAz({ tokens: ['token-one'] });
  const claude = fakeClaude();

  for (const dir of ['mine', 'demo/.abe']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(join(repo, 'abe.yaml'), `board: ${JSON.stringify(ado.board)}\nenvironments: {}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  // yours for the repo, never committed
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
  // typed in the checkout: its settings name the board
  const abe = cli({
    env: {
      PATH: `${claude.dir}:${az.dir}:/usr/bin:/bin`,
      ABE_CONFIG_DIR: join(root, 'mine'),
      ABE_TMUX: tmuxPath(),
      ...ado.env,
    },
    cwd: repo,
  });

  // the Mac's serve starts a card only where the install is done
  await installDone(abe.state.dir, repo);

  return { root, repo, ado, az, claude, abe };
};

const factory = (...argv: string[]): FakeStep => ({ abe: ['factory', ...argv, '--json'] });

const Stage = z.object({
  type: z.literal('factory.stage'),
  data: z.object({ session: z.string(), stage: z.string(), cause: z.string() }),
});

/** Reads `watch` until `session`'s run says `cause` in `stage`. */
const until = async (watch: Streaming, session: string, stage: string, cause: string) => {
  for (;;) {
    const e = Stage.safeParse(EventLine.parse(JSON.parse(await watch.next(15_000))));

    if (
      e.success &&
      e.data.data.session === session &&
      e.data.data.stage === stage &&
      e.data.data.cause === cause
    )
      return;
  }
};

const Ran = z.object({
  type: z.literal('command.ran'),
  data: z.object({ noun: z.string(), verb: z.string().nullable() }),
});

const walk = (n: UiNode, out: UiNode[] = []): UiNode[] => {
  out.push(n);
  for (const c of n.children ?? []) walk(c, out);

  return out;
};

const node = (tree: UiNode, id: string): UiNode => {
  const found = walk(tree).find((n) => n.id === id);

  if (found === undefined) throw new Error(`no ${id} in ${JSON.stringify(tree)}`);

  return found;
};

const kids = (tree: UiNode, id: string) => (node(tree, id).children ?? []).map((c) => c.id);

describe('the Factory overview from fake ports', () => {
  let w: World;
  let four: string;
  let five: string;
  let watch: Streaming;

  beforeAll(async () => {
    w = await world();
    await w.abe.run('status');
    watch = w.abe.spawn('watch', '--json');
    // Card 4: decided, built, its checks green, in review; card 5: decided, in build. Each turn
    // ends waiting on the person (its Stop).
    scriptClaude(w.abe.state.dir, [
      factory('stage-done', 'create-specification'),
      factory('stage-done', 'to-tickets'),
      factory('stage-done', 'build', '--report', 'README.md'),
      { say: 'In review.' },
    ]);
    const run4 = await w.abe.json(FactoryRunData, 'factory', 'run', '4', '--repo', w.repo);

    if (!run4.doc.ok) throw new Error(JSON.stringify(run4.doc.error));
    four = run4.doc.data.session;
    await until(watch, four, 'review', 'Stop');
    scriptClaude(
      w.abe.state.dir,
      [
        factory('stage-done', 'create-specification'),
        factory('stage-done', 'to-tickets'),
        { say: 'Building.' },
      ],
      {
        'go on': [factory('stage-done', 'build', '--report', 'README.md'), { say: 'In review.' }],
      },
    );
    const run5 = await w.abe.json(FactoryRunData, 'factory', 'run', '5', '--repo', w.repo);

    if (!run5.doc.ok) throw new Error(JSON.stringify(run5.doc.error));
    five = run5.doc.data.session;
    await until(watch, five, 'build', 'Stop');
  }, 90_000);
  afterAll(async () => {
    watch.signal('SIGKILL');
    await w.abe.close();
    await w.ado.stop();
    w.az.remove();
    w.claude.remove();
    rmSync(w.root, { recursive: true, force: true });
  });

  test('abe ui render factory --json: the Board, the cards in their columns, each with its rail row', async () => {
    const out = await w.abe.json(UiRenderData, 'ui', 'render', 'factory');

    expect(out.exit).toBe(0);
    if (!out.doc.ok) throw new Error(out.doc.error.message);
    const tree = out.doc.data.tree;

    expect(
      walk(tree)
        .filter((n) => n.kind === 'BoardColumn')
        .map((n) => n.id),
    ).toEqual(['col:New', 'col:Active', 'col:Resolved', 'col:Closed']);
    expect(walk(tree).some((n) => /^(lane:|run:|flow|cards)/.test(n.id ?? ''))).toBe(false);
    // Mine: Alex's card 4 (Active); 5 is no one's, so only on Team.
    expect(node(tree, 'card:4').props).toMatchObject({
      title: 'As a visitor I can sign in with email',
      rail: { stage: 'Review', glyph: '◆', word: 'Needs you', state: 'needs-you' },
      emphasis: 'needs-you',
    });
    // a local session: no box mark
    expect(node(tree, 'card:4').props.rail).not.toHaveProperty('box');
    expect(walk(tree).some((n) => n.id === 'card:5')).toBe(false);
    expect(JSON.stringify(node(tree, 'board-head').props.counts)).toMatch(
      /"Sprint 1 · \d+ cards?"/,
    );
    const text = await w.abe.run('ui', 'render', 'factory');

    expect(text.stdout).toContain('BoardCard #card:4 card=4 type="US"');
  });

  test('abe ui bridge: a run moved in its session moves its card by abe watch alone', async () => {
    // A watch of its own from here on: which commands the bridge has serve answer.
    const ran = w.abe.spawn('watch', '--json');

    // the watch is subscribed once it sees a marker (`settings get`, none of the counted reads):
    // asked again until it does, so the bridge's opening reads all come after
    for (let seen = false; !seen;) {
      await w.abe.run('settings', 'get', 'serve.target');
      try {
        for (;;) {
          const e = Ran.safeParse(EventLine.parse(JSON.parse(await ran.next(1_000))));

          if (e.success && e.data.data.noun === 'settings' && e.data.data.verb === 'get') break;
        }
        seen = true;
      } catch {
        // not subscribed yet: ask again
      }
    }
    const bridge = w.abe.spawn('ui', 'bridge');
    /** Its frames as the window takes them: a patch as the tree it gives. */
    const trees = asTrees();
    const send = (frame: unknown) => {
      bridge.write(`${JSON.stringify(frame)}\n`);
    };
    const next = async (match: (t: UiNode) => boolean) => {
      for (;;) {
        const f = trees(BridgeFrame.parse(JSON.parse(await bridge.next(15_000))));

        if (f.type === 'tree' && match(f.tree)) return f.tree;
      }
    };
    const stage = (t: UiNode, card: string): unknown => {
      const found = walk(t).find((n) => n.id === card);
      const rail: unknown = found?.props.rail;

      return typeof rail === 'object' && rail !== null && 'stage' in rail ? rail.stage : undefined;
    };

    try {
      send({ v: 2, type: 'hello', size: { width: 1440, height: 846 }, version: 'test' });
      send({ v: 2, type: 'open', screen: 'factory' });
      // Team: everyone's cards.
      send({ v: 2, type: 'input', input: { kind: 'key', key: '<Tab>' } });
      const team = await next((t) => stage(t, 'card:5') === 'Build');

      expect(node(team, 'card:5').props).toMatchObject({
        rail: { stage: 'Build', word: 'Needs you' },
      });
      // Building, serve moved card 5 to Active on the board: Active holds 4, 5 and Sam's 8.
      expect(kids(team, 'col:Active')).toContain('card:5');
      expect(node(team, 'col:Active').props).toMatchObject({ count: 3 });
      // the sprint's closed bug 9 in Closed, dim, done with no run (#239)
      expect(kids(team, 'col:Closed')).toEqual(['card:9']);
      expect(node(team, 'card:9').props).toMatchObject({ closed: true, note: { text: '✓ Done' } });
      await w.abe.run('session', 'send', five, 'go on');
      const moved = await next((t) => stage(t, 'card:5') === 'Review');

      expect(node(moved, 'card:5').props).toMatchObject({
        rail: { stage: 'Review', word: 'Reviewing' },
      });
      // Settled: its turn stopped, waiting on the person; then a marker after everything.
      await next((t) => node(t, 'card:5').props.emphasis === 'needs-you');
      await w.abe.run('status');
      const counted: Record<string, number> = {};

      for (;;) {
        const line = EventLine.parse(JSON.parse(await ran.next(15_000)));
        const e = Ran.safeParse(line);

        if (!e.success) continue;
        const name =
          e.data.data.verb === null ? e.data.data.noun : `${e.data.data.noun} ${e.data.data.verb}`;

        if (name === 'status') break;
        counted[name] = (counted[name] ?? 0) + 1;
      }
      // Only the opening reads: card lists, status, sessions. The move came by events; nothing
      // was read again.
      expect(counted).toMatchObject({ 'card list': 2, 'factory status': 1, 'session list': 1 });
    } finally {
      bridge.end();
      await bridge.exited;
      ran.signal('SIGKILL');
    }
  }, 60_000);

  test('abe ui bridge: the pane’s Sessions opens on the Board’s card and follows it; another pane screen keeps its slot', async () => {
    const bridge = w.abe.spawn('ui', 'bridge');
    /** Its frames as the window takes them: a patch as the tree it gives. */
    const trees = asTrees();
    const send = (frame: unknown) => {
      bridge.write(`${JSON.stringify(frame)}\n`);
    };
    const next = async (match: (f: BridgeFrame) => boolean): Promise<BridgeFrame[]> => {
      const seen: BridgeFrame[] = [];

      for (;;) {
        const f = trees(BridgeFrame.parse(JSON.parse(await bridge.next(15_000))));

        seen.push(f);
        if (match(f)) return seen;
      }
    };
    const pane = (f: BridgeFrame, screen: string, has = '') =>
      f.type === 'tree' &&
      f.slot === 'pane' &&
      f.screen === screen &&
      JSON.stringify(f).includes(has);
    const board = (f: BridgeFrame, card: number) =>
      f.type === 'tree' &&
      f.slot === undefined &&
      walk(f.tree).some((n) => n.id === `card:${card}` && n.props.selection === 'selected');

    try {
      send({
        v: 2,
        type: 'hello',
        size: { width: 1440, height: 846 },
        version: 'test',
        root: w.repo,
      });
      send({ v: 2, type: 'open', screen: 'factory' });
      // the Board has the keys (its selection draws `selected`, #330)
      send({ v: 2, type: 'focus', slot: 'main' });
      send({ v: 2, type: 'input', input: { kind: 'key', key: '<Tab>' } });
      send({ v: 2, type: 'input', input: { kind: 'click', id: 'card:5' } });
      await next((f) => board(f, 5));
      // Boxes holds the pane: the Board's next card is not Sessions' to show there
      send({ v: 2, type: 'resize', slot: 'pane', size: { width: 1020, height: 280 } });
      send({ v: 2, type: 'open', screen: 'boxes', slot: 'pane' });
      await next((f) => pane(f, 'boxes'));
      send({ v: 2, type: 'input', input: { kind: 'click', id: 'card:4' } });
      // the Board's `open sessions … ifOpen` goes out in the same step as its tree; the bridge
      // drops it, so no Sessions tree comes in the pane (a resize is no marker: the same tree at
      // another width is not sent again)
      const kept = await next((f) => board(f, 4));

      // and none in the next second either (a Sessions tree would follow the Board's at once)
      for (;;) {
        const line = await bridge.next(1_000).catch(() => undefined);

        if (line === undefined) break;
        kept.push(trees(BridgeFrame.parse(JSON.parse(line))));
      }
      expect(kept.some((f) => pane(f, 'sessions'))).toBe(false);
      // ⌘5 (no params): Sessions on the Board's card, #4
      send({ v: 2, type: 'open', screen: 'sessions', slot: 'pane' });
      await next((f) => pane(f, 'sessions', `"selected":"session:${four}"`));
      // the Board selects #5: Sessions follows
      send({ v: 2, type: 'input', input: { kind: 'click', id: 'card:5' } });
      await next((f) => pane(f, 'sessions', `"selected":"session:${five}"`));
    } finally {
      bridge.end();
      await bridge.exited;
    }
  }, 60_000);

  test('abe ui bridge, needs you from the Editor: Factory ◆ N, then ⌘⌥A lands on the oldest waiting run, the Chat column on it', async () => {
    const bridge = w.abe.spawn('ui', 'bridge');
    /** Its frames as the window takes them: a patch as the tree it gives. */
    const trees = asTrees();
    const send = (frame: unknown) => {
      bridge.write(`${JSON.stringify(frame)}\n`);
    };
    const next = async (match: (f: BridgeFrame) => boolean) => {
      for (;;) {
        const f = trees(BridgeFrame.parse(JSON.parse(await bridge.next(15_000))));

        if (match(f)) return f;
      }
    };

    try {
      send({ v: 2, type: 'hello', size: { width: 1440, height: 846 }, version: 'test' });
      send({ v: 2, type: 'open', screen: 'factory' });
      // what the stripe draws (#20): both runs wait for you, on its Board item
      const stripe = await next(
        (f) =>
          f.type === 'shell' &&
          f.effect.kind === 'stripe' &&
          f.effect.items.some((x) => x.id === 'board' && x.dot === 'needs-you'),
      );
      const shown =
        stripe.type === 'shell' && stripe.effect.kind === 'stripe' ? stripe.effect.items : [];

      expect(shown.find((x) => x.id === 'board')).toMatchObject({
        dot: 'needs-you',
        group: 'top',
      });
      expect(shown.find((x) => x.id === 'board')?.tooltip).toContain('need you');
      // ⌘⌥A: the shell shows the view and opens the screen again from the Editor
      send({ v: 2, type: 'open', screen: 'factory', params: { from: 'editor' } });
      // card 4 asked first: the window's Chat column on it holds the keys (2.1 #105)
      await next(
        (f) => f.type === 'shell' && f.effect.kind === 'focus' && f.effect.slot === 'chat',
      );
      // its session's rendered Chat
      const landed = await next(
        (f) =>
          f.type === 'tree' &&
          f.slot === 'chat' &&
          walk(f.tree).some((n) => n.kind === 'ChatHeader' && 'story' in n.props),
      );

      if (landed.type !== 'tree') throw new Error('no tree');
      expect(node(landed.tree, 'chat-header').props).toMatchObject({ story: { id: '#4' } });
    } finally {
      bridge.end();
      await bridge.exited;
    }
  }, 60_000);
});
