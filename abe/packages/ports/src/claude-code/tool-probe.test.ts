/** `pathToolProbe` (#108): a tool on serve's PATH runs with serve's environment; one off it is not found. */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fakeTool } from '@abe/testing';
import { eachOnPath, pathToolProbe } from './tool-probe';

const tmux = fakeTool('tmux', { stdout: 'tmux 3.5a', exit: 0 });

afterAll(() => {
  tmux.remove();
});

test('a tool on PATH: its exit and output, run with serve’s environment', async () => {
  const probe = pathToolProbe({ env: { PATH: tmux.path, ABE_MARK: 'serve' }, home: tmux.dir });

  expect(await probe.run(['tmux', '-V'])).toEqual({
    found: true,
    at: join(tmux.dir, 'tmux'),
    real: realpathSync(join(tmux.dir, 'tmux')),
    exit: 0,
    stdout: 'tmux 3.5a\n',
    stderr: '\n',
  });
  expect(tmux.calls()[0]).toMatchObject({ argv: ['-V'], env: { ABE_MARK: 'serve' } });
});

test('a tool not on PATH is not found, never run', async () => {
  expect(
    await pathToolProbe({ env: { PATH: tmux.path }, home: tmux.dir }).run([
      'no-such-tool-x',
      '--version',
    ]),
  ).toEqual({
    found: false,
  });
});

test('the node managers under its home (#145), looked for on each check', async () => {
  const probe = pathToolProbe({ env: { PATH: tmux.path }, home: tmux.dir });

  expect(await probe.managers()).toEqual([]);
  mkdirSync(join(tmux.dir, '.volta'));
  expect(await probe.managers()).toEqual([{ manager: 'Volta', home: join(tmux.dir, '.volta') }]);
});

test('every copy of a tool on PATH, in order, a link to one file once (#179)', async () => {
  const a = fakeTool('claude', { stdout: '2.1.39 (Claude Code)', exit: 0 });
  const b = fakeTool('claude', { stdout: '2.1.310 (Claude Code)', exit: 0 });

  symlinkSync(join(b.dir, 'claude'), join(a.dir, 'linked'));
  mkdirSync(join(a.dir, 'again'));
  symlinkSync(join(b.dir, 'claude'), join(a.dir, 'again', 'claude'));
  try {
    const path = `${a.dir}:${b.dir}:${join(a.dir, 'again')}:/nowhere`;

    expect(eachOnPath('claude', path)).toEqual([join(a.dir, 'claude'), join(b.dir, 'claude')]);
    const each = await pathToolProbe({ env: { PATH: path }, home: a.dir }).runEach([
      'claude',
      '--version',
    ]);

    expect(each.map((r) => (r.found ? r.stdout.trim() : null))).toEqual([
      '2.1.39 (Claude Code)',
      '2.1.310 (Claude Code)',
    ]);
  } finally {
    a.remove();
    b.remove();
  }
});
