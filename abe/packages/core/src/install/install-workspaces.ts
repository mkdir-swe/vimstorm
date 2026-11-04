/**
 * Factory install's Read in a monorepo: the folders its workspaces are in. The root
 * `package.json`'s `workspaces` (or yarn's `{ packages }`), else `pnpm-workspace.yaml`'s
 * `packages:`, else the folders at the top two levels holding a `package.json`. Never in
 * node_modules, build output or a dot folder; bounded (`WORKSPACES_READ`, `FOLDERS_LISTED`), and
 * a cap reached is said (`ReadCap`).
 */
import { z } from 'zod';
import { type RunChecks } from './install-kind';

/** The checkout's files as Read sees them, paths relative to its top. */
export type CheckoutFiles = {
  /** A file's text; `undefined` when it is not there. */
  read: (path: string) => Promise<string | undefined>;
  /** The names in a folder; empty when it is not there (or is a file). */
  list: (dir: string) => Promise<string[]>;
  /**
   * The lines of the files git tracks matching `pattern` (extended, any case), at most `max`;
   * none: Read searches nothing.
   */
  grep?: (pattern: string, max: number) => Promise<{ path: string; line: number; text: string }[]>;
  /** Whether git ignores a file (a rendered config, a secret): Read never reads one for the kind. */
  ignored?: (path: string) => Promise<boolean>;
  /**
   * An env file's key names, never a value (serve reads the file); `undefined`: not there. None:
   * Read says cloud credentials by the file's name alone.
   */
  envKeys?: (path: string) => Promise<readonly string[] | undefined>;
  /** Whether git tracks a file; none: Read takes none as tracked. */
  tracked?: (path: string) => Promise<boolean>;
  /**
   * origin's default branch (`origin/main`) when it tracks the folder `path` and HEAD does not
   * track the same there; `undefined`: it tracks none or the same. None: Read looks at no origin.
   */
  originOnly?: (path: string) => Promise<string | undefined>;
  /**
   * Runs commands once each on a clean tree of HEAD (serve makes it, outside the working tree);
   * none: Read runs nothing and offers every static check.
   */
  runChecks?: RunChecks;
};

/** How the workspaces were found. */
export const WorkspacesFrom = z.enum(['package.json', 'pnpm-workspace.yaml', 'folders']);
export type WorkspacesFrom = z.infer<typeof WorkspacesFrom>;

/** A cap Read reached: what it stopped counting (`workspaces`, `files`) and at how many. */
export const ReadCap = z.object({
  what: z.enum(['workspaces', 'folders', 'files', 'scripts', 'docs', 'terraform', 'config']),
  cap: z.number().int(),
});
export type ReadCap = z.infer<typeof ReadCap>;

/** At most this many workspaces are read. */
export const WORKSPACES_READ = 50;
/** At most this many folders are looked in to find them. */
export const FOLDERS_LISTED = 200;

/** Folders never looked in: dependencies and build output. Dot folders neither. */
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'cdk.out', 'coverage']);

const skipped = (name: string) => name.startsWith('.') || SKIPPED.has(name);

/** A name that looks like a file's (`README.md`): not looked in when scanning folders. */
const fileName = (name: string) => /\.[A-Za-z0-9]+$/.test(name);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const Globs = z.array(z.string());
const RootPackage = z.object({
  workspaces: z.union([Globs, z.object({ packages: Globs.optional() })]).optional(),
});

/** The globs the root `package.json` names; undefined: it names none. */
const packageGlobs = (text: string | undefined): string[] | undefined => {
  const w =
    text === undefined ? undefined : RootPackage.safeParse(parseJson(text)).data?.workspaces;
  const globs = Array.isArray(w) ? w : w?.packages;

  return globs === undefined || globs.length === 0 ? undefined : globs;
};

/** `pnpm-workspace.yaml`'s `packages:` list; undefined: none. */
const pnpmGlobs = (text: string | undefined): string[] | undefined => {
  if (text === undefined) return undefined;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  const out: string[] = [];

  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (/^\S/.test(line)) break;
    const m = /^\s*-\s*(['"]?)(.+?)\1\s*(?:#.*)?$/.exec(line);

    if (m?.[2] !== undefined) out.push(m[2]);
  }

  return out.length === 0 ? undefined : out;
};

/** A glob (`apps/*`, a `!` one) as a pattern over a folder's path. */
const globRe = (glob: string) => {
  const parts = glob.split(/(\*\*\/?|\*)/).map((p) => {
    if (p === '*') return '[^/]*';
    if (p === '**/') return '(?:.*/)?';
    if (p === '**') return '.*';

    return p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  });

  return new RegExp(`^${parts.join('')}/?$`);
};

const clean = (glob: string) => glob.trim().replace(/^\.\//, '').replace(/\/+$/, '');

export type FoundWorkspaces = {
  from: WorkspacesFrom | null;
  /** Each workspace's folder and the names in it, in the order found. */
  dirs: { dir: string; names: string[] }[];
  capped: ReadCap[];
};

/** The repo's workspaces, from its root `package.json`, `pnpm-workspace.yaml` and the names at its top. */
export const findWorkspaces = async (
  fs: CheckoutFiles,
  o: { pkg: string | undefined; pnpm: string | undefined; names: readonly string[] },
): Promise<FoundWorkspaces> => {
  const capped: ReadCap[] = [];
  const cap = (c: ReadCap) => {
    if (!capped.some((x) => x.what === c.what)) capped.push(c);
  };
  let lists = 0;
  const listed = new Map<string, string[]>();
  // the folders' names, as many as the budget allows, the rest dropped (and the cap said)
  const listAll = async (dirs: readonly string[]): Promise<Map<string, string[]>> => {
    const todo = dirs.filter((d) => !listed.has(d));
    const room = Math.max(0, FOLDERS_LISTED - lists);

    if (todo.length > room) cap({ what: 'folders', cap: FOLDERS_LISTED });
    lists += Math.min(room, todo.length);
    const got = await Promise.all(
      todo.slice(0, room).map(async (d) => [d, await fs.list(d)] as const),
    );

    for (const [d, names] of got) listed.set(d, [...names].sort());

    return new Map(dirs.flatMap((d) => (listed.has(d) ? [[d, listed.get(d) ?? []] as const] : [])));
  };
  const join = (dir: string, name: string) => (dir === '' ? name : `${dir}/${name}`);
  const fromPackage = packageGlobs(o.pkg);
  const fromPnpm = fromPackage === undefined ? pnpmGlobs(o.pnpm) : undefined;
  const globs = fromPackage ?? fromPnpm;
  const from: WorkspacesFrom =
    (fromPackage === undefined ? undefined : 'package.json') ??
    (fromPnpm === undefined ? 'folders' : 'pnpm-workspace.yaml');
  let candidates: string[] = [];

  if (globs === undefined) {
    // the folders at the top two levels
    const top = o.names.filter((n) => !skipped(n) && !fileName(n)).sort();
    const first = await listAll(top);
    const second = [...first].flatMap(([d, names]) =>
      names.filter((n) => !skipped(n) && !fileName(n)).map((n) => join(d, n)),
    );

    await listAll(second);
    candidates = [...top, ...second];
  } else {
    const nots = globs.filter((g) => g.startsWith('!')).map((g) => globRe(clean(g.slice(1))));

    for (const glob of globs.filter((g) => !g.startsWith('!')).map(clean)) {
      let dirs = [''];

      for (const seg of glob.split('/')) {
        if (!seg.includes('*')) {
          dirs = dirs.map((d) => join(d, seg));
          continue;
        }
        const re = globRe(seg === '**' ? '*' : seg);
        const names = await listAll(dirs);

        dirs = [...names].flatMap(([d, ns]) =>
          ns.filter((n) => !skipped(n) && re.test(n)).map((n) => join(d, n)),
        );
      }
      candidates.push(...dirs.filter((d) => d !== '' && !nots.some((re) => re.test(d))));
    }
    candidates = [...new Set(candidates)].filter((d) => !d.split('/').some(skipped));
    await listAll(candidates);
  }
  const dirs = candidates.flatMap((dir) => {
    const names = listed.get(dir) ?? [];

    return names.includes('package.json') ? [{ dir, names }] : [];
  });

  if (dirs.length > WORKSPACES_READ) cap({ what: 'workspaces', cap: WORKSPACES_READ });

  return {
    from: dirs.length === 0 && globs === undefined ? null : from,
    dirs: dirs.slice(0, WORKSPACES_READ),
    capped,
  };
};
