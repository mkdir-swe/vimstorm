/**
 * `DemoShop` (`abe demo new`): the demo bundled with this abe found on disk, copied with `node:fs`,
 * made a repo with `git`, put on GitHub and given its issues with `gh` on its own login. IO only;
 * the rules are core's `demo/demo.ts`.
 */
import { cpSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { type DemoShop } from '@abe/core';
import { ghRunner } from './gh';
import { type Env } from '../mac/locations';
import { gitEnv, runProcess, said } from '../mac/process';

const SEED = join('board', 'seed.json');

/** Creating the repo pushes it: longer than a read. */
const PUBLISH_TIMEOUT_MS = 5 * 60_000;

/** The executable this abe runs as, its links followed (`~/.local/bin/abe` is one to the app's). */
const executable = (): string | null => {
  try {
    return realpathSync(process.execPath);
  } catch {
    return null;
  }
};

/**
 * Where the bundled demo can be, first found wins: beside this source in its checkout
 * (`<repo>/abe/packages/ports/src/github` → `<repo>/examples/demo-shop`), the app bundle's
 * `Contents/Resources/demo-shop` beside `Contents/MacOS/abe`, a checkout's compiled
 * `abe/dist/abe-darwin-arm64`.
 */
export const demoPlaces = (exe: string | null = executable()): string[] => [
  join(import.meta.dir, '..', '..', '..', '..', '..', 'examples', 'demo-shop'),
  ...(exe === null
    ? []
    : [
        join(dirname(exe), '..', 'Resources', 'demo-shop'),
        join(dirname(exe), '..', '..', 'examples', 'demo-shop'),
      ]),
];

const ISSUE_URL = /https:\/\/github\.com\/\S+\/issues\/(\d+)/;
const REPO_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+/;

export const demoShopFrom = (env: Env, o: { places?: () => string[] } = {}): DemoShop => {
  const gh = ghRunner(env);
  const ghLong = ghRunner(env, PUBLISH_TIMEOUT_MS);
  const git = gitEnv(env);
  const run = async (argv: string[], cwd: string) => {
    const r = await runProcess(['git', ...argv], git, cwd);

    return r.exit === 0 ? null : said(r, `git ${argv[0] ?? ''}`);
  };

  return {
    home: env.HOME ?? '',
    source: () => (o.places ?? demoPlaces)().find((p) => existsSync(join(p, SEED))) ?? null,
    exists: (path) => existsSync(path),
    read: (source, file) => {
      try {
        return { ok: true, data: readFileSync(join(source, file), 'utf8') };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    login: async () => {
      const r = await gh(['api', 'user', '--jq', '.login']);
      const login = r.ok ? r.stdout.trim() : '';

      if (!r.ok) return { ok: false, message: r.error.message };

      return login === '' ? { ok: false, message: 'gh named no login' } : { ok: true, data: login };
    },
    repoExists: async (repo) => {
      const r = await gh(['repo', 'view', repo, '--json', 'name']);

      if (r.ok) return { ok: true, data: true };

      return r.error.code === 'not-found'
        ? { ok: true, data: false }
        : { ok: false, message: r.error.message };
    },
    copy: async ({ source, folder, skip, author }) => {
      const left = new Set(skip);

      try {
        cpSync(source, folder, {
          recursive: true,
          errorOnExist: true,
          force: false,
          filter: (from) =>
            relative(source, from)
              .split(sep)
              .every((part) => !left.has(part)) && basename(from) !== '.DS_Store',
        });
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      const named = await runProcess(['git', 'config', 'user.email'], git, folder);
      const as =
        named.exit === 0 && named.stdout.trim() !== ''
          ? []
          : ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`];
      const failed =
        (await run(['init', '--quiet', '--initial-branch=main'], folder)) ??
        (await run(['add', '--all'], folder)) ??
        (await run(
          [...as, 'commit', '--quiet', '--no-verify', '-m', 'Start the demo shop.'],
          folder,
        ));

      return failed === null ? { ok: true, data: undefined } : { ok: false, message: failed };
    },
    publish: async (folder, repo) => {
      const r = await ghLong([
        'repo',
        'create',
        repo,
        '--private',
        '--source',
        folder,
        '--remote',
        'origin',
        '--push',
      ]);

      if (!r.ok) return { ok: false, message: r.error.message };

      return { ok: true, data: REPO_URL.exec(r.stdout)?.[0] ?? `https://github.com/${repo}` };
    },
    issue: async (repo, card, assignee) => {
      const r = await gh(
        [
          'issue',
          'create',
          '--repo',
          repo,
          '--title',
          card.title,
          '--body-file',
          '-',
          ...card.labels.flatMap((l) => ['--label', l]),
          '--assignee',
          assignee,
        ],
        card.body,
      );

      if (!r.ok) return { ok: false, message: r.error.message };
      const m = ISSUE_URL.exec(r.stdout);

      return m === null
        ? { ok: false, message: `gh issue create printed no issue: ${r.stdout.trim()}` }
        : { ok: true, data: { number: Number(m[1]), title: card.title, url: m[0] } };
    },
  };
};
