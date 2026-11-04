/** Logins & tools' rows (#108): node's version manager named in its row (#145). */
import { expect, test } from 'bun:test';
import { toolCheck } from '../../install/tools';
import { type LoginStatusData } from '../../logins/logins';
import { type SourceStatus } from '../../install/source-status';
import { checkItems } from './logins-tools';

test("node's row names its manager and where its node is; other rows as they were", () => {
  const volta = [{ manager: 'Volta' as const, home: '/home/ada/.volta' }];
  const ran = (at: string, stdout: string) => ({ found: true, at, exit: 0, stdout, stderr: '' });
  const rows = checkItems({
    tools: {
      where: 'this Mac',
      tools: [
        toolCheck('node', ran('/home/ada/.volta/bin/node', 'v22.11.0'), false, volta),
        toolCheck('tmux', ran('/opt/homebrew/bin/tmux', 'tmux 3.5a'), false, volta),
      ],
    },
  });

  expect(rows.map((r) => [r.label, r.value, r.check])).toEqual([
    ['node', '22.11.0 · Volta', 'node --version · /home/ada/.volta/bin/node'],
    ['tmux', '3.5a', 'tmux -V'],
  ]);
});

test("an Entra refusal is the login's state (#237)", () => {
  const rows = checkItems({
    logins: {
      secret: null,
      logins: { github: 'ok', claude: 'ok', az: 'expired' },
      blocked: { az: 'AADSTS53003' },
    },
  });

  const az = rows.find((r) => r.id === 'login:az');

  expect([az?.state, az?.fix]).toEqual(['⚠ blocked by Entra (AADSTS53003)', null]);
});

test('a read under way draws its rows at once as checking…, in the order they land in (#345)', () => {
  const rows = checkItems({ checking: { logins: true, tools: true } });

  expect(rows.map((r) => r.id)).toEqual([
    'login:github',
    'login:claude',
    'login:az',
    'tool:node',
    'tool:tmux',
    'tool:docker',
    'tool:az',
    'tool:gh',
    'tool:claude',
    'tool:git',
    'tool:rg',
    'tool:aws',
  ]);
  expect(rows.every((r) => r.state === 'checking…' && r.fix === null && r.optional)).toBe(true);
  expect(rows.find((r) => r.id === 'tool:docker')?.label).toBe('Docker');
  expect(rows.find((r) => r.id === 'login:github')?.check).toBe('gh auth status');

  // the logins landed: theirs filled in, the tools still checking, the same rows
  const half = checkItems({
    logins: { secret: null, logins: { github: 'ok', claude: 'ok', az: 'ok' } },
    checking: { tools: true },
  });

  expect(half.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  expect(half.find((r) => r.id === 'login:github')?.state).toBe('✓ OK');
  expect(half.find((r) => r.id === 'tool:node')?.state).toBe('checking…');
});

test('a login says who it is signed in as (#345)', () => {
  const rows = checkItems({
    logins: {
      secret: null,
      logins: { github: 'ok', claude: 'ok', az: 'expired' },
      who: { github: 'ada', claude: 'ada@example.com', az: 'ada@example.com' },
    },
  });

  expect(rows.map((r) => [r.id, r.value])).toEqual([
    ['login:github', 'ada'],
    ['login:claude', 'ada@example.com'],
    // an expired login names no one: it is signed in as no one now
    ['login:az', null],
  ]);
});

test('a read refused keeps its rows, saying why, so the other read’s rows stay put (#345)', () => {
  const rows = checkItems({
    tools: { where: 'this Mac', tools: [] },
    refused: { logins: 'this abe serve keeps no logins' },
  });

  expect(rows.map((r) => [r.id, r.state, r.checking])).toEqual([
    ['login:github', "⚠ can't check: this abe serve keeps no logins", false],
    ['login:claude', "⚠ can't check: this abe serve keeps no logins", false],
    ['login:az', "⚠ can't check: this abe serve keeps no logins", false],
  ]);
});

test.each<[string, Partial<LoginStatusData>, string]>([
  [
    "az's own, in a checkout",
    {},
    "⚠ not signed in: this checkout reads az's own folder (~/.azure)",
  ],
  [
    'yours for this repo, in a checkout',
    { azureConfigDir: { from: 'checkout', dir: '/home/ada/az' } },
    '⚠ not signed in: this checkout reads az from /home/ada/az (board.azureConfigDir here)',
  ],
  [
    "az's own, outside a checkout",
    { outside: true },
    "⚠ not signed in: az's own folder (~/.azure)",
  ],
  [
    'what az said too',
    { said: { az: 'ERROR: Please run az login.' } },
    "⚠ not signed in: this checkout reads az's own folder (~/.azure); az said: ERROR: Please run az login.",
  ],
])("az's row names the folder it was checked in: %s", (_, more, state) => {
  const rows = checkItems({
    logins: { secret: null, logins: { github: 'ok', claude: 'ok', az: 'missing' }, ...more },
  });

  expect(rows.find((r) => r.id === 'login:az')?.state).toBe(state);
});

// a source's row (ADR 0028): its state, and its Sign in, serve's, never a fix
test.each<[string, SourceStatus, (string | boolean | null)[]]>([
  [
    'needs a sign-in: Sign in offered',
    {
      id: 'sentry',
      server: 'sentry',
      check: 'needs your sign-in',
      signIn: 'offered',
      reads: false,
    },
    ['needs your sign-in', false, 'offered'],
  ],
  [
    'serve signs in',
    { id: 'sentry', server: 'sentry', check: 'Signing in…', signIn: 'signing-in', reads: false },
    ['Signing in…', false, 'signing-in'],
  ],
  [
    'signed in, its read ok',
    { id: 'sentry', server: 'sentry', check: 'Signed in · read OK', signIn: null, reads: true },
    ['✓ Signed in · read OK', true, null],
  ],
  [
    'a failed sign-in: why, offered again',
    {
      id: 'sentry',
      server: 'sentry',
      check: 'sign-in failed: the browser closed',
      signIn: 'offered',
      reads: false,
    },
    ['sign-in failed: the browser closed', false, 'offered'],
  ],
])("a source's row: %s", (_, source, want) => {
  const [row] = checkItems({ sources: { repo: '/r', sources: [source] } });

  expect([row?.id, row?.group, row?.check, row?.fix]).toEqual([
    'source:sentry',
    'Sources',
    'MCP server sentry',
    null,
  ]);
  expect([row?.state ?? null, row?.ok ?? null, row?.signIn ?? null]).toEqual(want);
});
