import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PermissionReply,
  promptPaths,
  REAL_PATHS,
  realPathOf,
  unattendedAnswer,
  withRealPaths,
} from './permission';

const ROOT = '/workspace';
const CWD = '/workspace/repo';

/** A PermissionRequest as Claude Code sends it, with the real paths the hook added. */
const prompt = (
  tool: string,
  input: Record<string, unknown>,
  real: Record<string, string> = {},
): Record<string, unknown> => ({
  session_id: 'c1',
  cwd: CWD,
  permission_mode: 'acceptEdits',
  hook_event_name: 'PermissionRequest',
  tool_name: tool,
  tool_input: input,
  [REAL_PATHS]: real,
});

/** Real paths as given: no links. */
const same = (...paths: string[]) => Object.fromEntries(paths.map((p) => [p, p]));

const decided = (payload: unknown) => {
  const { answer, log } = unattendedAnswer(payload, ROOT);
  const { decision } = answer.hookSpecificOutput;

  return {
    behavior: decision.behavior,
    message: decision.behavior === 'deny' ? decision.message : '',
    log,
  };
};

describe('unattendedAnswer: a Factory run in a workspace, nobody at its prompts (#67)', () => {
  test('a sandboxed command goes through', () => {
    expect(decided(prompt('Bash', { command: 'echo "${PIPESTATUS[0]}"' })).behavior).toBe('allow');
  });

  test.each([
    [{ command: 'curl x', dangerouslyDisableSandbox: true }],
    [{ dangerouslyDisableSandbox: true, command: 'ls' }],
  ])('a command outside the sandbox is refused, and why: %j', (input) => {
    const { behavior, message } = decided(prompt('Bash', input));

    expect(behavior).toBe('deny');
    expect(message).toContain('sandbox');
    expect(message).toContain('abe factory needs-you');
  });

  test('a command it cannot read is refused', () => {
    expect(decided(prompt('Bash', {})).behavior).toBe('deny');
  });

  test.each<[string, Record<string, unknown>, Record<string, string>]>([
    ['Read', { file_path: '/workspace/repo/src/a.ts' }, same('/workspace/repo/src/a.ts')],
    ['Read', { file_path: 'src/a.ts' }, same('/workspace/repo/src/a.ts')],
    [
      'Read',
      { file_path: '/workspace/repo-base/README.md' },
      same('/workspace/repo-base/README.md'),
    ],
    ['Glob', { pattern: '**/*.ts' }, same('/workspace/repo')],
    [
      'Glob',
      { pattern: 'src/**/*.ts', path: '/workspace/repo-base' },
      same('/workspace/repo-base/src'),
    ],
    ['Grep', { pattern: 'TODO' }, same('/workspace/repo')],
    [
      'Grep',
      { pattern: 'TODO', path: '/workspace/repo/src', glob: '*.ts' },
      same('/workspace/repo/src'),
    ],
  ])('%s inside the workspace goes through: %j', (tool, input, real) => {
    expect(decided(prompt(tool, input, real)).behavior).toBe('allow');
  });

  test.each<[string, Record<string, unknown>, Record<string, string>]>([
    ['Read', { file_path: '/etc/passwd' }, same('/etc/passwd')],
    ['Read', { file_path: '/workspace/repo/../../home/abe/.ssh/id' }, same('/home/abe/.ssh/id')],
    ['Read', { file_path: '../../home/abe/.claude.json' }, same('/home/abe/.claude.json')],
    ['Read', { file_path: '~/.ssh/id_ed25519' }, {}],
    ['Glob', { pattern: '/home/abe/**' }, same('/home/abe')],
    ['Glob', { pattern: '../../**/*.json' }, same('/')],
    ['Glob', { pattern: 'src/*/../../../../etc/*' }, {}],
    ['Grep', { pattern: 'x', path: '/workspacex' }, same('/workspacex')],
    ['Glob', { pattern: '{..,x}/*' }, same('/workspace/repo')],
    ['Glob', { pattern: '{../..,x}/etc/*' }, same('/workspace/repo')],
    ['Glob', { pattern: '{a,/etc}/*' }, same('/workspace/repo')],
    ['Glob', { pattern: '~/.ssh/*' }, same('/workspace/repo/~/.ssh')],
    ['Glob', { pattern: 'src/{a,~/b}/*' }, same('/workspace/repo/src')],
    ['Grep', { pattern: 'x', path: '/workspace/repo/..' }, same('/workspace')],
  ])('%s outside the workspace is refused: %j', (tool, input, real) => {
    const { behavior, message } = decided(prompt(tool, input, real));

    expect(behavior).toBe('deny');
    expect(message).toContain('outside the workspace');
  });

  test('a link out of the workspace is refused: its real path is what counts', () => {
    const { behavior, message } = decided(
      prompt(
        'Read',
        { file_path: '/workspace/repo/creds' },
        { '/workspace/repo/creds': '/home/abe/.claude/.credentials.json' },
      ),
    );

    expect(behavior).toBe('deny');
    expect(message).toContain('outside the workspace');
  });

  test('a path the hook did not resolve is refused', () => {
    expect(decided(prompt('Read', { file_path: '/workspace/repo/a' }, {})).behavior).toBe('deny');
    const unresolved = Object.fromEntries(
      Object.entries(prompt('Read', { file_path: '/workspace/repo/a' })).filter(
        ([key]) => key !== REAL_PATHS,
      ),
    );

    expect(decided(unresolved).behavior).toBe('deny');
  });

  test.each(['mcp__chrome-devtools__take_screenshot', 'mcp__chrome-devtools__navigate_page'])(
    'its browser goes through: %s',
    (tool) => {
      expect(decided(prompt(tool, { url: 'http://localhost:3000' })).behavior).toBe('allow');
    },
  );

  test.each(['WebFetch', 'Write', 'Edit', 'mcp__other__tool', 'mcp__chrome-devtoolsx__click'])(
    'anything else is refused, saying what to do instead: %s',
    (tool) => {
      const { behavior, message } = decided(prompt(tool, {}));

      expect(behavior).toBe('deny');
      expect(message).toContain(tool);
      expect(message).toContain('abe factory needs-you');
    },
  );

  test('a payload that is no prompt is refused', () => {
    expect(decided({}).behavior).toBe('deny');
    expect(decided('nope').behavior).toBe('deny');
  });

  test('the log: tool, answer, why, and a short summary of the input', () => {
    expect(decided(prompt('Bash', { command: 'npm test', description: 'tests' })).log).toEqual({
      tool: 'Bash',
      behavior: 'allow',
      reason: 'a sandboxed command',
      input: 'npm test',
    });
    const denied = decided(prompt('Read', { file_path: '/etc/passwd' }, same('/etc/passwd'))).log;

    expect(denied).toMatchObject({ tool: 'Read', behavior: 'deny', input: '/etc/passwd' });
    expect(denied.reason).toContain('outside the workspace');
  });

  test('the log redacts before it cuts: a secret across the cut leaves no prefix', () => {
    const secret = 's3cr3t-value-that-is-long';
    const command = `${'x'.repeat(110)} ${secret}`;
    const { log } = unattendedAnswer(prompt('Bash', { command }), ROOT, (text) =>
      text.replaceAll(secret, '[redacted:abe]'),
    );

    expect(log.input).not.toContain('s3cr3t');
    expect(log.input.length).toBeLessThanOrEqual(120);
  });

  test("the log's summary is short and holds no browser input", () => {
    const long = `echo ${'x'.repeat(500)}`;

    expect(decided(prompt('Bash', { command: long })).log.input.length).toBeLessThanOrEqual(120);
    expect(
      decided(prompt('mcp__chrome-devtools__fill', { value: 'hunter2-password' })).log.input,
    ).toBe('');
  });
});

describe('promptPaths: where a file tool reaches, lexically', () => {
  test.each<[string, Record<string, unknown>, string[]]>([
    ['Read', { file_path: 'a/../b.ts' }, ['/workspace/repo/b.ts']],
    ['Glob', { pattern: '/abs/dir/*.ts', path: '/ignored' }, ['/abs/dir']],
    ['Glob', { pattern: '*.ts' }, ['/workspace/repo']],
    ['Grep', { pattern: 'x', path: 'src' }, ['/workspace/repo/src']],
    ['Bash', { command: 'ls' }, []],
  ])('%s %j → %j', (tool, input, paths) => {
    expect(promptPaths(prompt(tool, input))).toEqual({ ok: true, paths });
  });
});

describe('the hook side: real paths, links resolved', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'abe-perm-')));

  mkdirSync(join(dir, 'repo', 'src'), { recursive: true });
  mkdirSync(join(dir, 'outside'));
  symlinkSync(join(dir, 'outside'), join(dir, 'repo', 'out'));

  test('a link resolves to where it points; a missing file under its real folder', () => {
    expect(realPathOf(join(dir, 'repo', 'out', 'secret'), realpathSync)).toBe(
      join(dir, 'outside', 'secret'),
    );
    expect(realPathOf(join(dir, 'repo', 'src', 'new.ts'), realpathSync)).toBe(
      join(dir, 'repo', 'src', 'new.ts'),
    );
  });

  test('withRealPaths adds each path its tool reaches, the rest of the payload as it came', () => {
    const asked = {
      cwd: join(dir, 'repo'),
      hook_event_name: 'PermissionRequest',
      tool_name: 'Read',
      tool_input: { file_path: 'out/secret' },
    };
    const doc: unknown = JSON.parse(withRealPaths(JSON.stringify(asked), realpathSync));

    expect(doc).toEqual({
      ...asked,
      [REAL_PATHS]: { [join(dir, 'repo', 'out', 'secret')]: join(dir, 'outside', 'secret') },
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test('a payload that is no file prompt is left as it came', () => {
    expect(withRealPaths('not json', realpathSync)).toBe('not json');
    const bash = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } });

    expect(withRealPaths(bash, realpathSync)).toBe(bash);
  });
});

describe("PermissionReply: serve's socket line, read by the hook", () => {
  const answer = {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  };
  const line = (stdout: string) => JSON.stringify({ v: 1, exit: 0, stdout, stderr: '' });

  test("an answer in Claude Code's shape", () => {
    const reply = PermissionReply.safeParse(
      line(JSON.stringify({ ok: true, data: { id: 's', answer } })),
    );

    const got: unknown = reply.success ? reply.data.stdout.data.answer : undefined;

    expect(got).toEqual(answer);
  });

  test.each([
    ['no JSON line', 'not json'],
    ['stdout not JSON', line('nope')],
    ['a refusal', line(JSON.stringify({ ok: false, error: { code: 'x', message: 'y' } }))],
    ['no answer', line(JSON.stringify({ ok: true, data: { id: 's', state: 'waiting' } }))],
    ['another shape', line(JSON.stringify({ ok: true, data: { answer: { decision: 'allow' } } }))],
  ])('%s: no answer', (_, text) => {
    expect(PermissionReply.safeParse(text).success).toBe(false);
  });
});
