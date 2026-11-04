import { describe, expect, test } from 'bun:test';
import { hereOf, isHere, type RepoHere } from './here';

const HERE: RepoHere = {
  root: '/p/demo-shop/',
  checkouts: ['/private/p/demo-shop', '/wt/demo-shop/101-x'],
  github: 'mkdir-swe/demo-shop',
};

describe('isHere (#256): a session, run or box is the shown repo’s by its repo, never its card', () => {
  test.each<[string, RepoHere | undefined, string | null, boolean]>([
    ['a cloud one of the repo', HERE, 'mkdir-swe/demo-shop', true],
    ['a cloud one, the owner in another case', HERE, 'MKDIR-SWE/Demo-Shop', true],
    ['another repo of the same owner', HERE, 'mkdir-swe/qa2-e-85a7', false],
    ['a local one launched in the folder (trailing slash)', HERE, '/p/demo-shop', true],
    ['a local one launched in a worktree of it', HERE, '/wt/demo-shop/101-x', true],
    ['a local one of another checkout', HERE, '/p/other-shop', false],
    ['a box with no abe:repo tag', HERE, null, false],
    ['not known yet: every one', undefined, 'mkdir-swe/qa2-e-85a7', true],
    ['no GitHub origin: folders only', { ...HERE, github: null }, 'mkdir-swe/demo-shop', false],
  ])('%s', (_, here, repo, is) => {
    expect(isHere(here, repo)).toBe(is);
  });

  test('an answer naming no repo takes back what an earlier one said', () => {
    expect(hereOf({ here: HERE })).toEqual({ here: HERE });
    expect(hereOf({})).toEqual({ here: undefined });
  });
});
