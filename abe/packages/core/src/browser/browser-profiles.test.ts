import { describe, expect, test } from 'bun:test';
import {
  addProfiles,
  BrowserProfile,
  type ChromeFolder,
  migrationPlan,
  profileList,
  ProfileName,
  sourcedProfiles,
} from './browser-profiles';
import { mergeSettings } from '../layer/settings/layers';

const dir = (name: string): ChromeFolder => ({ name, link: false });
const link = (name: string): ChromeFolder => ({ name, link: true });
const none = { profiles: [], default: null };

describe('a profile name', () => {
  test.each([
    ['work', true],
    ['work-admin', true],
    ['po-review2', true],
    ['Work', false],
    ['work_admin', false],
    ['-work', false],
    ['work-', false],
    ['', false],
    ['default', false],
  ])('%p is %p', (name, ok) => {
    expect(ProfileName.safeParse(name).success).toBe(ok);
  });

  test('a purpose is one non-empty line', () => {
    expect(BrowserProfile.safeParse({ name: 'work', purpose: '  ' }).success).toBe(false);
  });
});

describe('merging browser.profiles', () => {
  test('a lower Layer adds; a name given above keeps the upper purpose', () => {
    expect(
      addProfiles(
        [{ name: 'work', purpose: 'app user' }],
        [
          { name: 'work', purpose: 'mine' },
          { name: 'po-review', purpose: "product owner's login" },
        ],
      ),
    ).toEqual([
      { name: 'work', purpose: 'app user' },
      { name: 'po-review', purpose: "product owner's login" },
    ]);
  });

  test("the repo's first, then yours, each with its Layer", () => {
    const merged = mergeSettings([
      {
        place: 'repo',
        file: 'r.yaml',
        doc: { browser: { profiles: [{ name: 'work', purpose: 'app user' }] } },
      },
      {
        place: 'machine',
        file: 'm.yaml',
        doc: {
          browser: {
            profiles: [
              { name: 'work', purpose: 'dropped' },
              { name: 'po-review', purpose: 'po' },
            ],
          },
        },
      },
    ]);

    expect(merged.problems).toEqual([]);
    expect(sourcedProfiles(merged.explain('browser.profiles').layers)).toEqual([
      { name: 'work', purpose: 'app user', layer: 'repo' },
      { name: 'po-review', purpose: 'po', layer: 'individual' },
    ]);
  });

  test('a Layer naming the built-in default is refused', () => {
    const merged = mergeSettings([
      {
        place: 'machine',
        file: 'm.yaml',
        doc: { browser: { profiles: [{ name: 'default', purpose: 'x' }] } },
      },
    ]);

    expect(merged.problems.map((p) => p.code)).toEqual(['invalid-setting']);
  });
});

describe("1.0's two Chromes", () => {
  test('a folder and its -admin twin become work and work-admin, with links and your Layer', () => {
    expect(migrationPlan([dir('acme'), dir('acme-admin')], none)).toEqual({
      renames: [
        { from: 'acme', to: 'work' },
        { from: 'acme-admin', to: 'work-admin' },
      ],
      links: [
        { from: 'acme', to: 'work' },
        { from: 'acme-admin', to: 'work-admin' },
      ],
      profiles: [
        { name: 'work', purpose: 'app user' },
        { name: 'work-admin', purpose: 'admin' },
      ],
      default: 'work',
    });
  });

  test.each<[string, ChromeFolder[]]>([
    ['after the migration', [dir('work'), dir('work-admin'), link('acme'), link('acme-admin')]],
    ['work already there', [dir('work'), dir('acme'), dir('acme-admin')]],
    ['no twin', [dir('acme'), dir('other')]],
    ['one folder', [dir('acme')]],
    ['a third folder', [dir('acme'), dir('acme-admin'), dir('po')]],
    ['nothing', []],
  ])('%s: nothing renamed', (_, folders) => {
    expect(migrationPlan(folders, none).renames).toEqual([]);
  });

  test('your Layer keeps what it names already', () => {
    const plan = migrationPlan([dir('acme'), dir('acme-admin')], {
      profiles: [{ name: 'work', purpose: 'mine' }],
      default: 'work',
    });

    expect(plan.profiles).toEqual([{ name: 'work-admin', purpose: 'admin' }]);
    expect(plan.default).toBeNull();
  });
});

describe('the list', () => {
  test('nothing set anywhere: only the built-in default', () => {
    expect(
      profileList({ profiles: [], default: null, folders: null, stored: () => null, migrated: [] }),
    ).toEqual({
      profiles: [
        {
          name: 'default',
          purpose: 'empty · a fresh profile every start',
          layer: 'built-in',
          default: true,
          storedAt: null,
          folder: null,
          open: null,
          storedAgo: null,
          storeFailed: null,
        },
      ],
      unlisted: [],
      migrated: [],
      missingDefault: null,
    });
  });

  test('a default no Layer has is said, and the built-in is in force', () => {
    const list = profileList({
      profiles: [{ name: 'work', purpose: 'app user', layer: 'repo' }],
      default: 'po-review',
      folders: [dir('work'), dir('old'), link('acme')],
      stored: () => null,
      migrated: [],
    });

    expect(list.missingDefault).toBe('po-review');
    expect(list.profiles.map((p) => [p.name, p.default, p.folder])).toEqual([
      ['work', false, true],
      ['default', true, null],
    ]);
    expect(list.unlisted).toEqual(['old']);
  });
});
