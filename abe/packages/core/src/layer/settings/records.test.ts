/** A records setting's rows of fields: taken apart from its value, put together again, what one lacks. */
import { describe, expect, test } from 'bun:test';
import { type SettingKey, SETTINGS } from './keys';
import { recordsOf } from './records';

describe('a records setting as rows of fields', () => {
  // key, its value, its rows, a lacking row's words
  const ROWS: readonly [SettingKey, unknown, string[][]][] = [
    [
      'views',
      [
        { screen: 'factory', node: 'col:Closed', hide: true },
        { screen: 'factory', node: 'col:Active', order: 0 },
        { screen: 'factory', node: 'col:Resolved', label: 'Done' },
        { screen: 'factory', node: 'stripe:git', group: 'bottom' },
      ],
      [
        ['factory', 'col:Closed', 'hide', ''],
        ['factory', 'col:Active', 'order', '0'],
        ['factory', 'col:Resolved', 'label', 'Done'],
        ['factory', 'stripe:git', 'group', 'bottom'],
      ],
    ],
    [
      'environments',
      {
        test: { account: '111111111111', region: 'eu-north-1', db: { read: { secret: 'r' } } },
        prod: { account: '222222222222', writePolicy: 'policies/prod.json' },
      },
      [
        ['test', '111111111111', 'eu-north-1', '', 'r', ''],
        ['prod', '222222222222', '', 'policies/prod.json', '', ''],
      ],
    ],
    [
      'worktree',
      {
        link: { all: ['frontend/.env'], dev: ['backend/.env.dev'], prod: ['backend/.env.prod'] },
        copy: { all: ['.vscode'] },
      },
      [
        ['frontend/.env', 'link', 'all'],
        ['backend/.env.dev', 'link', 'dev'],
        ['backend/.env.prod', 'link', 'prod'],
        ['.vscode', 'copy', 'all'],
      ],
    ],
    [
      'worktree',
      { link: ['backend/.env'], copy: ['.vscode'] },
      [
        ['backend/.env', 'link', ''],
        ['.vscode', 'copy', ''],
      ],
    ],
    ['kind', 'web-app', [['', 'web-app']]],
    [
      'kind',
      { 'apps/web': 'web-app', infra: 'iac' },
      [
        ['apps/web', 'web-app'],
        ['infra', 'iac'],
      ],
    ],
    [
      'env.notUsed',
      [{ key: 'backend/.env.old', why: 'nothing loads it: backend/package.json:11' }],
      [['backend/.env.old', 'nothing loads it: backend/package.json:11']],
    ],
  ];

  test.each(ROWS)('%s: its value as rows, and back, read by its schema', (key, value, rows) => {
    const def = recordsOf(key);

    expect(def?.rows(value)).toEqual(rows);
    expect(def?.value(rows)).toEqual(value);
    expect(SETTINGS[key].schema.safeParse(def?.value(rows)).success).toBe(true);
    expect(def?.lack(rows)).toBeUndefined();
  });

  test.each<[SettingKey, string[][], string]>([
    ['views', [['factory', '', 'hide', '']], 'Row 1: Part is empty'],
    [
      'views',
      [['factory', 'col:A', 'label', '']],
      'Row 1: label takes a value (order a place, label words, group top or bottom)',
    ],
    ['environments', [['dev', '', '', '', '', '']], 'Row 1: AWS account is empty'],
    ['env.notUsed', [['STRIPE_KEY', '']], 'Row 1: How you know is empty'],
  ])('%s %j lacks: %s', (key, rows, words) => {
    expect(recordsOf(key)?.lack(rows)).toBe(words);
  });

  test('a key with no records editor has none', () => {
    expect(recordsOf('checks')).toBeUndefined();
  });
});
