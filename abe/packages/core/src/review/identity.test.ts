import { describe, expect, test } from 'bun:test';
import { identityRefusal } from './identity';

const as = (login: string) => ({ ok: true as const, data: login });

describe('githubIdentity', () => {
  test.each([
    ['unset: any login goes', null, as('eve'), undefined],
    ['the same login goes', 'ada', as('ada'), undefined],
    ['the same login in another case goes', 'Ada', as('ada'), undefined],
    [
      'another login is refused naming both',
      'ada',
      as('eve'),
      '✗ GitHub writes go as ada (githubIdentity), but gh is signed in as eve: gh auth switch --user ada',
    ],
    [
      'no login is refused',
      'ada',
      as(''),
      '✗ GitHub writes go as ada (githubIdentity), but gh is signed in as nobody: gh auth switch --user ada',
    ],
  ])('%s', (_, expected, login, why) => {
    expect(identityRefusal(expected, login)?.why).toBe(why);
  });

  test("gh's login unread is refused in red, saying why", () => {
    expect(identityRefusal('ada', { ok: false, error: { message: 'gh auth login' } })).toEqual({
      tone: 'error',
      why: "✗ GitHub writes go as ada (githubIdentity), but gh's login could not be read: gh auth login",
    });
  });
});
