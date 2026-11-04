/**
 * `abe ui bridge` and `abe ui render`: the client's own code (`runClient`, `runBridge`,
 * `runRender`) in this test against a real `serve` in it (`macServed`), with this test as the app
 * on the bridge's lines. A start of serve, and a bridge or render with no serve, through the real
 * `abe` as a process (`cli()`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Event, readEnvelope, UiRenderData } from '@abe/core';
import { settingsPlaces } from '@abe/ports';
import {
  cli,
  type Cli,
  macServed,
  type Ran,
  requestAt,
  type Streaming,
  tempState,
} from '@abe/testing';
import { asTrees, BridgeFrame } from '@abe/ui';
import { type z } from 'zod';
import {
  appOpenParams,
  keysMoved,
  type KeysTold,
  runBridge,
  runRender,
  screenOpenParams,
} from './bridge';
import { type ClientOptions, personalCommandsIn, runClient } from '.';

/** What a test reads of a running `abe` (the bridge, a watch). */
type Stream = Pick<Streaming, 'next' | 'write' | 'end' | 'exited'> & { stop: () => void };

type Abe = Pick<Cli, 'state' | 'run' | 'json' | 'close'> & { spawn: (...argv: string[]) => Stream };

let abe: Abe;
/** Whether this test started an `abe`: the bridge's own rules below start none. */
let started = false;
const running: Stream[] = [];

afterEach(async () => {
  for (const s of running.splice(0)) s.stop();
  if (started) await abe.close();
  started = false;
});

const spawn = (...argv: string[]) => {
  const s = abe.spawn(...argv);

  running.push(s);

  return s;
};

/** Lines handed on as they come, read one at a time (`next`) until the writer ends. */
const lineQueue = () => {
  const queue: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;

  return {
    push: (line: string) => {
      const waiter = waiting.shift();

      if (waiter === undefined) queue.push(line);
      else waiter(line);
    },
    end: () => {
      ended = true;
      for (const waiter of waiting.splice(0)) waiter(undefined);
    },
    next: (ms = 5000) => {
      const ready = queue.shift();

      if (ready !== undefined) return Promise.resolve(ready);
      if (ended) return Promise.reject(new Error('ended'));

      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(got), 1);
          reject(new Error(`no line in ${ms} ms`));
        }, ms);
        const got = (line: string | undefined) => {
          clearTimeout(timer);
          if (line === undefined) reject(new Error('ended'));
          else resolve(line);
        };

        waiting.push(got);
      });
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const line = await new Promise<string | undefined>((resolve) => {
          const ready = queue.shift();

          if (ready !== undefined) resolve(ready);
          else if (ended) resolve(undefined);
          else waiting.push(resolve);
        });

        if (line === undefined) return;
        yield line;
      }
    },
  };
};

/** The real `abe`: a process per command, its serve started by the first. */
const real = () => {
  const c = cli();

  started = true;
  abe = {
    ...c,
    spawn: (...argv) => {
      const s = c.spawn(...argv);

      return {
        ...s,
        stop: () => {
          s.signal('SIGKILL');
        },
      };
    },
  };
};

/** The client's code in this test, on a serve in it: no process per command. */
/** `mine`: your settings on this Mac (`settings.yaml`) before serve starts. */
const inProcess = async (mine?: string) => {
  const state = tempState();

  if (mine !== undefined) {
    mkdirSync(join(state.dir, '.config', 'abe'), { recursive: true });
    writeFileSync(join(state.dir, '.config', 'abe', 'settings.yaml'), mine);
  }
  const s = await macServed({}, { state });
  const o: ClientOptions = {
    cwd: s.state.dir,
    where: {
      stateDir: s.state.dir,
      socket: s.state.socket,
      log: join(s.state.dir, 'serve.log'),
      plugins: join(s.state.dir, 'plugins'),
      defaultStates: [],
    },
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    personalCommands: () => personalCommandsIn(settingsPlaces(s.state.env, s.state.dir).configDir),
  };
  const run = async (...argv: string[]): Promise<Ran> => {
    const client = await runClient(argv, o);

    if (client.kind === 'ui-render')
      return runRender(client.screen, client.page, client.json, client.start, o);
    if (client.kind !== 'printed')
      throw new Error(`in-process: abe ${argv.join(' ')} is ${client.kind}`);

    return client.printed;
  };
  const json = async <T extends z.ZodType>(data: T, ...argv: string[]) => {
    const out = await run(...argv, '--json');

    return { exit: out.exit, stderr: out.stderr, doc: readEnvelope(data, JSON.parse(out.stdout)) };
  };
  const bridge = (start: boolean): Stream => {
    const lines = lineQueue();
    const out = lineQueue();
    const exited = runBridge(start, o, {
      lines,
      write: (text) => {
        for (const line of text.split('\n')) if (line !== '') out.push(line);
      },
      log: () => undefined,
      sleep: (ms) => Bun.sleep(ms),
    }).then((exit) => {
      out.end();

      return { exit, rest: [], stderr: '' };
    });

    return {
      next: out.next,
      write: (text) => {
        for (const line of text.split('\n')) if (line !== '') lines.push(line);
      },
      end: lines.end,
      exited,
      stop: lines.end,
    };
  };

  started = true;
  abe = {
    state: s.state,
    run,
    json,
    close: s.close,
    spawn: (...argv) => {
      if (argv[0] === 'ui' && argv[1] === 'bridge') return bridge(!argv.includes('--no-start'));
      if (argv[0] !== 'watch') throw new Error(`in-process: no abe ${argv.join(' ')} stream`);
      const w = s.watch(...argv.slice(1));

      return {
        next: w.next,
        write: () => undefined,
        end: w.close,
        exited: Promise.resolve({ exit: 0, rest: [], stderr: '' }),
        stop: w.close,
      };
    },
  };
};

const app = (bridge: Stream, trees = asTrees()) => ({
  send: (frame: unknown) => {
    bridge.write(`${JSON.stringify(frame)}\n`);
  },
  /** Frames until one matches, all of them in order. */
  until: async (match: (f: BridgeFrame) => boolean): Promise<BridgeFrame[]> => {
    const seen: BridgeFrame[] = [];

    for (;;) {
      const frame = trees(BridgeFrame.parse(JSON.parse(await bridge.next())));

      seen.push(frame);
      if (match(frame)) return seen;
    }
  },
});

const HELLO = { v: 2, type: 'hello', size: { width: 1000, height: 700 }, version: 'test' };
const OPEN = { v: 2, type: 'open', screen: 'status' };

const text = (f: BridgeFrame) => JSON.stringify(f);
const isTree = (f: BridgeFrame, has: string) => f.type === 'tree' && text(f).includes(has);

describe('abe ui bridge', () => {
  test('starts serve, and sends the status tree once it is read', async () => {
    real();
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send(HELLO);
    bridge.send(OPEN);
    const frames = await bridge.until((f) => isTree(f, '"title":"abe serve"'));
    const revs = frames.flatMap((f) => (f.type === 'tree' ? [f.rev] : []));

    expect(revs).toEqual(revs.map((_, i) => i + 1));
    expect(frames.map(text).at(-1)).toContain(`"dim":"${abe.state.socket}"`);
    const status = await abe.run('status', '--no-start');

    expect(status.exit).toBe(0);
  });

  test('a key becomes a command, and a command.ran event re-renders, an unchanged tree is not sent', async () => {
    await inProcess();
    await abe.run('status');
    const watcher = spawn('watch', '--json', '--since', '0');
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send(HELLO);
    bridge.send(OPEN);
    const first = await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    const rev = Math.max(...first.map((f) => (f.type === 'tree' ? f.rev : 0)));

    bridge.send({ v: 2, type: 'input', input: { kind: 'key', key: 'r' } });
    // `r` read status again: serve says so on the watch stream (ours, the bridge's first, then r's).
    let ran = 0;

    for (let i = 0; i < 50 && ran < 3; i += 1) {
      const event = Event.parse(JSON.parse(await watcher.next()));

      if (event.type === 'command.ran' && event.data.noun === 'status') ran += 1;
    }
    expect(ran).toBe(3);
    await abe.run('sheet', 'list');
    const after = await bridge.until((f) => isTree(f, 'Last command'));
    const trees = after.flatMap((f) => (f.type === 'tree' ? [f] : []));

    // Nothing moved on `r`: the next tree is the one the sheet list's command.ran made.
    expect(trees.map((f) => f.rev)).toEqual([rev + 1]);
    expect(trees.map(text).join('')).toContain('"note":"abe sheet list, exit');
  });

  test('a tree the app holds goes as a keyed patch; `again` sends it whole', async () => {
    await inProcess();
    const bridge = spawn('ui', 'bridge');
    const raw: BridgeFrame[] = [];
    const next = async (match: (f: BridgeFrame) => boolean) => {
      for (;;) {
        const f = BridgeFrame.parse(JSON.parse(await bridge.next()));

        raw.push(f);
        if (match(f)) return f;
      }
    };
    const send = (frame: unknown) => {
      bridge.write(`${JSON.stringify(frame)}\n`);
    };

    send(HELLO);
    send({ v: 2, type: 'open', screen: 'factory' });
    await next((f) => f.type === 'tree' && text(f).includes('"selected":"tab:mine"'));
    send({ v: 2, type: 'input', input: { kind: 'key', key: '<Tab>' } });
    // Team now: only what changed, on the tree the app holds (the frame before it)
    const patch = await next((f) => f.type === 'patch' && text(f).includes('tab:team'));
    const before = raw.slice(0, -1).findLast((f) => f.type === 'tree' || f.type === 'patch');

    expect(patch).toMatchObject({ type: 'patch', screen: 'factory' });
    expect(
      patch.type === 'patch' &&
        before !== undefined &&
        'rev' in before &&
        patch.base === before.rev,
    ).toBe(true);
    send({ v: 2, type: 'again', slot: 'main' });
    const whole = await next((f) => f.type === 'tree');

    expect(text(whole)).toContain('"selected":"tab:team"');
  });

  test("the shell's own command answers in an answer frame; the review slot draws its pane", async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send(HELLO);
    bridge.send({
      v: 2,
      type: 'run',
      id: 'draft-plan:1',
      argv: ['pr', 'draft-plan', '--path', '/work/shop'],
    });
    const answered = await bridge.until((f) => f.type === 'answer');

    expect(answered.at(-1)).toMatchObject({
      type: 'answer',
      id: 'draft-plan:1',
      reply: {
        ok: false,
        error: { code: 'invalid', message: 'This checkout has no GitHub repository' },
      },
    });
    bridge.send({
      v: 2,
      type: 'open',
      screen: 'review',
      params: { pr: '7', path: '/work/shop-pr-7' },
      slot: 'review',
    });
    const drawn = await bridge.until((f) => isTree(f, 'is not a git checkout'));

    expect(drawn.at(-1)).toMatchObject({ type: 'tree', screen: 'review', slot: 'review' });
  });

  test('a click on a node id reaches the screen', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send(HELLO);
    bridge.send(OPEN);
    const before = await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    await abe.run('sheet', 'list');
    before.push(...(await bridge.until((f) => isTree(f, 'Last command'))));
    // The look and the Feel the bridge reads at its start come in their own time: in before the click.
    for (const kind of ['look', 'feel']) {
      const its = (f: BridgeFrame) => f.type === 'shell' && f.effect.kind === kind;

      if (!before.some(its)) before.push(...(await bridge.until(its)));
    }
    bridge.send({ v: 2, type: 'input', input: { kind: 'click', id: 'reload' } });
    bridge.send({ v: 2, type: 'open', screen: 'nope' });
    // The reload's reads come back unchanged (no tree); the unknown screen is answered in order.
    const frames = await bridge.until((f) => f.type === 'error');

    expect(frames.map((f) => f.type)).toEqual(['error']);
    expect(frames.map(text).join('')).toContain('unknown-screen');
  });

  test.each<[string, string, string]>([
    [
      'any other v is refused: an app speaking v1 (whole trees only) too',
      '{"v":1,"type":"hello","size":{"width":1,"height":1},"version":"x"}',
      'unsupported-version',
    ],
    [
      'a v3 app is refused',
      '{"v":3,"type":"hello","size":{"width":1,"height":1},"version":"x"}',
      'unsupported-version',
    ],
    ['a line that is no frame is refused', '{"v":2,"type":"poke"}', 'bad-request'],
  ])('%s', async (_, line, code) => {
    await inProcess();
    const bridge = spawn('ui', 'bridge');

    bridge.write(`${line}\n`);
    const frame = BridgeFrame.parse(JSON.parse(await bridge.next()));

    expect(frame).toMatchObject({ v: 2, type: 'error', error: { code } });
  });

  test('the Factory overview: no selected frame before its cards, one workspaces frame while it does not change; exit and browser frames are taken', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send(HELLO);
    bridge.send({ v: 2, type: 'open', screen: 'factory' });
    bridge.send({ v: 2, type: 'exit', key: 'chat:4-a1b2:0', code: 0 });
    bridge.send({
      v: 2,
      type: 'browser',
      key: 'sheet:cart-a1:yours:v1',
      event: { kind: 'focus', focused: true },
    });
    bridge.send({ v: 2, type: 'open', screen: 'nope' });
    const frames = await bridge.until((f) => f.type === 'error');
    // the selected card is not said before the cards are read
    const selected = frames.filter((f) => f.type === 'shell' && f.effect.kind === 'selected');

    expect(selected).toEqual([]);
    // the header's feed is whole-state too: one frame, the reads having changed nothing
    expect(frames.filter((f) => f.type === 'shell' && f.effect.kind === 'workspaces')).toHaveLength(
      1,
    );
    // the exit and browser frames were no bad request: the one error is the unknown screen
    expect(
      frames
        .filter((f) => f.type === 'error')
        .map(text)
        .join(''),
    ).toContain('unknown-screen');
  });

  test('an open of the screen already open keeps its state (⌘⌥A from the Editor)', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send(HELLO);
    bridge.send({ v: 2, type: 'open', screen: 'factory' });
    await bridge.until((f) => isTree(f, '"selected":"tab:mine"'));
    bridge.send({ v: 2, type: 'input', input: { kind: 'key', key: '<Tab>' } });
    await bridge.until((f) => isTree(f, '"selected":"tab:team"'));
    bridge.send({ v: 2, type: 'open', screen: 'factory', params: { from: 'editor' } });
    bridge.send({ v: 2, type: 'open', screen: 'nope' });
    const frames = await bridge.until((f) => f.type === 'error');

    // opened anew it would draw Mine again
    expect(frames.filter((f) => isTree(f, '"selected":"tab:mine"'))).toEqual([]);
  });

  test('the Board’s card popup: main’s keys are its; Esc closes it, the Board as it was; the app’s close too', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));
    const popup = (f: BridgeFrame) => f.type === 'tree' && f.screen === 'card';

    bridge.send(HELLO);
    bridge.send({ v: 2, type: 'open', screen: 'factory' });
    await bridge.until((f) => isTree(f, '"selected":"tab:mine"'));
    bridge.send({ v: 2, type: 'input', input: { kind: 'key', key: '<Tab>' } });
    await bridge.until((f) => isTree(f, '"selected":"tab:team"'));
    // as ⏎ on a card opens it
    const card = { v: 2, type: 'open', screen: 'card', params: { card: '7', from: 'board' } };

    bridge.send({ ...card, slot: 'popup' });
    const opened = await bridge.until(popup);

    expect(opened.at(-1)).toMatchObject({ slot: 'popup' });
    bridge.send({ v: 2, type: 'input', input: { kind: 'key', key: '<Esc>' } });
    const closed = await bridge.until((f) => f.type === 'closed');

    // the Board never opened anew (it would draw Mine again), never left main
    expect(closed.filter((f) => isTree(f, '"selected":"tab:mine"'))).toEqual([]);
    expect(closed.at(-1)).toEqual({ v: 2, type: 'closed', slot: 'popup' });
    // the rail moved off the Board: the app closes it
    bridge.send({ ...card, slot: 'popup' });
    await bridge.until(popup);
    bridge.send({ v: 2, type: 'close', slot: 'popup' });
    await bridge.until((f) => f.type === 'closed');
  });

  test('the stripe’s clicks are the Board’s whatever the main slot holds: its menu hides an item from Skills', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));
    const pipelinesHidden = (f: BridgeFrame, hidden: boolean) =>
      f.type === 'shell' &&
      f.effect.kind === 'stripe' &&
      f.effect.items.some((i) => i.id === 'pipelines' && (i.hidden === true) === hidden);

    bridge.send(HELLO);
    bridge.send({ v: 2, type: 'open', screen: 'factory' });
    await bridge.until((f) => pipelinesHidden(f, false));
    bridge.send({ v: 2, type: 'open', screen: 'run' });
    bridge.send({
      v: 2,
      type: 'input',
      input: { kind: 'click', id: 'widget:stripe-menu:toggle:pipelines' },
    });
    await bridge.until((f) => pipelinesHidden(f, true));
  });

  test('one screen per slot: the chat slot’s tree names its slot, its inputs reach it, main keeps its own', async () => {
    await inProcess();
    const root = mkdtempSync(join(tmpdir(), 'abe-slot-'));
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send({ ...HELLO, root });
    bridge.send(OPEN);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    bridge.send({ v: 2, type: 'project', root, branch: 'card/7-show-stock' });
    bridge.send({ v: 2, type: 'open', screen: 'chat', slot: 'chat' });
    const chat = await bridge.until((f) => isTree(f, 'No session on #7 yet'));
    const tree = chat.at(-1);

    expect(tree).toMatchObject({ type: 'tree', screen: 'chat', slot: 'chat' });
    bridge.send({ v: 2, type: 'focus', slot: 'chat' });
    // Esc with nothing of the screen's open: the app hears it was not taken (the column's then)
    bridge.send({ v: 2, type: 'input', slot: 'chat', input: { kind: 'key', key: '<Esc>' } });
    await bridge.until(
      (f) => f.type === 'shell' && f.effect.kind === 'unhandled' && f.effect.slot === 'chat',
    );
    bridge.send({ v: 2, type: 'no-caret' });
    // the chat screen's launch menu, in Command mode's layer (layers stay global); a ⌘⏎ before
    // `factory status` answers is held and opens it once the run is read
    bridge.send({ v: 2, type: 'input', slot: 'chat', input: { kind: 'key', key: '<D-CR>' } });
    const menu = await bridge.until(
      (f) => f.type === 'layer' && text(f).includes('Launch in Local sandbox'),
    );

    // main's trees (the status screen's, read again as serve answers the chat screen) name no slot
    const mains = [...chat, ...menu].filter((f) => f.type === 'tree' && f.screen === 'status');

    expect(mains.every((f) => !('slot' in f))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('Boxes or Pipelines from a card’s workspace: Chat is the main checkout’s Abe chat, a project frame leaves it there', async () => {
    await inProcess();
    const main = mkdtempSync(join(tmpdir(), 'abe-main-'));
    const card = mkdtempSync(join(tmpdir(), 'abe-card-7-'));
    const bridge = app(spawn('ui', 'bridge'));
    const chat = (f: BridgeFrame) => f.type === 'tree' && f.screen === 'chat';

    bridge.send({ ...HELLO, root: main });
    bridge.send(OPEN);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    // card 7's workspace shown: its Chat on card 7
    bridge.send({ v: 2, type: 'project', root: card, branch: 'card/7-show-stock' });
    bridge.send({ v: 2, type: 'open', screen: 'chat', slot: 'chat' });
    await bridge.until((f) => isTree(f, 'No session on #7 yet'));
    // Boxes: the Abe chat, never card 7's
    bridge.send({ v: 2, type: 'open', screen: 'chat', slot: 'chat', params: { abe: main } });
    const boxes = await bridge.until((f) => chat(f) && !text(f).includes('#7'));

    expect(boxes.at(-1)).toMatchObject({ type: 'tree', screen: 'chat', slot: 'chat' });
    // the card workspace's branch read late: still the Abe chat
    bridge.send({ v: 2, type: 'project', root: card, branch: 'card/8-other' });
    bridge.send({ v: 2, type: 'open', screen: 'status' });
    const later = await bridge.until((f) => isTree(f, '"title":"Sessions"'));

    expect(later.filter((f) => chat(f) && /#[78]/.test(text(f)))).toEqual([]);
    rmSync(main, { recursive: true, force: true });
    rmSync(card, { recursive: true, force: true });
  });

  test('a jump while the Run place holds main: the Board kept behind it answers', async () => {
    await inProcess();
    const root = mkdtempSync(join(tmpdir(), 'abe-jump-'));
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send({ ...HELLO, root });
    bridge.send({ v: 2, type: 'open', screen: 'factory' });
    await bridge.until((f) => f.type === 'tree' && f.screen === 'factory');
    bridge.send({ v: 2, type: 'open', screen: 'run' });
    await bridge.until((f) => f.type === 'tree' && f.screen === 'run');
    bridge.send({ v: 2, type: 'project', root, branch: 'card/7-show-stock' });
    bridge.send({ v: 2, type: 'jump', to: 'workspace', from: { place: 'main', view: 'factory' } });
    const said = await bridge.until((f) => f.type === 'shell' && f.effect.kind === 'balloon');

    const last = said.at(-1);

    expect(last === undefined ? '' : text(last)).toContain('#7');
    rmSync(root, { recursive: true, force: true });
  });

  test('a jump: nothing linked on the main checkout; ⌃L on a story’s branch opens Linked with its rows', async () => {
    await inProcess();
    const root = mkdtempSync(join(tmpdir(), 'abe-jump-'));
    const bridge = app(spawn('ui', 'bridge'));
    const from = { place: 'editor', view: 'editor' };

    bridge.send({ ...HELLO, root });
    bridge.send(OPEN);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    bridge.send({ v: 2, type: 'jump', to: 'workspace', from });
    const none = await bridge.until((f) => f.type === 'shell' && f.effect.kind === 'balloon');

    expect(none.at(-1)).toMatchObject({
      effect: { kind: 'balloon', tone: 'info', text: 'Nothing linked here' },
    });
    // a worktree of story 7, no session known yet: its branch names the story
    bridge.send({ v: 2, type: 'project', root, branch: 'card/7-show-stock' });
    bridge.send({ v: 2, type: 'jump', to: 'linked', from });
    // at once, its rows Reading…; then each as its part lands
    const opened = await bridge.until(
      (f) => f.type === 'layer' && text(f).includes('"label":"Pull request"'),
    );
    const first = opened.at(-1);

    expect(first === undefined ? '' : text(first)).toContain('Reading…');
    const linked = await bridge.until(
      (f) => f.type === 'layer' && text(f).includes('"label":"Story","value":[{"text":"not read'),
    );

    // this serve has no board: the Story row says why, the other rows dim in place
    expect(linked.at(-1)).toMatchObject({
      type: 'layer',
      tree: { kind: 'LinkedLayer', props: { story: '#7', keys: '⌃L' } },
    });
    const last = linked.at(-1);

    expect(last === undefined ? '' : text(last)).toContain('not read');
    bridge.send({ v: 2, type: 'input', input: { kind: 'key', key: '<Esc>' } });
    await bridge.until((f) => f.type === 'layer' && f.tree === null);
    rmSync(root, { recursive: true, force: true });
  });

  test('the look: sent once serve answers, again when a Layer or a theme file moves it', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));
    const isLook = (f: BridgeFrame, slug: string) =>
      f.type === 'shell' && f.effect.kind === 'look' && f.effect.look.theme.slug === slug;
    const config = join(abe.state.dir, '.config', 'abe');

    bridge.send(HELLO);
    const first = await bridge.until((f) => isLook(f, 'islands-dark'));
    const look = first.at(-1);

    expect(
      look?.type === 'shell' && look.effect.kind === 'look' && look.effect.look.tokens['frame-bg'],
    ).toBe('#26282b');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'settings.yaml'), 'ui.theme: islands-dark-yours\n');
    // no such theme yet: Islands Dark again, which is no new frame; then the file appears
    mkdirSync(join(config, 'themes'), { recursive: true });
    writeFileSync(
      join(config, 'themes', 'islands-dark-yours.json'),
      JSON.stringify({
        name: 'Islands Dark (yours)',
        base: 'islands-dark',
        tokens: { 'abe-needs-you': '#a979f7' },
      }),
    );
    const mine = await bridge.until((f) => isLook(f, 'islands-dark-yours'));
    const got = mine.at(-1);

    expect(
      got?.type === 'shell' &&
        got.effect.kind === 'look' &&
        got.effect.look.tokens['abe-needs-you'],
    ).toBe('#a979f7');
    expect(mine.filter((f) => f.type === 'shell' && f.effect.kind === 'look')).toHaveLength(1);
  });

  test('the Launch box Chat opens (⇧⏎) hands its ⏎ back to the chat slot’s screen, which launches', async () => {
    await inProcess();
    const root = mkdtempSync(join(tmpdir(), 'abe-slot-'));
    const bridge = app(spawn('ui', 'bridge'));
    const input = (i: unknown) => ({ v: 2, type: 'input', slot: 'chat', input: i });

    bridge.send({ ...HELLO, root });
    bridge.send(OPEN);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    bridge.send({ v: 2, type: 'project', root, branch: 'card/7-show-stock' });
    bridge.send({ v: 2, type: 'open', screen: 'chat', slot: 'chat' });
    await bridge.until((f) => isTree(f, 'No session on #7 yet'));
    bridge.send({ v: 2, type: 'focus', slot: 'chat' });
    // ⌘⏎ waits for the card's run to be read; its menu up, the run is read
    bridge.send(input({ kind: 'key', key: '<D-CR>' }));
    await bridge.until((f) => f.type === 'layer' && text(f).includes('Launch agent…'));
    bridge.send(input({ kind: 'key', key: '<Esc>' }));
    bridge.send(input({ kind: 'key', key: '<S-CR>' }));
    await bridge.until((f) => f.type === 'layer' && text(f).includes('"kind":"LaunchBox"'));
    bridge.send(input({ kind: 'text', text: 'use the stock helper' }));
    // the box takes no ⏎ in its first 500 ms (the bridge stamps the clock as it opens)
    await Bun.sleep(600);
    bridge.send(input({ kind: 'key', key: '<CR>' }));
    // the chat screen took the launch: it says so, and the box is gone
    const frames = await bridge.until(
      (f) => f.type === 'tree' && f.screen === 'chat' && text(f).includes('Launching'),
    );

    expect(frames.some((f) => f.type === 'layer' && f.tree === null)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('`:override <what>` goes to the chat slot’s screen (a choice naming its slot)', async () => {
    await inProcess();
    const root = mkdtempSync(join(tmpdir(), 'abe-slot-'));
    const bridge = app(spawn('ui', 'bridge'));
    const key = (k: string) => ({ v: 2, type: 'input', input: { kind: 'key', key: k } });

    bridge.send({ ...HELLO, root });
    bridge.send(OPEN);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    bridge.send({ v: 2, type: 'project', root, branch: 'card/7-show-stock' });
    bridge.send({ v: 2, type: 'open', screen: 'chat', slot: 'chat' });
    await bridge.until((f) => isTree(f, 'No session on #7 yet'));
    bridge.send(key(':'));
    await bridge.until((f) => f.type === 'layer' && text(f).includes('"id":"command-mode"'));
    for (const ch of 'override db write test') bridge.send(key(ch === ' ' ? '<Space>' : ch));
    bridge.send(key('<CR>'));
    // no session pinned here: the chat screen says so (main's would say nothing)
    const frames = await bridge.until(
      (f) =>
        f.type === 'shell' &&
        f.effect.kind === 'balloon' &&
        text(f).includes('No session here to override'),
    );

    expect(frames.some((f) => f.type === 'shell' && f.effect.kind === 'focus')).toBe(true);
  });

  test('the Sessions tab in the pane slot: its Table from serve’s own reads', async () => {
    // your boxes (ADR 0042: this Mac is the default), read by none here
    await inProcess('serve.target: cloud\n');
    const root = mkdtempSync(join(tmpdir(), 'abe-pane-'));
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send({ ...HELLO, root });
    bridge.send(OPEN);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    bridge.send({ v: 2, type: 'resize', slot: 'pane', size: { width: 1020, height: 280 } });
    bridge.send({ v: 2, type: 'open', screen: 'sessions', slot: 'pane' });
    // this serve has no sessions, reads no boxes (no gh) and has no board: the unread row, the note
    const seen = await bridge.until(
      (f) => isTree(f, 'Board not read') && text(f).includes('Box sessions not read'),
    );
    const tree = seen.at(-1);

    expect(tree).toMatchObject({
      type: 'tree',
      screen: 'sessions',
      slot: 'pane',
      tree: { kind: 'Island', children: [{ kind: 'Table', id: 'sessions-table' }] },
    });
    expect(JSON.stringify(tree)).toContain('Box sessions not read');
    rmSync(root, { recursive: true, force: true });
  });

  test('a tab opened again: Sessions after Boxes draws its last rows at once, then reads them', async () => {
    // your boxes (ADR 0042: this Mac is the default), read by none here
    await inProcess('serve.target: cloud\n');
    const root = mkdtempSync(join(tmpdir(), 'abe-pane-'));
    const bridge = app(spawn('ui', 'bridge'));
    const pane = (f: BridgeFrame, screen: string) =>
      f.type === 'tree' && f.slot === 'pane' && f.screen === screen;

    bridge.send({ ...HELLO, root });
    bridge.send(OPEN);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    bridge.send({ v: 2, type: 'resize', slot: 'pane', size: { width: 1020, height: 280 } });
    bridge.send({ v: 2, type: 'open', screen: 'sessions', slot: 'pane' });
    await bridge.until((f) => pane(f, 'sessions') && text(f).includes('Box sessions not read'));
    bridge.send({ v: 2, type: 'open', screen: 'boxes', slot: 'pane' });
    await bridge.until((f) => pane(f, 'boxes'));
    bridge.send({ v: 2, type: 'open', screen: 'sessions', slot: 'pane' });
    const back = (await bridge.until((f) => pane(f, 'sessions'))).at(-1);

    expect(back === undefined ? '' : text(back)).not.toContain('Asking abe serve');
    expect(back === undefined ? '' : text(back)).toContain('Box sessions not read');
    rmSync(root, { recursive: true, force: true });
  });

  test('the Boxes tab in the pane slot: its Table from serve’s own box list', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send(HELLO);
    bridge.send(OPEN);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    bridge.send({ v: 2, type: 'resize', slot: 'pane', size: { width: 1400, height: 280 } });
    bridge.send({ v: 2, type: 'open', screen: 'boxes', slot: 'pane' });
    // this serve reaches no AWS: the boxes are not read, said in the Table's place
    const seen = await bridge.until(
      (f) => f.type === 'tree' && f.slot === 'pane' && !text(f).includes('Asking abe serve'),
    );

    expect(seen.at(-1)).toMatchObject({
      type: 'tree',
      screen: 'boxes',
      slot: 'pane',
      tree: { kind: 'Island', children: [{ kind: 'Table', id: 'boxes-table' }] },
    });
  });

  test('the Feel: its switches sent once serve answers, again when a Layer moves them', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));
    const isFeel = (f: BridgeFrame, feel: string) =>
      f.type === 'shell' && f.effect.kind === 'feel' && f.effect.feel.feel === feel;
    const config = join(abe.state.dir, '.config', 'abe');

    bridge.send(HELLO);
    const first = await bridge.until((f) => isFeel(f, 'vimstorm'));

    expect(first.at(-1)).toMatchObject({
      type: 'shell',
      effect: { kind: 'feel', feel: { tree: { autoReveal: false }, tabs: { limit: 10 } } },
    });
    mkdirSync(config, { recursive: true });
    // a change that moves no switch is no new frame; then the Feel moves them all
    writeFileSync(join(config, 'settings.yaml'), 'improve:\n  suggest: false\n');
    await Bun.sleep(1200);
    writeFileSync(join(config, 'settings.yaml'), 'ui:\n  feel: vscode\n');
    const vscode = await bridge.until((f) => isFeel(f, 'vscode'));

    expect(vscode.at(-1)).toMatchObject({
      type: 'shell',
      effect: {
        kind: 'feel',
        feel: { tree: { autoReveal: true }, tabs: { limit: null }, files: { autoSave: 'off' } },
      },
    });
    expect(vscode.filter((f) => f.type === 'shell' && f.effect.kind === 'feel')).toHaveLength(1);
  });

  test('ends when the app closes stdin', async () => {
    real();
    const bridge = spawn('ui', 'bridge');

    bridge.end();
    expect((await bridge.exited).exit).toBe(0);
  });
});

describe('Command mode over the bridge', () => {
  const key = (k: string) => ({ v: 2, type: 'input', input: { kind: 'key', key: k } });
  const typing = (text: string) => Array.from(text, (ch) => key(ch === ' ' ? '<Space>' : ch));
  const isLayer = (f: BridgeFrame, has: string) => f.type === 'layer' && text(f).includes(has);
  const closed = (f: BridgeFrame) => f.type === 'layer' && f.tree === null;

  const opened = async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send(HELLO);
    bridge.send(OPEN);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    bridge.send(key(':'));
    const frames = await bridge.until((f) => isLayer(f, '"id":"command-mode"'));

    return { bridge, frames };
  };

  test('`:` opens it as a layer over the screen, listing the command table but a session’s own steps', async () => {
    const { bridge, frames } = await opened();
    const last = frames.at(-1);

    expect(last?.type).toBe('layer');
    // nothing typed: Anywhere's rows and the placeholder, not the table
    expect(JSON.stringify(last)).toContain('"placeholder":"Ask anything, or a command"');
    expect(JSON.stringify(last)).not.toContain('"id":"command:');
    // no tree moved: the screen is still the status screen under the layer
    expect(frames.filter((f) => f.type === 'tree')).toEqual([]);
    // the command table's rows once typed, a session's own steps and the client's never
    for (const k of typing('fact')) bridge.send(k);
    const typed = await bridge.until((f) => isLayer(f, '"id":"command:factory status"'));

    expect(JSON.stringify(typed.at(-1))).not.toContain('factory decide');
    for (const k of [key('<C-u>'), ...typing('settings')]) bridge.send(k);
    await bridge.until((f) => isLayer(f, '"id":"command:settings get"'));
    for (const k of [key('<C-u>'), ...typing('watch')]) bridge.send(k);
    const watched = await bridge.until((f) => isLayer(f, '"filter":"watch"'));

    expect(JSON.stringify(watched.at(-1))).not.toContain('"command:watch"');
  });

  test('the Editor’s `:` lists its caret’s items under its caption, `:w⏎` Run in Neovim', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send(HELLO);
    bridge.send(OPEN);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    // the Editor has the keys; the app says where they are just before its `:`
    bridge.send({ v: 2, type: 'focus', slot: null });
    bridge.send({
      v: 2,
      type: 'editor-here',
      ex: ['write', 'quit'],
      caret: { file: 'api/src/cart.ts', line: 42 },
      items: [{ text: 'Go to Declaration', key: '⌘B' }],
    });
    bridge.send(key(':'));
    const up = await bridge.until((f) => isLayer(f, '"id":"command-mode"'));

    expect(JSON.stringify(up.at(-1))).toContain('"section":"api/src/cart.ts:42"');
    bridge.send(key('w'));
    await bridge.until((f) => isLayer(f, '"selected":"here:ex"'));
    bridge.send(key('<CR>'));
    await bridge.until(
      (f) => f.type === 'shell' && f.effect.kind === 'ex' && f.effect.text === 'w',
    );
    // said once: the next `:` (from the tree, say) has no caret Subject
    bridge.send(key(':'));
    const again = await bridge.until((f) => isLayer(f, '"id":"command-mode"'));

    expect(JSON.stringify(again.at(-1))).not.toContain('cart.ts:42');
  });

  test('a layer has the keys: the screen under it is told it lost them, and gets them back as it closes', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));
    const active = (on: boolean) => (f: BridgeFrame) =>
      isTree(f, '"id":"board-head"') && isTree(f, `"active":${on}`);

    bridge.send(HELLO);
    bridge.send({ v: 2, type: 'open', screen: 'factory' });
    bridge.send({ v: 2, type: 'focus', slot: 'main' });
    await bridge.until(active(true));
    // Command mode up over the Board: the Board draws as not having the keys
    bridge.send(key(':'));
    await bridge.until(active(false));
    bridge.send(key('<Esc>'));
    await bridge.until(active(true));
    // the keys elsewhere (the Chat column): a layer closing does not give them to the Board
    bridge.send({ v: 2, type: 'focus', slot: 'chat' });
    await bridge.until(active(false));
    bridge.send({ v: 2, type: 'input', slot: 'chat', input: { kind: 'key', key: ':' } });
    await bridge.until((f) => isLayer(f, '"id":"command-mode"'));
    bridge.send({ v: 2, type: 'input', slot: 'chat', input: { kind: 'key', key: '<Esc>' } });
    const after = await bridge.until(closed);

    expect(after.some(active(true))).toBe(false);
  });

  test('a screen opened while the keys are nowhere draws as not having them, under a first-key layer too', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));
    const head = (f: BridgeFrame) => isTree(f, '"id":"board-head"');
    const active = (on: boolean) => (f: BridgeFrame) => head(f) && isTree(f, `"active":${on}`);

    // the window not active yet (a launch behind another app, a shot's): the app names no slot
    bridge.send(HELLO);
    bridge.send({ v: 2, type: 'open', screen: 'factory' });
    const first = await bridge.until(head);

    expect(first.some(active(true))).toBe(false);
    // Command mode as the very first key: the Board under it is still grey
    bridge.send(key(':'));
    const up = await bridge.until((f) => isLayer(f, '"id":"command-mode"'));

    expect(up.some(active(true))).toBe(false);
    bridge.send(key('<Esc>'));
    await bridge.until(closed);
    // the window active: the Board lights up, and greys under a layer again
    bridge.send({ v: 2, type: 'focus', slot: 'main' });
    await bridge.until(active(true));
    bridge.send(key(':'));
    await bridge.until(active(false));
  });

  test('`?` lists the keys of the slot with the keys: the pane’s Sessions, then Chat’s', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));
    const ask = (slot: string) => ({ v: 2, type: 'input', slot, input: { kind: 'key', key: '?' } });
    const esc = { v: 2, type: 'input', input: { kind: 'key', key: '<Esc>' } };

    bridge.send(HELLO);
    bridge.send({ v: 2, type: 'open', screen: 'sessions', slot: 'pane' });
    bridge.send({ v: 2, type: 'focus', slot: 'pane' });
    bridge.send(ask('pane'));
    await bridge.until((f) => isLayer(f, 'Sessions keys'));
    bridge.send(esc);
    await bridge.until(closed);
    bridge.send({ v: 2, type: 'open', screen: 'chat', slot: 'chat' });
    bridge.send({ v: 2, type: 'focus', slot: 'chat' });
    bridge.send(ask('chat'));
    await bridge.until((f) => isLayer(f, 'Chat keys'));
  });

  test('⏎ runs a command through serve: its many lines in a list, Esc closes it', async () => {
    const { bridge } = await opened();

    for (const f of typing('status')) bridge.send(f);
    bridge.send(key('<CR>'));
    const frames = await bridge.until((f) => isLayer(f, '"title":"abe status"'));

    expect(frames.some(closed)).toBe(true);
    expect(JSON.stringify(frames.at(-1))).toContain('abe serve');
    bridge.send(key('<Esc>'));
    await bridge.until(closed);
  });

  test('a required argument is asked in a prompt; a refusal is a balloon with its code', async () => {
    const { bridge } = await opened();

    for (const f of typing('settings get')) bridge.send(f);
    bridge.send(key('<CR>'));
    await bridge.until((f) => isLayer(f, '"kind":"PromptLayer"'));
    for (const f of typing('nope')) bridge.send(f);
    bridge.send(key('<CR>'));
    const frames = await bridge.until((f) => f.type === 'shell' && f.effect.kind === 'balloon');

    // keyed by its run, said where, no `stays`: it fades
    expect(frames.at(-1)).toEqual({
      v: 2,
      type: 'shell',
      effect: {
        kind: 'balloon',
        tone: 'error',
        text: 'nope is not a setting (unknown-setting)',
        key: `run:settings\u0000get\u0000nope`,
        where: 'Command mode',
      },
    });
    // said on the status line too; a key once it was up a second takes that away
    await bridge.until(
      (f) => f.type === 'shell' && f.effect.kind === 'status' && f.effect.text !== '',
    );
    await Bun.sleep(1_100);
    bridge.send(key('<Esc>'));
    await bridge.until(
      (f) => f.type === 'shell' && f.effect.kind === 'status' && f.effect.text === '',
    );
  });

  test('an error goes once its cause is gone: the same run answered ok drops its balloon', async () => {
    real();
    const bridge = app(spawn('ui', 'bridge', '--no-start'));
    const sheetList = async () => {
      bridge.send(key(':'));
      await bridge.until((f) => isLayer(f, '"id":"command-mode"'));
      for (const f of typing('sheet list')) bridge.send(f);
      bridge.send(key('<CR>'));
    };

    bridge.send(HELLO);
    // no serve: `sheet list` is refused, a balloon keyed by its run
    await sheetList();
    const refused = await bridge.until((f) => f.type === 'shell' && f.effect.kind === 'balloon');
    const balloon = refused.at(-1);
    const balloonKey =
      balloon?.type === 'shell' && balloon.effect.kind === 'balloon' && balloon.effect.key;

    expect(balloonKey).toBe('run:sheet\u0000list');
    // serve up: the same run again answers ok, and the balloon and its status line go by themselves
    await abe.run('status');
    bridge.send(key('<Esc>'));
    await sheetList();
    const after = await bridge.until((f) => f.type === 'shell' && f.effect.kind === 'drop-balloon');

    expect(after.at(-1)).toEqual({
      v: 2,
      type: 'shell',
      effect: { kind: 'drop-balloon', key: 'run:sheet\u0000list' },
    });
  });

  test('commands run in the shown project’s folder: hello’s root, then project’s', async () => {
    await inProcess();
    const project = (name: string, target: string) => {
      const dir = mkdtempSync(join(tmpdir(), `abe-root-${name}-`));

      Bun.spawnSync(['git', 'init', '-q', dir]);
      mkdirSync(join(dir, '.abe'));
      writeFileSync(join(dir, 'abe.yaml'), `effort: ${target}\n`);

      return dir;
    };
    const shop = project('shop', 'low');
    const api = project('api', 'high');
    const bridge = app(spawn('ui', 'bridge'));
    const asked = async () => {
      bridge.send(key(':'));
      await bridge.until((f) => isLayer(f, '"id":"command-mode"'));
      for (const f of typing('settings get')) bridge.send(f);
      bridge.send(key('<CR>'));
      await bridge.until((f) => isLayer(f, '"kind":"PromptLayer"'));
      for (const f of typing('effort')) bridge.send(f);
      bridge.send(key('<CR>'));
      const frames = await bridge.until(
        (f) => f.type === 'shell' && f.effect.kind === 'status' && f.effect.text !== '',
      );

      return frames.map(text).at(-1) ?? '';
    };

    bridge.send({ ...HELLO, root: shop });
    bridge.send(OPEN);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    expect(await asked()).toContain('low');
    bridge.send({ v: 2, type: 'project', root: api });
    expect(await asked()).toContain('high');
    rmSync(shop, { recursive: true, force: true });
    rmSync(api, { recursive: true, force: true });
  });

  test('a repo serve followed is said and Recent told; one followed before the bridge watched, Recent alone', async () => {
    await inProcess();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-moved-')));
    const repo = (name: string) => {
      const dir = join(root, name);

      Bun.spawnSync(['git', 'init', '-q', dir]);
      mkdirSync(join(dir, '.abe'));

      return dir;
    };
    const seen = (dir: string) => requestAt(abe.state.socket, dir, 'status', '--json');
    const moved = (f: BridgeFrame) => f.type === 'shell' && f.effect.kind === 'repo-moved';

    // followed before the bridge watched: its balloon said by then, Recent told now
    const before = repo('before');

    await seen(before);
    renameSync(before, `${before}-moved`);
    await seen(`${before}-moved`);
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send(HELLO);
    bridge.send(OPEN);
    const told = await bridge.until(moved);

    expect(told.at(-1)).toMatchObject({ effect: { from: before, to: `${before}-moved` } });
    expect(told.some((f) => f.type === 'shell' && f.effect.kind === 'balloon')).toBe(false);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));

    // followed as the bridge watches: said, then Recent told
    const shop = repo('shop');

    await seen(shop);
    renameSync(shop, `${shop}-moved`);
    bridge.send({ v: 2, type: 'project', root: `${shop}-moved` });
    const said = await bridge.until(moved);

    expect(said.filter((f) => f.type === 'shell').slice(-2)).toMatchObject([
      { effect: { kind: 'balloon', tone: 'info', text: `${shop} moved to ${shop}-moved` } },
      { effect: { kind: 'repo-moved', from: shop, to: `${shop}-moved` } },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test('an argument abe takes for a flag is refused in its own words, with its code', async () => {
    const { bridge } = await opened();

    for (const f of typing('settings get')) bridge.send(f);
    bridge.send(key('<CR>'));
    await bridge.until((f) => isLayer(f, '"kind":"PromptLayer"'));
    for (const f of typing('--nope')) bridge.send(f);
    bridge.send(key('<CR>'));
    const frames = await bridge.until((f) => f.type === 'shell' && f.effect.kind === 'balloon');
    const balloon = frames.at(-1);

    expect(
      balloon?.type === 'shell' && balloon.effect.kind === 'balloon' && balloon.effect.text,
    ).toMatch(/^abe settings get --nope: .*\(usage\)$/);
    // said on the status line too, there once the balloon is closed
    const said = await bridge.until(
      (f) => f.type === 'shell' && f.effect.kind === 'status' && f.effect.text !== '',
    );

    const line = said.at(-1);

    expect(line?.type === 'shell' && line.effect.kind === 'status' && line.effect.text).toMatch(
      /^abe settings get --nope: .*\(usage\)$/,
    );
  });

  test('lists the table while no serve answers: help is the bridge’s own', async () => {
    real();
    const bridge = app(spawn('ui', 'bridge', '--no-start'));

    bridge.send(HELLO);
    bridge.send(key(':'));
    await bridge.until((f) => isLayer(f, '"id":"command-mode"'));
    // the table is the bridge's own: typed, its rows come with no serve (Ask grey)
    for (const f of typing('status')) bridge.send(f);
    const frames = await bridge.until((f) => isLayer(f, '"id":"command:status"'));

    expect(JSON.stringify(frames.at(-1))).toContain('"reason":"abe serve not answering"');
  });

  test('a screen’s word: :board shows the Abe view and opens its screen', async () => {
    const { bridge } = await opened();

    for (const f of typing('board')) bridge.send(f);
    bridge.send(key('<CR>'));
    const frames = await bridge.until((f) => f.type === 'tree' && f.screen === 'factory');

    expect(frames).toContainEqual({
      v: 2,
      type: 'shell',
      effect: { kind: 'view', view: 'factory' },
    });
    expect(frames.some(closed)).toBe(true);
  });
});

describe('the Settings dialog over the bridge', () => {
  const key = (k: string) => ({ v: 2, type: 'input', input: { kind: 'key', key: k } });
  const typing = (t: string) => Array.from(t, (ch) => key(ch === ' ' ? '<Space>' : ch));
  const isLayer = (f: BridgeFrame, has: string) => f.type === 'layer' && text(f).includes(has);
  const settings = { v: 2, type: 'open', screen: 'settings' };

  test('⌘,’s open is a layer over the screen with its rows read; keys go to it, Esc closes it', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send(HELLO);
    bridge.send(OPEN);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    bridge.send(settings);
    const frames = await bridge.until(
      (f) => isLayer(f, '"label":"Subagents"') || isLayer(f, '"scope":"'),
    );

    expect(frames.some((f) => isLayer(f, '"kind":"SettingsDialog"'))).toBe(true);
    // no tree moved: the dialog is a layer over the screen
    expect(frames.filter((f) => f.type === 'tree')).toEqual([]);
    // its first page once Problems answered (so no page jumps under you): Problems here
    await bridge.until((f) => isLayer(f, '"crumbs":["Problems'));
    // `/` searches every page: the dialog has the keys
    bridge.send(key('/'));
    for (const f of typing('idle')) bridge.send(f);
    await bridge.until((f) => isLayer(f, '"crumbs":["Search"]') && isLayer(f, 'Idle stop'));
    bridge.send(key('<Esc>'));
    bridge.send(key('<Esc>'));
    const closed = await bridge.until((f) => f.type === 'layer' && f.tree === null);

    expect(closed.at(-1)).toMatchObject({ type: 'layer', tree: null });
  });

  test('`:settings` in Command mode opens it', async () => {
    await inProcess();
    const bridge = app(spawn('ui', 'bridge'));

    bridge.send(HELLO);
    bridge.send(OPEN);
    await bridge.until((f) => isTree(f, '"title":"Sessions"'));
    bridge.send(key(':'));
    // Anywhere's Settings row, the word once typed
    await bridge.until((f) => isLayer(f, '"id":"anywhere:settings"'));
    for (const f of typing('settings')) bridge.send(f);
    bridge.send(key('<CR>'));
    const frames = await bridge.until((f) => isLayer(f, '"kind":"SettingsDialog"'));

    expect(frames.at(-1)).toMatchObject({ type: 'layer' });
  });
});

describe('abe ui render', () => {
  test('prints the status tree as an outline, and as --json', async () => {
    await inProcess();
    const out = await abe.run('ui', 'render', 'status');

    expect(out.exit).toBe(0);
    expect(out.stdout).toContain(
      'Island #serve\n    Stack direction="column"\n      ToolWindowHeader title="abe serve"\n',
    );
    expect(out.stdout).toContain(
      '      ToolWindowHeader title="Sessions" count=0\n      Empty title="No sessions"',
    );
    const json = await abe.json(UiRenderData, 'ui', 'render', 'status');

    expect(json.doc.ok && json.doc.data.screen).toBe('status');
  });

  test('an unknown screen is refused, naming the screens', async () => {
    await inProcess();
    const out = await abe.json(UiRenderData, 'ui', 'render', 'nope');

    expect(out.exit).toBe(1);
    expect(out.doc).toEqual({
      ok: false,
      error: {
        code: 'unknown-screen',
        message:
          'no screen "nope"; the screens: status, factory, chat, sessions, boxes, pipelines, review, welcome, run, card, prototype, settings',
      },
    });
  });

  test('its help names every screen it renders', async () => {
    await inProcess();
    const out = await abe.run('ui', 'render', '--help');

    expect(out.stdout).toContain(
      'screen  the screen: `status`, `factory`, `chat`, `sessions`, `boxes`, `pipelines`, `review`, `welcome`, `run`, `card`, `prototype`, or `settings` (the Settings dialog)\n',
    );
    expect(out.stdout).toContain(
      '--page  the Settings page to open (`problems`, `logins-tools`), with `settings`',
    );
  });

  test('settings draws the Settings dialog headless, on the page --page names', async () => {
    await inProcess();
    const out = await abe.run('ui', 'render', 'settings', '--page', 'vim');

    expect(out.exit).toBe(0);
    expect(out.stdout).toStartWith('SettingsDialog #settings title="Settings"');
    expect(out.stdout).toContain('SettingsPage #settings:page crumbs=["Editor","Vim"]');
    const json = await abe.json(UiRenderData, 'ui', 'render', 'settings', '--json');

    expect(json.doc.ok && json.doc.data.screen).toBe('settings');
    expect(json.doc.ok && json.doc.data.tree.kind).toBe('SettingsDialog');
  });

  test("settings waits for a page's reads: Logins & tools drawn with its checks, a group on its first page", async () => {
    await inProcess();
    const logins = await abe.run('ui', 'render', 'settings', '--page', 'logins-tools');

    expect(logins.exit).toBe(0);
    expect(logins.stdout).toContain('SettingsPage #settings:page crumbs=["Logins & tools"]');
    expect(logins.stdout).toContain('CheckRow #settings:line:');
    expect(logins.stdout).not.toContain('Checking logins and tools…');
    const group = await abe.run('ui', 'render', 'settings', '--page', 'editor');

    expect(group.stdout).toContain('SettingsPage #settings:page crumbs=["Editor","General"]');
  });

  test('settings refuses a page it has not, naming the pages; --page goes with settings only', async () => {
    await inProcess();
    const nope = await abe.json(UiRenderData, 'ui', 'render', 'settings', '--page', 'nope');

    expect(nope.exit).toBe(1);
    expect(nope.doc.ok ? '' : nope.doc.error.code).toBe('unknown-page');
    expect(nope.doc.ok ? '' : nope.doc.error.message).toStartWith(
      'no Settings page "nope"; the pages: problems, appearance, ',
    );
    const status = await abe.json(UiRenderData, 'ui', 'render', 'status', '--page', 'vim');

    expect(status.exit).toBe(2);
    expect(status.doc).toEqual({
      ok: false,
      error: {
        code: 'usage',
        message: '--page opens a Settings page: abe ui render settings --page <page>',
      },
    });
  });

  test("pipelines: the shown folder's runs, or why they were not read (the Pipelines tab)", async () => {
    await inProcess();
    const out = await abe.run('ui', 'render', 'pipelines');

    expect(out.exit).toBe(0);
    expect(out.stdout).not.toContain('Not drawn yet');
    expect(out.stdout).toContain('Island #pipelines');
    expect(out.stdout).toContain('"title":"Runs not read"');
    expect(out.stdout).toContain('has no GitHub origin to read its Actions from');
  });

  test('with --no-start and no serve, the tree says serve is not answering', async () => {
    real();
    const out = await abe.run('ui', 'render', 'status', '--no-start');

    expect(out.stdout).toContain('Empty title="abe serve is not answering"');
  });
});

/** Where the keys went, as the bridge tells the screens: each step's slot with the keys and a layer up. */
const keysWalk = (
  steps: readonly (readonly [now: 'main' | 'pane' | 'chat' | null, layer: boolean])[],
) => {
  let at: KeysTold = { told: null, under: null };
  const tells: string[] = [];

  for (const [now, layer] of steps) {
    const moved = keysMoved(at, now, layer);

    at = moved.state;
    tells.push(
      ...moved.tell.map(
        ([slot, i]) =>
          `${slot} ${i.focused ? 'got' : 'lost'}${i.layer === true ? ' to a layer' : ''}`,
      ),
    );
  }

  return { tells, at };
};

// A layer opened over a slot takes the keys with `layer: true`, so a list keeps its held order
// under a menu; they come back as it closes, or the slot is told it lost them for real.
describe('the keys told', () => {
  test.each<[string, Parameters<typeof keysWalk>[0], string[]]>([
    [
      'a slot gets them, then another: lost, got',
      [
        ['pane', false],
        ['chat', false],
      ],
      ['pane got', 'pane lost', 'chat got'],
    ],
    [
      'a menu opened over the list and closed: lost to a layer, then got back',
      [
        ['pane', false],
        [null, true],
        ['pane', false],
      ],
      ['pane got', 'pane lost to a layer', 'pane got'],
    ],
    [
      'the layer closed with the keys in another slot: the one under it lost them for real',
      [
        ['pane', false],
        [null, true],
        ['chat', false],
      ],
      ['pane got', 'pane lost to a layer', 'pane lost', 'chat got'],
    ],
    [
      'the layer closed with the keys in the Editor: lost, and no slot got them',
      [
        ['pane', false],
        [null, true],
        [null, false],
      ],
      ['pane got', 'pane lost to a layer', 'pane lost'],
    ],
    [
      'the keyboard moving while the layer is up is told no one until it closes',
      [
        ['pane', false],
        [null, true],
        [null, true],
        ['pane', false],
      ],
      ['pane got', 'pane lost to a layer', 'pane got'],
    ],
    [
      'nothing moved: nothing told',
      [
        ['pane', false],
        ['pane', false],
        [null, true],
        [null, true],
      ],
      ['pane got', 'pane lost to a layer'],
    ],
  ])('%s', (_, steps, tells) => {
    expect(keysWalk(steps).tells).toEqual(tells);
  });

  test('the slot that got them back holds them, with no layer under', () => {
    expect(
      keysWalk([
        ['pane', false],
        [null, true],
        ['pane', false],
      ]).at,
    ).toEqual({ told: 'pane', under: null });
  });
});

type Params = Readonly<Record<string, string>>;

const CHOSE: Params = { session: 's9', waking: 'shop-9' };

// A screen already open is opened again with the column's mode, which is the app's; what the
// screen pinned is kept when only the mode changed.
describe('a screen opened again keeps the column’s mode', () => {
  test.each<[string, Params, Params | undefined, Params, Params]>([
    [
      'the app changing only the mode keeps what the screen chose, waking said once',
      CHOSE,
      { card: '5' },
      { card: '5', mode: 'terminal' },
      { session: 's9', mode: 'terminal' },
    ],
    [
      'the mode taken off again keeps it too',
      { session: 's9', mode: 'terminal' },
      { card: '5', mode: 'terminal' },
      { card: '5' },
      { session: 's9' },
    ],
    [
      'another card is the app’s',
      CHOSE,
      { card: '5' },
      { card: '6', mode: 'terminal' },
      { card: '6', mode: 'terminal' },
    ],
    ['a screen the app never opened is the app’s', CHOSE, undefined, { card: '5' }, { card: '5' }],
    [
      'the same params again (⌘⌥A’s `from`, a selection that rested twice) are the app’s',
      CHOSE,
      { card: '5' },
      { card: '5' },
      { card: '5' },
    ],
  ])('%s', (_, chose, before, now, opened) => {
    expect(appOpenParams(chose, before, now)).toEqual(opened);
  });

  test.each<[Params, Params, Params]>([
    [{ card: '5', mode: 'terminal' }, { session: 's9' }, { session: 's9', mode: 'terminal' }],
    [{ card: '5' }, { session: 's9', mode: 'terminal' }, { session: 's9' }],
    // a session chosen in the Abe chat on Boxes stays on its main checkout
    [{ abe: '/repo' }, { session: 's9' }, { session: 's9', abe: '/repo' }],
  ])('a screen’s own open of %j stays in the column’s mode', (column, asked, opened) => {
    expect(screenOpenParams(column, asked)).toEqual(opened);
  });
});
