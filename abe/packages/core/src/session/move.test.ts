import { describe, expect, test } from 'bun:test';
import {
  claudeSessionFile,
  claudeSessionOf,
  claudeArgv,
  ClaudeSession,
  leftBehind,
  movedTranscriptLog,
  movePlan,
  resumedTranscript,
  sessionMoveText,
  transcriptInScratch,
  unsafeMovePath,
} from '../index';

describe('what stays behind: core’s defaults, then the repo pack’s move.leave', () => {
  test.each([
    ['src/cart.ts', [], undefined],
    ['.scratch/4/checks.md', [], undefined],
    ['.scratch/4/sessions/4-a1b2.jsonl', [], undefined],
    ['notes.md', [], undefined],
    ['node_modules/react/index.js', [], 'packages'],
    ['web/node_modules/x/y.js', [], 'packages'],
    ['.scratch/4/app/node_modules/x.js', [], 'packages'],
    ['.venv/bin/python', [], 'packages'],
    ['dist/index.js', [], 'build'],
    ['web/.next/cache/a', [], 'build'],
    ['tsconfig.tsbuildinfo', [], 'build'],
    ['coverage/lcov.info', [], 'build'],
    ['.env', [], 'credentials'],
    ['web/.env.local', [], 'credentials'],
    ['.aws/credentials', [], 'credentials'],
    ['certs/dev.pem', [], 'credentials'],
    ['.npmrc', [], 'credentials'],
    ['fixtures/big.sql', ['*.sql'], 'repo'],
    ['tmp/cache.bin', ['tmp/'], 'repo'],
    ['tmp/cache.bin', ['/other/'], undefined],
    // core's reason wins over the repo's
    ['dist/x.sql', ['*.sql'], 'build'],
  ] as const)('%s with %j: %s', (path, globs, why) => {
    expect(leftBehind(path, globs)).toBe(why);
  });

  test('a plan: copied in order, left with why; a path out of the worktree or into .git refused', () => {
    expect(
      movePlan(
        [
          'b.ts',
          'a.ts',
          'node_modules/x.js',
          '.env',
          '../out.txt',
          '/etc/passwd',
          '.scratch/../../x',
          '.git/hooks/post-checkout',
          '.git',
          'sub/.git/config',
          'a.ts',
          '',
        ],
        [],
      ),
    ).toEqual({
      copied: ['a.ts', 'b.ts'],
      left: [
        { path: '.env', why: 'credentials' },
        { path: 'node_modules/x.js', why: 'packages' },
      ],
      unsafe: [
        '../out.txt',
        '.git',
        '.git/hooks/post-checkout',
        '.scratch/../../x',
        '/etc/passwd',
        'sub/.git/config',
      ],
    });
  });

  test.each([
    ['src/.gitignore', false],
    ['.github/workflows/ci.yml', false],
    ['.scratch/4/x.git', false],
    ['.git', true],
    ['.GIT/config', true],
    ['.git/config', true],
    ['a/.git/config', true],
    ['/a', true],
    ['a/../b', true],
    ['..', true],
  ])('%s unsafe: %s', (path, bad) => {
    expect(unsafeMovePath(path)).toBe(bad);
  });
});

describe('what a box’s session run --resume is held to', () => {
  const uuid = '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6';

  test.each([
    [uuid, true],
    [uuid.toUpperCase(), false],
    ['not-a-uuid', false],
    ['../x', false],
  ])('%s is a Claude session: %s', (id, ok) => {
    expect(ClaudeSession.safeParse(id).success).toBe(ok);
  });

  test.each([
    ['.scratch/4/sessions/4-a1b2.jsonl', true],
    ['.scratch/x', true],
    ['.scratch', false],
    ['.scratchy/x', false],
    ['/tmp/.scratch/x', false],
    ['.scratch/../.bashrc', false],
    ['notes/x.jsonl', false],
  ])('%s is a log in .scratch: %s', (path, ok) => {
    expect(transcriptInScratch(path)).toBe(ok);
  });
});

describe('the transcript: a log in .scratch and Claude Code’s own session file', () => {
  const uuid = '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6';

  test.each([
    [`/home/abe/.claude/projects/-workspace-repo/${uuid}.jsonl`, uuid],
    [`/home/me/.claude/projects/-home-me-shop-wt-4-x/${uuid}.jsonl`, uuid],
    [`/home/abe/.claude/projects/../${uuid}.jsonl`, undefined],
    [`/home/abe/.claude/other/x/${uuid}.jsonl`, undefined],
    ['/home/abe/.claude/projects/x/not-a-uuid.jsonl', undefined],
    [null, undefined],
  ] as const)('%s names %s', (path, id) => {
    expect(claudeSessionOf(path)).toBe(id);
  });

  test('where it goes: the log beside the card’s Evidence, the session file by its folder', () => {
    expect(movedTranscriptLog(4, '4-a1b2')).toBe('.scratch/4/sessions/4-a1b2.jsonl');
    expect(claudeSessionFile('/home/me/', '/home/me/shop-wt/4-sign.in', uuid)).toBe(
      `/home/me/.claude/projects/-home-me-shop-wt-4-sign-in/${uuid}.jsonl`,
    );
  });

  test('each line’s cwd moves to the new folder; other lines byte for byte', () => {
    const text = [
      JSON.stringify({ type: 'user', cwd: '/workspace/repo', message: 'hi' }),
      '{"type":"summary","summary":"x"}',
      'not json "cwd"',
      JSON.stringify({ type: 'user', cwd: '/elsewhere' }),
      '',
    ].join('\n');
    const lines = resumedTranscript(text, '/workspace/repo', '/home/me/wt').split('\n');

    expect(JSON.parse(lines[0] ?? '')).toEqual({
      type: 'user',
      cwd: '/home/me/wt',
      message: 'hi',
    });
    expect(lines.slice(1)).toEqual([
      '{"type":"summary","summary":"x"}',
      'not json "cwd"',
      JSON.stringify({ type: 'user', cwd: '/elsewhere' }),
      '',
    ]);
  });

  test('a moved session’s claude resumes its Claude session instead of starting one', () => {
    const argv = claudeArgv({
      claude: 'claude',
      settings: 's.json',
      pluginDir: 'p',
      skillsOnTop: false,
      mcpMode: 'yours',
      claudeSession: uuid,
      resume: true,
      instructions: 'i',
      prompt: 'go on',
    });

    expect(argv).toContain('--resume');
    expect(argv[argv.indexOf('--resume') + 1]).toBe(uuid);
    expect(argv).not.toContain('--session-id');
  });
});

test('the text names what was copied, what stayed and the box', () => {
  expect(
    sessionMoveText({
      id: '4-a1b2',
      card: 4,
      from: 'cloud',
      to: 'local',
      box: 'demo-shop-4',
      worktree: '/home/me/shop-wt/4-sign-in',
      branch: 'card/4-sign-in',
      head: 'abcdef1234567',
      state: 'working',
      copied: { staged: true, unstaged: false, files: ['a.ts', '.scratch/4/x'], transcript: true },
      left: [
        { path: 'node_modules/x', why: 'packages' },
        { path: 'node_modules/y', why: 'packages' },
        { path: '.env', why: 'credentials' },
      ],
      boxStopped: true,
      note: null,
    }),
  ).toBe(
    [
      '4-a1b2  AB#4 moved to this machine',
      '  worktree /home/me/shop-wt/4-sign-in  card/4-sign-in',
      '  copied   the commits to abcdef1, the staged diff, 2 files (untracked, .scratch), the transcript',
      '  left     packages (2), credentials (1); running servers and terminals, Reach write credentials (a session on this machine reads only)',
      '  box      demo-shop-4 stopped, its disk kept',
      '',
    ].join('\n'),
  );
});

test('a move to the cloud names the box, never "your environment" (#139)', () => {
  const text = sessionMoveText({
    id: '4-a1b2',
    card: 4,
    from: 'local',
    to: 'cloud',
    box: 'demo-shop-4',
    worktree: '/workspace/shop',
    branch: 'card/4-sign-in',
    head: 'abcdef1234567',
    state: 'working',
    copied: { staged: false, unstaged: false, files: [], transcript: true },
    left: [],
    boxStopped: false,
    note: null,
  });

  expect(text.split('\n')[0]).toBe('4-a1b2  AB#4 moved to box demo-shop-4');
});
