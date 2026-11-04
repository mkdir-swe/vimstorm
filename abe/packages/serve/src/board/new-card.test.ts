/**
 * New card end to end (#346): the real `abe ui bridge` and its `serve`, the real Azure DevOps
 * adapter on the fake Azure DevOps and a fake `az`, this test as the app. `:new <title>` on the
 * Board opens the dialog; Create makes the card, the status line says so, and the Board selects
 * it on Mine. (A refusal kept in the dialog: `ui/src/command/new-card.test.ts`; Azure's words for it:
 * `board.test.ts`.)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  boardLayers,
  type BoardLayers,
  cli,
  type Cli,
  fakeAdo,
  type FakeAdo,
  fakeAz,
  type FakeAz,
  type Streaming,
} from '@abe/testing';
import { asTrees, BridgeFrame } from '@abe/ui';

const HELLO = { v: 2, type: 'hello', size: { width: 1440, height: 846 }, version: 'test' };
const key = (k: string) => ({ v: 2, type: 'input', input: { kind: 'key', key: k } });
const typing = (text: string) => Array.from(text, (ch) => key(ch === ' ' ? '<Space>' : ch));
const text = (f: BridgeFrame) => JSON.stringify(f);
const isLayer = (f: BridgeFrame, has: string) => f.type === 'layer' && text(f).includes(has);
const isTree = (f: BridgeFrame, has: string) => f.type === 'tree' && text(f).includes(has);

describe('New card over the bridge (#346)', () => {
  let ado: FakeAdo;
  let az: FakeAz;
  let files: BoardLayers;
  let abe: Cli;
  const running: Streaming[] = [];

  beforeAll(async () => {
    ado = await fakeAdo();
    az = fakeAz({ tokens: ['token-one'] });
    files = boardLayers(ado.board);
    abe = cli({ env: { PATH: az.path, ...files.env, ...ado.env }, cwd: files.repo });
  });
  afterAll(async () => {
    for (const s of running.splice(0)) s.signal('SIGKILL');
    await abe.close();
    await ado.stop();
    az.remove();
    files.remove();
  });

  const board = async () => {
    const bridge = abe.spawn('ui', 'bridge');
    /** Its frames as the window takes them: a patch as the tree it gives. */
    const trees = asTrees();

    running.push(bridge);
    const send = (frame: unknown) => {
      bridge.write(`${JSON.stringify(frame)}\n`);
    };
    const until = async (match: (f: BridgeFrame) => boolean): Promise<BridgeFrame[]> => {
      const seen: BridgeFrame[] = [];

      for (;;) {
        const frame = trees(BridgeFrame.parse(JSON.parse(await bridge.next())));

        seen.push(frame);
        if (match(frame)) return seen;
      }
    };

    send(HELLO);
    send({ v: 2, type: 'open', screen: 'factory' });
    send({ v: 2, type: 'focus', slot: 'main' });
    // both lists read: the Board counts its columns
    await until((f) => isTree(f, '"id":"col:New"') && isTree(f, '"count":'));

    return { send, until };
  };

  test('`:` words ⌘⏎ (New card “…”), then Create: made, said, and selected on Mine', async () => {
    const { send, until } = await board();

    send(key(':'));
    await until((f) => isLayer(f, '"id":"command-mode"'));
    for (const k of typing('Customers can save a wishlist')) send(k);
    // the words' New card row, ⌘⏎ on the line
    await until((f) => isLayer(f, '"id":"here:new"') && isLayer(f, 'wishlist'));
    send(key('<D-CR>'));
    await until((f) => isLayer(f, '"kicker":"New card"'));
    // the ⏎ that chose it never also creates: past the guard
    await Bun.sleep(600);
    send(key('<CR>'));
    const made = await until(
      (f) => f.type === 'shell' && text(f).includes('Made #') && text(f).includes('wishlist'),
    );
    const id = /Made #(\d+)/.exec(made.map(text).find((t) => t.includes('Made #')) ?? '')?.[1];

    expect(id).toBeDefined();
    // the Board's ring on it, on Mine: the card the screen says is selected
    await until(
      (f) =>
        f.type === 'shell' &&
        f.effect.kind === 'selected' &&
        text(f).includes(`"card":${id ?? ''}`),
    );
    await until((f) => isTree(f, '"selected":"tab:mine"'));
  }, 30_000);
});
