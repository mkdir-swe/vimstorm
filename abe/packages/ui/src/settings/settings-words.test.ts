import { describe, expect, test } from 'bun:test';
import * as core from '@abe/core';
import type { ListedRow, PersonalOverride, SettingsProblem } from '@abe/core';
import {
  isInfoRow,
  overridePill,
  overrideWords,
  problemsOnly,
  prsText,
  tokenHelp,
} from './settings-words';

const problem = (kind: SettingsProblem['kind']): SettingsProblem => ({
  kind,
  code: 'no-checks',
  text: kind,
  where: 'here',
  page: 'layers',
  way: { kind: 'open', page: 'layers', row: null },
});

const problems: SettingsProblem[] = core.PROBLEM_KINDS.map(problem);

const prs: [ListedRow['prs']][] = [
  [[]],
  [[{ number: 1, url: 'u1' }]],
  [
    [
      { number: 1, url: 'u1' },
      { number: 2, url: 'u2' },
    ],
  ],
];

const override = (key: PersonalOverride['key'], since: string | null): PersonalOverride => ({
  key,
  value: true,
  shown: 'on',
  reason: 'my sandbox',
  since,
});

const overrides: [PersonalOverride[]][] = [
  [[]],
  [[override('autoMerge', '2026-10-24T10:00:00.000Z')]],
  [[override('autoMerge', null), override('setup', null), override('factory.done', null)]],
];

describe("ui's settings words match core's (#37 keeps ui to core's types)", () => {
  test.each(problems)('info row of $kind', (p) => {
    expect(isInfoRow(p)).toBe(core.isInfoRow(p));
  });

  test('problems only', () => {
    expect(problemsOnly(problems)).toEqual(core.problemsOnly(problems));
  });

  test.each(prs)('open proposals %#', (p) => {
    expect(prsText(p)).toBe(core.prsText(p));
  });

  test.each(overrides)('override pill and words %#', (os) => {
    expect(overridePill(os)).toBe(core.overridePill(os));
    expect(os.map(overrideWords)).toEqual(os.map(core.overrideWords));
  });
});

const TOKENS = ((): core.ThemeToken[] => {
  const dark = core.themeCatalogue([]).find((t) => t.slug === 'islands-dark');

  if (dark === undefined) throw new Error('no Islands Dark');

  return core.themeGroups(dark).flatMap((g) => g.tokens);
})();

describe('tokenHelp: a Colours token in words (#300)', () => {
  test('every token keeps words, none of its source references', () => {
    for (const t of TOKENS) {
      const help = tokenHelp(t.usage);

      expect({ name: t.name, help }).not.toMatchObject({ help: '' });
      expect(help).not.toMatch(/\.\.|\.rs\b|\.lua\b|[A-Z]+_[A-Z]|WsIcon|^[A-Z]{3,}\.|:\d/);
    }
  });

  test('the help a person reads', () => {
    const help = (name: string) => tokenHelp(TOKENS.find((t) => t.name === name)?.usage ?? '');

    expect(help('border')).toBe(
      'Generic 1px component border, splitters, tab strip underline, tool window header line.',
    );
    expect(help('term-black')).toBe(
      'ANSI 0. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
    );
    expect(help('abe-needs-you')).toBe(
      'Needs you only: workspace dots, the overflow count, status words and badges. Never red, never shared with Running.',
    );
  });
});
