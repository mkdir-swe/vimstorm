/** Proposals for the repo (#108 S3, ADR 0030): what is offered, branches, words and rows' pull requests. */
import { describe, expect, test } from 'bun:test';
import { mergeSettings } from './layers';
import { listSettings, prsText } from './list';
import { PROPOSAL_PATH, PROPOSAL_PREFIX, proposalBranch } from './places';
import {
  entryValueOf,
  proposalBody,
  proposalName,
  proposalTitle,
  proposedValue,
  proposeOffer,
  readProposalKey,
  withProposals,
  YOURS_ALONE,
} from './propose';

describe('where a proposal lands', () => {
  test("the repo's abe.yaml, one branch per thing proposed", () => {
    expect(PROPOSAL_PATH).toBe('abe.yaml');
    expect(proposalBranch('autoMerge')).toBe('settings/repo/autoMerge');
    expect(PROPOSAL_PREFIX).toBe('settings/repo/');
    expect(proposalName('board', 'done')).toBe('board.done');
    expect(readProposalKey('board#done')).toEqual({ key: 'board', field: 'done' });
    expect(readProposalKey('nope')).toBeUndefined();
  });
});

describe('what is offered', () => {
  test('a factory setting, in a checkout', () => {
    expect(proposeOffer({ key: 'autoMerge', repo: 'r' })).toEqual({ ok: true });
    expect(proposeOffer({ key: 'checks', repo: null })).toMatchObject({
      ok: false,
      code: 'no-target',
    });
  });

  test.each(['logins.gh', 'agents.prod', 'credentials', 'ui.theme', 'localMode'] as const)(
    '%s is yours alone: never proposed',
    (key) => {
      expect(proposeOffer({ key, repo: 'r' })).toEqual({
        ok: false,
        code: 'personal-only',
        message: YOURS_ALONE,
      });
    },
  );
});

describe('the value a proposal writes', () => {
  test("a field row changes that field of the file's entry, its other fields kept", () => {
    const doc = { board: { project: 'Shop', done: 'Resolved' } };

    expect(entryValueOf(doc, 'board')).toEqual({ project: 'Shop', done: 'Resolved' });
    expect(
      proposedValue({ key: 'board', field: 'done', doc, parsed: 'Closed', typed: 'Closed' }),
    ).toEqual({ ok: true, value: { project: 'Shop', done: 'Closed' } });
  });

  test("a whole object setting keeps the file's other fields; a replaced list does not merge", () => {
    const doc = { board: { project: 'Shop', done: 'Resolved' }, checks: ['tests'] };

    expect(
      proposedValue({ key: 'board', field: null, doc, parsed: { done: 'Closed' }, typed: '' }),
    ).toEqual({ ok: true, value: { project: 'Shop', done: 'Closed' } });
    expect(proposedValue({ key: 'checks', field: null, doc, parsed: ['lint'], typed: '' })).toEqual(
      { ok: true, value: ['lint'] },
    );
  });

  test("an Override's value is the entry; dotted and nested keys both read", () => {
    expect(
      entryValueOf({ overrides: { autoMerge: { value: true, reason: 'x' } } }, 'autoMerge'),
    ).toBe(true);
    expect(entryValueOf({ limits: { maxBoxesPerPerson: 2 } }, 'limits.maxBoxesPerPerson')).toBe(2);
    expect(entryValueOf({ 'box.idleMinutes': 30 }, 'box.idleMinutes')).toBe(30);
  });

  test('YAML first, else the text; a value that fits neither is refused', () => {
    expect(
      proposedValue({ key: 'autoMerge', field: null, doc: {}, parsed: true, typed: 'true' }),
    ).toEqual({ ok: true, value: true });
    expect(
      proposedValue({ key: 'autoMerge', field: null, doc: {}, parsed: 'maybe', typed: 'maybe' }).ok,
    ).toBe(false);
  });
});

describe('the pull request', () => {
  test('the reason is the body’s first line; the title names the target', () => {
    const body = proposalBody({
      reason: 'We close on test since Sprint 1',
      name: 'board.done',
      label: 'Done column',
      from: 'Resolved',
      value: 'Closed',
      where: 'repo acme/shop',
      path: 'abe.yaml',
    });

    expect(body.split('\n')[0]).toBe('We close on test since Sprint 1');
    expect(body).toContain(
      'Done column (`board.done`): Resolved → Closed, proposed for repo acme/shop.',
    );
    expect(proposalTitle({ where: 'repo acme/shop', label: 'Done column', value: 'Closed' })).toBe(
      'Repo acme/shop: Done column → Closed',
    );
  });
});

describe('rows with their open pull requests', () => {
  const row = (data: ReturnType<typeof listSettings>, id: string) =>
    data.rows.find((r) => r.id === id);

  test("found by the proposal's branch", () => {
    const data = withProposals(listSettings(mergeSettings([])), [
      { branch: 'settings/repo/autoMerge', number: 2, url: 'https://y/pull/2' },
      { branch: 'settings/repo/board.done', number: 5, url: 'https://y/pull/5' },
    ]);

    expect(row(data, 'autoMerge')?.prs).toEqual([{ number: 2, url: 'https://y/pull/2' }]);
    expect(row(data, 'checks')?.prs).toEqual([]);
    expect(prsText(row(data, 'board#done')?.prs ?? [])).toBe('PR #5 open');
  });
});
