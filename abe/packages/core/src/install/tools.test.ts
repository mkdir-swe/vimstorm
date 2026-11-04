/** The tool checks' rules (#108): versions read from each tool's own output, too old, fixes. */
import { describe, expect, test } from 'bun:test';
import {
  CLAUDE_MIN,
  claudeCheck,
  claudeForSession,
  olderThan,
  toolCheck,
  toolProblem,
  type ToolName,
  toolsCheckText,
} from './tools';

const ok = (tool: ToolName, stdout: string) =>
  toolCheck(tool, { found: true, exit: 0, stdout, stderr: '' }, false).version;

describe('toolCheck', () => {
  test("each tool's version, as its check prints it", () => {
    expect(ok('node', 'v22.11.0\n')).toBe('22.11.0');
    expect(ok('tmux', 'tmux 3.5a\n')).toBe('3.5a');
    expect(ok('docker', '27.3.1\n')).toBe('27.3.1');
    expect(ok('az', '{\n  "azure-cli": "2.67.0",\n  "azure-cli-core": "2.67.0"\n}')).toBe('2.67.0');
    expect(
      ok('gh', 'gh version 2.63.0 (2024-11-27)\nhttps://github.com/cli/cli/releases/tag/v2.63.0\n'),
    ).toBe('2.63.0');
    expect(ok('claude', '2.1.3 (Claude Code)\n')).toBe('2.1.3');
    expect(ok('git', 'git version 2.47.1\n')).toBe('2.47.1');
    expect(ok('rg', 'ripgrep 14.1.1\n\nfeatures:+pcre2\n')).toBe('14.1.1');
    expect(ok('aws', 'aws-cli/2.22.0 Python/3.12.6 Darwin/25.6.0 exe/arm64\n')).toBe('2.22.0');
  });

  test('a version it cannot read is still ok: the check passed', () => {
    expect(
      toolCheck('tmux', { found: true, exit: 0, stdout: 'odd', stderr: '' }, false),
    ).toMatchObject({
      state: 'ok',
      version: null,
    });
  });

  test('too old, failed, missing; on a box no fix', () => {
    expect(
      toolCheck('node', { found: true, exit: 0, stdout: 'v16.20.0', stderr: '' }, false),
    ).toMatchObject({
      state: 'old',
      fix: 'brew upgrade node',
    });
    expect(
      toolCheck('gh', { found: true, exit: 2, stdout: '', stderr: 'boom\nmore' }, false),
    ).toMatchObject({
      state: 'failed',
      message: 'boom',
      fix: null,
    });
    expect(
      toolCheck('docker', { found: true, exit: 1, stdout: '', stderr: 'x' }, true),
    ).toMatchObject({
      state: 'failed',
      message: 'engine not running',
      fix: null,
    });
    expect(toolCheck('rg', { found: false }, true)).toMatchObject({ state: 'missing', fix: null });
  });
});

describe('node and its version manager (#145)', () => {
  const volta = [
    { manager: 'Volta' as const, home: '/home/ada/.volta', tool: '/home/ada/.volta/bin/volta' },
  ];
  const ran = (at: string, stdout = 'v22.11.0\n') =>
    ({ found: true, at, exit: 0, stdout, stderr: '' }) as const;

  test('a node found names where it is and the manager it is under', () => {
    expect(toolCheck('node', ran('/home/ada/.volta/bin/node'), false, volta)).toMatchObject({
      state: 'ok',
      where: '/home/ada/.volta/bin/node',
      manager: 'Volta',
    });
    expect(toolCheck('node', ran('/opt/homebrew/bin/node'), false, volta)).toMatchObject({
      where: '/opt/homebrew/bin/node',
      manager: 'Homebrew',
    });
    // Only node's manager is named: other tools say where they are.
    expect(
      toolCheck('gh', { ...ran('/opt/homebrew/bin/gh'), stdout: 'gh version 2.6' }, false, volta),
    ).toMatchObject({
      where: '/opt/homebrew/bin/gh',
      manager: null,
    });
  });

  test("missing with a manager installed: that manager's install, not Homebrew's", () => {
    expect(toolCheck('node', { found: false }, false, volta)).toMatchObject({
      state: 'missing',
      message: "not found on serve's PATH; Volta is installed but has no node",
      fix: '/home/ada/.volta/bin/volta install node',
      where: null,
      manager: null,
    });
    expect(toolCheck('node', { found: false }, false)).toMatchObject({
      message: "not found on serve's PATH",
      fix: 'brew install node',
    });
    // A tool no manager installs keeps its brew fix.
    expect(toolCheck('rg', { found: false }, false, volta)).toMatchObject({
      message: "not found on serve's PATH",
      fix: 'brew install ripgrep',
    });
  });

  test('too old under a manager: upgraded with it', () => {
    expect(
      toolCheck('node', ran('/home/ada/.volta/bin/node', 'v16.20.0'), false, volta),
    ).toMatchObject({ state: 'old', fix: '/home/ada/.volta/bin/volta install node' });
    expect(
      toolCheck('node', ran('/opt/homebrew/bin/node', 'v16.20.0'), false, volta),
    ).toMatchObject({
      fix: 'brew upgrade node',
    });
  });

  test('the text names the manager and where its node is', () => {
    expect(
      toolsCheckText({
        where: 'this Mac',
        tools: [toolCheck('node', ran('/home/ada/.volta/bin/node'), false, volta)],
      }),
    ).toBe(
      'tools on this machine, as abe serve runs them:\n  node   ✓ 22.11.0 · Volta /home/ada/.volta/bin/node\n',
    );
  });
});

describe('Docker on a Mac (#164)', () => {
  const gone = toolCheck('docker', { found: false }, false);
  const down = toolCheck('docker', { found: true, exit: 1, stdout: '', stderr: 'x' }, false);

  test('not there or not answering is no problem: only the fake box and image builds need it', () => {
    expect(gone).toMatchObject({
      state: 'missing',
      optional: 'the fake box and image builds',
      fix: 'brew install --cask docker',
    });
    expect(toolProblem(gone)).toBe(false);
    expect(toolProblem(down)).toBe(false);
    expect(toolsCheckText({ where: 'this Mac', tools: [gone] })).toBe(
      "tools on this machine, as abe serve runs them:\n  Docker ○ not found on serve's PATH · optional: only the fake box and image builds need it  (brew install --cask docker)\n",
    );
  });

  test('on a box its workspace runs in Docker: a problem there; every other tool is needed', () => {
    expect(toolProblem(toolCheck('docker', { found: false }, true))).toBe(true);
    expect(toolProblem(toolCheck('tmux', { found: false }, false))).toBe(true);
    expect(toolCheck('tmux', { found: false }, false).optional).toBeNull();
  });
});

test('olderThan compares numeric parts', () => {
  expect(olderThan('16.20.0', '18')).toBe(true);
  expect(olderThan('18.0.0', '18')).toBe(false);
  expect(olderThan('3.5a', '3.2')).toBe(false);
  expect(olderThan('3.1', '3.2')).toBe(true);
});

describe('claude: the first new enough on PATH (#179, #190)', () => {
  const v = (at: string, version: string) =>
    ({ found: true, at, exit: 0, stdout: `${version} (Claude Code)\n`, stderr: '' }) as const;
  const old = v('/home/ada/.volta/bin/claude', '2.1.39');
  const fresh = v('/home/ada/.local/bin/claude', '2.1.310');

  test(`older than ${CLAUDE_MIN} is too old, fixed by its own update`, () => {
    expect(claudeCheck([old], false)).toMatchObject({
      state: 'old',
      version: '2.1.39',
      where: '/home/ada/.volta/bin/claude',
      message: `2.1.39 at /home/ada/.volta/bin/claude is too old: ${CLAUDE_MIN} or newer`,
      fix: "'/home/ada/.volta/bin/claude' update",
    });
    expect(claudeCheck([fresh, old], false)).toMatchObject({ state: 'ok', version: '2.1.310' });
    expect(claudeCheck([], false)).toMatchObject({ state: 'missing' });
  });

  test('an old one first on PATH is flagged, naming the one sessions use', () => {
    expect(claudeCheck([old, fresh], false)).toMatchObject({
      state: 'old',
      message: `2.1.39 at /home/ada/.volta/bin/claude comes first on PATH and is too old (${CLAUDE_MIN} or newer); sessions use 2.1.310 at /home/ada/.local/bin/claude`,
      fix: "'/home/ada/.volta/bin/claude' update",
    });
  });

  test('a session runs the first new enough; none: refused with the version, where and fix', () => {
    expect(claudeForSession([old, fresh], '/p')).toEqual({
      ok: true,
      path: '/home/ada/.local/bin/claude',
    });
    expect(claudeForSession([old], '/p')).toEqual({
      ok: false,
      code: 'old-claude',
      message: `claude 2.1.39 at /home/ada/.volta/bin/claude is older than ${CLAUDE_MIN}, which a session's settings need (its hooks): '/home/ada/.volta/bin/claude' update, or put a newer claude first on PATH (abe tools check)`,
    });
    expect(claudeForSession([], '/usr/bin:/bin')).toEqual({
      ok: false,
      code: 'no-claude',
      message: "claude is not on the session's PATH: /usr/bin:/bin",
    });
  });
});
