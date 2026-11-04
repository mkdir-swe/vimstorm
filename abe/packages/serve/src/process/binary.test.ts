/** The compiled `abe`, run from a clean PATH and HOME: it starts `serve` and answers. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Event, StatusData } from '@abe/core';
import { cli, type Cli } from '@abe/testing';

const target = `bun-${process.platform}-${process.arch}`;
const supported = target === 'bun-darwin-arm64' || target === 'bun-linux-arm64';
const BUILD = join(import.meta.dir, '..', '..', '..', '..', 'scripts', 'build.sh');
const ABE_VERSION = '2.2.0-test.7';

describe.skipIf(!supported)(`the compiled abe (${target})`, () => {
  const out = mkdtempSync(join(tmpdir(), 'abe-bin-'));
  const binary = join(out, 'abe');
  let abe: Cli;

  beforeAll(async () => {
    // As `bun run build:*` builds it, its version given.
    const build = Bun.spawn(
      ['bash', BUILD, process.platform === 'darwin' ? 'darwin' : 'linux', binary],
      // bun build leaves its scratch copies in the cwd: keep them in `out`.
      {
        cwd: out,
        env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ABE_VERSION },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
    // Only HOME and PATH=/usr/bin:/bin: the socket and state go to their defaults under HOME.
    abe = cli({ binary, env: { ABE_STATE_DIR: '', ABE_SOCKET: '' } });
  }, 60_000);

  afterAll(async () => {
    await abe.close();
    rmSync(out, { recursive: true, force: true });
  });

  test('starts serve and answers status --json', async () => {
    const first = await abe.json(StatusData, 'status');
    const second = await abe.json(StatusData, 'status');

    expect(first.exit).toBe(0);
    if (!first.doc.ok || !second.doc.ok) throw new Error(first.stderr);
    expect(first.doc.data.socket).toBe(join(abe.state.dir, '.local', 'state', 'abe', 'serve.sock'));
    expect(second.doc.data.pid).toBe(first.doc.data.pid);
    // The build's own version, not the package's.
    expect(first.doc.data.version).toBe(ABE_VERSION);
  });

  // What a checkout keeps where abe is typed: none of it reaches abe or the serve it starts.
  test.each<[string, Record<string, string>, number]>([
    ["an .env abe may not open (a session's never-read file)", { '.env': 'A=1\n' }, 0o000],
    ['an .env that names another state folder', { '.env': 'XDG_STATE_HOME=./elsewhere\n' }, 0o644],
    [
      'a bunfig.toml that preloads a script',
      {
        'bunfig.toml': 'preload = ["./pre.ts"]\n',
        'pre.ts': "require('node:fs').writeFileSync('preloaded', '');\n",
      },
      0o644,
    ],
  ])('a checkout with %s: abe answers as anywhere else', async (_, files, mode) => {
    const repo = mkdtempSync(join(tmpdir(), 'abe-repo-'));

    try {
      for (const [name, text] of Object.entries(files))
        writeFileSync(join(repo, name), text, { mode });
      const status = await abe.jsonWith({ cwd: repo }, StatusData, 'status');

      expect(status.exit).toBe(0);
      if (!status.doc.ok) throw new Error(status.stderr);
      expect(status.doc.data.socket).toBe(
        join(abe.state.dir, '.local', 'state', 'abe', 'serve.sock'),
      );
      expect(readdirSync(repo).sort()).toEqual(Object.keys(files).sort());
    } finally {
      for (const name of Object.keys(files)) chmodSync(join(repo, name), 0o644);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('abe watch --json streams from the real serve and exits 0 on SIGINT', async () => {
    await abe.json(StatusData, 'status');
    const w = abe.spawn('watch', '--json', '--since', '0');
    const [started] = await w.lines(1);
    const doc: unknown = JSON.parse(started ?? '');

    expect(Event.parse(doc)).toMatchObject({ seq: 1, type: 'serve.started' });
    w.signal('SIGINT');
    expect((await w.exited).exit).toBe(0);
  });
});
