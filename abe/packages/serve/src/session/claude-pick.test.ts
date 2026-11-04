/**
 * Which `claude` a local session runs (#179, #190), in a real `serve` with the fake `claude` in a
 * real `tmux`: an old Claude Code first on the session's PATH (Volta's npm 2.1.39) is passed over
 * for the newer one after it; with only the old one the launch is refused, saying which and why.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLAUDE_MIN, FactoryRunData, readEnvelope, type Reply } from '@abe/core';
import {
  card,
  fakeBoard,
  fakeClaude,
  type FakeClaude,
  scenario,
  scriptClaude,
  type ServeScenario,
  until,
} from '@abe/testing';
import { z } from 'zod';

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
};

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...GIT_ENV, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);
};

const BOARD = { organization: 'https://dev.azure.com/demo-org', project: 'Shop', team: 'Web' };

const checkout = (dir: string) => {
  git(dirname(dir), 'init', '-q', '-b', 'main', dir);
  mkdirSync(join(dir, '.abe'));
  // yours for the repo is never committed
  writeFileSync(join(dir, '.gitignore'), '.fake-claude/\n.scratch/\n.abe/settings.local.yaml\n');
  writeFileSync(join(dir, 'abe.yaml'), `board: ${JSON.stringify(BOARD)}\nenvironments: {}\n`);
  writeFileSync(join(dir, '.abe', 'settings.local.yaml'), '');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');

  return dir;
};

let root: string;
let old: string;
let claude: FakeClaude;
const open: ServeScenario[] = [];

/** A serve whose sessions get `path`, and yours on this Mac for a local run. */
const serveWith = async (path: string) => {
  const s = await scenario({
    board: fakeBoard([card(4, 'Sign in'), card(5, 'Cart')], { states: ['New', 'Closed'] }),
    sessions: {
      env: {
        ...GIT_ENV,
        PATH: path,
        ABE_CONFIG_DIR: join(root, 'mine'),
      },
    },
  });

  open.push(s);

  return s;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'abe-cp-'));
  for (const dir of ['mine', 'old']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
  // Volta's npm Claude Code: too old for a session's hooks.
  old = join(root, 'old');
  writeFileSync(join(old, 'claude'), '#!/bin/sh\necho "2.1.39 (Claude Code)"\n', { mode: 0o755 });
  claude = fakeClaude();
});

afterAll(async () => {
  for (const s of open) await s.close();
  claude.remove();
  rmSync(root, { recursive: true, force: true });
});

const parsed = (reply: Reply) => readEnvelope(FactoryRunData, JSON.parse(reply.stdout));

test(
  'an old claude first on PATH is passed over for the newer one after it',
  { timeout: 30_000 },
  async () => {
    const s = await serveWith(`${old}:${claude.path}`);

    scriptClaude(s.state.dir, [{ say: 'ok' }]);
    const repo = checkout(join(root, 'shop'));
    const run = parsed(await s.request('factory', 'run', '4', '--repo', repo, '--json'));

    if (!run.ok) throw new Error(JSON.stringify(run.error));
    const argv = await until('its claude started', () => {
      try {
        return z
          .array(z.string())
          .parse(
            JSON.parse(readFileSync(join(run.data.worktree, '.fake-claude', 'argv.json'), 'utf8')),
          );
      } catch {
        return undefined;
      }
    });

    expect(argv).toContain('--settings');
  },
);

test('only an old claude: refused before anything starts, saying which and the fix', async () => {
  const s = await serveWith(`${old}:/usr/bin:/bin`);
  const repo = checkout(join(root, 'cart'));
  const reply = await s.request('factory', 'run', '5', '--repo', repo, '--json');

  expect(reply.exit).toBe(1);
  expect(JSON.parse(reply.stdout)).toEqual({
    ok: false,
    error: {
      code: 'old-claude',
      message: `claude 2.1.39 at ${join(old, 'claude')} is older than ${CLAUDE_MIN}, which a session's settings need (its hooks): '${join(old, 'claude')}' update, or put a newer claude first on PATH (abe tools check)`,
    },
  });
});
