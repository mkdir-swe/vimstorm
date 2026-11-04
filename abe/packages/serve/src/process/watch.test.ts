/**
 * `abe watch` through the CLI seam: the real `abe` as processes against a real `serve`, read as a
 * client reads it (stdout lines, exit codes).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Event, PROTOCOL, StatusData } from '@abe/core';
import { ask } from '@abe/ports';
import { cli, type Cli, scenario, type ServeScenario, type Streaming } from '@abe/testing';
import { VERSION } from '.';

const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

const events = (lines: readonly string[]) =>
  lines.map((l) => {
    const doc: unknown = JSON.parse(l);

    return Event.parse(doc);
  });

const keys = (line: string) => {
  const doc: unknown = JSON.parse(line);

  return typeof doc === 'object' && doc !== null ? Object.keys(doc) : [];
};

const ran = (noun: string, verb: string | null, exit: number) => ({
  type: 'command.ran',
  data: { noun, verb, exit },
});

let abe: Cli;
const watchers: Streaming[] = [];

/**
 * A Mac that says `serve.target: local` in its own settings: with the cloud default, a Mac that
 * reaches no boxes (no gh, no AWS login here) says so once as a `boxes.unread` event, which these
 * sequences do not count.
 */
const local = (): Cli => {
  const c = cli();
  const dir = join(c.state.dir, '.config', 'abe');

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.yaml'), 'serve.target: local\n');

  return c;
};

const watch = (...argv: string[]) => {
  const w = abe.spawn('watch', ...argv);

  watchers.push(w);

  return w;
};

const closeAll = async () => {
  for (const w of watchers.splice(0)) w.signal('SIGKILL');
  await abe.close();
};

describe('abe watch --json', () => {
  afterEach(closeAll);

  test('prints serve.started and one command.ran per command, numbered one apart', async () => {
    abe = local();
    await abe.json(StatusData, 'status');
    const w = watch('--json', '--since', '0');
    const replayed = await w.lines(2);

    await abe.run('serve');
    await abe.run('help', '--json');
    await abe.run('status');
    const live = await w.lines(3);
    const all = [...replayed, ...live];

    for (const line of all) expect(keys(line)).toEqual(['seq', 'at', 'type', 'data']);
    const seen = events(all);

    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    for (const e of seen) expect(e.at).toMatch(RFC3339);
    expect(seen).toMatchObject([
      { type: 'serve.started', data: { version: VERSION, socket: abe.state.socket } },
      ran('status', null, 0),
      // `abe serve` asks whether one runs first, then is refused.
      ran('status', null, 0),
      ran('serve', null, 1),
      // `help` is answered by the client, so serve never sees it.
      ran('status', null, 0),
    ]);
  });

  test('without --since it prints only what happens from now on', async () => {
    abe = local();
    await abe.json(StatusData, 'status');
    const w = watch('--json');
    const first = w.next();

    // Until the watcher is listening, its first line is the status after it.
    let line: string | undefined;

    while (line === undefined) {
      await abe.run('status', '--no-start');
      line = await Promise.race([first, Bun.sleep(50).then(() => undefined)]);
    }
    const [e] = events([line]);

    expect(e).toMatchObject(ran('status', null, 0));
    expect(e?.seq).toBeGreaterThan(2);
  });

  test("a request's tag rides its command.ran: a client knows its own commands from others'", async () => {
    abe = local();
    await abe.json(StatusData, 'status');
    const w = watch('--json', '--since', '1');

    await w.lines(1);
    const line = (tag?: string) =>
      JSON.stringify({
        v: PROTOCOL,
        argv: ['status', '--json'],
        cwd: '/',
        ...(tag === undefined ? {} : { tag }),
      });

    expect((await ask(abe.state.socket, line('views:read:1'))).ok).toBe(true);
    expect((await ask(abe.state.socket, line())).ok).toBe(true);
    const [mine, theirs] = events(await w.lines(2));

    expect(mine).toMatchObject({
      type: 'command.ran',
      data: { noun: 'status', tag: 'views:read:1' },
    });
    expect(theirs).toMatchObject(ran('status', null, 0));
    expect(theirs?.data).not.toHaveProperty('tag');
  });

  test('--since resumes after the number it names', async () => {
    abe = local();
    for (let i = 0; i < 4; i += 1) await abe.run('status');
    const w = watch('--json', '--since', '3');

    expect(events(await w.lines(2)).map((e) => e.seq)).toEqual([4, 5]);
  });

  test('a --since that is no whole number is a usage error, exit 2', async () => {
    abe = local();
    const out = await abe.run('watch', '--since', '-1', '--json');

    expect(out.exit).toBe(2);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, error: { code: 'usage' } });
    expect(out.stderr).toStartWith('usage: abe watch');
  });

  test('two watchers see the same sequence; killing one disturbs neither the other nor serve', async () => {
    abe = local();
    await abe.run('status');
    const a = watch('--json', '--since', '0');
    const b = watch('--json', '--since', '0');

    await abe.run('status');
    const fromA = await a.lines(3);
    const fromB = await b.lines(3);

    expect(fromA).toEqual(fromB);
    a.signal('SIGKILL');
    expect((await a.exited).exit).not.toBe(0);
    await abe.run('serve');
    const after = events(await b.lines(3));

    expect(after.map((e) => e.seq)).toEqual([4, 5, 6]);
    // The killed watch's own end, and `abe serve`'s probe and refusal.
    const said = after.map((e) =>
      e.type === 'command.ran' ? `${e.data.noun} ${e.data.exit}` : '',
    );

    expect(said.sort()).toEqual(['serve 1', 'status 0', 'watch 0']);
    expect((await abe.json(StatusData, 'status', '--no-start')).exit).toBe(0);
  });

  test('SIGINT ends it with exit 0', async () => {
    abe = local();
    await abe.run('status');
    const w = watch('--json', '--since', '0');

    await w.lines(2);
    w.signal('SIGINT');
    const end = await w.exited;

    expect(end.exit).toBe(0);
    expect(end.stderr).toBe('');
  });

  test('serve stopping ends it with exit 3, after the stop itself', async () => {
    abe = local();
    await abe.run('status');
    const w = watch('--json', '--since', '0');

    await w.lines(2);
    await abe.run('serve', 'stop');
    const end = await w.exited;

    expect(events(end.rest)).toMatchObject([ran('serve', 'stop', 0)]);
    expect(end.exit).toBe(3);
    expect(end.stderr).toContain('abe serve ended the stream');
  });
});

describe('abe watch', () => {
  afterEach(closeAll);

  test('prints one readable line per event', async () => {
    abe = local();
    await abe.run('status');
    const w = watch('--since', '0');
    const [started, status] = await w.lines(2);

    expect(started).toMatch(
      new RegExp(
        `^1 \\S+Z serve\\.started abe serve ${VERSION.replaceAll('.', '\\.')} listening on ${abe.state.socket} \\(pid \\d+\\)$`,
      ),
    );
    expect(status).toMatch(/^2 \S+Z command\.ran abe status: 0$/);
  });

  test('--no-start with no serve is exit 3 and one failure document', async () => {
    abe = local();
    const out = await abe.run('watch', '--json', '--no-start');

    expect(out.exit).toBe(3);
    expect(JSON.parse(out.stdout)).toMatchObject({
      ok: false,
      error: { code: 'serve-unreachable' },
    });
  });
});

describe('abe watch --since against a ring that dropped events', () => {
  let s: ServeScenario;

  afterEach(() => s.close());

  test('sends one watch.gap first, then what the ring holds', async () => {
    s = await scenario({ ring: 3 });
    for (let i = 0; i < 5; i += 1) await s.request('status');
    // The CLI against this in-process serve; its own state is only for HOME.
    const client = cli({ env: { ABE_SOCKET: s.state.socket } });
    const w = client.spawn('watch', '--json', '--since', '1', '--no-start');

    try {
      const seen = events(await w.lines(4));

      expect(seen).toMatchObject([
        { seq: 3, type: 'watch.gap', data: { since: 1, first: 4 } },
        { seq: 4 },
        { seq: 5 },
        { seq: 6 },
      ]);
    } finally {
      w.signal('SIGKILL');
      await w.exited;
      client.state.remove();
    }
  });
});

describe('watchers that fall behind or die mid-stream', () => {
  let s: ServeScenario;
  let client: Cli;

  afterEach(async () => {
    for (const w of watchers.splice(0)) w.signal('SIGKILL');
    client.state.remove();
    await s.close();
  });

  /** A serve holding `n` events, and the CLI pointed at it. */
  const busy = async (n: number) => {
    s = await scenario();
    for (let i = 1; i < n; i += 1) await s.request('status');
    client = cli({ env: { ABE_SOCKET: s.state.socket } });
  };

  const follow = (...argv: string[]) => {
    const w = client.spawn('watch', ...argv, '--no-start');

    watchers.push(w);

    return w;
  };

  test('one killed in the middle of a replay leaves the other and serve', async () => {
    await busy(3000);
    const a = follow('--json', '--since', '0');
    const b = follow('--json', '--since', '0');

    await a.next();
    a.signal('SIGKILL');
    await a.exited;
    const seen = events(await b.lines(3000));

    expect(seen.map((e) => e.seq)).toEqual(Array.from({ length: 3000 }, (_, i) => i + 1));
    expect((await s.request('status', '--json')).exit).toBe(0);
  });

  test('one that stopped reading never holds up serve stopping', async () => {
    await busy(3000);
    const stalled = follow('--json', '--since', '0');

    await stalled.next();
    stalled.signal('SIGSTOP');
    for (let i = 0; i < 2000; i += 1) await s.request('status');
    const stopped = await Promise.race([
      s.serve.stop().then(() => 'stopped'),
      Bun.sleep(3000).then(() => 'still running'),
    ]);

    expect(stopped).toBe('stopped');
  });
});
