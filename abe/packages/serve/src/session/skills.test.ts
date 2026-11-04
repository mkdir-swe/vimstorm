/**
 * `session skills`: what each kind of session lists, from real `SKILL.md` files in a disposable
 * repo and `HOME`: Abe's plugin skills as `/abe:<name>` (the repo's `abe/skills` copies in place
 * of core's, `abe` only in the Abe chat), the repo's `.claude/skills` as `/<name>`, yours only
 * with `skillsOnTop`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillsOfSession } from './skills';

const root = mkdtempSync(join(tmpdir(), 'abe-slash-skills-'));
const repo = join(root, 'demo-shop');
const worktree = join(root, 'demo-shop-wt', 'card-2-cart');
const home = join(root, 'home');

const skill = (dir: string, name: string, front: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\n${front}\n---\n\nBody.\n`);
};

// installed: Abe's copied into abe/skills, one changed, one the team added, `abe` never replaced;
// the copies it lacks (implement) are off, never core's again
skill(
  join(repo, 'abe', 'skills'),
  'triage',
  'name: triage\ndescription: Sorts the inbox,\n  the team way.',
);
skill(join(repo, 'abe', 'skills'), 'team-only', 'name: team-only\ndescription: Ours.');
skill(join(repo, 'abe', 'skills'), 'abe', 'name: abe\ndescription: Not loaded.');
// the worktree's own Claude Code skills
skill(
  join(worktree, '.claude', 'skills'),
  'seed-db',
  'name: seed-db\ndescription: Seeds the demo DB.',
);
skill(join(worktree, '.claude', 'skills'), 'tdd', 'name: tdd\ndescription: The repo’s tdd.');
skill(
  join(worktree, '.claude', 'skills'),
  'helper',
  'name: helper\ndescription: x\nuser-invocable: false',
);
// yours: one of the repo's name wins
skill(join(home, '.claude', 'skills'), 'tdd', 'name: tdd\ndescription: My tdd.');
skill(join(home, '.claude', 'skills'), 'standup', 'description: My standup notes.');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const CARD = { abe: null, repo, worktree, skillsOnTop: false };
const HUB = { abe: { repo }, repo, worktree: repo, skillsOnTop: false };

describe('skillsOfSession', () => {
  test.each([
    [
      'a card session',
      CARD,
      {
        has: ['/abe:factory', '/abe:triage', '/abe:team-only', '/seed-db', '/tdd'],
        not: ['/abe:abe', '/abe:install', '/abe:implement', '/helper', '/standup'],
      },
    ],
    [
      'the Abe chat',
      HUB,
      {
        has: ['/abe:abe', '/abe:install', '/abe:triage', '/abe:factory'],
        not: ['/seed-db', '/standup'],
      },
    ],
    [
      'with skillsOnTop',
      { ...CARD, skillsOnTop: true },
      { has: ['/standup', '/tdd', '/seed-db'], not: ['/helper'] },
    ],
  ])('%s', (_, meta, want) => {
    const names = skillsOfSession(meta, home).map((s) => s.name);

    for (const n of want.has) expect(names).toContain(n);
    for (const n of want.not) expect(names).not.toContain(n);
    expect(new Set(names).size).toBe(names.length);
  });

  test('whose each is, in order, a description on one line, the repo’s copy in force', () => {
    const card = skillsOfSession(CARD, home);
    const mine = skillsOfSession({ ...CARD, skillsOnTop: true }, home);

    expect(card.find((s) => s.name === '/abe:triage')).toEqual({
      name: '/abe:triage',
      whose: 'abe',
      description: 'Sorts the inbox, the team way.',
    });
    expect(card.filter((s) => s.name === '/tdd').map((s) => s.whose)).toEqual(['repo']);
    expect(mine.filter((s) => s.name === '/tdd').map((s) => s.description)).toEqual(['My tdd.']);
    expect([...new Set(mine.map((s) => s.whose))]).toEqual(['abe', 'repo', 'yours']);
  });
});
