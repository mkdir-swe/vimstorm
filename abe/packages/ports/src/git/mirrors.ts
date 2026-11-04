/**
 * Each repo's bare mirror on the box, through `git`: cloned once from GitHub, fetched before every
 * use. Git asks `gh` for the person's login (`gh auth git-credential`), so no token is ever in an
 * environment, a URL or a file of ours.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Mirrors } from '@abe/core';
import { withoutGhDropped } from '../github/gh';
import { type Env } from '../mac/locations';

export type MirrorOptions = {
  /** Where mirrors live (`<dir>/repos/<owner>/<repo>.git`) and snapshots are unpacked (`<dir>/build`). */
  dir: string;
  env: Env;
  /** Where a repo is cloned from the first time (default: GitHub over https). */
  url?: (repo: string) => string;
};

const fail = (what: string, stderr: string, exit: number) =>
  new Error(`git ${what} failed: ${stderr.trim() || `exit ${exit}`}`);

export const gitMirrors = (o: MirrorOptions): Mirrors => {
  // A parent git's variables would point every command at its repo, and no token may leak.
  const env = withoutGhDropped(o.env);
  const url = o.url ?? ((repo: string) => `https://github.com/${repo}.git`);
  const mirror = (repo: string) => join(o.dir, 'repos', `${repo}.git`);

  const git = async (args: readonly string[]) => {
    const child = Bun.spawn(['git', ...args], {
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { stdout, stderr, exit };
  };

  return {
    sync: async (repo) => {
      const path = mirror(repo);

      if (existsSync(path)) {
        const fetched = await git(['-C', path, 'fetch', '--prune', '--quiet']);

        if (fetched.exit !== 0) throw fail('fetch', fetched.stderr, fetched.exit);

        return path;
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const cloned = await git([
        'clone',
        '--mirror',
        '--quiet',
        '--config',
        'credential.helper=',
        '--config',
        'credential.helper=!gh auth git-credential',
        url(repo),
        path,
      ]);

      if (cloned.exit !== 0) {
        await rm(path, { recursive: true, force: true });
        throw fail('clone', cloned.stderr, cloned.exit);
      }

      return path;
    },
    tree: async (repo, path) => {
      const out = await git([
        '-C',
        mirror(repo),
        'rev-parse',
        '--verify',
        '--quiet',
        `HEAD:${path}`,
      ]);

      return out.exit === 0 ? out.stdout.trim() : undefined;
    },
    snapshot: async (repo) => {
      const dest = join(o.dir, 'build', repo);

      await rm(dest, { recursive: true, force: true });
      await mkdir(dest, { recursive: true, mode: 0o700 });
      const archive = Bun.spawn(['git', '-C', mirror(repo), 'archive', '--format=tar', 'HEAD'], {
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const untar = Bun.spawn(['tar', '-x', '-C', dest], {
        stdin: archive.stdout,
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const [archived, untarred, why, untarWhy] = await Promise.all([
        archive.exited,
        untar.exited,
        new Response(archive.stderr).text(),
        new Response(untar.stderr).text(),
      ]);

      if (archived !== 0 || untarred !== 0)
        throw fail('archive', `${why}${untarWhy}`, archived || untarred);

      return dest;
    },
    checkout: async (repo) => {
      const dest = join(o.dir, 'checkouts', repo);
      const head = await git(['-C', mirror(repo), 'rev-parse', '--verify', 'HEAD^{commit}']);

      if (head.exit !== 0) throw fail('rev-parse', head.stderr, head.exit);
      const at = head.stdout.trim();

      // A worktree of the mirror, detached at its default branch's head: only abe writes it.
      if (existsSync(join(dest, '.git'))) {
        const moved = await git(['-C', dest, 'checkout', '--quiet', '--force', '--detach', at]);

        // One that no longer moves (its mirror cloned again) is made anew below.
        if (moved.exit === 0) return dest;
      }
      await rm(dest, { recursive: true, force: true });
      // A checkout removed by hand (or a mirror cloned again) leaves its record: dropped first.
      await git(['-C', mirror(repo), 'worktree', 'prune']);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      const added = await git([
        '-C',
        mirror(repo),
        'worktree',
        'add',
        '--quiet',
        '--detach',
        dest,
        at,
      ]);

      if (added.exit !== 0) throw fail('worktree add', added.stderr, added.exit);

      return dest;
    },
  };
};
