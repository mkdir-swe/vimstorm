/**
 * The Boxes tab (#104 S2, board X-Boxes) as the bridge drives it in the pane slot: its one read and
 * the quiet 5-minute one, the columns per state, problems first, the clock moving Up / Cost / the
 * stuck time, events changing rows in place, ⏎ attaching, the filter, and the empty, login and
 * unread states.
 */
import { describe, expect, test } from 'bun:test';
import type { BoxData, PortForward, PortListData } from '@abe/core';
import { boxCostAt } from '@abe/core';
import { BOXES_OFF } from '@abe/core/box-text';
import {
  X_BOXES,
  boxesAnswer,
  cardsAnswer,
  type EventBody,
  eventInput,
  listCard,
  settingAnswer,
} from '@abe/testing';
import { boxesScreen, type BoxesState, costAt, sizesUpTo } from './boxes';
import { commandMode } from '../command/command';
import { type Node, type Table } from '../runtime/components';
import { type ConfirmLayer, type PickLayer, type PromptLayer } from '../runtime/layers';
import { type Command, type Input, mount, mountLayer, step } from '../runtime/runtime';
import { withLive } from '../live';

const SIZE = { width: 1400, height: 280 };
const MIN = 60_000;

const at = (minutes: number) => new Date(Date.parse(X_BOXES.now) + minutes * MIN).toISOString();

/** Boxes with its live facts, as the bridge feeds them (the board's titles). */
const LIVE_BOXES = withLive(boxesScreen);

const drive = (params: Record<string, string> = {}) => {
  let held = step(LIVE_BOXES, LIVE_BOXES.init, { kind: 'open', params, size: SIZE });
  let commands: Command[] = held.commands;
  const d = {
    get state(): BoxesState {
      return held.state.screen;
    },
    get commands(): Command[] {
      return commands;
    },
    get table(): Table {
      const t = held.tree.kind === 'Island' ? held.tree.children[0] : undefined;

      if (t?.kind !== 'Table') throw new Error(`no Table: ${JSON.stringify(held.tree)}`);

      return t;
    },
    send(...inputs: Input[]) {
      for (const input of inputs) {
        held = step(LIVE_BOXES, held.state, input);
        commands = held.commands;
      }

      return d;
    },
    keys: (...keys: string[]) => d.send(...keys.map((key): Input => ({ kind: 'key', key }))),
    tick: (minutes = 0) => d.send({ kind: 'tick', at: at(minutes) }),
    read(boxes: BoxData[] = [X_BOXES.asleep, X_BOXES.running], queued = [X_BOXES.queued]) {
      d.tick().send(boxesAnswer(boxes, queued));
      // The board's titles of the workspaces' cards, when the screen asked for them.
      if (argvs(commands).includes('card list --closed')) d.send(titlesAnswer());

      return d;
    },
    /** Each row's cells as words: `#1 show stock…`, `● running`, … */
    rows: () =>
      d.table.props.rows.map((r) =>
        r.cells
          .map((c) => [c.accent, c.mark, c.text].filter((x) => x !== undefined).join(' '))
          .join(' | '),
      ),
    names: () => d.table.props.rows.map((r) => r.id),
  };

  return d;
};

/** A read of the tab: its boxes and, beside them, their workspaces' ports (#16). */
const READS = ['box list', 'port list'];

const argvs = (commands: readonly Command[]) =>
  commands.flatMap((c) => (c.kind === 'run' ? [c.argv.join(' ')] : []));

/** The team's `card list` (live's) the screen follows for its workspaces' titles (X_BOXES.titles). */
const titlesAnswer = (): Input =>
  cardsAnswer(
    Object.entries(X_BOXES.titles).map(([id, title]) => listCard(Number(id), title, 'Active')),
    false,
  );

const event = (e: EventBody & { at?: string }): Input => eventInput(e, at(0));

const ALL = [X_BOXES.asleep, X_BOXES.running, X_BOXES.stuck, X_BOXES.silent];

describe('the boxes screen', () => {
  test('reads box list once on open, asking meanwhile; opened again it reads nothing', () => {
    const d = drive();

    expect(argvs(d.commands)).toEqual(READS);
    expect(d.table.props.empty).toEqual({
      title: 'Asking abe serve',
      line: 'Your boxes, a moment',
    });
    expect(argvs(d.send({ kind: 'open', params: {}, size: SIZE }).commands)).toEqual([]);
  });

  test('opened again once another tab had the pane (#156): its last rows at once, read anew', () => {
    const tableOf = (node: Node): Table => {
      const t = node.kind === 'Island' ? node.children[0] : undefined;

      if (t?.kind !== 'Table') throw new Error(`no Table: ${JSON.stringify(node)}`);

      return t;
    };
    const { mounted } = mount(boxesScreen, {}, SIZE);

    mounted.send({ kind: 'tick', at: at(0) });
    mounted.send(boxesAnswer([X_BOXES.asleep, X_BOXES.running], [X_BOXES.queued]));
    const shown = tableOf(mounted.tree).props.rows.map((r) => r.id);
    const again = mounted.reopen({}, SIZE);

    expect(shown.length).toBe(3);
    expect(argvs(again?.commands ?? [])).toEqual(READS);
    const first = tableOf(again?.mounted.tree ?? mounted.tree);

    expect(first.props.rows.map((r) => r.id)).toEqual(shown);
    expect(first.props.empty).toBeUndefined();
    // the read's answer is what it shows then
    again?.mounted.send(boxesAnswer([X_BOXES.running], []));
    expect(tableOf(again?.mounted.tree ?? mounted.tree).props.rows.map((r) => r.id)).toEqual([
      'box:demo-shop-1',
    ]);
  });

  test("X-Boxes' columns and rows: running then asleep, each column as 4.1 draws it", () => {
    const d = drive().read([X_BOXES.asleep, X_BOXES.running], []);

    expect(d.table.props.columns.map((c) => c.label)).toEqual([
      'Box',
      'Story',
      'State',
      'Size',
      'Disk',
      'Release',
      'Up',
      'Cost',
      'Until',
    ]);
    expect(d.rows()).toEqual([
      'demo-shop-1 | — | ● running | m8g.large | — | v11 | 1 h 12 min | $0.12 today | stops at 10:30',
      'demo-shop-3 | — | ○ asleep | m8g.large | — | v11 | — | $0.84 today | —',
    ]);
    const [running] = d.table.props.rows;

    expect(running?.cells[2]).toEqual({ mark: '●', text: 'running', hue: 'warn' });
    expect(running?.cells[7]?.tooltip).toBe('today since 00:00 · on-demand estimate');
    expect(d.table.props.selected).toBe('box:demo-shop-1');
    expect(d.table.props.foot?.map((f) => `${f.keys} ${f.label}`)).toEqual([
      '⏎ box shell',
      '⌘⏎ actions',
      'r read again',
    ]);
  });

  test("Release: a box on another abe than this Mac's says its version, the skew on hover (#188)", () => {
    const skew =
      "demo-shop-1 runs abe 2.0.0-alpha.0, this machine 2.2.0-1a2b3c4d: commands newer than the box's abe fail there · update the box release (docs/cloud.md › A new abe on your box)";
    const d = drive().read(
      [
        { ...X_BOXES.running, abe: '2.0.0-alpha.0', skew },
        { ...X_BOXES.asleep, abe: '2.2.0-1a2b3c4d' },
      ],
      [],
    );
    const [old, same] = d.table.props.rows;

    expect(old?.cells[5]).toEqual({ text: 'v11 · abe 2.0.0-alpha.0', hue: 'warn', tooltip: skew });
    expect(same?.cells[5]).toEqual({ text: 'v11', hue: 'dim', tooltip: 'abe 2.2.0-1a2b3c4d' });
  });

  test('problems first (stuck starting, serve silent) in bad, then running, Queued, asleep', () => {
    const d = drive().read(ALL, [X_BOXES.queued]);

    expect(d.names()).toEqual([
      'box:demo-shop-2',
      'box:demo-shop-4',
      'box:demo-shop-1',
      'box:demo-shop-5',
      'box:demo-shop-3',
    ]);
    expect(d.rows()[0]).toBe(
      'demo-shop-2 | — | ● starting · 6 min | m8g.large | — | v11 | 6 min | $0.01 today | —',
    );
    expect(d.rows()[1]).toContain('● running · serve not answering · ');
    // The State cell's tooltip: what is true and the next step, as --on and box status say it (#143).
    const [stuck, silent] = d.table.props.rows.map((r) => r.cells[2]?.tooltip);

    expect(stuck).toBe(
      'box demo-shop-2 is starting · 6 min · try again in a minute; abe box status demo-shop-2 says when it runs',
    );
    // Up 1 h 12 min: past booting, never told to wake.
    expect(silent).toBe(
      'box demo-shop-4 is running · serve not answering · 1 h 12 min · abe box attach demo-shop-4 -- journalctl -u abe-serve says why; abe box stop demo-shop-4, then abe box start demo-shop-4 boots it again',
    );
    expect(d.rows()[3]).toBe(
      'demo-shop-5 | #5 show delivery dates | Queued | — | — | — | — | — | —',
    );
    expect(d.table.props.rows.map((r) => r.hue)).toEqual([
      'bad',
      'bad',
      undefined,
      undefined,
      undefined,
    ]);
    expect(d.table.props.rows[0]?.cells[2]?.hue).toBe('bad');
    // a box starting under 5 minutes is no problem: starting, after running
    const fresh = { ...X_BOXES.stuck, launchedAt: at(-2) };

    expect(drive().read([fresh, X_BOXES.running], []).rows()[1]).toContain('● starting |');
  });

  test("State's hues as DS AgentStatus: running warn, starting, stopping and asleep dim", () => {
    const fresh = { ...X_BOXES.stuck, launchedAt: at(-2) };
    // as the serve lists a box being stopped (#235): no serve, workspace or idle stop
    const stopping: BoxData = {
      ...X_BOXES.running,
      name: 'demo-shop-6',
      state: 'stopping',
      serve: null,
      workspace: null,
    };

    delete stopping.idle;
    const d = drive().read([X_BOXES.asleep, stopping, fresh, X_BOXES.running], []);

    expect(d.names()).toEqual([
      'box:demo-shop-1',
      'box:demo-shop-2',
      'box:demo-shop-6',
      'box:demo-shop-3',
    ]);
    expect(d.table.props.rows.map((r) => r.cells[2])).toEqual([
      { mark: '●', text: 'running', hue: 'warn' },
      { mark: '●', text: 'starting', hue: 'dim' },
      { mark: '●', text: 'stopping', hue: 'dim' },
      { mark: '○', text: 'asleep', hue: 'dim' },
    ]);
    expect(d.table.props.rows.map((r) => r.hue)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test('Up, Cost and the stuck time tick from the clock, the rows kept while it reads', () => {
    const d = drive().read(ALL, []);

    expect(argvs(d.tick(2).commands)).toEqual([]);
    expect(d.rows()[0]).toContain('● starting · 8 min');
    // half an hour on: the quiet read is due, and the rows move meanwhile
    expect(argvs(d.tick(30).commands)).toEqual(READS);
    expect(d.rows()[0]).toContain('● starting · 36 min');
    // running: 1 h 42 min up, its cost grown by half an hour at $0.10004 an hour
    expect(d.rows()[2]).toContain('1 h 42 min | $0.17 today |');
    // asleep: its cost holds
    expect(d.rows()[3]).toContain('$0.84 today');
  });

  test('box.state and box.idle change rows in place; the selection stays on its box by name', () => {
    const d = drive().read([X_BOXES.asleep, X_BOXES.running], []).keys('ö');

    expect(d.table.props.selected).toBe('box:demo-shop-3');
    // Keep awake: Until says it at once
    d.send(
      event({
        type: 'box.idle',
        data: { box: 'demo-shop-1', idle: X_BOXES.idle(null, ['awake']) },
      }),
    );
    expect(argvs(d.commands)).toEqual([]);
    expect(d.rows()[0]).toEndWith('| kept awake');
    // kept up by something else
    d.send(
      event({
        type: 'box.idle',
        data: { box: 'demo-shop-1', idle: X_BOXES.idle(null, ['working']) },
      }),
    );
    expect(d.rows()[0]).toEndWith('| kept up · session working');
    // Let it sleep: the stop time back
    d.send(
      event({
        type: 'box.idle',
        data: { box: 'demo-shop-1', idle: X_BOXES.idle(X_BOXES.local(10, 45)) },
      }),
    );
    expect(d.rows()[0]).toEndWith('| stops at 10:45');
    // demo-shop-3 woken: starting, its Up from the move; demo-shop-1 stopped: asleep, its cost held
    d.send(
      event({ type: 'box.state', data: { box: 'demo-shop-3', state: 'starting', cause: 'start' } }),
      event({ type: 'box.state', data: { box: 'demo-shop-1', state: 'stopped', cause: 'stop' } }),
    );
    expect(argvs(d.commands)).toEqual([]);
    // the list worked with the keys holds its order (#264): the rows change in place
    expect(d.rows()).toEqual([
      'demo-shop-1 | — | ○ asleep | m8g.large | — | v11 | — | $0.12 today | —',
      'demo-shop-3 | — | ● starting | m8g.large | — | v11 | 0 min | $0.84 today | —',
    ]);
    expect(d.table.props.selected).toBe('box:demo-shop-3');
    // the pane lost the keyboard: sorted afresh, the selection on its box
    d.send({ kind: 'focus', focused: false });
    expect(d.names()).toEqual(['box:demo-shop-3', 'box:demo-shop-1']);
    expect(d.table.props.selected).toBe('box:demo-shop-3');
    // running, then terminated: gone
    d.send(
      event({ type: 'box.state', data: { box: 'demo-shop-3', state: 'running', cause: 'start' } }),
    );
    expect(d.rows()[0]).toContain('● running');
    d.send(
      event({
        type: 'box.state',
        data: { box: 'demo-shop-3', state: 'terminated', cause: 'terminate' },
      }),
    );
    expect(d.names()).toEqual(['box:demo-shop-1']);
  });

  test('a box not known, or a move that says too little, reads the list again', () => {
    const d = drive().read([X_BOXES.running], []);

    d.send(
      event({ type: 'box.state', data: { box: 'demo-shop-9', state: 'starting', cause: 'up' } }),
    );
    expect(argvs(d.commands)).toEqual(READS);
    // the rows stay while it reads (no spinner); a second event meanwhile asks nothing more
    expect(d.names()).toEqual(['box:demo-shop-1']);
    d.send(
      event({ type: 'box.state', data: { box: 'demo-shop-1', state: 'failed', cause: 'up' } }),
    );
    expect(argvs(d.commands)).toEqual([]);
    d.send(
      boxesAnswer([
        X_BOXES.running,
        X_BOXES.box('demo-shop-9', { state: 'pending', launchedAt: at(0) }),
      ]),
    );
    expect(d.names()).toEqual(['box:demo-shop-1', 'box:demo-shop-9']);
    // box.idle of a box not listed (a teammate's is never yours): nothing
    d.send(
      event({ type: 'box.idle', data: { box: 'theirs-1', idle: X_BOXES.idle(null, ['awake']) } }),
    );
    expect(d.names()).toEqual(['box:demo-shop-1', 'box:demo-shop-9']);
  });

  test('while shown it reads the list again quietly every 5 minutes', () => {
    const d = drive().read([X_BOXES.running], []);

    expect(argvs(d.tick(4).commands)).toEqual([]);
    expect(argvs(d.tick(5).commands)).toEqual(READS);
    expect(d.names()).toEqual(['box:demo-shop-1']);
    // stopped from the AWS console: asleep once the read answers
    d.send(boxesAnswer([{ ...X_BOXES.running, state: 'stopped', serve: null }]));
    expect(d.rows()[0]).toContain('○ asleep');
    expect(argvs(d.tick(9).commands)).toEqual([]);
    expect(argvs(d.tick(10).commands)).toEqual(READS);
  });

  test("⏎ opens the box's own shell in a Terminal tab (asleep too: the attach wakes it); Queued: nothing", () => {
    const d = drive().read([X_BOXES.asleep, X_BOXES.running], [X_BOXES.queued]);

    expect(d.keys('<CR>').commands).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'terminal-tab',
          argv: ['abe', 'box', 'attach', 'demo-shop-1', '--', 'bash', '-l'],
          title: 'demo-shop-1',
        },
      },
    ]);
    expect(d.keys('G', '<CR>').commands).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'terminal-tab',
          argv: ['abe', 'box', 'attach', 'demo-shop-3', '--', 'bash', '-l'],
          title: 'demo-shop-3',
        },
      },
    ]);
    expect(d.keys('l', '<CR>').commands).toEqual([]);
    expect(d.table.props.selected).toBe('box:demo-shop-5');
  });

  test('l ö gg G move; a click selects; ⌃L jumps along the selected row’s story', () => {
    // ADR 0022: each box's workspaces under it; a box's story is its only workspace's
    const silent4: BoxData = {
      ...X_BOXES.silent,
      workspaces: [X_BOXES.ws(4, 'mkdir-swe/demo-shop')],
    };
    const d = drive().read([X_BOXES.stuck, silent4, holding1, X_BOXES.asleep], [X_BOXES.queued]);
    const linked = () => boxesScreen.linked?.(d.state);

    expect(d.names()).toEqual([
      'box:demo-shop-2',
      'box:demo-shop-4',
      'box:demo-shop-4:ws:4',
      'box:demo-shop-1',
      'box:demo-shop-1:ws:1',
      'box:demo-shop-5',
      'box:demo-shop-3',
    ]);
    // starting, its workspaces not read yet: no story
    expect(linked()).toBeUndefined();
    d.keys('ö');
    expect(linked()).toBe(4);
    d.keys('ö', 'ö');
    expect(d.table.props.selected).toBe('box:demo-shop-1');
    expect(linked()).toBe(1);
    d.keys('G');
    expect(d.table.props.selected).toBe('box:demo-shop-3');
    d.keys('l');
    expect(linked()).toBe(5);
    d.keys('g', 'g');
    expect(d.table.props.selected).toBe('box:demo-shop-2');
    d.send({ kind: 'click', id: 'box:demo-shop-4:ws:4' });
    expect(linked()).toBe(4);
    // a box holding two: no one story of its own
    const two: BoxData = {
      ...X_BOXES.running,
      workspaces: [X_BOXES.ws(1, 'mkdir-swe/demo-shop'), X_BOXES.ws(7, 'mkdir-swe/demo-shop')],
    };

    expect(boxesScreen.linked?.(drive().read([two], []).state)).toBeUndefined();
  });

  test('/ filters as you type by box, story or title; ⏎ keeps it, Esc clears it', () => {
    const silent4: BoxData = {
      ...X_BOXES.silent,
      workspaces: [X_BOXES.ws(4, 'mkdir-swe/demo-shop')],
    };
    const d = drive()
      .read([X_BOXES.stuck, silent4, holding1, X_BOXES.asleep], [X_BOXES.queued])
      .keys('/', 's', 't', 'o', 'c', 'k');

    expect(boxesScreen.typing?.(d.state)).toBe(true);
    // #1's title: its workspace's row
    expect(d.names()).toEqual(['box:demo-shop-1:ws:1']);
    expect(d.table.props.note).toBe('/stock▏ · 1 of 7');
    expect(d.table.props.filter).toBe('stock');
    d.keys('<CR>');
    expect(d.table.props.note).toBe('/stock · 1 of 7');
    expect(boxesScreen.typing?.(d.state)).toBe(false);
    // `/` again: a new text (the Board's, #245)
    d.keys('/');
    expect(d.table.props.note).toBe('/▏');
    d.keys('#', '4');
    expect(d.names()).toEqual(['box:demo-shop-4:ws:4']);
    d.keys('<Esc>');
    expect(d.names()).toHaveLength(7);
    d.keys('/', 'z', 'z');
    expect(d.table.props.empty).toEqual({
      title: 'No boxes match “zz”',
      line: 'Esc clears the filter',
    });
  });

  test('states: no boxes; the AWS login expired (⏎ logs in); not read (the rows kept); serve down', () => {
    expect(drive().read([], []).table.props.empty).toEqual({
      title: 'No boxes',
      line: 'a story launched on a box makes one',
    });
    const login = drive()
      .tick()
      .send({
        kind: 'result',
        id: 'boxes',
        command: 'box list',
        reply: {
          ok: false,
          error: {
            code: 'aws-auth',
            // the profile is the error's own, never read out of its words
            message: 'not logged in to AWS (Token has expired)',
            profile: 'abe-tooling',
          },
        },
      });

    expect(login.rows()).toEqual(['● AWS login expired · aws sso login --profile abe-tooling']);
    expect(login.keys('<CR>').commands).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'terminal-tab',
          argv: ['aws', 'sso', 'login', '--profile', 'abe-tooling'],
          title: 'aws sso login',
        },
      },
    ]);
    // logged in, read again: the rows
    login.send(boxesAnswer([X_BOXES.running]));
    expect(login.names()).toEqual(['box:demo-shop-1']);

    const unread = drive()
      .read([X_BOXES.running], [])
      .send(
        event({ type: 'boxes.unread', data: { code: 'aws-failed', message: 'EC2 not answering' } }),
      );

    expect(unread.table.props.note).toBe('Boxes not read · EC2 not answering');
    expect(unread.names()).toEqual(['box:demo-shop-1']);
    expect(unread.send(boxesAnswer([X_BOXES.running])).table.props.note).toBe('Read 10:00');

    const down = drive()
      .tick()
      .send({
        kind: 'result',
        id: 'boxes',
        command: 'box list',
        reply: { ok: false, error: { code: 'serve-unreachable', message: 'no abe serve' } },
      });

    expect(down.table.props.empty).toEqual({
      title: 'abe serve not answering',
      line: 'no abe serve',
    });
    // any other refusal says the boxes were not read, in its own words
    const other = drive()
      .tick()
      .send({
        kind: 'result',
        id: 'boxes',
        command: 'box list',
        reply: { ok: false, error: { code: 'no-boxes', message: 'boxes are off here' } },
      });

    expect(other.table.props.empty).toEqual({
      title: 'Boxes not read',
      line: 'boxes are off here',
    });
    // serve.target local and no box profile (#344): off, in words, never a raw aws line
    const off = drive()
      .tick()
      .send({
        kind: 'result',
        id: 'boxes',
        command: 'box list',
        reply: { ok: false, error: BOXES_OFF },
      });

    expect(off.table.props.empty).toEqual({
      title: 'Boxes are off',
      line: 'serve.target is local, so launches run on this machine · abe settings set serve.target cloud uses your boxes',
    });
    expect(off.table.props.note).toBeUndefined();
  });

  test('opened on a box (Linked’s box row) selects it', () => {
    const d = drive({ box: 'demo-shop-3' }).read();

    expect(d.table.props.selected).toBe('box:demo-shop-3');
  });

  test('a box with no abe:title: its Story the board’s title of its card, read once', () => {
    const untitled = X_BOXES.box('demo-shop-7', { card: 7, title: '' });
    const d = drive()
      .tick()
      .send(boxesAnswer([untitled, X_BOXES.running], []));

    expect(argvs(d.commands)).toEqual(['card list --closed']);
    expect(d.rows().find((r) => r.startsWith('demo-shop-7'))).toContain('| #7 |');
    const answer = cardsAnswer([listCard(7, 'Show delivery dates', 'Active')], false);

    d.send(answer);
    expect(d.rows().find((r) => r.startsWith('demo-shop-7'))).toContain('#7 show delivery dates');
    // read again: the titles kept, not asked twice
    d.send(boxesAnswer([untitled]));
    expect(argvs(d.commands)).toEqual([]);
    // a box with its own title asks nothing
    expect(argvs(drive().read([X_BOXES.running], []).commands)).toEqual([]);
    // a new untitled card the board was not read for: read again
    const other = X_BOXES.box('demo-shop-8', { card: 8, title: null });

    d.send(boxesAnswer([untitled, other]));
    expect(argvs(d.commands)).toEqual(['card list --closed']);
    d.send(answer, boxesAnswer([untitled, other]));
    expect(argvs(d.commands)).toEqual([]);
  });

  test('a box.state said while box list is out is put back on its answer', () => {
    const d = drive().read([X_BOXES.asleep], []);

    d.tick(6);
    expect(argvs(d.commands)).toEqual(READS);
    d.send(
      event({ type: 'box.state', data: { box: 'demo-shop-3', state: 'starting', cause: 'x' } }),
      boxesAnswer([X_BOXES.asleep], []),
    );
    expect(d.rows()[0]).toContain('● starting');
  });

  test('woken (#217, #244): as its serve boots it says booting, dim (#213 B4), once it answers the list is read again for its stop and release', () => {
    const d = drive().read([X_BOXES.asleep], []);

    d.tick(1).send(
      event({
        type: 'box.state',
        data: { box: 'demo-shop-3', state: 'starting', cause: 'wake' },
        at: at(1),
      }),
    );
    expect(d.rows()[0]).toContain('● starting');
    // EC2 runs it, its serve not answering yet (#143): a normal boot, booting in dim (#244, #213 B4)
    d.send(event({ type: 'box.step', data: { box: 'demo-shop-3', step: 'booting' }, at: at(1) }));
    d.tick(2);
    expect(d.rows()[0]).toContain('● booting |');
    expect(d.table.props.rows[0]?.hue).toBeUndefined();
    expect(d.table.props.rows[0]?.cells[2]).toEqual({
      mark: '●',
      text: 'booting',
      hue: 'dim',
      tooltip:
        'box demo-shop-3 is booting: its abe serve answers in a minute or two · abe box status demo-shop-3 says when',
    });
    expect(argvs(d.commands)).toEqual([]);
    // its serve answers: the list again, for what only its status says
    d.send(
      event({ type: 'box.state', data: { box: 'demo-shop-3', state: 'running', cause: 'wake' } }),
    );
    expect(d.rows()[0]).toContain('● running |');
    expect(argvs(d.commands)).toEqual(READS);
    d.send(
      boxesAnswer([
        {
          ...X_BOXES.asleep,
          state: 'running',
          serve: 'answers',
          launchedAt: at(1),
          idle: X_BOXES.idle(X_BOXES.local(10, 32)),
          abe: '2.2.0-6897e4a1',
        },
      ]),
    );
    expect(d.rows()[0]).toEndWith('| stops at 10:32');
    expect(d.table.props.rows[0]?.cells[5]?.tooltip).toBe('abe 2.2.0-6897e4a1');
  });

  test('its serve answering while box list is out: read once more after that answer (#217)', () => {
    const d = drive().read([X_BOXES.asleep], []);

    d.tick(6);
    expect(argvs(d.commands)).toEqual(READS);
    d.send(
      event({ type: 'box.state', data: { box: 'demo-shop-3', state: 'running', cause: 'wake' } }),
    );
    expect(argvs(d.commands)).toEqual([]);
    // the answer was asked before it answered: read again
    d.send(boxesAnswer([X_BOXES.asleep], []));
    expect(d.rows()[0]).toContain('● running');
    expect(argvs(d.commands)).toEqual(READS);
    d.send(boxesAnswer([{ ...X_BOXES.asleep, state: 'running', serve: 'answers' }], []));
    expect(argvs(d.commands)).toEqual([]);
  });

  test('its serve answering before the first answer, or for a box not known yet: read once more too (#217)', () => {
    // before the first answer
    const first = drive();

    first.send(
      event({ type: 'box.state', data: { box: 'demo-shop-3', state: 'running', cause: 'wake' } }),
    );
    expect(argvs(first.commands)).toEqual([]);
    first.read([X_BOXES.asleep], []);
    expect(argvs(first.commands)).toEqual(READS);
    // a box made: not known, its starting reads the list; running while that is out
    const made = drive().read([X_BOXES.running], []);

    made.send(
      event({ type: 'box.state', data: { box: 'demo-shop-9', state: 'starting', cause: 'up' } }),
    );
    expect(argvs(made.commands)).toEqual(READS);
    made.send(
      event({ type: 'box.state', data: { box: 'demo-shop-9', state: 'running', cause: 'up' } }),
    );
    expect(argvs(made.commands)).toEqual([]);
    made.send(
      boxesAnswer([
        X_BOXES.running,
        X_BOXES.box('demo-shop-9', { state: 'pending', launchedAt: at(0), serve: null }),
      ]),
    );
    expect(argvs(made.commands)).toEqual(READS);
    expect(made.rows()[1]).toContain('demo-shop-9');
    expect(made.rows()[1]).toContain('● running');
  });

  test('booting while box list is out: that answer is read again (#217)', () => {
    const d = drive().read([X_BOXES.asleep], []);

    d.tick(6);
    expect(argvs(d.commands)).toEqual(READS);
    d.send(event({ type: 'box.step', data: { box: 'demo-shop-3', step: 'booting' } }));
    expect(d.rows()[0]).toContain('● booting |');
    d.send(boxesAnswer([{ ...X_BOXES.asleep, state: 'pending', launchedAt: at(5) }], []));
    expect(argvs(d.commands)).toEqual(READS);
    d.send(
      boxesAnswer([{ ...X_BOXES.asleep, state: 'running', launchedAt: at(5), serve: 'silent' }]),
    );
    expect(argvs(d.commands)).toEqual([]);
    expect(d.rows()[0]).toContain('● booting |');
    // booting for a box it does not list, or one running already: nothing
    d.send(event({ type: 'box.step', data: { box: 'demo-shop-9', step: 'booting' } }));
    expect(argvs(d.commands)).toEqual([]);
    d.send(event({ type: 'box.step', data: { box: 'demo-shop-3', step: 'workspace' } }));
    expect(d.rows()[0]).toContain('● booting |');
  });

  test('a normal boot is booting, not a problem (#244, #213 B4); past 15 min, a refused link or a serve that went, red', () => {
    // its serve not answering since its boot (serve says its sshd not up yet so too)
    const booting: BoxData = {
      ...X_BOXES.asleep,
      state: 'running',
      launchedAt: at(-1),
      serve: 'silent',
      reach: { kind: 'silent', since: at(-1) },
    };
    const d = drive().read([booting], []);

    expect(d.rows()[0]).toContain('● booting |');
    expect(d.table.props.rows[0]?.hue).toBeUndefined();
    // up past booting: a problem, in bad, said as it is
    d.tick(16);
    expect(d.rows()[0]).toContain('● running · serve not answering · 17 min |');
    expect(d.table.props.rows[0]?.hue).toBe('bad');
    // a link refused (the login, the rights) is no boot
    const refused = drive().read(
      [{ ...booting, reach: { kind: 'unreachable', why: 'handshake refused (HTTP 403)' } }],
      [],
    );

    expect(refused.rows()[0]).toContain('● running · cannot be reached |');
    expect(refused.table.props.rows[0]?.hue).toBe('bad');
    // a serve that answered and went (`stopped`): its boot restarting it (the release install)
    // for under 2 min, then a problem
    const went = drive().read(
      [{ ...booting, reach: { kind: 'silent', since: at(0), stopped: true } }],
      [],
    );

    expect(went.rows()[0]).toContain('● booting |');
    went.tick(2);
    expect(went.rows()[0]).toContain('● running · serve not answering · 2 min |');
    expect(went.table.props.rows[0]?.hue).toBe('bad');
    // gone silent after its boot: a problem at once
    const late = drive().read(
      [{ ...booting, launchedAt: at(-30), reach: { kind: 'silent', since: at(0), stopped: true } }],
      [],
    );

    expect(late.table.props.rows[0]?.hue).toBe('bad');
  });

  test('r reads the list again (#217); while it is out, nothing more', () => {
    const d = drive().read([X_BOXES.running], []);

    expect(argvs(d.keys('r').commands)).toEqual(READS);
    expect(argvs(d.keys('r').commands)).toEqual([]);
    d.send(boxesAnswer([{ ...X_BOXES.running, idle: X_BOXES.idle(X_BOXES.local(10, 50)) }], []));
    expect(d.rows()[0]).toEndWith('| stops at 10:50');
    // typed into the filter it is a letter
    d.keys('/');
    expect(argvs(d.send({ kind: 'text', text: 'r' }).commands)).toEqual([]);
  });

  test(':boxes shows the pane on Boxes', () => {
    expect(boxesScreen.words?.map((w) => [w.word, w.commands])).toEqual([
      ['boxes', [{ kind: 'shell', effect: { kind: 'show', place: 'boxes' } }]],
    ]);
  });
});

describe("the tab's cost as core's box helpers say it", () => {
  test.each([0, 30, 600])('cost %i min on from its read', (m) => {
    const now = Date.parse(X_BOXES.now) + m * MIN;
    const day = new Date(now);

    day.setHours(0, 0, 0, 0);
    for (const b of [X_BOXES.running, X_BOXES.asleep])
      expect(costAt(b, now)).toBe(
        b.costToday === null
          ? null
          : boxCostAt(b.costToday, b.state === 'running', now, day.getTime()),
      );
  });
});

/**
 * The box's menu (#104 S3, board X-BoxMenu) as the bridge carries it: ⌘⏎ on a row hands the menu
 * to Command mode, which keys and draws it; what it hands back goes to the screen; the screen's
 * menus and confirms go back to Command mode. `out` is what reached neither (runs, shell effects).
 */
const menuOn = (
  boxes: BoxData[],
  queued = [X_BOXES.queued],
  select?: string,
  more: Input[] = [],
) => {
  const d = drive()
    .read(boxes, queued)
    .send(...more);
  const layer = mountLayer(commandMode([]));
  let out: Command[] = [];
  const perform = (commands: readonly Command[]) => {
    for (const c of commands)
      if (c.kind === 'menu' || c.kind === 'confirm') perform(layer.send(c));
      else if (c.kind === 'choice') perform(d.send(c).commands);
      else out.push(c);
  };
  const m = {
    d,
    get out() {
      return out;
    },
    get tree(): Node | undefined {
      return layer.tree;
    },
    get pick(): PickLayer['props'] {
      if (layer.tree?.kind !== 'PickLayer')
        throw new Error(`no pick: ${JSON.stringify(layer.tree)}`);

      return layer.tree.props;
    },
    get confirm(): ConfirmLayer['props'] {
      if (layer.tree?.kind !== 'ConfirmLayer')
        throw new Error(`no ask: ${JSON.stringify(layer.tree)}`);

      return layer.tree.props;
    },
    get prompt(): PromptLayer['props'] {
      if (layer.tree?.kind !== 'PromptLayer')
        throw new Error(`no field: ${JSON.stringify(layer.tree)}`);

      return layer.tree.props;
    },
    /** Each row as drawn: `Keep awake · until you say ⏎`, `Stop now — asleep`. */
    rows: () =>
      m.pick.rows.map((r) =>
        [
          r.text,
          r.reason === undefined ? undefined : `— ${r.reason}`,
          r.dim === undefined ? undefined : `· ${r.dim}`,
          r.note,
        ]
          .filter((x) => x !== undefined)
          .join(' '),
      ),
    keys(...keys: string[]) {
      out = [];
      for (const key of keys) perform(layer.send({ kind: 'key', key }));

      return m;
    },
    /** A result for the screen (its own runs' answers). */
    answer(input: Input) {
      out = [];
      perform(d.send(input).commands);

      return m;
    },
  };

  if (select !== undefined) d.send({ kind: 'click', id: `box:${select}` });
  perform(d.keys('<D-CR>').commands);

  return m;
};

const effects = (commands: readonly Command[]) =>
  commands.flatMap((c) => (c.kind === 'shell' ? [c.effect] : []));

type Effect = ReturnType<typeof effects>[number];

/** demo-shop-1 with #1's workspace on it (ADR 0022): its story and workspace the box row's too. */
const holding1: BoxData = {
  ...X_BOXES.running,
  workspaces: [X_BOXES.ws(1, 'mkdir-swe/demo-shop')],
};
const kept = { ...X_BOXES.running, idle: X_BOXES.idle(null, ['awake']) };
const starting = { ...X_BOXES.stuck, launchedAt: at(-2) };

describe('the box menu', () => {
  test('running, not kept: Keep awake first, Let it sleep grey as it stops then, Terminate… red with t', () => {
    const m = menuOn([holding1], []);

    expect(m.pick.title).toBe('demo-shop-1');
    expect(m.rows()).toEqual([
      'Keep awake · until you say ⏎',
      'Let it sleep — stops at 10:30',
      'Stop now',
      'Attach',
      'Forward port…',
      'Resize… · now m8g.large',
      'Terminate… t',
      'Open card · #1',
      'Open workspace · /workspace/repo',
    ]);
    expect(m.pick.selected).toBe('keep');
    expect(m.pick.rows.filter((r) => r.risky === true).map((r) => r.text)).toEqual(['Terminate…']);
    // the run rows: Command mode runs them, its status line says the answer
    expect(argvs(m.keys('<CR>').out)).toEqual(['box keep demo-shop-1']);
    expect(argvs(menuOn([X_BOXES.running], []).keys('<Down>', '<CR>').out)).toEqual([
      'box stop demo-shop-1',
    ]);
  });

  test('running, kept awake: Let it sleep first, Keep awake grey already kept', () => {
    const m = menuOn([kept], []);

    expect(m.rows().slice(0, 3)).toEqual([
      'Let it sleep · kept awake ⏎',
      'Keep awake — already kept',
      'Stop now',
    ]);
    expect(argvs(m.keys('<CR>').out)).toEqual(['box sleep demo-shop-1']);
  });

  test('asleep: Wake first, what needs it awake wakes it, Stop now and Forward port… grey', () => {
    // asleep, its workspaces are not read: no story to jump to from the box
    const m = menuOn([X_BOXES.asleep], []);

    expect(m.pick.title).toBe('demo-shop-3');
    expect(m.rows()).toEqual([
      'Wake ⏎',
      'Keep awake · wakes it',
      'Stop now — asleep',
      'Attach · wakes it',
      'Forward port… — asleep',
      'Resize…',
      'Terminate… t',
      'Open card — no story',
      'Open workspace — no workspace',
    ]);
    expect(argvs(m.keys('<CR>').out)).toEqual(['box start demo-shop-3']);
  });

  test('starting: as running, Attach and Open workspace when it answers', () => {
    const rows = menuOn(
      [{ ...starting, workspaces: [X_BOXES.ws(2, 'mkdir-swe/demo-shop')] }],
      [],
    ).rows();

    expect(rows[0]).toBe('Keep awake · until you say ⏎');
    expect(rows).toContain('Attach · when it answers');
    expect(rows).toContain('Open workspace · when it answers');
    expect(rows).toContain('Stop now');
    // `box forward` never waits for it
    expect(rows).toContain('Forward port… — when it answers');
    // booting (#244): EC2 runs it, its serve not up yet: the menu of a starting box too
    const booting = menuOn(
      [
        {
          ...starting,
          workspaces: [X_BOXES.ws(2, 'mkdir-swe/demo-shop')],
          state: 'running',
          serve: 'silent',
          reach: { kind: 'silent', since: null },
        },
      ],
      [],
    ).rows();

    expect(booting).toEqual(rows);
  });

  test('Queued: Open card and why it waits, nothing else', () => {
    const m = menuOn([], [X_BOXES.queued]);

    expect(m.rows()).toEqual([
      'Open card · #5',
      'Queued — starts when a box stops or the limit rises',
    ]);
    expect(m.keys('<CR>').out).toEqual([{ kind: 'jump', to: 'story', story: 5 }]);
  });

  test('Attach as ⏎; Open card and Open workspace are the jumps', () => {
    // the box's own shell, a workspace on it or not
    const attach = menuOn([holding1], []).keys('a', 't', 't', '<CR>');
    const boxShell: Effect = {
      kind: 'terminal-tab',
      argv: ['abe', 'box', 'attach', 'demo-shop-1', '--', 'bash', '-l'],
      title: 'demo-shop-1',
    };

    expect(effects(attach.out)).toEqual([boxShell]);
    expect(menuOn([holding1], []).keys('w', 'o', 'r', 'k', '<CR>').out).toEqual([
      { kind: 'jump', to: 'workspace', story: 1 },
    ]);
    expect(effects(menuOn([X_BOXES.running], []).keys('a', 't', 't', '<CR>').out)).toEqual([
      boxShell,
    ]);
  });

  test('Stop now with a session working there asks first, then stops it with --yes (#316)', () => {
    const working = {
      ...X_BOXES.running,
      session: { id: '1-ab12', state: 'working' as const, since: at(-5) },
    };
    const m = menuOn([working], []).keys('<Down>', '<CR>');
    const ask = m.confirm;

    expect(ask.question).toBe('Stop demo-shop-1?');
    expect(ask.details).toEqual([
      'Session 1-ab12 is working there: it ends mid-turn. Its branch and files stay on the box; Retry starts a new session there.',
    ]);
    expect(m.out).toEqual([]);
    m.keys('y');
    expect(m.out).toEqual([
      { kind: 'run', id: 'boxes:stop:demo-shop-1', argv: ['box', 'stop', 'demo-shop-1', '--yes'] },
    ]);
    m.answer({
      kind: 'result',
      id: 'boxes:stop:demo-shop-1',
      command: 'box stop',
      reply: { ok: true, data: { ...X_BOXES.running, state: 'stopped' } },
      text: 'demo-shop-1  stopped\n',
    });
    expect(effects(m.out)).toEqual([{ kind: 'status', text: 'demo-shop-1  stopped' }]);
    // waiting on you: nothing works there, Stop now stops it as before
    const waiting = {
      ...X_BOXES.running,
      session: { id: '1-ab12', state: 'waiting' as const, since: at(-5) },
    };

    const plain = menuOn([waiting], []).keys('<Down>', '<CR>');

    expect(argvs(plain.out)).toEqual(['box stop demo-shop-1']);
    // it began working since the list was read: serve asks, so the app asks, then --yes
    plain.answer({
      kind: 'result',
      id: 'boxes:stop:demo-shop-1',
      command: 'box stop',
      reply: { ok: false, error: { code: 'confirm', message: 'session 1-ab12 is working …' } },
      text: '',
    });
    expect(plain.confirm.question).toBe('Stop demo-shop-1?');
    expect(plain.confirm.details).toEqual(['session 1-ab12 is working …']);
    expect(argvs(plain.keys('y').out)).toEqual(['box stop demo-shop-1 --yes']);
  });

  test('t as the first key asks before terminating; y runs it; its answer drops the row', () => {
    const m = menuOn([X_BOXES.running, X_BOXES.asleep], [], 'demo-shop-3').keys('t');
    const ask = m.confirm;

    expect(ask.question).toBe('Terminate demo-shop-3?');
    expect(ask.details).toEqual([
      'Its disk and every workspace on it are deleted; work not pushed is lost.',
    ]);
    expect(ask.risky).toEqual({ label: 'Terminate', letter: 'y' });
    expect(m.out).toEqual([]);
    // Esc: back to the menu, nothing run
    expect(m.keys('<Esc>').tree?.kind).toBe('PickLayer');
    expect(m.out).toEqual([]);
    m.keys('t', 'y');
    expect(m.tree).toBeUndefined();
    expect(m.out).toEqual([
      {
        kind: 'run',
        id: 'boxes:terminate',
        argv: ['box', 'terminate', 'demo-shop-3', '--yes'],
      },
    ]);
    m.answer({
      kind: 'result',
      id: 'boxes:terminate',
      command: 'box terminate',
      reply: { ok: true, data: { ...X_BOXES.asleep, state: 'terminated' } },
      text: 'demo-shop-3  terminated\n',
    });
    expect(effects(m.out)).toEqual([{ kind: 'status', text: 'demo-shop-3  terminated' }]);
    expect(m.d.names()).toEqual(['box:demo-shop-1']);
  });

  test('t after a filter letter types it; ⏎ on Terminate… asks as t does', () => {
    const m = menuOn([X_BOXES.running], []).keys('s', 't');

    expect(m.pick.filter).toBe('st');
    expect(m.pick.rows.map((r) => r.text)).toEqual(['Stop now']);
    const viaEnter = menuOn([X_BOXES.running], []).keys('e', 'r', 'm', '<CR>');

    expect(viaEnter.tree?.kind).toBe('ConfirmLayer');
    expect(viaEnter.keys('y').out.map((c) => c.kind)).toEqual(['run']);
  });

  test('IAM refuses: a red balloon, only your lead can terminate boxes; the row stays', () => {
    const m = menuOn([X_BOXES.running], []).keys('t', 'y');

    m.answer({
      kind: 'result',
      id: 'boxes:terminate',
      command: 'box terminate',
      reply: {
        ok: false,
        error: {
          code: 'terminate-refused',
          message: 'Terminate refused: only your lead can terminate boxes',
        },
      },
    });
    expect(effects(m.out)).toEqual([
      {
        kind: 'balloon',
        tone: 'error',
        text: 'Terminate refused: only your lead can terminate boxes',
      },
    ]);
    expect(m.d.names()).toEqual(['box:demo-shop-1']);
  });

  test('Forward port…: a field Port on the box, then a terminal tab named forward 3000', () => {
    const m = menuOn([X_BOXES.running], []).keys('f', '<CR>');
    expect(m.prompt.title).toBe('Port on the box');
    // not a number: said in the field, nothing run
    m.keys('x', '<CR>');
    expect(m.prompt.error).toBe('port is a number');
    m.keys('<BS>', '3', '0', '0', '0', '<CR>');
    expect(m.tree).toBeUndefined();
    expect(effects(m.out)).toEqual([
      {
        kind: 'terminal-tab',
        argv: ['abe', 'box', 'forward', 'demo-shop-1', '3000'],
        title: 'forward 3000',
      },
    ]);
  });

  test('Resize…: the sizes up to the team limit, the current marked; sessions running ask y', () => {
    const m = menuOn([X_BOXES.running], []).keys('r', 'e', 's', '<CR>');

    expect(argvs(m.out)).toEqual(['settings get limits.maxBoxSize']);
    m.answer(settingAnswer('boxes:max', 'limits.maxBoxSize', 'm8g.2xlarge'));
    expect(m.pick.title).toBe('Resize demo-shop-1 · now m8g.large');
    expect(m.rows()).toEqual(['m8g.large — now', 'm8g.xlarge', 'm8g.2xlarge']);
    expect(m.pick.selected).toBe('m8g.xlarge');
    m.keys('<CR>');
    expect(m.out).toEqual([
      {
        kind: 'run',
        id: 'boxes:resize:demo-shop-1 m8g.xlarge',
        argv: ['box', 'resize', 'demo-shop-1', 'm8g.xlarge'],
      },
    ]);
    // sessions run on it: asked y, then resized anyway
    m.answer({
      kind: 'result',
      id: 'boxes:resize:demo-shop-1 m8g.xlarge',
      command: 'box resize',
      reply: {
        ok: false,
        error: {
          code: 'sessions-running',
          message: '1 session runs on the box; resizing stops it: --yes to resize anyway',
        },
      },
    });
    const ask = m.confirm;

    expect(ask.question).toBe('Resize demo-shop-1 to m8g.xlarge?');
    expect(ask.details).toEqual([
      '1 session runs on the box; resizing stops it: --yes to resize anyway',
    ]);
    expect(argvs(m.keys('y').out)).toEqual(['box resize demo-shop-1 m8g.xlarge --yes']);
    // that answer is Command mode's: once the box runs again, the list is read for its size
    m.answer(
      event({
        type: 'box.state',
        data: { box: 'demo-shop-1', state: 'stopping', cause: 'resize' },
      }),
    );
    expect(argvs(m.out)).toEqual([]);
    m.answer(
      event({ type: 'box.state', data: { box: 'demo-shop-1', state: 'running', cause: 'resize' } }),
    );
    expect(argvs(m.out)).toEqual(READS);
    m.answer(boxesAnswer([{ ...X_BOXES.running, size: 'm8g.xlarge' }], []));
    expect(m.d.rows()[0]).toContain('| m8g.xlarge |');
    // a resize that went through: the Size column at once, its line on the status line
    m.answer({
      kind: 'result',
      id: 'boxes:resize:demo-shop-1 m8g.xlarge',
      command: 'box resize',
      reply: {
        ok: true,
        data: {
          box: 'demo-shop-1',
          from: 'm8g.large',
          to: 'm8g.xlarge',
          changed: true,
          status: 'running',
        },
      },
      text: 'box demo-shop-1: m8g.large → m8g.xlarge (running)\n',
    });
    expect(m.d.rows()[0]).toContain('| m8g.xlarge |');
    expect(effects(m.out)).toEqual([
      { kind: 'status', text: 'box demo-shop-1: m8g.large → m8g.xlarge (running)' },
    ]);
  });

  test('the sizes Resize… offers stop at the limit; one that is no size offers them all', () => {
    expect(sizesUpTo('m8g.large')).toEqual(['m8g.large']);
    expect(sizesUpTo('m8g.16xlarge')).toHaveLength(7);
    expect(sizesUpTo('nonsense')).toHaveLength(7);
  });
});

describe('times across tonight’s DST change (#260): 03:00 CEST → 02:00 CET', () => {
  test('each box’s stop from its own instant; one past the change names its zone', () => {
    const zoneWas = process.env.TZ;

    process.env.TZ = 'Europe/Stockholm';
    try {
      const stops = (name: string, iso: string): BoxData => ({
        ...X_BOXES.running,
        name,
        idle: X_BOXES.idle(iso),
      });
      const d = drive();

      // 02:31 CEST
      d.send({ kind: 'tick', at: '2026-10-25T00:31:00.000Z' });
      d.send(
        boxesAnswer(
          [
            stops('demo-shop-1', '2026-10-25T00:55:00.000Z'),
            stops('demo-shop-3', '2026-10-25T01:08:00.000Z'),
          ],
          [],
        ),
      );
      expect(d.rows().map((r) => r.split(' | ').at(-1))).toEqual([
        'stops at 02:55',
        'stops at 02:08 CET',
      ]);
      // 02:30 CET, an hour later: the earlier one is the one on the other side now
      d.send({ kind: 'tick', at: '2026-10-25T01:30:00.000Z' });
      expect(d.rows().map((r) => r.split(' | ').at(-1))).toEqual([
        'stops at 02:55 CEST',
        'stops at 02:08',
      ]);
    } finally {
      // bun test runs on UTC with no TZ set
      process.env.TZ = zoneWas ?? 'UTC';
    }
  });
});

describe('boxes of other repos (#262): this repo’s first, every other’s named on its row', () => {
  const other = (name: string, card: number): BoxData => ({
    ...X_BOXES.running,
    name,
    card,
    title: 'box check',
    repo: 'mkdir-swe/qa2-e-85a7',
  });
  const HERE = { root: '/p/demo-shop', checkouts: [], github: 'mkdir-swe/demo-shop' };
  const table = (here: typeof HERE | undefined) =>
    drive()
      .tick()
      .send(
        boxesAnswer([other('qa2-e-85a7-101', 101), holding1, X_BOXES.asleep], [], 'boxes', here),
      );
  const stories = (d: ReturnType<typeof drive>) =>
    d.table.props.rows.map((r) => `${r.id ?? ''} ${r.cells[1]?.accent ?? ''}`);

  test('the shown folder’s repo first, unnamed; another repo’s after, its repo on its row', () => {
    const d = table(HERE);

    // a repo's box names its workspaces' stories on their rows (ADR 0022); an old box its own
    expect(stories(d)).toEqual([
      'box:demo-shop-1 ',
      'box:demo-shop-1:ws:1 #1',
      'box:demo-shop-3 ',
      'box:qa2-e-85a7-101 qa2-e-85a7#101',
    ]);
    expect(d.table.props.rows[3]?.cells[1]?.tooltip).toBe(
      'mkdir-swe/qa2-e-85a7 · another repo · box check',
    );
    // `/` finds them by their repo too
    expect(d.keys('/').send({ kind: 'text', text: 'qa2' }).names()).toEqual(['box:qa2-e-85a7-101']);
  });

  test('asked in no checkout (or an older serve): every repo named while there are several', () => {
    const d = table(undefined);

    expect(stories(d)).toEqual([
      'box:demo-shop-1 ',
      'box:demo-shop-1:ws:1 demo-shop#1',
      'box:demo-shop-3 ',
      'box:qa2-e-85a7-101 qa2-e-85a7#101',
    ]);
    expect(d.table.props.rows[0]?.cells[1]?.text).toBe('demo-shop · 1 workspace');
  });

  test('all of one repo: no repo named, as before', () => {
    const d = drive()
      .tick()
      .send(boxesAnswer([holding1], [], 'boxes'));

    expect(stories(d)).toEqual(['box:demo-shop-1 ', 'box:demo-shop-1:ws:1 #1']);
  });
});

/** Thirteen sleeping boxes, demo-shop-1 … demo-shop-13 (7 rows fit in `SIZE`). */
const THIRTEEN = Array.from({ length: 13 }, (_, i) =>
  X_BOXES.box(`demo-shop-${i + 1}`, { state: 'stopped', card: i + 1, serve: null }),
);
const shown = (d: ReturnType<typeof drive>) =>
  d.table.props.rows.map((r) => {
    const name = (r.id ?? '').replace('box:demo-shop-', 'd');

    return r.id === d.table.props.selected ? `>${name}` : name;
  });

describe('the boxes list (QA2 C: #263 #264 #267 #268 #271 #272 #287)', () => {
  test('names in number order: demo-shop-2 before demo-shop-10 (#272)', () => {
    const d = drive().read(THIRTEEN, []);

    expect(shown(d)).toEqual(['>d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
    expect(d.keys('G').names().at(-1)).toBe('box:demo-shop-13');
  });

  test('the tree’s moves: a count, Ö, PgDn, End, Home, ⌃D (#271)', () => {
    const d = drive().read(THIRTEEN, []);

    expect(d.keys('5', 'ö').table.props.selected).toBe('box:demo-shop-6');
    expect(d.keys('Ö').table.props.selected).toBe('box:demo-shop-11');
    expect(d.keys('<Home>').table.props.selected).toBe('box:demo-shop-1');
    expect(d.keys('<PageDown>').table.props.selected).toBe('box:demo-shop-8');
    expect(d.keys('<End>').table.props.selected).toBe('box:demo-shop-13');
    expect(d.keys('L', '<C-d>').table.props.selected).toBe('box:demo-shop-11');
  });

  test('a box woken under the cursor changes in place; sorted afresh once the keys leave (#264)', () => {
    const d = drive().read(THIRTEEN, []).keys('3', 'ö');

    expect(shown(d)).toEqual(['d1', 'd2', 'd3', '>d4', 'd5', 'd6', 'd7']);
    for (const state of ['starting', 'running'] as const)
      d.send(event({ type: 'box.state', data: { box: 'demo-shop-4', state, cause: 'start' } }));
    expect(shown(d)).toEqual(['d1', 'd2', 'd3', '>d4', 'd5', 'd6', 'd7']);
    // another box below woken: nothing moves either
    d.send(
      event({ type: 'box.state', data: { box: 'demo-shop-6', state: 'starting', cause: 'start' } }),
    );
    expect(shown(d)).toEqual(['d1', 'd2', 'd3', '>d4', 'd5', 'd6', 'd7']);
    d.send({ kind: 'focus', focused: false });
    expect(shown(d).slice(0, 3)).toEqual(['>d4', 'd6', 'd1']);
  });

  test('maximized before any key: every row that fits is drawn (#264 re-test)', () => {
    const d = drive().read(THIRTEEN, []).send({ kind: 'focus', focused: true });

    expect(shown(d)).toHaveLength(7);
    d.send({ kind: 'resize', size: { width: 1400, height: 1100 } });
    expect(shown(d)).toEqual(['>d1', ...Array.from({ length: 12 }, (_, i) => `d${i + 2}`)]);
  });

  test('a menu opened from the list keeps the order: Wake changes the row in place (#264 reopened)', () => {
    const d = drive().read(THIRTEEN, []).keys('4', 'ö');

    expect(shown(d)).toEqual(['d1', 'd2', 'd3', 'd4', '>d5', 'd6', 'd7']);
    // ⌘⏎: the menu layer takes the keys, the list keeps its order under it
    d.keys('<D-CR>').send({ kind: 'focus', focused: false, layer: true });
    d.send(
      event({ type: 'box.state', data: { box: 'demo-shop-5', state: 'starting', cause: 'start' } }),
    );
    expect(shown(d)).toEqual(['d1', 'd2', 'd3', 'd4', '>d5', 'd6', 'd7']);
    // the menu closed, the keys back: still held
    d.send({ kind: 'focus', focused: true });
    d.send(
      event({ type: 'box.state', data: { box: 'demo-shop-5', state: 'running', cause: 'start' } }),
    );
    expect(shown(d)).toEqual(['d1', 'd2', 'd3', 'd4', '>d5', 'd6', 'd7']);
    // leaving the pane: sorted afresh
    d.send({ kind: 'focus', focused: false });
    expect(shown(d)[0]).toBe('>d5');
  });

  test('the selected box terminated: the next one takes its place, the window stays (#267)', () => {
    const d = drive().read(THIRTEEN, []).keys('G', 'l', 'l');

    expect(shown(d)).toEqual(['d7', 'd8', 'd9', 'd10', '>d11', 'd12', 'd13']);
    d.send({
      kind: 'result',
      id: 'boxes:terminate',
      command: 'box terminate',
      reply: { ok: true, data: { ...X_BOXES.box('demo-shop-11'), state: 'terminated' } },
    });
    expect(shown(d)).toEqual(['d6', 'd7', 'd8', 'd9', 'd10', '>d12', 'd13']);
    // the last one: the one above
    d.keys('G').send({
      kind: 'result',
      id: 'boxes:terminate',
      command: 'box terminate',
      reply: { ok: true, data: { ...X_BOXES.box('demo-shop-13'), state: 'terminated' } },
    });
    expect(d.table.props.selected).toBe('box:demo-shop-12');
  });

  test('/ types k l ö ä, arrows move, ⏎ once attaches, Esc puts it back and keeps the keys (#268 #263)', () => {
    const d = drive().read(THIRTEEN, []).keys('3', 'ö', '/', '1');

    expect(shown(d)).toEqual(['>d1', 'd10', 'd11', 'd12', 'd13']);
    expect(d.keys('<Down>', '<Down>').table.props.note).toBe('/1▏ · 5 of 13');
    expect(d.table.props.selected).toBe('box:demo-shop-11');
    expect(d.table.props.filter).toBe('1');
    // ö types (as in the tree's speed search): no box matches "1ö"
    expect(d.keys('ö').table.props.empty?.title).toBe('No boxes match “1ö”');
    d.keys('<BS>');
    expect(d.keys('<CR>').commands).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'terminal-tab',
          argv: ['abe', 'box', 'attach', 'demo-shop-11', '--', 'bash', '-l'],
          title: 'demo-shop-11',
        },
      },
    ]);
    expect(d.table.props.note).toBe('/1 · 5 of 13');
    // Esc on the kept filter: off, demo-shop-11 still selected, the keys still the list's
    d.keys('<Esc>');
    expect(d.table.props.filter).toBeUndefined();
    expect(d.table.props.selected).toBe('box:demo-shop-11');
    expect(d.keys('ö').table.props.selected).toBe('box:demo-shop-12');
    // Esc while typing: back on the row before `/`
    d.keys('/', '1', '3', '<Esc>');
    expect(d.table.props.selected).toBe('box:demo-shop-12');
  });

  test('r says it reads, then when it read (#287)', () => {
    const d = drive().read(THIRTEEN, []);

    expect(d.table.props.note).toBe('Read 10:00');
    d.tick(2).keys('r');
    expect(argvs(d.commands)).toEqual(READS);
    expect(d.table.props.note).toBe('Reading box list…');
    d.send(boxesAnswer(THIRTEEN, []));
    expect(d.table.props.note).toBe('Read 10:02');
  });

  test('the wheel over the Table scrolls the rows, the selection stays (#323)', () => {
    const d = drive().read(THIRTEEN, []);

    d.send({ kind: 'scroll', id: 'boxes-table', x: 0, y: 3 });
    expect(shown(d)).toEqual(['d4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10']);
    expect(d.table.props.selected).toBe('box:demo-shop-1');
    expect(d.commands).toEqual([]);
    d.send({ kind: 'scroll', id: 'boxes-table', x: 0, y: -1 });
    expect(shown(d)[0]).toBe('d3');
    // a move goes on from the selection, the window as far as brings it in
    expect(d.keys('ö').table.props.selected).toBe('box:demo-shop-2');
    expect(shown(d)[0]).toBe('>d2');
    // Linked's box row opens the tab on a box out of the wheeled view: it comes into view
    d.send({ kind: 'scroll', id: 'boxes-table', x: 0, y: 6 });
    d.send({ kind: 'open', params: { box: 'demo-shop-1' }, size: SIZE });
    expect(shown(d)[0]).toBe('>d1');
  });
});

describe('boxes per repo (ADR 0022): each box with its workspaces under it, an old box marked', () => {
  const GB = { freeGb: 29, totalGb: 60 };
  const two: BoxData = {
    ...X_BOXES.running,
    name: 'demo-shop',
    workspaces: [
      X_BOXES.ws(102, 'mkdir-swe/demo-shop', 'stopped'),
      X_BOXES.ws(101, 'mkdir-swe/demo-shop'),
    ],
    load: {
      at: X_BOXES.now,
      memory: { availableMb: 9000, totalMb: 16_000 },
      cpuPercent: 20,
      disk: GB,
      workspaces: [
        { card: '101', diskGb: 4.1 },
        { card: '102', diskGb: 3.8 },
      ],
    },
  };
  const titles: Input = cardsAnswer(
    [listCard(101, 'Show stock on cards', 'Active'), listCard(102, 'Cart total', 'Active')],
    false,
  );
  const read = (boxes: BoxData[]) => {
    const d = drive().tick().send(boxesAnswer(boxes, []));

    // the board's titles of the workspaces' cards are asked for once
    expect(argvs(d.commands)).toEqual(['card list --closed']);

    return d.send(titles);
  };

  test('the box row, then its workspaces by card: their story, state and disk; the box its disk used of its size', () => {
    const d = read([two]);

    expect(d.names()).toEqual(['box:demo-shop', 'box:demo-shop:ws:101', 'box:demo-shop:ws:102']);
    expect(d.rows()).toEqual([
      'demo-shop | 2 workspaces | ● running | m8g.large | 31 / 60 GB | v11 | 1 h 12 min | $0.12 today | stops at 10:30',
      ' | #101 show stock on cards | ● workspace up | — | 4.1 GB | — | — | — | —',
      ' | #102 cart total | ○ workspace stopped | — | 3.8 GB | — | — | — | —',
    ]);
    expect(d.table.props.rows[0]?.cells[4]?.tooltip).toBe(
      '29 GB free · grows by itself under 20 % free',
    );
  });

  test("each workspace's rough share of the box's cost, split by its busy minutes today", () => {
    const d = read([
      {
        ...two,
        busyToday: [
          { card: '101', minutes: 30 },
          { card: '102', minutes: 10 },
        ],
      },
    ]);

    expect(d.rows().map((r) => r.split(' | ')[7])).toEqual(['$0.12 today', '≈$0.09', '≈$0.03']);
    expect(d.table.props.rows[1]?.cells[7]).toMatchObject({ hue: 'dim' });
  });

  test("Linked's Box row opens the tab on the card's workspace row, else on its box", () => {
    const d = read([two]);

    d.send({ kind: 'open', params: { box: 'demo-shop', card: '102' }, size: SIZE });
    expect(d.table.props.selected).toBe('box:demo-shop:ws:102');
    d.send({ kind: 'open', params: { box: 'demo-shop' }, size: SIZE });
    expect(d.table.props.selected).toBe('box:demo-shop');
  });

  test('⏎ on a workspace row: a terminal in that card’s workspace; ⌃L along its story', () => {
    const d = read([two]).keys('ö');

    expect(boxesScreen.linked?.(d.state)).toBe(101);
    expect(effects(d.keys('<CR>').commands)).toEqual([
      {
        kind: 'terminal-tab',
        argv: ['abe', 'box', 'attach', 'demo-shop', '--card', '101'],
        title: 'demo-shop #101',
      },
    ]);
    // the box row: the box's own shell, never a workspace's
    expect(effects(d.keys('l', '<CR>').commands)).toEqual([
      {
        kind: 'terminal-tab',
        argv: ['abe', 'box', 'attach', 'demo-shop', '--', 'bash', '-l'],
        title: 'demo-shop',
      },
    ]);
  });

  test("a workspace's menu: Open workspace, story, Attach, Forward port…, Download locally, Remove workspace… asked, then run on its box", () => {
    const m = menuOn(
      [{ ...two, cardSessions: [{ card: '101', id: '101-ab12' }] }],
      [],
      'demo-shop:ws:101',
    );

    expect(m.pick.title).toBe('demo-shop · #101');
    expect(m.rows()).toEqual([
      'Open workspace · /workspace/repo',
      'Open card · #101',
      'Attach ⏎',
      'Forward port…',
      'Download locally · recovery · go on on this machine',
      'Remove workspace…',
    ]);
    expect(m.pick.rows.filter((r) => r.risky === true).map((r) => r.text)).toEqual([
      'Remove workspace…',
    ]);
    m.keys('r', 'e', 'm', '<CR>');
    expect(m.confirm.question).toBe("Remove #101's workspace on demo-shop?");
    m.keys('y');
    expect(argvs(m.out)).toEqual(['--on demo-shop workspace rm 101']);
    // removed: its row goes at once, said on the status line
    const done = m.d.send({
      kind: 'result',
      id: 'boxes:remove-workspace:demo-shop 101',
      command: 'workspace rm',
      reply: { ok: true, data: { card: '101', removed: true } },
      text: 'removed the workspace of card 101: its container, clone and database\n',
    });

    expect(done.names()).toEqual(['box:demo-shop', 'box:demo-shop:ws:102']);
    expect(effects(done.commands)).toEqual([
      {
        kind: 'status',
        text: 'removed the workspace of card 101: its container, clone and database',
      },
    ]);
  });

  test("Download locally on a workspace row copies that card's session, never another workspace's", () => {
    const sessions: BoxData = {
      ...two,
      session: { id: '101-ab12', state: 'waiting', since: X_BOXES.now },
      cardSessions: [
        { card: '101', id: '101-ab12' },
        { card: '102', id: '102-ef56' },
      ],
    };
    const on102 = menuOn([sessions], [], 'demo-shop:ws:102');

    on102.keys('d', 'o', 'w', '<CR>');
    expect(argvs(on102.out)).toEqual(['session download 102-ef56']);
    // no session of #102 on this Mac: grey, the box's own (#101's) never taken
    const none = menuOn(
      [{ ...sessions, cardSessions: [{ card: '101', id: '101-ab12' }] }],
      [],
      'demo-shop:ws:102',
    );

    expect(none.pick.rows.find((r) => r.id === 'download')?.reason).toBe(
      'no session of it on this machine',
    );
  });

  test('an old box (a 2.2 box made for one card): marked, never launched on; Download locally or Terminate', () => {
    const old = {
      ...X_BOXES.old,
      session: { id: '9-cd34', state: 'ended' as const, since: X_BOXES.now },
    };
    const d = drive()
      .tick()
      .send(boxesAnswer([old], []));

    expect(d.rows()[0]).toBe(
      'demo-shop-9 | #9 saved carts | ⚠ old box · asleep | m8g.large | — | v11 | — | — | —',
    );
    expect(d.table.props.rows[0]?.cells[2]?.tooltip).toBe(
      'a 2.2 box made for one card: never launched on · Download locally or Terminate',
    );
    const m = menuOn([old], [], 'demo-shop-9');

    expect(m.rows()).toEqual([
      "Download locally · its card's work to this machine",
      'Terminate… t',
      'Open card · #9',
    ]);
    expect(argvs(m.keys('<CR>').out)).toEqual(['session download 9-cd34']);
    // running with its one workspace: still no workspace row (nothing is offered on it)
    const up = drive()
      .tick()
      .send(
        boxesAnswer(
          [{ ...old, state: 'running', workspaces: [X_BOXES.ws(9, 'mkdir-swe/demo-shop')] }],
          [],
        ),
      );

    expect(up.names()).toEqual(['box:demo-shop-9']);
  });
});

describe("a workspace's ports (#16): under its row, forwarded or offered, opened in the browser", () => {
  const box: BoxData = {
    ...X_BOXES.running,
    name: 'demo-shop',
    workspaces: [X_BOXES.ws(101, 'mkdir-swe/demo-shop'), X_BOXES.ws(102, 'mkdir-swe/demo-shop')],
  };
  const fwd = (o: Partial<PortForward> = {}): PortForward => ({
    box: 'demo-shop',
    card: '101',
    port: 3000,
    local: 3000,
    state: 'open',
    fixed: false,
    since: X_BOXES.now,
    ...o,
  });
  const offer = (card: string, port: number, fixed = false) => ({
    box: 'demo-shop',
    card,
    port,
    fixed,
  });
  const portsAnswer = (data: Partial<PortListData>): Input => ({
    kind: 'result',
    id: 'boxes:ports',
    command: 'port list',
    reply: { ok: true, data: { forwards: [], offered: [], unread: [], ...data } },
  });
  const read = (data: Partial<PortListData>) => drive().read([box], []).send(portsAnswer(data));
  /** The port rows, as words, and their ids. */
  const portRows = (d: ReturnType<typeof drive>) =>
    d.rows().filter((_, i) => d.names()[i]?.includes(':port:') === true);
  const opened = (port: number, local = port) => ({
    kind: 'open-url' as const,
    url: `http://localhost:${String(local)}`,
  });

  test.each<[string, Partial<PortListData>, string, string | undefined]>([
    [
      'offered',
      { offered: [offer('101', 3000)] },
      ' | :3000 | listening | — | — | — | — | — | —',
      undefined,
    ],
    [
      'open',
      { forwards: [fwd()] },
      ' | :3000 → localhost:3000 | ● open | — | — | — | — | — | —',
      undefined,
    ],
    [
      'opening',
      { forwards: [fwd({ state: 'opening' })] },
      ' | :3000 → localhost:3000 | ● opening | — | — | — | — | — | —',
      undefined,
    ],
    [
      'asleep',
      { forwards: [fwd({ state: 'asleep' })] },
      ' | :3000 → localhost:3000 | ○ box asleep | — | — | — | — | — | —',
      'box asleep: back when it wakes',
    ],
    [
      'failed',
      { forwards: [fwd({ state: 'failed', note: 'the relay did not answer' })] },
      ' | :3000 → localhost:3000 | failed | — | — | — | — | — | —',
      'the relay did not answer',
    ],
    [
      'moved',
      { forwards: [fwd({ local: 3001, note: 'localhost:3000 was taken' })] },
      ' | :3000 → localhost:3001 | ● open | — | — | — | — | — | —',
      undefined,
    ],
  ])('%s: its row and its State on hover', (_, data, row, stateTip) => {
    const d = read(data);

    expect(portRows(d)).toEqual([row]);
    const cells = d.table.props.rows.find((r) => r.id?.includes(':port:') === true)?.cells;

    expect(cells?.[2]?.tooltip).toBe(stateTip);
  });

  test.each<[string, PortForward | undefined, boolean, string | undefined]>([
    [
      'a local port not the box’s',
      fwd({ local: 3001, note: 'localhost:3000 was taken' }),
      false,
      'localhost:3000 was taken',
    ],
    ['fixed', fwd(), true, "fixed: the repo's auth callback names it, only localhost:3000 will do"],
    [
      'fixed, offered',
      undefined,
      true,
      "fixed: the repo's auth callback names it, only localhost:3000 will do",
    ],
    ['neither', fwd(), false, undefined],
  ])('the port on hover: %s', (_, f, fixed, tip) => {
    const d = read(
      f === undefined ? { offered: [offer('101', 3000, fixed)] } : { forwards: [{ ...f, fixed }] },
    );
    const cells = d.table.props.rows.find((r) => r.id?.includes(':port:') === true)?.cells;

    expect(cells?.[1]?.tooltip).toBe(tip);
  });

  test('under each workspace by port, forwards and offered; / finds a port by :3000', () => {
    const d = read({
      forwards: [fwd({ port: 5173, local: 5173 })],
      offered: [offer('101', 3000), offer('102', 3000)],
    });

    expect(d.names()).toEqual([
      'box:demo-shop',
      'box:demo-shop:ws:101',
      'box:demo-shop:ws:101:port:3000',
      'box:demo-shop:ws:101:port:5173',
      'box:demo-shop:ws:102',
      'box:demo-shop:ws:102:port:3000',
    ]);
    expect(d.keys('/', ':', '5').names()).toEqual(['box:demo-shop:ws:101:port:5173']);
  });

  test.each<[string, EventBody, string[]]>([
    [
      'opened',
      { type: 'port.forward', data: fwd() },
      [' | :3000 → localhost:3000 | ● open | — | — | — | — | — | —'],
    ],
    [
      'asleep with its box',
      { type: 'port.forward', data: fwd({ state: 'asleep' }) },
      [' | :3000 → localhost:3000 | ○ box asleep | — | — | — | — | — | —'],
    ],
    [
      'closed: offered again',
      { type: 'port.forward', data: { ...fwd(), closed: true } },
      [' | :3000 | listening | — | — | — | — | — | —'],
    ],
    [
      'listening on another',
      {
        type: 'workspace.ports',
        box: 'demo-shop',
        data: { card: '101', ports: [3000, 8080], fixed: [] },
      },
      [
        ' | :3000 | listening | — | — | — | — | — | —',
        ' | :8080 | listening | — | — | — | — | — | —',
      ],
    ],
    [
      'listening on none',
      { type: 'workspace.ports', box: 'demo-shop', data: { card: '101', ports: [], fixed: [] } },
      [],
    ],
    [
      'another box’s',
      { type: 'workspace.ports', box: 'demo-shop-1', data: { card: '101', ports: [], fixed: [] } },
      [' | :3000 | listening | — | — | — | — | — | —'],
    ],
  ])('an event changes them in place: %s', (_, e, rows) => {
    const d = read({ offered: [offer('101', 3000)] }).send(event(e));

    expect(portRows(d)).toEqual(rows);
    expect(d.commands).toEqual([]);
  });

  test('a forward on another local port says so on the status line once, as it opens', () => {
    const moved = fwd({ local: 3001, note: 'localhost:3000 was taken' });
    const d = read({ offered: [offer('101', 3000)] }).send(
      event({ type: 'port.forward', data: { ...moved, state: 'opening' } }),
    );

    expect(d.commands).toEqual([]);
    expect(effects(d.send(event({ type: 'port.forward', data: moved })).commands)).toEqual([
      {
        kind: 'status',
        text: 'demo-shop #101 :3000 → localhost:3001 · open (localhost:3000 was taken)',
      },
    ]);
    expect(d.send(event({ type: 'port.forward', data: moved })).commands).toEqual([]);
  });

  test.each<[string, Partial<PortListData>, Effect[], string[]]>([
    ['open: the browser at once', { forwards: [fwd({ local: 3001 })] }, [opened(3000, 3001)], []],
    [
      'offered: forwarded first',
      { offered: [offer('101', 3000)] },
      [],
      ['port open demo-shop 101 3000'],
    ],
    [
      'asleep: forwarded again',
      { forwards: [fwd({ state: 'asleep' })] },
      [],
      ['port open demo-shop 101 3000'],
    ],
    [
      'failed: tried again',
      { forwards: [fwd({ state: 'failed' })] },
      [],
      ['port open demo-shop 101 3000'],
    ],
  ])('⏎ on a port row, %s', (_, data, shells, runs) => {
    const d = read(data).keys('ö', 'ö', '<CR>');

    expect(effects(d.commands)).toEqual(shells);
    expect(argvs(d.commands)).toEqual(runs);
  });

  const OPEN_ID = 'boxes:port-open:demo-shop 101 3000';
  /** `port open`'s answer: the forward, else a refusal. */
  const portOpen = (f: Partial<PortForward>): Input => ({
    kind: 'result',
    id: OPEN_ID,
    command: 'port open',
    reply: { ok: true, data: fwd(f) },
  });
  const portRefused = (code: string, message: string): Input => ({
    kind: 'result',
    id: OPEN_ID,
    command: 'port open',
    reply: { ok: false, error: { code, message } },
  });

  test.each<[string, Input, Effect[]]>([
    ['open: the browser on its local port', portOpen({ local: 3001 }), [opened(3000, 3001)]],
    [
      'refused: its message',
      portRefused('port-taken', 'localhost:3000 is taken on this machine'),
      [{ kind: 'balloon', tone: 'error', text: 'localhost:3000 is taken on this machine' }],
    ],
    [
      'failed: said',
      portOpen({ state: 'failed', note: 'no relay' }),
      [
        {
          kind: 'balloon',
          tone: 'error',
          text: 'demo-shop #101 :3000 → localhost:3000 · failed (no relay)',
        },
      ],
    ],
  ])('port open answers: %s', (_, answer, shells) => {
    const d = read({ offered: [offer('101', 3000)] }).send(answer);

    expect(effects(d.commands)).toEqual(shells);
  });

  test('⌘⏎ on a port row: Open in browser, Stop forwarding only when forwarded', () => {
    const on = (data: Partial<PortListData>) =>
      menuOn([box], [], 'demo-shop:ws:101:port:3000', [portsAnswer(data)]);
    const offered = on({ offered: [offer('101', 3000)] });

    expect(offered.pick.title).toBe('demo-shop · #101 :3000');
    expect(offered.rows()).toEqual(['Open in browser · forwards it first ⏎']);
    expect(argvs(offered.keys('<CR>').out)).toEqual(['port open demo-shop 101 3000']);
    const open = on({ forwards: [fwd({ local: 3001 })] });

    expect(open.rows()).toEqual(['Open in browser · localhost:3001 ⏎', 'Stop forwarding']);
    expect(effects(open.keys('<CR>').out)).toEqual([opened(3000, 3001)]);
    const stop = on({ forwards: [fwd({ state: 'asleep' })] });

    expect(argvs(stop.keys('s', 't', 'o', '<CR>').out)).toEqual(['port close demo-shop 101 3000']);
  });

  test.each<[string, string[], string]>([
    ['a box row: its own shell', [], 'box shell'],
    ['a workspace row: its shell', ['ö'], 'workspace shell'],
    ['a port row: the browser', ['ö', 'ö'], 'open in browser'],
  ])('⏎ in the key line on %s', (_, keys, label) => {
    const d = read({ offered: [offer('101', 3000)] }).keys(...keys);

    expect(d.table.props.foot?.[0]).toEqual({ keys: '⏎', label });
  });

  test('the workspace’s Forward port…: its port asked, forwarded by serve, then the browser', () => {
    const m = menuOn([box], [], 'demo-shop:ws:101', [portsAnswer({})]).keys('f', '<CR>');

    expect(m.prompt.title).toBe('Port in the workspace');
    m.keys('3', '0', '0', '0', '<CR>');
    expect(argvs(m.out)).toEqual(['port open demo-shop 101 3000']);
    m.answer(portOpen({}));
    expect(effects(m.out)).toEqual([opened(3000)]);
  });
});
