import { describe, expect, test } from 'bun:test';
import { MAX_NOTE, notesPrompt, noteText, standingNotes } from './launch-note';
import { factoryLaunchPrompt, launchPrompt } from '../session/session';
import { mergeSettings } from '../layer/settings';

const NOTE = {
  by: 'Ada Example',
  text: "use the existing price helper, don't add a dependency",
  at: '2026-10-25T10:00:00.000Z',
};
const CARD = {
  id: 102,
  title: 'Show VAT under the cart total',
  description: 'Why: …',
  acceptanceCriteria: '',
};

describe('the Launch note in the first prompt (#347)', () => {
  test('after the card, your note under your name, then the standing notes with whose each is', () => {
    expect(
      launchPrompt(CARD, {
        note: NOTE,
        standing: [{ text: 'write the test first', layer: 'individual' }],
      }),
    ).toBe(
      [
        'Work on card AB#102: Show VAT under the cart total',
        '',
        'Why: …',
        '',
        '## Notes from Ada Example',
        "use the existing price helper, don't add a dependency",
        '',
        '## Standing notes',
        '- write the test first (yours)',
      ].join('\n'),
    );
  });

  test('no note and no standing notes: the card alone, as before', () => {
    expect(launchPrompt(CARD)).toBe('Work on card AB#102: Show VAT under the cart total\n\nWhy: …');
    expect(notesPrompt(null, [])).toBe('');
  });

  test("a run's: the factory skill on the card, then the note", () => {
    const prompt = factoryLaunchPrompt(CARD, { note: NOTE });

    expect(prompt).toStartWith('/abe:factory Work on card AB#102');
    expect(prompt).toContain('## Notes from Ada Example');
  });
});

describe('--note / --note-file', () => {
  test.each([
    [{ note: '  write it small  ' }, 'write it small'],
    [{ file: 'from a file\n' }, 'from a file'],
    [{ note: '   ' }, null],
    [{}, null],
  ])('%p', (o, want) => {
    expect(noteText(o)).toEqual({ ok: true, data: want });
  });

  test('both, or too long, is refused', () => {
    expect(noteText({ note: 'a', file: 'b' })).toMatchObject({
      ok: false,
      error: { code: 'usage' },
    });
    expect(noteText({ note: 'x'.repeat(MAX_NOTE + 1) })).toMatchObject({
      ok: false,
      error: { code: 'note-too-long' },
    });
  });
});

describe('standing notes: launch.notes, each Layer adding, an Override dropping an upper one', () => {
  const merged = (repo: unknown, mine: unknown) =>
    mergeSettings([
      { place: 'repo', file: '/repo/abe.yaml', doc: repo },
      { place: 'local', file: '/repo/.abe/settings.local.yaml', doc: mine },
    ]);

  test('each with the Layer that wrote it', () => {
    expect(
      standingNotes(
        merged(
          { 'launch.notes': ['say which test you ran'] },
          { 'launch.notes': ['write the test first'] },
        ),
      ),
    ).toEqual([
      { text: 'say which test you ran', layer: 'repo' },
      { text: 'write the test first', layer: 'individual' },
    ]);
  });

  test("an Override in your Layer drops the repo's", () => {
    expect(
      standingNotes(
        merged(
          { 'launch.notes': ['say which test you ran'] },
          {
            overrides: {
              'launch.notes': { value: ['write the test first'], reason: 'not this repo' },
            },
          },
        ),
      ),
    ).toEqual([{ text: 'write the test first', layer: 'individual' }]);
  });

  test('none set: none', () => {
    expect(standingNotes(merged({}, {}))).toEqual([]);
  });
});
