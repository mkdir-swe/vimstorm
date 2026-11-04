import { describe, expect, test } from 'bun:test';
import {
  abeSkewed,
  abeSkewText,
  boxTooOldText,
  type TableRefusal,
  tableRefusalOf,
} from './box-version';
import { type Ran } from '../ports';

const HELP = '\nabe: the command line every Abe client uses (VimStorm, agents, scripts)\n';

const REFUSED: [string, Ran, TableRefusal][] = [
  [
    'text: an unknown command, its help after it',
    { exit: 2, stdout: '', stderr: `abe: unknown command: box keep\n${HELP}` },
    { kind: 'command', said: 'unknown command: box keep' },
  ],
  [
    'json: an unknown command',
    {
      exit: 2,
      stdout:
        '{"ok":false,"error":{"code":"unknown-command","message":"unknown command: session transcript"}}\n',
      stderr: HELP,
    },
    { kind: 'command', said: 'unknown command: session transcript' },
  ],
  [
    'text: a flag its table has not got',
    { exit: 2, stdout: '', stderr: 'abe: unknown flag --profile\n' },
    { kind: 'argument', said: 'unknown flag --profile' },
  ],
  [
    'json: an argument its table has not got',
    {
      exit: 2,
      stdout: '{"ok":false,"error":{"code":"usage","message":"unexpected argument 3"}}\n',
      stderr: '',
    },
    { kind: 'argument', said: 'unexpected argument 3' },
  ],
];

describe("a box's answer that is its abe not knowing what it was sent (#188)", () => {
  test.each(REFUSED)('%s', (_, ran, want) => {
    expect(tableRefusalOf(ran)).toEqual(want);
  });

  test.each([
    ['an answer', { exit: 0, stdout: '{"ok":true,"data":{}}\n', stderr: '' }],
    [
      "a handler's own usage refusal",
      {
        exit: 2,
        stdout: '{"ok":false,"error":{"code":"usage","message":"not a card id (4, AB#4): x"}}\n',
        stderr: '',
      },
    ],
    ['a refusal', { exit: 1, stdout: '', stderr: 'abe: session 3-1 has ended\n' }],
    ['no abe there', { exit: 3, stdout: '', stderr: 'abe: abe serve is not running\n' }],
    ['the link', { exit: 255, stdout: '', stderr: 'ssh: connect to host: timed out\n' }],
  ])('%s is none', (_, ran) => {
    expect(tableRefusalOf(ran)).toBeUndefined();
  });
});

describe('the words', () => {
  test('a command the box has not got: both versions, and what to do', () => {
    expect(
      boxTooOldText({
        box: 'demo-shop-3',
        command: 'box keep',
        refusal: { kind: 'command', said: 'unknown command: box keep' },
        theirs: '2.0.0-alpha.0',
        here: '2.2.0-1a2b3c4d',
      }),
    ).toBe(
      "demo-shop-3 runs abe 2.0.0-alpha.0, this machine 2.2.0-1a2b3c4d: `box keep` needs this machine's abe on the box · update the box release (docs/cloud.md › A new abe on your box)",
    );
  });

  test('an argument it has not got: what it said', () => {
    expect(
      boxTooOldText({
        box: 'demo-shop-3',
        command: 'session run',
        refusal: { kind: 'argument', said: 'unknown flag --profile' },
        theirs: '2.0.0-alpha.0',
        here: '2.2.0-1a2b3c4d',
      }),
    ).toBe(
      'demo-shop-3 runs abe 2.0.0-alpha.0, this machine 2.2.0-1a2b3c4d: its `session run` does not take what this machine sends (unknown flag --profile) · update the box release (docs/cloud.md › A new abe on your box)',
    );
  });

  test('the versions differ', () => {
    expect(abeSkewText('demo-shop-3', '2.0.0-alpha.0', '2.2.0-1a2b3c4d')).toBe(
      "demo-shop-3 runs abe 2.0.0-alpha.0, this machine 2.2.0-1a2b3c4d: commands newer than the box's abe fail there · update the box release (docs/cloud.md › A new abe on your box)",
    );
  });
});

test.each([
  ['2.0.0-alpha.0', '2.2.0-1a2b3c4d', true],
  ['2.0.0-alpha.0-7bd706fa', '2.2.0', true],
  ['2.2.0-1a2b3c4d', '2.2.0-5e6f7a8b-dirty', false],
  ['2.2.0-1a2b3c4d', '2.2.0', false],
  ['2.2.0-rc.1', '2.2.0', true],
])(
  '%s on the box, %s here: skewed %p (another release, not another commit)',
  (theirs, here, want) => {
    expect(abeSkewed(theirs, here)).toBe(want);
  },
);
