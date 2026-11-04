/**
 * View tweaks (#85): `views` hides, reorders and relabels a screen's parts by node id; every screen
 * the bridge opens draws its tree with them, read again on each settings change. Then a product
 * owner's `:improve show the terminal again` through Command mode and the overview, routed as the
 * bridge routes them.
 */
import { describe, expect, test } from 'bun:test';
import { type SessionData, VIEW_NODES, type ViewTweak } from '@abe/core';
import { z } from 'zod';
import {
  cardsAnswer,
  listCard,
  runsAnswer,
  session,
  sessionsAnswer,
  settingAnswer,
  factsInput,
} from '@abe/testing';
import { commandMode } from '../command/command';
import { type Node } from '../runtime/components';
import { factoryScreen } from '../board/factory';
import { type Command, type Input, mountLayer, step } from '../runtime/runtime';
import { SCREENS } from '../runtime/screens';
import { statusScreen } from './status';
import { applyViews, viewsOfValue, withViews } from './views';

const SIZE = { width: 1440, height: 846 };

const walk = (n: Node, out: Node[] = []): Node[] => {
  out.push(n);
  if ('children' in n) for (const c of n.children ?? []) walk(c, out);

  return out;
};
const ids = (tree: Node) => walk(tree).flatMap((n) => (n.id === undefined ? [] : [n.id]));
const find = (tree: Node, id: string) => walk(tree).find((n) => n.id === id);
const colIds = (tree: Node) =>
  walk(tree)
    .filter((n) => n.kind === 'BoardColumn' && n.id?.startsWith('col:') === true)
    .map((n) => n.id);

const viewsAnswer = (id: string, tweaks: ViewTweak[]): Input => ({
  kind: 'result',
  id,
  command: 'settings get',
  reply: {
    ok: true,
    data: {
      key: 'views',
      // as JSON comes back: no undefined keys
      value: z.json().parse(JSON.parse(JSON.stringify(tweaks))),
      layer: 'individual',
      lowered: null,
      problems: [],
    },
  },
});

const SETTINGS_CHANGED: Input = {
  kind: 'event',
  event: {
    seq: 1,
    at: '2026-10-23T09:00:00.000Z',
    type: 'settings.changed',
    data: { keys: [], repo: null, files: ['settings.yaml'] },
  },
};

/** The overview as the bridge holds it (with its tweaks) and Command mode over it. */
const drive = () => {
  const screen = withViews(factoryScreen);
  let held = step(screen, screen.init, { kind: 'open', params: {}, size: SIZE });
  const layer = mountLayer(commandMode([]));
  const runs: { id: string; argv: string[] }[] = [];
  const perform = (commands: readonly Command[]) => {
    for (const c of commands) if (c.kind === 'run') runs.push({ id: c.id, argv: c.argv });
  };
  const toScreen = (input: Input) => {
    held = step(screen, held.state, input);
    perform(held.commands);
  };

  perform(held.commands);
  const d = {
    runs,
    get tree(): Node {
      return held.tree;
    },
    send(...inputs: Input[]) {
      for (const input of inputs) {
        const person = input.kind === 'key' || input.kind === 'click' || input.kind === 'text';

        if (person && (layer.tree !== undefined || (input.kind === 'key' && input.key === ':')))
          perform(layer.send(input));
        else if (input.kind === 'result' && input.id === 'help') perform(layer.send(input));
        else toScreen(input);
      }

      return d;
    },
    /** The id of the last run of `argv`'s words. */
    last(...words: string[]) {
      const run = runs.filter((r) => words.every((w, i) => r.argv[i] === w)).at(-1);

      if (run === undefined)
        throw new Error(`no run of ${words.join(' ')}: ${JSON.stringify(runs)}`);

      return run.id;
    },
  };

  return d.send(
    factsInput(
      cardsAnswer([listCard(4, 'Cart total includes shipping', 'New')], true),
      cardsAnswer([listCard(4, 'Cart total includes shipping', 'New')], false),
      runsAnswer([]),
      sessionsAnswer([]),
    ),
    settingAnswer('target', 'serve.target', 'cloud'),
  );
};

describe('applyViews: a tweak over a tree', () => {
  const tree = drive().tree;

  test('hide takes the node out', () => {
    const hidden = applyViews('factory', tree, [
      { screen: 'factory', node: 'col:Closed', hide: true },
    ]);

    expect(colIds(hidden)).toEqual(['col:New', 'col:Active', 'col:Resolved']);
    const row = find(hidden, 'columns');

    expect(row?.kind === 'BoardColumns' ? row.children.length : undefined).toBe(3);
  });

  test('order moves it among its siblings; label gives it other words', () => {
    const tweaked = applyViews('factory', tree, [
      { screen: 'factory', node: 'col:Resolved', order: 0 },
      { screen: 'factory', node: 'col:Active', label: 'Doing' },
      { screen: 'factory', node: 'board-head', label: 'Sprint board' },
    ]);

    expect(colIds(tweaked)).toEqual(['col:Resolved', 'col:New', 'col:Active', 'col:Closed']);
    expect(find(tweaked, 'col:Active')).toMatchObject({ props: { name: 'Doing' } });
    expect(find(tweaked, 'board-head')).toMatchObject({ props: { title: 'Sprint board' } });
  });

  test('another screen’s tweaks, and a node not on screen now, change nothing', () => {
    expect(applyViews('factory', tree, [{ screen: 'status', node: 'serve', hide: true }])).toBe(
      tree,
    );
    expect(applyViews('factory', tree, [{ screen: 'factory', node: 'chat', hide: true }])).toBe(
      tree,
    );
  });

  test('a settings value reads as tweaks of the right shape only', () => {
    const read = viewsOfValue([
      { screen: 'factory', node: 'col:Closed', hide: true },
      { screen: 'factory', node: 'col:Active', order: 1 },
      { screen: 'factory', node: 'x' },
      'nonsense',
    ]);

    expect(read).toEqual([
      { screen: 'factory', node: 'col:Closed', hide: true },
      { screen: 'factory', node: 'col:Active', order: 1 },
    ]);
    expect(viewsOfValue(null)).toEqual([]);
  });
});

describe('core’s node ids are the screens’', () => {
  test('every fixed id of the factory catalog is in the overview’s tree', () => {
    const d = drive();
    const shown = ids(d.tree);

    for (const n of VIEW_NODES.factory ?? [])
      if (n.part === undefined && !n.id.includes('<')) expect(shown).toContain(n.id);
    expect(shown.some((id) => id.startsWith('col:'))).toBe(true);
  });

  test('every screen of the catalog is a screen the bridge opens', () => {
    expect(Object.keys(VIEW_NODES).sort()).toEqual(Object.keys(SCREENS).sort());
  });
});

describe('every screen draws with your views', () => {
  test('read on open and on every settings change; the tweak changes the factory tree', () => {
    const d = drive();

    expect(colIds(d.tree)).toContain('col:Closed');
    d.send(
      viewsAnswer(d.last('settings', 'get', 'views'), [
        { screen: 'factory', node: 'col:Closed', hide: true },
      ]),
    );
    expect(colIds(d.tree)).not.toContain('col:Closed');
    // undone: the settings change and the read says none
    d.send(SETTINGS_CHANGED);
    const again = d.last('settings', 'get', 'views');

    d.send(viewsAnswer(again, []));
    expect(colIds(d.tree)).toContain('col:Closed');
  });

  test('the keys walk the columns as drawn: never into a hidden one, a moved one where it shows', () => {
    const d = drive();
    const focused = () =>
      walk(d.tree).find((n) => n.kind === 'BoardColumn' && n.props.focused === true)?.id;
    const keys = (...ks: string[]) => d.send(...ks.map((k): Input => ({ kind: 'key', key: k })));
    const cards = (['New', 'Active', 'Resolved', 'Closed'] as const).map((state, i) =>
      listCard(10 + i, `Card ${state}`, state),
    );

    // a card in every column
    d.send(
      factsInput(
        cardsAnswer(cards, true),
        cardsAnswer(cards, false),
        runsAnswer([]),
        sessionsAnswer([]),
      ),
    );
    d.send(
      viewsAnswer(d.last('settings', 'get', 'views'), [
        { screen: 'factory', node: 'col:Closed', hide: true },
        { screen: 'factory', node: 'col:Resolved', order: 0 },
      ]),
    );
    expect(colIds(d.tree)).toEqual(['col:Resolved', 'col:New', 'col:Active']);
    keys('ä', 'ä', 'ä', 'ä');
    expect(focused()).toBe('col:Active');
    keys('k', 'k', 'k', 'k');
    expect(focused()).toBe('col:Resolved');
  });

  test('an older read answering late changes nothing; a failed read keeps the tweaks', () => {
    const d = drive();
    const first = d.last('settings', 'get', 'views');

    d.send(SETTINGS_CHANGED);
    const second = d.last('settings', 'get', 'views');

    d.send(viewsAnswer(second, [{ screen: 'factory', node: 'col:Closed', hide: true }]));
    d.send(viewsAnswer(first, []));
    expect(colIds(d.tree)).not.toContain('col:Closed');
    d.send(SETTINGS_CHANGED, {
      kind: 'result',
      id: d.last('settings', 'get', 'views'),
      command: 'settings get',
      reply: { ok: false, error: { code: 'no-settings', message: 'none' } },
    });
    expect(colIds(d.tree)).not.toContain('col:Closed');
  });
});

describe('a cloud launch’s clock by the second through the wrapper (#142)', () => {
  const at = '2026-10-01T09:00:00.000Z';
  const starting: SessionData = {
    ...session('s4', 'starting', 1),
    worktree: '/w',
    box: 'demo-shop-1',
    since: at,
    startedAt: at,
    launch: {
      step: 'box-booting',
      since: at,
      startedAt: at,
      box: 'demo-shop-1',
      how: 'new',
      detail: null,
      told: false,
      done: [],
    },
  };

  test.each(['chat', 'sessions', 'factory'])(
    '%s ticks while a launch starts, not after',
    (name) => {
      const screen = SCREENS[name];

      if (screen === undefined) throw new Error(name);
      const { mounted } = screen.mount({ root: '/w' }, SIZE);

      expect(mounted.seconds()).toBe(false);
      mounted.send(factsInput(sessionsAnswer([starting])));
      expect(mounted.seconds()).toBe(true);
      mounted.send(factsInput(sessionsAnswer([{ ...starting, state: 'working', launch: null }])));
      expect(mounted.seconds()).toBe(false);
    },
  );
});

describe('the views read is the wrapper’s own', () => {
  const ran = (noun: string, verb: string | null, tag?: string): Input => ({
    kind: 'event',
    event: {
      seq: 2,
      at: '2026-10-23T09:00:00.000Z',
      type: 'command.ran',
      data: { noun, verb, exit: 0, ...(tag === undefined ? {} : { tag }) },
    },
  });

  test('its command.ran never reaches the screen: status does not read again nor name it', () => {
    const screen = withViews(statusScreen);
    const opened = screen.step(screen.init, { kind: 'open', params: {}, size: SIZE });
    const sent = opened.commands.find((c) => c.kind === 'run' && c.argv[0] === 'settings');

    expect(sent).toMatchObject({ kind: 'run', id: 'views:read:1' });
    const own = screen.step(opened.state, ran('settings', 'get', 'views:read:1'));

    expect(own.commands).toEqual([]);
    expect(own.state).toBe(opened.state);
    // anyone else's command still does
    const other = screen.step(opened.state, ran('sheet', 'list'));

    expect(other.state.inner.last).toBe('abe sheet list, exit 0');
  });

  test("someone else's abe settings get is no echo: it shows as Last command", () => {
    const screen = withViews(statusScreen);
    const opened = screen.step(screen.init, { kind: 'open', params: {}, size: SIZE });
    const theirs = screen.step(opened.state, ran('settings', 'get'));

    expect(theirs.state.inner.last).toBe('abe settings get, exit 0');
    // another screen's run with a tag of its own is no echo either
    const other = screen.step(opened.state, ran('settings', 'get', 'cmd:3'));

    expect(other.state.inner.last).toBe('abe settings get, exit 0');
  });
});
