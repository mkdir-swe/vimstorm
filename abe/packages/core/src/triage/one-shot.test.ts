import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  askingJson,
  modelFor,
  oneShotArgv,
  oneShotEnv,
  readJsonAnswer,
  type Role,
} from './one-shot';

describe('modelFor: the role’s model, lowered by allowedModels', () => {
  test.each([
    ['reader', ['opus', 'sonnet', 'haiku'], 'sonnet'],
    ['reader', ['opus', 'haiku'], 'haiku'],
    ['reader', ['haiku', 'sonnet'], 'sonnet'],
    ['reader', ['opus'], 'opus'],
    ['writer', ['opus', 'sonnet'], 'opus'],
    ['writer', ['sonnet', 'haiku'], 'sonnet'],
    ['coordinator', ['haiku'], 'haiku'],
    ['reader', [], undefined],
  ] satisfies [Role, string[], string | undefined][])(
    '%s under %j → %s',
    (role, allowed, model) => {
      expect(modelFor(role, allowed)).toBe(model);
    },
  );
});

describe('oneShotEnv: a session’s clean environment without its socket', () => {
  const parent = {
    HOME: '/home/a',
    USER: 'a',
    PATH: '/usr/bin:/bin',
    LANG: 'sv_SE.UTF-8',
    GITHUB_TOKEN: 'ghp_x',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    ABE_SOCKET: '/s/serve.sock',
    DATABASE_URL: 'postgres://shop:shop@127.0.0.1/shop',
  };

  test('HOME, USER, PATH with abe’s folder first, TERM, the locale and the Reach given; nothing else', () => {
    expect(
      oneShotEnv({ parent, bin: '/st/bin', reach: { ABE_AWS_READ_TEST: 'abe-test' } }),
    ).toEqual({
      ok: true,
      env: {
        HOME: '/home/a',
        USER: 'a',
        PATH: '/st/bin:/usr/bin:/bin',
        TERM: 'xterm-256color',
        LANG: 'sv_SE.UTF-8',
        ABE_AWS_READ_TEST: 'abe-test',
      },
    });
  });

  test('a write name is refused, as for a session', () => {
    expect(
      oneShotEnv({ parent, bin: '/st/bin', reach: { ABE_AWS_WRITE_TEST: 'x' } }),
    ).toMatchObject({ ok: false, code: 'write-name' });
  });
});

test('oneShotArgv: print mode, no tools, MCP servers, slash commands or settings files, nothing kept', () => {
  expect(oneShotArgv({ claude: '/bin/claude', model: 'haiku', system: 'Be brief.' })).toEqual([
    '/bin/claude',
    '-p',
    '--model',
    'haiku',
    '--tools',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--output-format',
    'text',
    '--append-system-prompt',
    'Be brief.',
  ]);
  expect(oneShotArgv({ claude: 'claude', model: 'opus', system: '' })).not.toContain(
    '--append-system-prompt',
  );
});

test('askingJson: the prompt, then the ask for one JSON document of the shape', () => {
  const asked = askingJson('Sort these.\n', '{"n": 1}');

  expect(asked.startsWith('Sort these.\n\n')).toBe(true);
  expect(asked).toContain('exactly one JSON document');
  expect(asked.trimEnd().endsWith('{"n": 1}')).toBe(true);
});

describe('readJsonAnswer: the JSON in a text answer, zod-checked', () => {
  const Shape = z.object({ n: z.number() });

  test.each([
    ['bare', '{"n": 1}'],
    ['with whitespace', '\n  {"n": 1}\n'],
    ['in a fence', 'Here it is:\n```json\n{"n": 1}\n```\n'],
    ['with a line around it', 'Sure. {"n": 1} Done.'],
  ])('%s', (_, text) => {
    expect(readJsonAnswer(text, Shape)).toEqual({ ok: true, data: { n: 1 } });
  });

  test.each([
    ['no JSON', 'I cannot decide.', 'no JSON document in the answer'],
    ['the wrong shape', '{"n": "one"}', 'n: '],
    ['cut off', '{"n": 1', 'no JSON document in the answer'],
  ])('%s is unreadable, with why', (_, text, why) => {
    const read = readJsonAnswer(text, Shape);

    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.message).toContain(why);
  });
});
