import { describe, expect, test } from 'bun:test';
import {
  type CheckState,
  type DeployState,
  type PrData,
  type TrackingErrorCode,
  checkRunState,
  checksState,
  deployState,
  ghErrorCode,
  parseRef,
  parseRepo,
  statusContextState,
} from './tracking';

describe('parseRef reads <owner/repo>#<n>', () => {
  test.each([
    ['mkdir-swe/vimstorm#37', { repo: 'mkdir-swe/vimstorm', number: 37 }],
    ['mkdir-swe/demo-shop#1', { repo: 'mkdir-swe/demo-shop', number: 1 }],
    ['a-b/c_d.e#9', { repo: 'a-b/c_d.e', number: 9 }],
  ])('%s', (text, ref) => {
    const got: unknown = parseRef(text);

    expect(got).toEqual(ref);
  });

  test.each(['mkdir-swe/vimstorm', '#37', 'vimstorm#37', 'a/b#0', 'a/b#x', 'a/b/c#1', 'a/b#1 '])(
    '%s is no ref',
    (text) => {
      expect(parseRef(text)).toBeUndefined();
    },
  );

  test.each([
    ['mkdir-swe/vimstorm', true],
    ['ada', false],
    ['a/b/c', false],
    ['../x', false],
    ['a/..', false],
    ['a/.', false],
    ['a/.github', true],
  ])('parseRepo %s', (text, ok) => {
    expect(parseRepo(text) !== undefined).toBe(ok);
  });
});

describe("ghErrorCode reads gh's stderr", () => {
  test.each<[string, TrackingErrorCode]>([
    ['gh: Not Found (HTTP 404)', 'not-found'],
    ["GraphQL: Could not resolve to a Repository with the name 'a/b'. (repository)", 'not-found'],
    ['gh: Bad credentials (HTTP 401)', 'auth'],
    ['To get started with GitHub CLI, please run:  gh auth login', 'auth'],
    ['gh: API rate limit exceeded for user ID 1. (HTTP 403)', 'rate-limited'],
    ['gh: You have exceeded a secondary rate limit. (HTTP 403)', 'rate-limited'],
    ['gh: Too Many Requests (HTTP 429)', 'rate-limited'],
    ['gh: Resource not accessible by integration (HTTP 403)', 'gh-failed'],
    ['gh: Pull Request is not mergeable (HTTP 405)', 'gh-failed'],
    ['', 'gh-failed'],
  ])('%s → %s', (stderr, code) => {
    expect(ghErrorCode(stderr)).toBe(code);
  });
});

describe('deployState: the newest status of the newest deployment', () => {
  const at = (minute: number) => `2026-10-23T10:${String(minute).padStart(2, '0')}:00Z`;

  test.each<
    [string, { state: string; createdAt: string; id: number }[], Exclude<DeployState, 'none'>]
  >([
    ['no status yet is pending', [], 'pending'],
    ['success', [{ state: 'success', createdAt: at(2), id: 2 }], 'success'],
    ['queued', [{ state: 'queued', createdAt: at(2), id: 2 }], 'pending'],
    ['in progress', [{ state: 'in_progress', createdAt: at(2), id: 2 }], 'pending'],
    ['pending', [{ state: 'pending', createdAt: at(2), id: 2 }], 'pending'],
    ['failure', [{ state: 'failure', createdAt: at(2), id: 2 }], 'failure'],
    ['error', [{ state: 'error', createdAt: at(2), id: 2 }], 'failure'],
    [
      'the newest wins, in any order',
      [
        { state: 'success', createdAt: at(5), id: 5 },
        { state: 'in_progress', createdAt: at(3), id: 3 },
      ],
      'success',
    ],
    [
      'inactive (a later deploy replaced it) keeps what it reached',
      [
        { state: 'inactive', createdAt: at(9), id: 9 },
        { state: 'success', createdAt: at(5), id: 5 },
        { state: 'in_progress', createdAt: at(3), id: 3 },
      ],
      'success',
    ],
  ])('%s', (_, statuses, state) => {
    expect(deployState(statuses)).toBe(state);
  });
});

describe('checksState: failure over pending over success', () => {
  test.each<[CheckState[], PrData['checks']['state']]>([
    [[], 'none'],
    [['success', 'skipped'], 'success'],
    [['success', 'pending'], 'pending'],
    [['pending', 'failure', 'success'], 'failure'],
    [['skipped'], 'success'],
  ])('%j → %s', (states, state) => {
    expect(checksState(states.map((s) => ({ name: 'c', state: s, url: null })))).toBe(state);
  });
});

describe("a check's state from GitHub's names", () => {
  test.each<[string, string | null, CheckState]>([
    ['QUEUED', null, 'pending'],
    ['IN_PROGRESS', null, 'pending'],
    ['COMPLETED', 'SUCCESS', 'success'],
    ['COMPLETED', 'FAILURE', 'failure'],
    ['COMPLETED', 'TIMED_OUT', 'failure'],
    ['COMPLETED', 'CANCELLED', 'failure'],
    ['COMPLETED', 'ACTION_REQUIRED', 'failure'],
    ['COMPLETED', 'NEUTRAL', 'skipped'],
    ['COMPLETED', 'SKIPPED', 'skipped'],
  ])('check run %s %s → %s', (status, conclusion, state) => {
    expect(checkRunState(status, conclusion)).toBe(state);
  });

  test.each<[string, CheckState]>([
    ['SUCCESS', 'success'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
    ['FAILURE', 'failure'],
    ['ERROR', 'failure'],
  ])('status %s → %s', (state, ours) => {
    expect(statusContextState(state)).toBe(ours);
  });
});
