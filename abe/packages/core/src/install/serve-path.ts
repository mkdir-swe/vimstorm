/**
 * serve's PATH on the Mac (#145): the one its tools check, its sessions and their checks all use.
 * serve inherits whatever PATH started it (the app from the Dock: launchd's minimal one), which
 * leaves out the node a version manager (Volta, nvm, fnm, asdf, mise) puts on a terminal's PATH.
 * So serve reads its person's login shell's PATH once at start and puts it first, its own after,
 * and the managers' node folders found on disk last (when the shell could not be read). The rules
 * here: the merge, where each manager keeps its node, which manager a node is under, the fix that
 * installs node, and the launch's refusal when the repo needs node and the session has none.
 */
import { type Env } from '../session/session';

export const NODE_MANAGERS = ['Volta', 'nvm', 'fnm', 'asdf', 'mise'] as const;
export type NodeManager = (typeof NODE_MANAGERS)[number];

/** A manager's folders to look in (the first that exists is it) and its node's folder there. */
export type NodePlace = {
  manager: NodeManager;
  homes: string[];
  /** Its node's folder under its home; `null` for nvm's, read from its versions (`nvmBin`). */
  bin: string | null;
};

/**
 * A manager found on this Mac: where it lives, and its own command when found on disk (Volta's
 * binary, nvm's `nvm.sh`); without one its fix calls it by name.
 */
export type FoundManager = { manager: NodeManager; home: string; tool?: string };

const parts = (path: string) => path.split(':').filter((p) => p !== '');

/**
 * serve's PATH: the login shell's (`null`: not read) first, as the person's terminal orders it
 * (Volta's node before Homebrew's), then the PATH serve was started with, then the managers'
 * folders; each folder once.
 */
export const servePath = (o: {
  login: string | null;
  inherited: string;
  managers: readonly string[];
}): string =>
  [...new Set([...parts(o.login ?? ''), ...parts(o.inherited), ...o.managers])].join(':');

const given = (env: Env, name: string) => {
  const value = env[name];

  return value === undefined || value === '' ? undefined : value;
};

/** Where each manager keeps its node: its own variable, else its default folders. */
export const nodePlaces = (env: Env, home: string): NodePlace[] => {
  const of = (name: string, ...defaults: string[]) => {
    const set = given(env, name);

    return set === undefined ? defaults.map((d) => `${home}/${d}`) : [set];
  };

  return [
    { manager: 'Volta', homes: of('VOLTA_HOME', '.volta'), bin: 'bin' },
    { manager: 'nvm', homes: of('NVM_DIR', '.nvm'), bin: null },
    {
      manager: 'fnm',
      homes: of('FNM_DIR', '.local/share/fnm', 'Library/Application Support/fnm', '.fnm'),
      bin: 'aliases/default/bin',
    },
    { manager: 'asdf', homes: of('ASDF_DATA_DIR', '.asdf'), bin: 'shims' },
    { manager: 'mise', homes: of('MISE_DATA_DIR', '.local/share/mise'), bin: 'shims' },
  ];
};

const numbers = (version: string) =>
  version
    .replace(/^v/, '')
    .split('.')
    .map((p) => Number.parseInt(p, 10));

const newer = (a: string, b: string) => {
  const x = numbers(a);
  const y = numbers(b);

  for (let i = 0; i < Math.max(x.length, y.length); i += 1)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);

  return 0;
};

/**
 * nvm's node folder (nvm has no shims: its shell function puts one version on PATH): the newest
 * installed version its `alias/default` names (`22`, `v22.3.0`), else the newest installed one.
 */
export const nvmBin = (
  nvmHome: string,
  alias: string | null,
  versions: readonly string[],
): string | null => {
  const sorted = versions.filter((v) => /^v\d/.test(v)).sort((a, b) => newer(b, a));
  const wanted = alias?.trim().replace(/^v/, '') ?? '';
  const match = /^\d+(\.\d+)*$/.test(wanted)
    ? sorted.find((v) => `${v.slice(1)}.`.startsWith(`${wanted}.`))
    : undefined;
  const version = match ?? sorted[0];

  return version === undefined ? null : `${nvmHome}/versions/node/${version}/bin`;
};

/** Which manager a node found at `path` is under; Homebrew by its prefix; `null`: none known. */
export const managerOf = (
  path: string,
  found: readonly FoundManager[],
): NodeManager | 'Homebrew' | null =>
  found.find((m) => path.startsWith(`${m.home}/`))?.manager ??
  (path.startsWith('/opt/homebrew/') || path.startsWith('/usr/local/Cellar/') ? 'Homebrew' : null);

/** A folder as a word for `sh`: quoted only when it has to be. */
const word = (path: string) =>
  /^[\w./~-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;

/**
 * Each manager's install, run by a login shell that may not have read the file that sets the
 * manager up (`zsh -lc` reads no `.zshrc`): its own command when found (Volta's binary, nvm's
 * script sourced first), else by name.
 */
const INSTALL: Readonly<Record<NodeManager, (tool: string | undefined) => string>> = {
  Volta: (tool) => `${tool === undefined ? 'volta' : word(tool)} install node`,
  nvm: (tool) => `${tool === undefined ? '' : `. ${word(tool)} && `}nvm install --lts`,
  fnm: () => 'fnm install --lts && fnm default lts-latest',
  asdf: () => 'asdf plugin add nodejs; asdf install nodejs latest && asdf set -u nodejs latest',
  mise: () => 'mise use -g node@lts',
};

/** The command that installs (or upgrades) node: the first manager found's, else Homebrew's. */
export const nodeFix = (managers: readonly FoundManager[]): string => {
  const first = managers[0];

  return first === undefined ? 'brew install node' : INSTALL[first.manager](first.tool);
};

/** A setup that runs a node tool. */
const NODE_TOOL = /(^|[\s;&|(])(npm|npx|node|pnpm|yarn|corepack)(\s|$)/;

type RepoNode = { packageJson: boolean; bunLock: boolean; setup: string | null };

/** Why a repo needs node, in words: its `package.json` (not a Bun repo's), a setup running a node tool. */
const needs = (o: RepoNode): string[] => [
  ...(o.packageJson && !o.bunLock ? ['package.json'] : []),
  ...(o.setup !== null && NODE_TOOL.test(o.setup) ? [`setup \`${o.setup}\``] : []),
];

/**
 * Whether a repo needs node: a `package.json` at its top (unless a `bun.lock` says Bun runs it),
 * or a setup that runs a node tool.
 */
export const nodeNeeded = (o: RepoNode): boolean => needs(o).length > 0;

/**
 * A local card session's launch where the repo needs node and no node runs on its PATH (`node`:
 * the one that answered `node --version`, `null` none, or only a manager's shim with no version):
 * refused before anything starts, with the fix; `null` when fine.
 */
export const nodeAtLaunch = (
  o: RepoNode & { node: string | null; managers: readonly FoundManager[]; path: string },
): { code: 'no-node'; message: string } | null => {
  const why = needs(o);

  if (o.node !== null || why.length === 0) return null;
  const first = o.managers[0];
  const fix =
    first === undefined
      ? nodeFix([])
      : `${first.manager} is installed but has no node: ${nodeFix([first])}`;

  return {
    code: 'no-node',
    message: `no node runs on the session's PATH (${o.path}), and this repo needs it (${why.join(', ')}): its setup and checks would fail. ${fix}, then launch again (abe tools check shows what serve finds)`,
  };
};
