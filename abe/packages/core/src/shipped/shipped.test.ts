import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  type AbeFolder,
  AbeInstalled,
  abeInForce,
  applyUpdates,
  copyInto,
  merge3,
  pluginFor,
  PROTOCOL_FILE,
  proposeUpdates,
  SHIPPED_FILES,
  type UpdateFile,
  updatesOf,
} from '.';

const roots: string[] = [];

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const git = (repo: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', repo, ...args], {
    env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: repo, GIT_CONFIG_NOSYSTEM: '1' },
  });

  return ran.stdout.toString();
};

const filesIn = (dir: string): string[] => {
  try {
    return readdirSync(dir).flatMap((n) =>
      statSync(join(dir, n)).isDirectory() ? filesIn(join(dir, n)) : [join(dir, n)],
    );
  } catch {
    return [];
  }
};

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** A temporary repo's `abe/` as the port: its files, and git's history of them. */
const folderAt = (repo: string): AbeFolder => {
  const top = join(repo, 'abe');

  return {
    read: (p) => {
      try {
        return readFileSync(join(top, p), 'utf8');
      } catch {
        return null;
      }
    },
    write: (p, text) => {
      mkdirSync(dirname(join(top, p)), { recursive: true });
      writeFileSync(join(top, p), text);
    },
    files: () =>
      ['skills', 'workflows'].flatMap((d) => filesIn(join(top, d)).map((f) => relative(top, f))),
    hash: sha,
    history: (p) =>
      Promise.resolve(
        git(repo, 'log', '--format=%H', '--', `abe/${p}`)
          .split('\n')
          .filter((c) => c !== '')
          .map((c) => git(repo, 'show', `${c}:abe/${p}`)),
      ),
  };
};

const abeText = (path: string) => SHIPPED_FILES.find((f) => f.path === path)?.text ?? '';

/** A repo with git, Abe's files copied in and committed. */
const installed = () => {
  const repo = mkdtempSync(join(tmpdir(), 'abe-shipped-'));

  roots.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  const folder = folderAt(repo);

  copyInto(folder, '3.3.1');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'install');

  return { repo, folder };
};

/** The repo's copy of `path` as an older Abe copied it (`old`), committed, its base `old`. */
const copiedOld = (r: { repo: string; folder: AbeFolder }, path: string, old: string) => {
  const record = AbeInstalled.parse(JSON.parse(r.folder.read('installed.json') ?? '{}'));

  r.folder.write(path, old);
  r.folder.write(
    'installed.json',
    JSON.stringify({ ...record, files: { ...record.files, [path]: sha(old) } }),
  );
  git(r.repo, 'add', '-A');
  git(r.repo, 'commit', '-qm', 'older Abe');
};

const remove = (r: { repo: string }, path: string) => {
  rmSync(join(r.repo, 'abe', path), { recursive: true });
};

const VERIFY = 'skills/verify/SKILL.md';
const verify = abeText(VERIFY);
const lines = verify.split('\n');
/** Abe's verify as an older Abe shipped it: one of its own CLI calls in the middle. */
const verifyWithProtocol = [
  ...lines.slice(0, 12),
  '```sh',
  'abe factory verify --phase after --result pass --report .scratch/<card>/verify-after.md --json',
  '```',
  ...lines.slice(12),
].join('\n');
const TEAM_EDIT = '\n## Our app\n\nSign in as the demo-shop test user first.\n';

const plugin = SHIPPED_FILES.filter((f) => f.plugin !== null);
const textIn = (files: readonly { path: string; text: string }[], path: string) =>
  files.find((f) => f.path === path)?.text ?? null;

type Repo = ReturnType<typeof installed>;

describe('shipped files: what a session and the loader see, and the three-way update', () => {
  test.each<[string, (r: Repo) => void, (r: Repo) => void]>([
    [
      'not installed: Abe’s own, all of them',
      (r) => {
        rmSync(join(r.repo, 'abe'), { recursive: true });
      },
      (r) => {
        expect(textIn(pluginFor(plugin, r.folder), VERIFY)).toBe(verify);
        expect(abeInForce(r.folder).map((f) => f.path)).toEqual(SHIPPED_FILES.map((f) => f.path));
      },
    ],
    [
      'an edited copy is the repo’s; Abe’s own files stay Abe’s',
      (r) => {
        r.folder.write(VERIFY, `${verify}${TEAM_EDIT}`);
      },
      (r) => {
        expect(textIn(pluginFor(plugin, r.folder), VERIFY)).toBe(`${verify}${TEAM_EDIT}`);
        expect(textIn(pluginFor(plugin, r.folder), 'skills/factory/SKILL.md')).toBe(
          abeText('skills/factory/SKILL.md'),
        );
        // the step's protocol beside the repo's copy: Abe's, as this Abe's CLI is
        expect(textIn(pluginFor(plugin, r.folder), 'skills/verify/PROTOCOL.md')).toBe(
          abeText('skills/verify/PROTOCOL.md'),
        );
        expect(abeInForce(r.folder).map((f) => f.path)).not.toContain(VERIFY);
      },
    ],
    [
      'a deleted copy is disabled for the session and the loader alike',
      (r) => {
        remove(r, 'skills/verify');
      },
      (r) => {
        expect(textIn(pluginFor(plugin, r.folder), VERIFY)).toBeNull();
        expect(abeInForce(r.folder).map((f) => f.path)).not.toContain(VERIFY);
        expect(updatesOf(r.folder)).toEqual([]);
      },
    ],
    [
      'a skill only the repo has is added; a folder of a skill Abe keeps is not read',
      (r) => {
        r.folder.write('skills/seed/SKILL.md', 'ours only');
        r.folder.write('skills/factory/SKILL.md', 'our factory');
      },
      (r) => {
        const seen = pluginFor(plugin, r.folder);

        expect(textIn(seen, 'skills/seed/SKILL.md')).toBe('ours only');
        expect(textIn(seen, 'skills/factory/SKILL.md')).toBe(abeText('skills/factory/SKILL.md'));
      },
    ],
  ])('%s', (_, arrange, check) => {
    const r = installed();

    arrange(r);
    check(r);
  });

  test.each<[string, (r: Repo) => void, Partial<UpdateFile>, (r: Repo) => void]>([
    [
      'an unedited copy takes Abe’s, and its base moves: no longer newer, never read as edited',
      (r) => {
        copiedOld(r, VERIFY, verifyWithProtocol);
      },
      { how: 'copy', text: verify },
      (r) => {
        expect(r.folder.read(VERIFY)).toBe(verify);
      },
    ],
    [
      'an edited copy merges three ways: Abe’s protocol goes, the team’s edit stays',
      (r) => {
        copiedOld(r, VERIFY, verifyWithProtocol);
        r.folder.write(VERIFY, `${verifyWithProtocol}${TEAM_EDIT}`);
      },
      { how: 'merged', conflicts: 0, text: `${verify}${TEAM_EDIT}` },
      (r) => {
        expect(r.folder.read(VERIFY)).toBe(`${verify}${TEAM_EDIT}`);
        expect(r.folder.read(VERIFY)).not.toContain('abe factory verify');
      },
    ],
    [
      'both changed the same lines: a conflict with git’s markers',
      (r) => {
        copiedOld(r, VERIFY, verifyWithProtocol);
        r.folder.write(VERIFY, verifyWithProtocol.replace('--result pass', '--result ours'));
      },
      { how: 'conflict', conflicts: 1 },
      (r) => {
        expect(r.folder.read(VERIFY)).toContain("<<<<<<< the repo's copy\n");
      },
    ],
    [
      'a deleted copy stays deleted; its base still moves',
      (r) => {
        copiedOld(r, VERIFY, verifyWithProtocol);
        remove(r, VERIFY);
      },
      { how: 'deleted', text: null },
      (r) => {
        expect(r.folder.read(VERIFY)).toBeNull();
      },
    ],
    [
      'a file Abe added since the install is written',
      (r) => {
        const record = AbeInstalled.parse(JSON.parse(r.folder.read('installed.json') ?? '{}'));
        const files = Object.fromEntries(
          Object.entries(record.files).filter(([path]) => path !== VERIFY),
        );

        r.folder.write('installed.json', JSON.stringify({ ...record, files }));
        remove(r, VERIFY);
      },
      { how: 'new', text: verify },
      (r) => {
        expect(r.folder.read(VERIFY)).toBe(verify);
      },
    ],
  ])('%s', async (_, arrange, proposed, after) => {
    const r = installed();

    arrange(r);
    expect(updatesOf(r.folder).map((u) => u.name)).toEqual(['verify']);
    const files = await proposeUpdates(r.folder, '3.5.14');

    expect(files).toMatchObject([{ path: VERIFY, kind: 'skill', name: 'verify', ...proposed }]);
    // nothing written by the proposal
    expect(updatesOf(r.folder).map((u) => u.name)).toEqual(['verify']);
    applyUpdates(r.folder, '3.5.14', files);
    after(r);
    expect(updatesOf(r.folder)).toEqual([]);
  });

  /** Every `abe …` a text calls: inline code starting so, and code lines starting so. */
  const calls = (text: string): string[] => [
    ...[...text.matchAll(/`(abe [^`\n]+)`/g)].map((m) => m[1] ?? ''),
    ...text.split('\n').filter((line) => line.startsWith('abe ')),
  ];

  test.each(SHIPPED_FILES.filter((f) => f.owner === 'repo').map((f) => [f.path, f] as const))(
    "%s, a repo's once copied, calls no abe command: its skill's PROTOCOL.md is Abe's",
    (path, f) => {
      expect(calls(f.text)).toEqual([]);
      const protocol = SHIPPED_FILES.find((g) => g.path === path.replace(/[^/]+$/, PROTOCOL_FILE));

      if (protocol !== undefined)
        expect([protocol.owner, protocol.plugin]).toEqual(['abe', f.plugin]);
    },
  );

  test.each<[string, [string, string, string], string, number]>([
    ['only ours changed', ['a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nc\n'], 'a\nB\nc\n', 0],
    ['both, apart', ['a\nb\nc\nd\n', 'A\nb\nc\nd\n', 'a\nb\nc\nD\n'], 'A\nb\nc\nD\n', 0],
    ['both, the same change', ['a\nb\n', 'a\nX\n', 'a\nX\n'], 'a\nX\n', 0],
    [
      'both, the same line differently',
      ['a\nb\nc\n', 'a\nO\nc\n', 'a\nT\nc\n'],
      'a\n<<<<<<< o\nO\n||||||| b\nb\n=======\nT\n>>>>>>> t\nc\n',
      1,
    ],
    [
      'no base: any difference is one conflict',
      ['', 'x\n', 'y\n'],
      '<<<<<<< o\nx\n||||||| b\n=======\ny\n>>>>>>> t\n',
      1,
    ],
  ])('merge3: %s', (_, [base, ours, theirs], text, conflicts) => {
    expect(merge3(base, ours, theirs, { ours: 'o', base: 'b', theirs: 't' })).toEqual({
      text,
      conflicts,
    });
  });
});
