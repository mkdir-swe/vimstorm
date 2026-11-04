/**
 * A card's new worktree made ready before its `claude` starts, by serve outside the session's
 * sandbox: its third-party packages linked from the main checkout when their lockfiles are the
 * same and the checkout has them installed (the repo's own packages linked into the worktree; the
 * setup's other steps, codegen and the like, run after: `setupAfterLink`), else
 * the repo pack's setup (the `setup` setting) or the lockfile's own install that changes nothing
 * (`npm ci`), its network the package registries alone; the env files and the install's untracked
 * files the checks need copied in. A failed setup puts the run at Needs you with the end of its
 * output.
 */
import { z } from 'zod';
import { tail } from '../factory/checks';

/** How long a setup may run. */
export const SETUP_TIMEOUT_MS = 15 * 60_000;

/** The lockfiles a worktree's packages are installed from, the first one found wins. */
export const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const;
export type Lockfile = (typeof LOCKFILES)[number];

/**
 * The lockfile's install that installs exactly what it says and changes nothing, as CI runs it.
 * `yarnBerry`: the checkout has a `.yarnrc.yml` (Yarn 2 and later, `--immutable`).
 */
export const ciCommand = (lock: Lockfile, yarnBerry: boolean): string => {
  switch (lock) {
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return 'npm ci';
    case 'pnpm-lock.yaml':
      return 'pnpm install --frozen-lockfile';
    case 'yarn.lock':
      return yarnBerry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
    case 'bun.lock':
    case 'bun.lockb':
      return 'bun install --frozen-lockfile';
  }
};

/**
 * The lockfile's own install that brings `node_modules` up to the manifests (`npm install`): a
 * prototype's packages, cloned from the main checkout, when its manifests are not the checkout's.
 */
export const installCommand = (lock: Lockfile, yarnBerry: boolean): string => {
  switch (lock) {
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return 'npm install';
    case 'pnpm-lock.yaml':
      return 'pnpm install';
    case 'yarn.lock':
      return yarnBerry ? 'yarn install' : 'yarn install --non-interactive';
    case 'bun.lock':
    case 'bun.lockb':
      return 'bun install';
  }
};

/**
 * The `node_modules` folders a prototype's worktree clones from the main checkout, from the top:
 * of the folders git leaves out (`git ls-files -o -i --exclude-standard --directory`, each ending
 * in `/`), those named `node_modules` that lie in no other one (a package's own nested ones come
 * with it), sorted.
 */
export const nodeModulesTops = (ignored: readonly string[]): string[] =>
  [
    ...new Set(
      ignored
        .map((l) => l.trim().replace(/\/+$/, ''))
        .filter((l) => l !== '' && !l.startsWith('../'))
        .filter((l) => {
          const parts = l.split('/');

          return (
            parts.at(-1) === 'node_modules' && parts.indexOf('node_modules') === parts.length - 1
          );
        }),
    ),
  ].sort();

/**
 * The files whose bytes decide a worktree's packages (`manifests`): every `package.json` git
 * tracks (`tracked`) and the lockfiles beside them, from the top, sorted. Two worktrees with
 * the same bytes in each need no install between them.
 */
export const manifestPaths = (tracked: readonly string[]): string[] => {
  const dirs = [
    ...new Set(
      tracked
        .filter((p) => p === 'package.json' || p.endsWith('/package.json'))
        .filter((p) => !p.split('/').includes('node_modules'))
        .map((p) => (p === 'package.json' ? '' : p.slice(0, -'/package.json'.length))),
    ),
  ];

  return dirs
    .flatMap((d) => ['package.json', ...LOCKFILES].map((f) => (d === '' ? f : `${d}/${f}`)))
    .sort();
};

/** A shell line's steps: split at `&&`, `;` and line ends outside quotes, each trimmed. */
const stepsOf = (line: string): string[] => {
  const steps: string[] = [];
  let step = '';
  let quote: string | undefined;

  for (let at = 0; at < line.length; at++) {
    const c = line[at] ?? '';

    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      step += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      step += c;
    } else if (c === ';' || c === '\n' || (c === '&' && line[at + 1] === '&')) {
      steps.push(step);
      step = '';
      if (c === '&') at++;
    } else step += c;
  }
  steps.push(step);

  return steps.map((s) => s.trim()).filter((s) => s !== '');
};

/** Each package manager's verbs that install the packages (bare `yarn` too). */
const INSTALL_VERBS: Readonly<Record<string, readonly string[]>> = {
  npm: ['ci', 'install', 'i'],
  pnpm: ['install', 'i'],
  yarn: ['install', ''],
  bun: ['install', 'i'],
};

/** Whether a step installs packages: its first command a package manager's install. */
const installs = (step: string): boolean => {
  const [tool = '', ...rest] = (step.split('||')[0] ?? '').trim().split(/\s+/);
  const verb = rest.find((w) => !w.startsWith('-')) ?? '';

  return INSTALL_VERBS[tool]?.includes(verb) === true;
};

/**
 * The repo pack's setup once a worktree's packages are linked from the main checkout: its steps
 * (`&&`, `;`, lines) but those that install packages (`npm ci`, `pnpm install`, bare `yarn`, …),
 * which linking stands for, in order and joined by `&&`; null when nothing is left. A setup with
 * no install step is kept whole (`make bootstrap`).
 */
export const setupAfterLink = (setup: string): string | null => {
  const after = stepsOf(setup).filter((s) => !installs(s));

  return after.length === 0 ? null : after.join(' && ');
};

/** The public registries of npm, yarn, bun and PyPI: a setup reaches them whatever the configs say. */
export const DEFAULT_REGISTRIES = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'repo.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
] as const;

/** The package managers' config files that name registries, in the checkout and in `HOME`. */
export const REGISTRY_CONFIGS = ['.npmrc', '.yarnrc.yml', '.yarnrc', 'bunfig.toml'] as const;
export type RegistryConfig = (typeof REGISTRY_CONFIGS)[number];

/** A URL's host, lower case, no userinfo or port. */
const hostOf = (url: string): string | undefined =>
  /^https?:\/\/(?:[^@/]*@)?([^/:?#\s]+)/i.exec(url)?.[1]?.toLowerCase();

/** A config line that names a registry: npm's `registry=`, yarn's `npmRegistryServer`, bun's. */
const REGISTRY_LINE: Readonly<Record<RegistryConfig, RegExp>> = {
  '.npmrc': /^\s*(?:@[\w.-]+:)?registry\s*=\s*["']?(https?:\/\/[^\s"']+)/,
  '.yarnrc.yml': /^\s*npmRegistryServer\s*:\s*["']?(https?:\/\/[^\s"']+)/,
  '.yarnrc': /^\s*"?(?:@[\w.-]+:)?registry"?\s+["']?(https?:\/\/[^\s"']+)/,
  'bunfig.toml':
    /^\s*(?:registry|url|"@[\w.-]+"|[\w-]+)\s*=\s*(?:\{[^}]*url\s*=\s*)?["'](https?:\/\/[^"']+)/,
};

/**
 * The hosts a worktree's setup may reach: the public registries and each one the main checkout's
 * or the person's config names (`configs`: each file's name and text, never the worktree's, which
 * the agent writes).
 */
export const registryHosts = (
  configs: readonly { file: RegistryConfig; text: string }[],
): string[] => {
  const named = configs.flatMap(({ file, text }) =>
    text.split('\n').flatMap((line) => {
      const url = REGISTRY_LINE[file].exec(line)?.[1];
      const host = url === undefined ? undefined : hostOf(url);

      return host === undefined ? [] : [host];
    }),
  );

  return [...new Set([...DEFAULT_REGISTRIES, ...named])];
};

/** Whether `host` is one of `allowed` (an exact host, or `*.<domain>` for any host under it). */
export const registryAllows = (allowed: readonly string[], host: string): boolean => {
  const h = host.toLowerCase();

  return allowed.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) : h === a));
};

/** The CI files whose `NODE_OPTIONS` the checks take, by their path from the top. */
export const CI_FILES = [
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^azure-pipelines[\w.-]*\.ya?ml$/,
  /^\.gitlab-ci\.ya?ml$/,
  /^bitbucket-pipelines\.ya?ml$/,
  /^\.circleci\/config\.ya?ml$/,
] as const;

const unquoted = (value: string) => {
  const v = value.trim();
  const quoted = /^(['"])(.*)\1$/.exec(v);

  return quoted === null ? v : (quoted[2] ?? '');
};

/** The heap `--max-old-space-size` gives, in MB; 0 for none. */
const heapOf = (options: string) =>
  Number(/--max[-_]old[-_]space[-_]size[= ](\d+)/.exec(options)?.[1] ?? 0);

const withoutComment = (line: string) => line.replace(/\s+#.*$/, '');

/**
 * The `NODE_OPTIONS` the repo's CI gives its jobs (`files`: each CI file's path from the top and
 * its text): a YAML `env:` or `variables:` entry, an Azure `name:` / `value:` pair, or a shell's
 * `NODE_OPTIONS=…` before a command. Of several, the one with the most heap. A value CI computes
 * (`${{ … }}`, `$(…)`) is not read. Null: none.
 */
export const ciNodeOptions = (files: readonly { path: string; text: string }[]): string | null => {
  const found: string[] = [];

  for (const { path, text } of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!CI_FILES.some((re) => re.test(path))) continue;
    const lines = text.split('\n').map(withoutComment);

    for (const [n, code] of lines.entries()) {
      const yaml = /^\s*-?\s*["']?NODE_OPTIONS["']?\s*:\s*(.+)$/.exec(code)?.[1];
      const shell = /(?:^|[\s;&(])(?:export\s+)?NODE_OPTIONS=("[^"]*"|'[^']*'|\S+)/.exec(code)?.[1];
      const pair = /^\s*-?\s*name\s*:\s*["']?NODE_OPTIONS["']?\s*$/.test(code)
        ? /^\s*value\s*:\s*(.+)$/.exec(lines[n + 1] ?? '')?.[1]
        : undefined;
      const value = yaml ?? shell ?? pair;

      if (value === undefined) continue;
      const v = unquoted(value);

      if (v !== '' && !/\$\{\{|\$\(|\$\{/.test(v)) found.push(v);
    }
  }

  return found.reduce<string | null>(
    (best, v) => (best === null || heapOf(v) > heapOf(best) ? v : best),
    null,
  );
};

/**
 * A file or folder of the main checkout a card's new worktree gets copied in, from the top. `over`: the checkout's, over what the worktree's branch has
 * (a Local only install's `.abe/`, which the branch may track an older one of), the branch's
 * copy hidden from git. `link`: linked to the checkout's, never copied (the repo's worktree recipe,
 * `worktree.link`). `listed`: the recipe names it, so its absence from the checkout is said.
 * `skip`: never put in, and why (an env file of an environment off for agents, ADR 0029).
 */
export type WorktreeCopy = {
  path: string;
  over?: true;
  link?: true;
  listed?: true;
  skip?: string;
};

/** A command's run: what ran, its exit (null: killed at its time) and its output, cut at its end. */
const Ran = z.object({ run: z.string(), exit: z.number().int().nullable(), output: z.string() });

/**
 * What made the worktree ready, as it ran: `linked` its packages from the main checkout (`from`)
 * and then, when the setup has steps other than its install, those (`run`, as `ran`'s),
 * `cloned` a prototype's: each `node_modules` copied on write from the main checkout (`from`),
 * then the lockfile's install when its manifests differ (`run`, as `ran`'s),
 * `ran` a setup command (`run`, its exit, null: killed at its time, and its output, cut at its
 * end), `none` only copied files. `copied`: the files copied in from the main checkout, from the
 * top. `links`: those linked to
 * the checkout's (`worktree.link`); `skipped`: those left out, each with why; `missing`: those the
 * recipe names that the checkout lacks. `notCopied`: those the checkout has that could not be put in,
 * each with why (the setup failed: said, never silent). `script`: the recipe's script
 * (`hooks.worktree-setup`), run last.
 */
export const SetupRan = Ran.extend({
  how: z.enum(['ran', 'linked', 'cloned', 'none']).default('ran'),
  from: z.string().optional(),
  copied: z.array(z.string()).default([]),
  links: z.array(z.string()).optional(),
  skipped: z.record(z.string(), z.string()).optional(),
  missing: z.array(z.string()).optional(),
  notCopied: z.record(z.string(), z.string()).optional(),
  script: Ran.optional(),
});
export type SetupRan = z.infer<typeof SetupRan>;

/** How a run's exit is said: its code, or killed at its time. */
const exitWords = (exit: number | null) => (exit === null ? 'killed at its time' : `exit ${exit}`);

/** The files the checkout has that the worktree did not get, each with why (`notCopied`). */
const notCopiedOf = (ran: SetupRan) =>
  Object.entries(ran.notCopied ?? {}).map(([p, why]) => `${p} (${why})`);

/**
 * Whether the worktree is ready: its setup and the recipe's script (when it ran) passed, and it
 * got every file the main checkout has for it.
 */
export const setupPassed = (ran: SetupRan): boolean =>
  ran.exit === 0 && (ran.script?.exit ?? 0) === 0 && notCopiedOf(ran).length === 0;

/**
 * Why a failed setup needs you (its command, exit and the end of its output), the main
 * checkout's files the worktree did not get, or the recipe's
 * script's with where it is fixed, the repo's own (`WORKTREE_FIX`); null when both passed.
 */
export const setupReason = (ran: SetupRan): string | null => {
  if (ran.exit !== 0)
    return `the repo's setup \`${ran.run}\` failed (${exitWords(ran.exit)}) in the new worktree:\n${tail(ran.output, 20, 4000)}`;
  const notCopied = notCopiedOf(ran);

  if (notCopied.length > 0)
    return `the new worktree did not get the main checkout's ${notCopied.join(', ')}: its next start puts them in again, or copy them in by hand`;
  if (ran.script === undefined || ran.script.exit === 0) return null;

  return `the repo's worktree script \`${ran.script.run}\` failed (${exitWords(ran.script.exit)}) in the new worktree:\n${tail(ran.script.output, 20, 4000)}\nThe script and abe.yaml's worktree: are the repo's: fix them there, or ask the Abe chat.`;
};

/** `session show`'s setup line: what was done in the worktree before `claude` started. */
const ranWords = (ran: SetupRan) =>
  `${ran.run} (network: the package registries only): ${ran.exit === 0 ? 'passed' : `failed (${exitWords(ran.exit)})`}`;

const SETUP_DONE: Readonly<Record<SetupRan['how'], (ran: SetupRan) => string>> = {
  // and the setup's steps but its install, when it has others (`setupAfterLink`)
  linked: (ran) =>
    `packages linked from ${ran.from ?? 'the main checkout'} (the same lockfile)${ran.run === '' ? '' : `, then ${ranWords(ran)}`}`,
  cloned: (ran) =>
    `packages cloned from ${ran.from ?? 'the main checkout'} (copy on write)${ran.run === '' ? '' : `, then ${ranWords(ran)}`}`,
  ran: ranWords,
  none: () => '',
};

export const setupText = (ran: SetupRan): string => {
  const done = SETUP_DONE[ran.how](ran);
  const links = ran.links ?? [];
  const missing = ran.missing ?? [];
  const copied = ran.copied;
  const skipped = Object.entries(ran.skipped ?? {}).map(([p, why]) => `${p} (${why})`);
  const notCopied = notCopiedOf(ran);
  const script =
    ran.script === undefined
      ? ''
      : `${ran.script.run}: ${ran.script.exit === 0 ? 'passed' : `failed (${exitWords(ran.script.exit)})`}`;

  return [
    done,
    copied.length === 0 ? '' : `copied ${copied.join(', ')}`,
    links.length === 0 ? '' : `linked ${links.join(', ')}`,
    skipped.length === 0 ? '' : `skipped ${skipped.join(', ')}`,
    missing.length === 0
      ? ''
      : `not in the main checkout: ${missing.join(', ')} (abe.yaml worktree:)`,
    notCopied.length === 0 ? '' : `not copied: ${notCopied.join(', ')}`,
    script,
  ]
    .filter((s) => s !== '')
    .join(' · ');
};
