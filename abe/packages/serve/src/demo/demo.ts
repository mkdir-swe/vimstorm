/**
 * `abe demo new`: the bundled demo copied to your folder, made your private `<login>/demo-shop` on
 * GitHub, its cards made issues assigned to you (its board is its GitHub Issues). Each refusal before anything is made (the folder there, the repo
 * there, no gh login) and each failure after part of it says how to start over. The rules and
 * words are core's `demo/demo.ts`; the IO the `DemoShop` port's.
 */
import { isAbsolute, join, resolve } from 'node:path';
import {
  DEMO_FOLDER,
  DEMO_REPO_NAME,
  DEMO_SEED_FILE,
  DEMO_SKIPPED,
  type DemoIssue,
  DemoSeed,
  type DemoShop,
  demoNext,
  demoRefusal,
  homeShort,
  isRepoName,
  refused,
  type Handlers,
} from '@abe/core';

/** What the handler holds: where it was typed, and the demo's world (none: refused). */
export type DemoCtx = { cwd: string; serve: { demo: DemoShop | undefined } };

const no = (r: { code: string; message: string }) => refused(r.code, r.message);

/** The folder named (`~` your home, else from where it was typed), or the default one. */
const folderOf = (named: string | undefined, name: string, cwd: string, home: string): string => {
  if (named === undefined) return join(home, DEMO_FOLDER, name);
  if (named === '~' || named.startsWith('~/')) return join(home, named.slice(1));

  return isAbsolute(named) ? resolve(named) : resolve(cwd, named);
};

const seedOf = (demo: DemoShop, source: string) => {
  const text = demo.read(source, DEMO_SEED_FILE);

  if (!text.ok) return { ok: false as const, message: text.message };
  try {
    const seed = DemoSeed.safeParse(JSON.parse(text.data));

    return seed.success
      ? { ok: true as const, seed: seed.data }
      : { ok: false as const, message: seed.error.message };
  } catch (e) {
    return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
  }
};

export const demoHandlers = () =>
  ({
    'demo new': async (args, ctx) => {
      const demo = ctx.serve.demo;
      const source = demo?.source() ?? null;

      if (demo === undefined || source === null) return no(demoRefusal.noDemo());
      const name = args.name ?? DEMO_REPO_NAME;

      if (!isRepoName(name)) return no(demoRefusal.badName(name));
      const folder = folderOf(args.folder, name, ctx.cwd, demo.home);
      const shown = homeShort(folder, demo.home);

      if (demo.exists(folder)) return no(demoRefusal.folderExists(shown));
      const seed = seedOf(demo, source);

      if (!seed.ok) return no(demoRefusal.badSeed(seed.message));
      const login = await demo.login();

      if (!login.ok) return no(demoRefusal.noLogin(login.message));
      const repo = `${login.data}/${name}`;
      const there = await demo.repoExists(repo);

      if (!there.ok) return no(demoRefusal.noLogin(there.message));
      if (there.data) return no(demoRefusal.repoExists(repo));

      const copied = await demo.copy({
        source,
        folder,
        skip: DEMO_SKIPPED,
        author: { name: login.data, email: `${login.data}@users.noreply.github.com` },
      });

      if (!copied.ok) return no(demoRefusal.copyFailed(shown, copied.message));
      const url = await demo.publish(folder, repo);

      if (!url.ok) return no(demoRefusal.repoFailed(repo, shown, url.message));
      const issues: DemoIssue[] = [];

      // In the seed's order, one at a time, so the issues' numbers follow it.
      for (const card of seed.seed.cards) {
        const made = await demo.issue(repo, card, login.data);

        if (!made.ok)
          return no(demoRefusal.issueFailed(repo, shown, issues.length, card.title, made.message));
        issues.push(made.data);
      }

      return {
        ok: true,
        data: { folder, repo, url: url.data, private: true, issues, next: demoNext(shown) },
      };
    },
  }) satisfies Partial<Handlers<DemoCtx>>;
