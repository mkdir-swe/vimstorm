/** `gh auth status`'s logins, read by name only. */
import { describe, expect, test } from 'bun:test';
import { readGhAccounts } from './gh';

const SIGNED_IN = (login: string, active: boolean) =>
  [
    'github.com',
    `  ✓ Logged in to github.com account ${login} (keyring)`,
    `  - Active account: ${active}`,
    '  - Git operations protocol: https',
    '  - Token: gho_************************************',
  ].join('\n');

describe('readGhAccounts: the logins gh is signed in as, and the active one', () => {
  test.each<[string, string, { active: string | null; signedIn: string[] }]>([
    ['none', '', { active: null, signedIn: [] }],
    ['one, active', SIGNED_IN('ann', true), { active: 'ann', signedIn: ['ann'] }],
    [
      'two, the first active',
      `${SIGNED_IN('ann', true)}\n${SIGNED_IN('ann-acme', false)}`,
      { active: 'ann', signedIn: ['ann', 'ann-acme'] },
    ],
    [
      'an enterprise managed login, whole, inactive',
      `${SIGNED_IN('ann', true)}\n${SIGNED_IN('ann_acme', false)}`,
      { active: 'ann', signedIn: ['ann', 'ann_acme'] },
    ],
    [
      'an enterprise managed login, active',
      `${SIGNED_IN('ann', false)}\n${SIGNED_IN('ann-lee_acme2', true)}`,
      { active: 'ann-lee_acme2', signedIn: ['ann', 'ann-lee_acme2'] },
    ],
    [
      'before multi-account: "as <login>", the one login active',
      'github.com\n  ✓ Logged in to github.com as ann_acme (/home/.config/gh/hosts.yml)',
      { active: 'ann_acme', signedIn: ['ann_acme'] },
    ],
    [
      'a login gh can no longer use is not signed in',
      [
        'github.com',
        '  X Failed to log in to github.com account ann_acme (keyring)',
        '  - Active account: false',
        SIGNED_IN('ann', true),
      ].join('\n'),
      { active: 'ann', signedIn: ['ann'] },
    ],
  ])('%s', (_, text, want) => {
    expect(readGhAccounts(text)).toEqual(want);
  });
});
