/** How an error goes away (#348): it fades, it stays only when it needs you, its cause gone it goes. */
import { describe, expect, test } from 'bun:test';
import {
  ERROR_FADE_MS,
  errorFadeMs,
  errorSaid,
  INPUT_GRACE_MS,
  lineFaded,
  lineGoesOnInput,
  MAX_FADE_MS,
  needsYou,
  runKey,
  STATUS_FADE_MS,
} from './errors';

const at = (ms: number) => new Date(Date.parse('2026-10-25T11:00:00.000Z') + ms).toISOString();

describe('an error fades (#348)', () => {
  test('after 8 s and the time to read it, 30 s at most', () => {
    expect(errorFadeMs('Boom')).toBe(ERROR_FADE_MS + 250);
    expect(errorFadeMs('the card did not move (move-failed)')).toBe(ERROR_FADE_MS + 6 * 250);
    expect(errorFadeMs('word '.repeat(500))).toBe(MAX_FADE_MS);
  });

  test('a refusal that needs nothing of you fades, keyed by its run, said where', () => {
    const said = errorSaid(
      'nope is not a setting (unknown-setting)',
      { key: runKey(['settings', 'get', 'nope']), where: 'Command mode' },
      at(0),
    );

    expect(said.balloon).toEqual({
      kind: 'balloon',
      tone: 'error',
      text: 'nope is not a setting (unknown-setting)',
      key: runKey(['settings', 'get', 'nope']),
      where: 'Command mode',
    });
    expect(said.action).toBeUndefined();
    expect(lineFaded(said.line, at(errorFadeMs(said.line.text) - 1))).toBe(false);
    expect(lineFaded(said.line, at(errorFadeMs(said.line.text)))).toBe(true);
  });

  test('with no run, the same words are the same error; its lines become one status line', () => {
    const said = errorSaid('Sheet: it could not load\n  its origin is gone', {}, at(0));

    expect(said.key).toBe('said:Sheet: it could not load\n  its origin is gone');
    expect(said.line.text).toBe('Sheet: it could not load · its origin is gone');
  });

  test('its status line goes at the next key or click, once up a second', () => {
    const said = errorSaid('Boom (failed)', {}, at(0));

    expect(lineGoesOnInput(said.line, at(INPUT_GRACE_MS - 1))).toBe(false);
    expect(lineGoesOnInput(said.line, at(INPUT_GRACE_MS))).toBe(true);
    // a command's answer is no error: it stays its 30 s whatever is pressed
    expect(lineGoesOnInput({ text: 'Moved #3', at: at(0) }, at(5_000))).toBe(false);
  });
});

describe('only what needs you stays (#348)', () => {
  test.each<[string, string | undefined, string | null]>([
    [
      'no Azure DevOps token from az (az exited 1): run `az login --allow-no-subscriptions` and retry (auth)',
      undefined,
      'Log in…',
    ],
    ['your GitHub login, for the log store: gh is not logged in (no-login)', undefined, 'Log in…'],
    ['demo-shop-3 does not answer (box-unreachable)', undefined, 'Retry'],
    // the Boxes tab says a refusal in its own words, no code: the refused run's code counts
    ['the team has 4 boxes up', 'box-limit', 'Boxes…'],
    ['AWS refused it: only your own boxes are yours', 'aws-refused', null],
  ])('%s: stays, its action %s', (text, code, label) => {
    const said = errorSaid(text, { key: 'run:x', code }, at(0));

    expect(said.balloon.stays).toBe(true);
    expect(said.balloon.action).toBe(label ?? undefined);
  });

  test('a code in the middle of the words, or no code of the table, is no need', () => {
    expect(needsYou('the (auth) step failed')).toBeUndefined();
    expect(needsYou('Boom (move-failed)')).toBeUndefined();
    expect(needsYou('Boom (constructor)')).toBeUndefined();
    expect(needsYou('Boom', 'toString')).toBeUndefined();
  });
});

describe('a status line fades (#204)', () => {
  test('after its time; not before', () => {
    const line = { text: "Stopped #30's session", at: at(0) };

    expect(lineFaded(line, at(STATUS_FADE_MS - 1))).toBe(false);
    expect(lineFaded(line, at(STATUS_FADE_MS))).toBe(true);
  });

  test('one under way stays; an empty one has nothing to fade', () => {
    expect(
      lineFaded({ text: 'Make card: writing 30 and its spec issue…', at: at(0) }, at(3_600_000)),
    ).toBe(false);
    expect(lineFaded({ text: '', at: at(0) }, at(3_600_000))).toBe(false);
  });
});
