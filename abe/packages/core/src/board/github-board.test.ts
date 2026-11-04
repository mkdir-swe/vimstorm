/** A GitHub board's issues as cards: states and columns, tags, types, long fields, the setting filled. */
import { describe, expect, test } from 'bun:test';
import {
  githubBoardFilled,
  githubCardState,
  githubCardTags,
  githubCardType,
  type GithubState,
  githubStateOf,
  githubStateWrite,
  issueBody,
  type IssueStateWrite,
  splitIssueBody,
} from './github-board';

describe("an issue's state as the Board's column", () => {
  test.each<[string, 'open' | 'closed', string | null, string[], GithubState]>([
    ['open, no column label', 'open', null, ['bug'], 'New'],
    ['open, active', 'open', null, ['Active', 'web'], 'Active'],
    ['open, resolved wins over active', 'open', null, ['active', 'resolved'], 'Resolved'],
    ['closed as completed', 'closed', 'completed', ['active'], 'Closed'],
    ['closed with no reason (older issues)', 'closed', null, [], 'Closed'],
    ['closed as not planned', 'closed', 'not_planned', [], 'Removed'],
    ['closed as a duplicate', 'closed', 'duplicate', [], 'Removed'],
  ])('%s', (_, state, stateReason, labels, column) => {
    expect(githubCardState({ state, stateReason, labels })).toBe(column);
  });

  test('tags are the labels less the column ones; bug makes a Bug', () => {
    expect(githubCardTags(['active', 'bug', 'Resolved', 'web'])).toEqual(['bug', 'web']);
    expect(githubCardType(['Bug'])).toBe('Bug');
    expect(githubCardType(['enhancement'])).toBe('Issue');
  });
});

describe('a move written as an issue: open or closed, its column label', () => {
  test.each<[string, string, 'open' | 'closed', string[], IssueStateWrite | undefined]>([
    [
      'New takes the column labels off',
      'New',
      'open',
      ['active', 'web'],
      {
        state: 'open',
        stateReason: null,
        labels: ['web'],
      },
    ],
    [
      'Active on, Resolved off',
      'active',
      'open',
      ['resolved', 'web'],
      {
        state: 'open',
        stateReason: null,
        labels: ['web', 'active'],
      },
    ],
    [
      'Resolved opens a closed one again',
      'Resolved',
      'closed',
      [],
      {
        state: 'open',
        stateReason: 'reopened',
        labels: ['resolved'],
      },
    ],
    [
      'Closed: completed, no column label left',
      'Closed',
      'open',
      ['active', 'bug'],
      {
        state: 'closed',
        stateReason: 'completed',
        labels: ['bug'],
      },
    ],
    [
      'Done reads as Closed',
      'Done',
      'open',
      [],
      {
        state: 'closed',
        stateReason: 'completed',
        labels: [],
      },
    ],
    [
      'Removed: not planned',
      'Removed',
      'open',
      [],
      {
        state: 'closed',
        stateReason: 'not_planned',
        labels: [],
      },
    ],
    ['a state GitHub has nothing like', 'In Review', 'open', [], undefined],
  ])('%s', (_, typed, state, labels, write) => {
    const to = githubStateOf(typed);

    expect(to === undefined ? undefined : githubStateWrite(to, { state, labels })).toEqual(write);
  });
});

describe("an issue's body as a card's description and acceptance criteria", () => {
  test.each([
    [
      'no criteria heading',
      'Just do it.\n',
      { description: 'Just do it.', acceptanceCriteria: '' },
    ],
    [
      'the heading splits it',
      '## Why\n\nSlow.\n\n## Acceptance criteria\n\n- [ ] Fast.\n',
      { description: '## Why\n\nSlow.', acceptanceCriteria: '- [ ] Fast.' },
    ],
    [
      'any level, a colon',
      '### acceptance criteria:\n- a',
      { description: '', acceptanceCriteria: '- a' },
    ],
    ['no body', null, { description: '', acceptanceCriteria: '' }],
  ])('%s', (_, body, fields) => {
    expect(splitIssueBody(body)).toEqual(fields);
  });

  test('written back as one body that splits the same', () => {
    const fields = { description: '## Why\n\nSlow.', acceptanceCriteria: '- [ ] Fast.' };

    expect(issueBody(fields)).toBe('## Why\n\nSlow.\n\n## Acceptance criteria\n\n- [ ] Fast.\n');
    expect(splitIssueBody(issueBody(fields))).toEqual(fields);
    expect(issueBody({ description: 'Only this.', acceptanceCriteria: '' })).toBe('Only this.');
  });
});

describe('the board setting filled for a GitHub board at a checkout', () => {
  const at = (origin: string | undefined, githubAccount: string | null = null) => ({
    origin: () => origin,
    githubAccount,
  });

  test.each([
    [
      'origin’s repo, ssh',
      { provider: 'github' },
      at('git@github.com:acme/shop.git'),
      {
        provider: 'github',
        repo: 'acme/shop',
      },
    ],
    [
      'origin’s repo, https, the gh login',
      { provider: 'gh' },
      at('https://github.com/acme/shop', 'ada'),
      {
        provider: 'gh',
        repo: 'acme/shop',
        githubAccount: 'ada',
      },
    ],
    [
      'a repo named wins over origin',
      { provider: 'github', repo: 'acme/web' },
      at('git@github.com:acme/shop.git'),
      {
        provider: 'github',
        repo: 'acme/web',
      },
    ],
    [
      'an origin not on GitHub: no repo',
      { provider: 'github' },
      at('https://dev.azure.com/acme/Shop/_git/shop'),
      {
        provider: 'github',
      },
    ],
    [
      'another board: as it is',
      { provider: 'azure', project: 'Shop' },
      at('git@github.com:acme/shop.git', 'ada'),
      {
        provider: 'azure',
        project: 'Shop',
      },
    ],
  ])('%s', (_, board, where, filled) => {
    expect(githubBoardFilled(board, where)).toEqual(filled);
  });

  test('origin is read only when the board is GitHub’s and names no repo', () => {
    let read = 0;
    const origin = () => {
      read += 1;

      return 'git@github.com:acme/shop.git';
    };

    githubBoardFilled({ provider: 'local' }, { origin, githubAccount: null });
    githubBoardFilled({ provider: 'github', repo: 'acme/web' }, { origin, githubAccount: null });
    expect(read).toBe(0);
  });
});
