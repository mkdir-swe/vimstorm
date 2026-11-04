import { describe, expect, test } from 'bun:test';
import { FACTORY_RUN_INSTRUCTIONS, PLAIN_SESSION_INSTRUCTIONS } from '../skills/instructions';
import {
  CRASHED,
  crashed,
  REOPENED_PROMPT,
  reopenedInstructions,
  reopenedPrompt,
  reopenedSince,
  RUN_OVER_INSTRUCTIONS,
  runOver,
  runOverText,
} from './reopen';
import { claudeArgv } from './session';

const NOT_OVER = { outcome: null, cleared: null };
const DONE = { outcome: 'done' as const, cleared: null };
const CLEARED = {
  outcome: null,
  cleared: { at: '2026-10-24T00:00:00.000Z', worktree: 'removed' as const, why: null },
};

describe('Reopen (#343): what a reopened session is told', () => {
  test.each([
    ['no run (a plain session)', undefined, false],
    ['a run not over', NOT_OVER, false],
    ['a run done', DONE, true],
    ['a run cleared', CLEARED, true],
  ] as const)('%s: over %p', (_, run, over) => {
    expect(run === undefined ? false : runOver(run)).toBe(over);
  });

  test('instructions: a plain one stays plain, a run not over a run, a run over a conversation', () => {
    expect(reopenedInstructions(undefined)).toBe(PLAIN_SESSION_INSTRUCTIONS);
    expect(reopenedInstructions(NOT_OVER)).toBe(FACTORY_RUN_INSTRUCTIONS);
    expect(reopenedInstructions(DONE)).toEndWith(RUN_OVER_INSTRUCTIONS);
    expect(reopenedInstructions(CLEARED)).toEndWith(RUN_OVER_INSTRUCTIONS);
  });

  test.each([
    ['your message, always', 'why this helper?', NOT_OVER, 'why this helper?'],
    ['a run not over, nothing typed: go on', undefined, NOT_OVER, REOPENED_PROMPT],
    ['blank is nothing typed', '  ', NOT_OVER, REOPENED_PROMPT],
    ['a plain one waits for you', undefined, undefined, ''],
    ['a run over waits for you', undefined, DONE, ''],
  ] as const)('first prompt: %s', (_, message, run, prompt) => {
    expect(reopenedPrompt(message, run)).toBe(prompt);
  });

  test('crashed only for an ended session with the crashed reason', () => {
    expect(crashed({ state: 'ended', reason: CRASHED })).toBe(true);
    expect(crashed({ state: 'ended', reason: null })).toBe(false);
    expect(crashed({ state: 'working', reason: CRASHED })).toBe(false);
  });

  test('run over: abe factory says so, with its outcome or cleared', () => {
    expect(runOverText(4, 'done')).toStartWith("AB#4's run is over (done): ");
    expect(runOverText(4, null)).toStartWith("AB#4's run is over (cleared): ");
  });

  test('reopened since a Done run became Done: only a reopen at or after it counts', () => {
    const since = '2026-10-24T10:00:00.000Z';

    expect(reopenedSince([], since)).toBe(false);
    expect(reopenedSince(['2026-10-24T09:00:00.000Z'], since)).toBe(false);
    expect(reopenedSince(['2026-10-24T09:00:00.000Z', since], since)).toBe(true);
  });
});

describe('claudeArgv: a reopen (#343)', () => {
  const argv = (prompt: string) =>
    claudeArgv({
      claude: 'claude',
      settings: 's.json',
      pluginDir: 'plugin',
      skillsOnTop: false,
      mcpMode: 'yours',
      claudeSession: 'c0ffee',
      resume: true,
      instructions: 'core',
      prompt,
    });

  test('resumes its conversation, never a new session id', () => {
    const a = argv('');

    expect(a[a.indexOf('--resume') + 1]).toBe('c0ffee');
    expect(a).not.toContain('--session-id');
  });

  test('no prompt: the instructions are last, so claude waits at its prompt; a message is the first prompt', () => {
    expect(argv('').slice(-2)).toEqual(['--append-system-prompt', 'core']);
    expect(argv('why?').slice(-3)).toEqual(['--append-system-prompt', 'core', 'why?']);
  });
});
