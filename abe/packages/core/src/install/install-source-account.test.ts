/** A source's account: only names from the answer, and the ask that gets one server's reading tools. */
import { describe, expect, test } from 'bun:test';
import {
  readSourceAccount,
  type SourceAccount,
  sourceAccountArgv,
  sourceAccountSettings,
} from './install-source-account';

describe('readSourceAccount: the names it told, nothing else', () => {
  test.each<[string, string, SourceAccount]>([
    [
      'all three',
      '{"account":"ann","org":"acme","project":"web"}',
      { account: 'ann', org: 'acme', project: 'web' },
    ],
    ['nulls left out', '{"account":"ann","org":null,"project":null}', { account: 'ann' }],
    ['a line around it', 'Here it is:\n{"org":"acme"}\n', { org: 'acme' }],
    ['trimmed', '{"org":"  acme "}', { org: 'acme' }],
    ['"null" is none', '{"account":"null","org":"acme"}', { org: 'acme' }],
    ['a URL is not kept', '{"org":"https://acme.sentry.io","project":"web"}', { project: 'web' }],
    ['over one line is not kept', '{"account":"ann\\nsk-123"}', {}],
    ['too long is not kept', `{"account":"${'a'.repeat(101)}"}`, {}],
    ['not JSON', 'I could not call it.', {}],
    ['not the shape', '{"account":42}', {}],
  ])('%s', (_, text, want) => {
    expect(readSourceAccount(text)).toEqual(want);
  });
});

describe('sourceAccountArgv: one server from one file, its reading tools, no built-in ones', () => {
  test('the argv', () => {
    const argv = sourceAccountArgv({
      claude: '/bin/claude',
      model: 'haiku',
      mcp: 'sentry',
      config: '/home/ann/.claude.json',
    });

    expect(argv.slice(0, 18)).toEqual([
      '/bin/claude',
      '-p',
      '--model',
      'haiku',
      '--tools',
      '',
      '--mcp-config',
      '/home/ann/.claude.json',
      '--strict-mcp-config',
      '--settings',
      JSON.stringify(sourceAccountSettings('sentry')),
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--max-turns',
      '2',
      '--output-format',
    ]);
  });

  test('only that server started, every tool of it allowed, none denied', () => {
    const s = sourceAccountSettings('sentry');

    expect(s.allowedMcpServers).toEqual([{ serverName: 'sentry' }]);
    expect(s.permissions.allow).toEqual(['mcp__sentry__*']);
    expect(s.permissions.deny).toEqual([]);
  });
});
