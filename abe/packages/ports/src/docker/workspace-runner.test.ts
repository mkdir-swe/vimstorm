/**
 * The managed settings' write in the workspace container (#67): as root, into a folder only its
 * writer owns, so a repo's `.abe/session` layer that made `/etc/claude-code` as the session's user
 * cannot let the session replace them. The script runs for real here; a fake `id` stands in for
 * root where the folder is this test's user's.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeFolderShell } from '@abe/core';
import { CONVERSATIONS, MANAGED_WRITE, workspaceRunner } from './workspace-runner';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'managed-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (dir: string, text: string, path = '/usr/bin:/bin') => {
  const ran = Bun.spawnSync(['sh', '-c', MANAGED_WRITE, 'sh', dir, join(dir, 'managed.json')], {
    stdin: new TextEncoder().encode(text),
    env: { PATH: path },
  });

  return { exit: ran.exitCode, stderr: ran.stderr.toString() };
};

test('made when missing: the folder 755, the file 644, written whole', () => {
  const dir = join(root, 'etc', 'claude-code');

  expect(write(dir, '{"a":1}\n').exit).toBe(0);
  expect(statSync(dir).mode & 0o777).toBe(0o755);
  expect(statSync(join(dir, 'managed.json')).mode & 0o777).toBe(0o644);
  expect(readFileSync(join(dir, 'managed.json'), 'utf8')).toBe('{"a":1}\n');
  expect(existsSync(join(dir, 'managed.json.new'))).toBe(false);
});

test('a link left at the file is replaced, never written through', () => {
  const dir = join(root, 'claude-code');
  const elsewhere = join(root, 'elsewhere');

  mkdirSync(dir);
  writeFileSync(elsewhere, 'kept\n');
  symlinkSync(elsewhere, join(dir, 'managed.json'));
  symlinkSync(elsewhere, join(dir, 'managed.json.new'));
  expect(write(dir, '{}\n').exit).toBe(0);
  expect(readFileSync(elsewhere, 'utf8')).toBe('kept\n');
  expect(readFileSync(join(dir, 'managed.json'), 'utf8')).toBe('{}\n');
});

test("a folder its writer does not own is refused: nothing written (an image made it the session's)", () => {
  const dir = join(root, 'claude-code');
  const bin = join(root, 'bin');

  mkdirSync(dir);
  mkdirSync(bin);
  // The writer is root (uid 0); the folder is this test's user's, as a repo layer's `abe` made it.
  writeFileSync(join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
  const out = write(dir, '{}\n', `${bin}:/usr/bin:/bin`);

  expect(out.exit).toBe(5);
  expect(out.stderr).toContain('not owned by uid 0');
  expect(existsSync(join(dir, 'managed.json'))).toBe(false);
});

test(".claude for the script user: folders and files readable, none writable, the local settings the owner's alone", () => {
  const dir = join(root, '.claude');

  mkdirSync(join(dir, 'worktrees', 'agent-1'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'settings.local.json'), '{}', { mode: 0o664 });
  writeFileSync(join(dir, 'worktrees', 'agent-1', 'a.ts'), 'x', { mode: 0o664 });
  const ran = Bun.spawnSync(['sh', '-c', claudeFolderShell(dir)]);

  expect(ran.exitCode).toBe(0);
  const mode = (path: string) => statSync(path).mode & 0o7777;

  expect(mode(dir)).toBe(0o755);
  expect(mode(join(dir, 'worktrees', 'agent-1'))).toBe(0o755);
  expect(mode(join(dir, 'worktrees', 'agent-1', 'a.ts'))).toBe(0o644);
  expect(mode(join(dir, 'settings.local.json'))).toBe(0o600);
});

test("Claude Code's write folder (.cc-writes) made ahead, readable: its own 0700 mkdir keeps it so, so eslint . walks it", () => {
  const dir = join(root, '.claude');
  const mode = (path: string) => statSync(path).mode & 0o7777;

  expect(Bun.spawnSync(['sh', '-c', claudeFolderShell(dir)]).exitCode).toBe(0);
  expect(mode(join(dir, '.cc-writes'))).toBe(0o755);
  // What Claude Code 2.1.309 does before a settings write: mkdir -p with mode 0700.
  mkdirSync(join(dir, '.cc-writes'), { recursive: true, mode: 0o700 });
  expect(mode(join(dir, '.cc-writes'))).toBe(0o755);
  // One a session made before (0700) is widened on the next up.
  chmodSync(join(dir, '.cc-writes'), 0o700);
  expect(Bun.spawnSync(['sh', '-c', claudeFolderShell(dir)]).exitCode).toBe(0);
  expect(mode(join(dir, '.cc-writes'))).toBe(0o755);
});

test('a .claude that is a link is taken away, never followed: what it points at keeps its modes', () => {
  const home = join(root, 'home');
  const dir = join(root, 'repo', '.claude');

  mkdirSync(join(home, '.claude'), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  writeFileSync(join(home, '.claude', '.credentials.json'), '{}', { mode: 0o600 });
  mkdirSync(join(root, 'repo'));
  symlinkSync(home, dir);
  const ran = Bun.spawnSync(['sh', '-c', claudeFolderShell(dir)]);

  expect(ran.exitCode).toBe(0);
  const mode = (path: string) => statSync(path).mode & 0o7777;

  expect(mode(home)).toBe(0o700);
  expect(mode(join(home, '.claude'))).toBe(0o700);
  expect(mode(join(home, '.claude', '.credentials.json'))).toBe(0o600);
  // A folder of its own in the link's place.
  expect(mode(dir)).toBe(0o755);
});

test('a private file never widens, even for a moment, and a link inside is left alone', () => {
  const dir = join(root, '.claude');
  const outside = join(root, 'outside.txt');

  mkdirSync(join(dir, 'worktrees', 'w'), { recursive: true });
  writeFileSync(join(dir, 'worktrees', 'w', 'settings.local.json'), '{}', { mode: 0o600 });
  writeFileSync(outside, 'x', { mode: 0o600 });
  symlinkSync(outside, join(dir, 'link'));
  const script = claudeFolderShell(dir);

  expect(script).not.toContain('chmod -R');
  expect(Bun.spawnSync(['sh', '-c', script]).exitCode).toBe(0);
  expect(statSync(join(dir, 'worktrees', 'w', 'settings.local.json')).mode & 0o7777).toBe(0o600);
  expect(statSync(outside).mode & 0o7777).toBe(0o600);
});

const conversations = (volume: string, home: string) => {
  const ran = Bun.spawnSync(['sh', '-c', CONVERSATIONS, 'sh', volume, home], {
    env: { PATH: '/usr/bin:/bin' },
  });

  return { exit: ran.exitCode, stderr: ran.stderr.toString() };
};

test("Claude Code's conversations on the workspace volume (#343): a new container's home finds them", () => {
  const volume = join(root, 'volume', 'claude-conversations');
  const home = join(root, 'home');
  const projects = join(home, '.claude', 'projects');

  // an older container kept them in its home: moved onto the volume once, then linked
  mkdirSync(join(projects, '-workspace-repo'), { recursive: true });
  writeFileSync(join(projects, '-workspace-repo', 'c0ffee.jsonl'), '{}\n');
  expect(conversations(volume, home)).toEqual({ exit: 0, stderr: '' });
  expect(lstatSync(projects).isSymbolicLink()).toBe(true);
  expect(statSync(volume).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(volume, '-workspace-repo', 'c0ffee.jsonl'), 'utf8')).toBe('{}\n');
  // again: nothing changes
  expect(conversations(volume, home).exit).toBe(0);
  // a new container: its home has no .claude; linked again, the conversation there
  rmSync(join(home, '.claude'), { recursive: true });
  expect(conversations(volume, home).exit).toBe(0);
  expect(readFileSync(join(projects, '-workspace-repo', 'c0ffee.jsonl'), 'utf8')).toBe('{}\n');
});

test('a link planted at the volume folder (by the script user) is refused: no conversation goes through it', () => {
  const volume = join(root, 'volume', 'claude-conversations');
  const theirs = join(root, 'theirs');
  const home = join(root, 'home');

  mkdirSync(theirs, { recursive: true });
  mkdirSync(join(root, 'volume'));
  symlinkSync(theirs, volume);
  const out = conversations(volume, home);

  expect(out.exit).toBe(4);
  expect(out.stderr).toContain('is not a folder of its own');
  expect(existsSync(join(home, '.claude', 'projects'))).toBe(false);
});

/** A runner whose every command in the container fails, saying `stderr`. */
const failing = (stderr: string) =>
  workspaceRunner({
    exec: () => Promise.resolve({ exit: 1, stdout: '', stderr: `${stderr}\n` }),
    socketDir: root,
    socketMount: '/abe',
    attachVia: [],
  });

// tmux's server ends with its last session: a look or a stop that meets it going finds none.
test.each<[string, boolean, boolean]>([
  ['no server running on /tmp/tmux-1000/default', true, true],
  ['error connecting to /tmp/tmux-1000/default (No such file or directory)', true, true],
  ['server exited unexpectedly', true, true],
  ['Error response from daemon: No such container: abe-workspace', true, false],
  ['open terminal failed: not a terminal', false, false],
])('tmux saying %j: none running %p, stopped %p', async (stderr, none, stopped) => {
  const r = failing(stderr);

  expect(await r.running()).toMatchObject(none ? { ok: true, data: [] } : { ok: false });
  expect((await r.stop('4-a1b2')).ok).toBe(stopped);
});
