import { describe, expect, test } from 'bun:test';
import { hubNameApart } from './hub';

describe('hubNameApart: conversations named by the same first words told apart (N4)', () => {
  test('the first keeps the words; a second is `<name> 2`, a third `<name> 3`', () => {
    expect(hubNameApart('Please run exactly thi…', ['Abe 1'])).toBe('Please run exactly thi…');
    expect(hubNameApart('Please run exactly thi…', ['Please run exactly thi…'])).toBe(
      'Please run exactly thi… 2',
    );
    expect(hubNameApart('Install', ['Install', 'Install 2'])).toBe('Install 3');
  });
});
