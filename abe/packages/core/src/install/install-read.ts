/**
 * Factory install's Read stage (#22, story 39): what the install learns from local files only
 * (the checkout, its CI, README, env examples, a monorepo's workspaces) and the Layers in force,
 * before anything remote is touched. `readCheckout` reads the checkout through serve's file reads
 * (`CheckoutFiles`); `readFindings` is the pure part, over the files' text and the `board` setting
 * as the Layers merge it.
 */
import { REPO_PATH } from '../layer/settings/places';
import { z } from 'zod';
import { boardProviderOf, type BoardSettingProvider } from '../board/board-provider';
import { BoardHint, boardHintsIn } from './install-board-hints';
import { AwsProfileSeen, awsProfilesOf, scriptPaths } from './install-aws-profiles';
import {
  CloudCredentials,
  cloudCredentialsWhy,
  COMPOSE_FILES,
  isEnvFileName,
  parseEnvFile,
  publicEnvOnly,
  viteEnvPrefixesAt,
} from './install-gate';
import {
  DEV_CONFIG,
  DevPort,
  devPortsOf,
  type FoundLine,
  ORIGIN_AUTH_PATTERN,
  ORIGIN_AUTH_READ,
  originAuthOf,
  originFixedPorts,
} from './install-ports';
import { OutwardScript, outwardScripts, runFiles, SCRIPT_FILE } from './install-outward';
import { renderCommands } from './install-render';
import { MergeDeploy, mergeDeploysOf } from './install-deploys';
import { EnvFileFound, isEnvExampleName } from './credentials';
import {
  KindFindings,
  type RepoKindSaid,
  neverRead,
  proveChecks,
  KIND_DIRS,
  KIND_FILE,
  KIND_READ,
  kindOf,
} from './install-kind';
import { FoundSource, foundSources } from './install-sources';
import { type CheckoutFiles, findWorkspaces, ReadCap, WorkspacesFrom } from './install-workspaces';

/** The files Read looks at, relative to the checkout's top; those missing are skipped. */
export const READ_FILES = [
  'README.md',
  'README',
  'package.json',
  'pnpm-workspace.yaml',
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  ...COMPOSE_FILES,
  'azure-pipelines.yml',
  REPO_PATH,
  'CLAUDE.md',
  'AGENTS.md',
  // the MCP servers it names: its sources (`install-sources.ts`, `MCP_FILES`)
  '.mcp.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
] as const;

/** The folder whose `*.md` files Read looks in for sources' links (at most `DOCS_READ` of them). */
export const DOCS_DIR = 'docs';
export const DOCS_READ = 20;

/** The folders whose `*.tf` files Read looks in for the aws provider (at most `TF_READ`). */
export const TF_DIRS = ['.', 'terraform', 'infra'] as const;
export const TF_READ = 20;

/** The folder whose `*.yml` / `*.yaml` files are CI. */
export const CI_DIR = '.github/workflows';

/** The examples Read takes env keys from (the first one present). */
export const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template', '.env.dist'] as const;

/**
 * Where a board can be (the one question Read asks when no Layer names it); `local`: a board On
 * this Mac, its cards kept in Abe's state and never sent; `github-issues`: the repo's own issues
 * (`board.provider: github`).
 */
export const BOARD_PROVIDERS = [
  'github-issues',
  'github-projects',
  'azure-boards',
  'jira',
  'local',
] as const;
export const BoardProvider = z.enum(BOARD_PROVIDERS);
export type BoardProvider = z.infer<typeof BoardProvider>;

export const BOARD_PROVIDER_WORDS: Readonly<Record<BoardProvider, string>> = {
  'github-issues': 'GitHub Issues',
  'github-projects': 'GitHub Projects',
  'azure-boards': 'Azure Boards',
  jira: 'Jira',
  local: 'On this machine',
};

/** A board the repo names, as Read and Board say it: `Azure Boards acme/Shop/Web`, `Jira SHOP`. */
export const boardHintWords = (h: BoardHint): string => {
  const org = h.organization?.slice(h.organization.lastIndexOf('/') + 1) ?? null;
  const name =
    h.provider === 'azure-boards' && org !== null && org !== h.name ? `${org}/${h.name}` : h.name;

  return `${BOARD_PROVIDER_WORDS[h.provider]} ${name}`;
};

/** A Layer's board the board login can't read, as the install keeps it. */
export type UnreadableBoard = { board: BoardWhere; organization: string; why: string };

/**
 * What Board says when a Layer's board refused the board login, and the repo's own board it
 * offers first: the first Azure board the repo names that is not that one, else any other board
 * it names; null: none.
 */
export const boardProposal = (
  u: UnreadableBoard,
  hints: readonly BoardHint[],
): { said: string; hint: BoardHint | null } => {
  const org = u.organization.slice(u.organization.lastIndexOf('/') + 1);
  const project = u.board.name.split('/')[0];
  const same = (h: BoardHint) =>
    h.provider === 'azure-boards' &&
    h.organization === u.organization &&
    (h.project === null || h.project === project);
  const others = hints.filter((h) => !same(h));
  const hint = others.find((h) => h.provider === 'azure-boards') ?? others[0] ?? null;
  const code = /\b(40[13])\b/.exec(u.why)?.[1];
  const repo =
    hint === null
      ? 'nothing in the repo names a board'
      : `the repo's ${hint.why} names ${boardHintWords(hint)}`;

  return {
    said: `The repo's settings name ${org}/${u.board.name}, which your az login can't read${code === undefined ? '' : ` (${code})`}; ${repo}`,
    hint,
  };
};

export const BoardWhere = z.object({
  provider: BoardProvider,
  /** The board's name as its provider says it (`shop/Storefront`, `PROJ`). */
  name: z.string().min(1),
  /** The repo's settings named it, or `you` when the person answered Read's question. */
  from: z.enum(['repo', 'you']),
  /**
   * An Azure link that names no team (a query, a work item): the project's default team taken
   * (`defaultTeam`), which the Connection check says.
   */
  defaultTeam: z.boolean().optional(),
});
export type BoardWhere = z.infer<typeof BoardWhere>;

export const CiFile = z.object({ file: z.string(), commands: z.array(z.string()) });
export type CiFile = z.infer<typeof CiFile>;

/** One workspace of a monorepo, as its own folder says it. */
export const Workspace = z.object({
  /** Its folder, from the checkout's top (`backend`). */
  dir: z.string(),
  /** Its package.json's scripts by name. */
  scripts: z.record(z.string(), z.string()),
  /** Its scripts that run tests, by name (`test`, `test:e2e`). */
  tests: z.array(z.string()),
  /** Its env example (`backend/.env.example`) and its keys (no values). */
  envExample: z.string().nullable(),
  envKeys: z.array(z.string()),
  /** What it is built with, from its dependencies (`react`, `fastify`, `vitest`). */
  stack: z.array(z.string()),
});
export type Workspace = z.infer<typeof Workspace>;

/** At most this many files are read in the workspaces (package.json, env example, configs, scripts). */
export const WORKSPACE_FILES_READ = 150;
/** At most this many shell scripts the package scripts and CI run are read. */
export const SCRIPTS_READ = 20;

export const ReadFindings = z.object({
  /** The files read, relative to the checkout's top. */
  files: z.array(z.string()),
  ci: z.array(CiFile),
  /** package.json's scripts by name. */
  scripts: z.record(z.string(), z.string()),
  /** The env example keys came from, and its keys (no values). */
  envExample: z.string().nullable(),
  envKeys: z.array(z.string()),
  /** The logins the repo needs (`github`, `claude`, `az`, `aws`), from what was read. */
  logins: z.array(z.string()),
  /** CI logs in to Azure (`azure/login`, Azure Pipelines): az is needed whatever the board is. */
  azureCi: z.boolean().default(false),
  /** The board a Layer names; `null`: Read asks. */
  board: BoardWhere.nullable(),
  /**
   * Ports an auth callback fixes (`localhost:3000/callback` in an env example), or the repo's own
   * dev port when an auth redirect is the page's origin (`originAuth`): Run locally keeps them
   * instead of `ABE_PORT_BASE`, one run at a time.
   */
  fixedPorts: z.array(z.number().int()),
  /** The dev-server ports the repo names itself (a vite or webpack config, a package script). */
  devPorts: z.array(DevPort).default([]),
  /** Where an auth redirect is the page's origin (`path:line text`): its dev port is fixed. */
  originAuth: z.array(z.string()).default([]),
  /** What its sessions may read besides the board and GitHub, as found in the repo. */
  sources: z.array(FoundSource).default([]),
  /**
   * Why the repo needs aws: each place it was found, its file and line and what was there
   * (`package.json:12 @aws-sdk/client-s3`); empty: it does not (Just this Mac skips aws then).
   */
  aws: z.array(z.string()).default([]),
  /**
   * The named aws profiles its scripts and CI use, each with where (`backend/package.json:11
   * creds.sh dev`). Never the repo's login by itself: Logins asks which, these offered first.
   */
  awsProfiles: z.array(AwsProfileSeen).default([]),
  /**
   * Its scripts that write real systems (a deploy, an import, GitHub secrets set), each with where
   * and why: the install's session never runs them on Just this Mac, and asks first on Connected.
   */
  outward: z.array(OutwardScript).default([]),
  /** A monorepo's workspaces (empty: none), and how they were found. */
  workspaces: z.array(Workspace).default([]),
  workspacesFrom: WorkspacesFrom.nullable().default(null),
  /** The caps Read reached: what was left unread. */
  capped: z.array(ReadCap).default([]),
  /**
   * The boards the repo names (Board proposes them): an Azure DevOps origin's org and project
   * first, then each link to Azure Boards, GitHub Projects or Jira and each Azure DevOps org said
   * in prose, in the agent files, README, docs and CI; empty: none.
   */
  boards: z.array(BoardHint).default([]),
  /**
   * The repo's kind, from evidence (ADR 0026): how the stages run. Null: a record from before
   * kinds, run as an app.
   */
  kind: KindFindings.nullable().default(null),
  /** The CI jobs that deploy on a merge to the default branch, and where to (ADR 0026). */
  deploys: z.array(MergeDeploy).default([]),
  /**
   * The env files that hold cloud credentials (aws in the name, or its key names: names only,
   * never a value): never read by a session, and refused to what a local run loads while aws is off.
   */
  cloudCredentials: z.array(CloudCredentials).default([]),
  /**
   * The env files Read would never read whose every key is public (`publicEnvOnly`, the repo's
   * vite `envPrefix` too; names only): readable, so Read never lists them as never read.
   */
  publicEnv: z.array(z.string()).default([]),
  /**
   * Every env file at the top and in the workspaces, examples too, with its key names (never a
   * value), whether git tracks it and what today's rules say: what the Env files stage's prefill
   * reads (ADR 0028).
   */
  envFiles: z.array(EnvFileFound).default([]),
  /**
   * origin's default branch (`origin/main`) when it tracks a `.abe/` this checkout's HEAD does not
   * track the same (a teammate's or an earlier install's, older than this install writes): card
   * worktrees get this install's, that one stays as it is. Absent: none, or the same.
   */
  originAbe: z.string().optional(),
});
export type ReadFindings = z.infer<typeof ReadFindings>;

/** At most this many env files are looked at for cloud credentials. */
export const CREDENTIALS_READ = 40;

/** The `board` setting as the merge has it, and the Layer whose entry won. */
export type BoardSetting = { value: Readonly<Record<string, unknown>>; layer: string };

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/** A `board.provider` setting's word as the install says it. */
const SETTING_TO_INSTALL: Readonly<Record<BoardSettingProvider, BoardProvider>> = {
  azure: 'azure-boards',
  github: 'github-issues',
  local: 'local',
};

/** The board the repo's settings name (ADR 0030: what the org's or team's named moved there). */
export const boardOfSetting = (s: BoardSetting | undefined): BoardWhere | null => {
  if (s?.layer !== 'repo') return null;
  const v = s.value;
  const word = boardProviderOf(v.provider);
  const org = str(v.organization);
  // an Azure DevOps board says its project, its provider unsaid (the `board` setting's own shape)
  const azure = org?.includes('dev.azure.com') === true || str(v.project) !== undefined;
  // the setting says azure, local or github; the install's words are Azure Boards, On this Mac
  // and GitHub Issues
  const given = BoardProvider.safeParse(v.provider);
  const spelled: BoardProvider | undefined =
    word === undefined ? undefined : SETTING_TO_INSTALL[word];
  const provider: BoardProvider | undefined = spelled ?? (given.success ? given.data : undefined);
  const picked = provider ?? (azure ? 'azure-boards' : undefined);
  const named = [str(v.project), str(v.team)].filter((p) => p !== undefined).join('/') || org;
  // a board On this Mac needs no name: it is this Mac's; a GitHub board's is its repo, origin's
  // unless it names one
  const name =
    picked === 'github-issues'
      ? (str(v.repo) ?? 'origin')
      : (named ?? (picked === 'local' ? BOARD_PROVIDER_WORDS.local : undefined));

  return picked === undefined || name === undefined
    ? null
    : { provider: picked, name, from: s.layer };
};

/** A workflow's commands: each `run:` line, and the lines of a `run: |` block. */
export const ciCommands = (text: string): string[] => {
  const out: string[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i] ?? '');

    if (m === null) continue;
    const [, indent = '', rest = ''] = m;

    if (!/^[|>][-+]?\s*$/.test(rest)) {
      if (rest !== '') out.push(rest.replace(/^(['"])(.*)\1$/, '$2'));
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? '';

      if (line.trim() === '') continue;
      if (line.length - line.trimStart().length <= indent.length) break;
      out.push(line.trim());
      i = j;
    }
  }

  return out;
};

const Scripts = z.object({ scripts: z.record(z.string(), z.string()).optional() });
const Package = z.object({
  dependencies: z.record(z.string(), z.unknown()).optional(),
  devDependencies: z.record(z.string(), z.unknown()).optional(),
});

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const scriptsOf = (text: string | undefined): Record<string, string> =>
  text === undefined ? {} : (Scripts.safeParse(parseJson(text)).data?.scripts ?? {});

const depsOf = (text: string | undefined): string[] => {
  const pkg = text === undefined ? undefined : Package.safeParse(parseJson(text)).data;

  return Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
};

const isPackage = (path: string) => path === 'package.json' || path.endsWith('/package.json');
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.');

/** A relative path from `dir`, from the top; undefined: from / or out of the checkout. */
const fromTop = (dir: string, path: string): string | undefined => {
  if (path.startsWith('/') || path.startsWith('~') || path.includes('$')) return undefined;
  const out: string[] = [];

  for (const part of [...(dir === '.' ? [] : dir.split('/')), ...path.split('/')]) {
    if (part === '' || part === '.') continue;
    if (part !== '..') out.push(part);
    else if (out.pop() === undefined) return undefined;
  }

  return out.length === 0 ? '.' : out.join('/');
};

/** A command run from `cwd` (`.` the top), and who runs it. */
type CopyCommand = { cwd: string; by: 'ci' | 'script'; command: string };

/**
 * The env files a command copies an env example to (`cp .env.example .env`, `cp -n`, `cat
 * .env.example > .env`, after a `cd`), from the top, each with who copies it: CI first.
 */
const exampleCopies = (commands: readonly CopyCommand[]): Map<string, 'ci' | 'script'> => {
  const out = new Map<string, 'ci' | 'script'>();

  for (const { cwd, by, command } of [...commands].sort((a, b) => a.by.localeCompare(b.by))) {
    let dir: string | undefined = cwd;

    for (const step of command.split(/&&|\|\||;/)) {
      const [verb, ...args] = step
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/^(['"])(.*)\1$/, '$2'));
      const plain = args.filter((a) => !a.startsWith('-'));

      if (dir === undefined) break;
      if (verb === 'cd') {
        dir = plain[0] === undefined ? undefined : fromTop(dir, plain[0]);
        continue;
      }
      const paths = plain.filter((a) => a !== '>');
      const copy = verb === 'cp' || (verb === 'cat' && plain[1] === '>');
      const [from, to] = copy && paths.length === 2 ? paths : [];

      if (from === undefined || to === undefined || !isEnvExampleName(baseName(from))) continue;
      const target = fromTop(dir, to);

      if (target !== undefined && !out.has(target)) out.set(target, by);
    }
  }

  return out;
};

/** The files that may name the team's board: the README, the docs, CI, the agent files. */
const DOC_PATH =
  /^(readme[^/]*|docs\/.*|\.github\/.*|azure-pipelines\.ya?ml|claude\.md|agents\.md)$/i;

const CALLBACK_KEY = /(CALLBACK|REDIRECT|RETURN|NEXTAUTH|AUTH).*_?(URL|URI)$/;

/** Ports a callback URL to this Mac fixes. */
const fixedPortsOf = (env: ReadonlyMap<string, string>): number[] =>
  [...env]
    .filter(([key]) => CALLBACK_KEY.test(key))
    .flatMap(([, v]) => {
      const m = /^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/i.exec(v);

      return m?.[1] === undefined ? [] : [Number(m[1])];
    });

const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length;

/** A dependency that uses aws: its SDK, CDK, Serverless. */
const AWS_DEPENDENCY = /^(aws-sdk|@aws-sdk\/.+|aws-cdk-lib|aws-cdk|@aws-cdk\/.+|serverless)$/;

/**
 * A file that uses aws: CDK's, Serverless', and the env files a script keeps a profile's
 * credentials in (`.env.aws.dev`, its name only: never read).
 */
const AWS_NAME = /^(cdk\.json|serverless\.(ya?ml|ts|js)|\.env\.aws(\.[\w.-]+)?)$/;

/** A config a named aws profile may be in, read beside a workspace's package.json. */
const PROFILE_CONFIG = /^(cdk\.json|serverless\.ya?ml)$/;

/** In a Terraform file: the aws provider. */
const AWS_TERRAFORM = /provider\s+"aws"|hashicorp\/aws/;

/** In CI: an aws action or command. */
// an action by its name, never its pinned ref (`@<sha>`)
const AWS_CI = /aws-actions\/[\w.-]+|\baws\s+[\w-]+/;

/** A dependency that says what a workspace is built with. */
const STACK =
  /^(react|next|vue|nuxt|svelte|@sveltejs\/kit|@angular\/core|vite|express|fastify|@nestjs\/core|hono|koa|astro|electron|react-native|expo|vitest|jest|mocha|@playwright\/test|cypress|storybook|prisma|drizzle-orm|typeorm|aws-cdk-lib|serverless)$/;

/** A script that runs tests: by its name, or by the runner it calls. */
const TEST_SCRIPT = /^(test|e2e)(:|$)/;
const TEST_RUNNER = /\b(vitest|jest|mocha|playwright\s+test|cypress\s+run|bun\s+test)\b/;

/** The line of the repo Layer's `logins:` naming aws (`- aws`, `- aws: { … }`, `[gh, aws]`). */
const awsLoginLine = (text: string): number | null => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('logins:'));

  if (start < 0) return null;
  if (/^logins:\s*\[.*\baws\b/.test(lines[start] ?? '')) return start + 1;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j] ?? '';

    if (/^\S/.test(line)) break;
    if (/^\s*-\s*aws\b/.test(line)) return j + 1;
  }

  return null;
};

type EnvExample = { file: string; keys: readonly string[] };

/**
 * Why the repo needs aws, strongest first: the names at its top and in its workspaces (`cdk.json`,
 * Serverless'), Terraform's aws provider, CI's aws steps, then its dependencies (each package.json,
 * the main ones first), its env examples, the profiles its scripts name and its sources: each
 * hint's file, line and what was there.
 */
const awsNeeds = (o: {
  files: ReadonlyMap<string, string>;
  names: readonly string[];
  ci: readonly CiFile[];
  envs: readonly EnvExample[];
  profiles: readonly AwsProfileSeen[];
  sources: readonly FoundSource[];
}): string[] => {
  const out: string[] = [];

  // CDK's and Serverless' configs before the env files a script keeps credentials in
  const named = o.names.filter((n) => AWS_NAME.test(baseName(n)));

  for (const name of [
    ...named.filter((n) => !baseName(n).startsWith('.env')),
    ...named.filter((n) => baseName(n).startsWith('.env')),
  ])
    out.push(name);
  for (const [path, text] of o.files) {
    const m = path.endsWith('.tf') ? AWS_TERRAFORM.exec(text) : null;

    if (m !== null) out.push(`${path}:${lineOf(text, m.index)} ${m[0]}`);
  }
  for (const c of o.ci) {
    const text = o.files.get(c.file) ?? '';
    const m = AWS_CI.exec(text);

    if (m !== null) out.push(`${c.file}:${lineOf(text, m.index)} ${m[0]}`);
  }
  // its own aws dependencies, the main ones first (aws-cdk-lib before an alpha module)
  for (const [path, text] of o.files)
    if (isPackage(path))
      for (const dep of depsOf(text)
        .filter((d) => AWS_DEPENDENCY.test(d))
        .sort((a, b) => Number(a.startsWith('@')) - Number(b.startsWith('@'))))
        out.push(`${path}:${lineOf(text, text.indexOf(`"${dep}"`))} ${dep}`);
  for (const e of o.envs) {
    const text = o.files.get(e.file) ?? '';

    for (const key of e.keys.filter((k) => k.startsWith('AWS_')))
      out.push(`${e.file}:${lineOf(text, Math.max(0, text.indexOf(key)))} ${key}`);
  }
  for (const p of o.profiles) {
    const [first] = p.seen;

    if (first !== undefined && !out.includes(first)) out.push(first);
  }
  const layer = o.files.get(REPO_PATH);
  const login = layer === undefined ? null : awsLoginLine(layer);

  if (login !== null) out.push(`${REPO_PATH}:${login} logins: aws`);
  for (const s of o.sources)
    if (/(^|[^a-z])aws/i.test(s.id) || /(^|[^a-z])aws/i.test(s.mcp ?? '')) out.push(s.why);

  return out;
};

/** A workspace from its files: its package.json's scripts and dependencies, its env example. */
const workspaceOf = (files: ReadonlyMap<string, string>, dir: string): Workspace => {
  const pkg = files.get(`${dir}/package.json`);
  const scripts = scriptsOf(pkg);
  const example = ENV_EXAMPLES.map((e) => `${dir}/${e}`).find((p) => files.has(p));

  return {
    dir,
    scripts,
    tests: Object.entries(scripts)
      .filter(([name, command]) => TEST_SCRIPT.test(name) || TEST_RUNNER.test(command))
      .map(([name]) => name),
    envExample: example ?? null,
    envKeys: [...parseEnvFile(example === undefined ? '' : (files.get(example) ?? '')).keys()],
    stack: depsOf(pkg).filter((d) => STACK.test(d)),
  };
};

/** Every login tool, in the order the install checks them. */
const LOGIN_ORDER = ['github', 'claude', 'az', 'aws'];

/**
 * The logins the repo needs once its board is known, in the install's order: what Read found, and
 * az for an Azure board (a Layer's, or the one the person gave Read with `board-where`).
 */
export const loginsWithBoard = (
  logins: readonly string[],
  board: BoardWhere | null,
  azureCi: boolean,
): string[] =>
  LOGIN_ORDER.filter((t) =>
    // az follows the board in force and Azure CI, whatever board Read first saw
    t === 'az'
      ? board?.provider === 'azure-boards' || azureCi
      : logins.includes(t) || (t === 'github' && board?.provider === 'github-issues'),
  );

/**
 * Read's findings from the files read (path → text), the names at the checkout's top, a
 * monorepo's workspaces (each folder and the names in it) and the `board` setting in force.
 */
export const readFindings = (o: {
  files: ReadonlyMap<string, string>;
  board: BoardSetting | undefined;
  names?: readonly string[];
  workspaces?: readonly { dir: string; names: readonly string[] }[];
  workspacesFrom?: WorkspacesFrom | null;
  capped?: readonly ReadCap[];
  /** The lines a search found for an origin-bound auth redirect (`ORIGIN_AUTH_PATTERN`). */
  found?: readonly FoundLine[];
  /** The names Read listed for the kind (`KIND_DIRS`), as paths from the top. */
  kindNames?: readonly string[];
  /** The kind the person said it is (`kind:` in `abe.yaml`, `abe install kind`), over the files'. */
  said?: RepoKindSaid | null;
}): ReadFindings => {
  const ci = [...o.files]
    .filter(([path]) => path.startsWith(`${CI_DIR}/`) || path === 'azure-pipelines.yml')
    .map(([file, text]) => ({ file, commands: ciCommands(text) }));
  const example = ENV_EXAMPLES.find((p) => o.files.has(p));
  const env = parseEnvFile(example === undefined ? '' : (o.files.get(example) ?? ''));
  const board = boardOfSetting(o.board);
  const ciText = ci.map((c) => o.files.get(c.file) ?? '').join('\n');
  const needs = new Set(['github', 'claude']);
  const workspaces = (o.workspaces ?? []).map((w) => workspaceOf(o.files, w.dir));
  const envs: EnvExample[] = [
    ...(example === undefined ? [] : [{ file: example, keys: [...env.keys()] }]),
    ...workspaces.flatMap((w) =>
      w.envExample === null ? [] : [{ file: w.envExample, keys: w.envKeys }],
    ),
  ];
  const names = [
    ...(o.names ?? []),
    ...(o.workspaces ?? []).flatMap((w) => w.names.map((n) => `${w.dir}/${n}`)),
  ];
  const sources = foundSources({ files: o.files, names, envs });
  const awsProfiles = awsProfilesOf(o.files);
  const aws = awsNeeds({ files: o.files, names, ci, envs, profiles: awsProfiles, sources });
  const devPorts = devPortsOf(o.files);
  const originAuth = originAuthOf(o.found ?? []);
  const ports = [
    ...envs.flatMap((e) =>
      fixedPortsOf(e.file === example ? env : parseEnvFile(o.files.get(e.file) ?? '')),
    ),
    ...originFixedPorts(devPorts, originAuth),
  ];

  const deploys = mergeDeploysOf(
    o.files,
    ci.map((c) => c.file),
  );
  const azureCi = /azure\/login@|AzureCLI@/.test(ciText) || o.files.has('azure-pipelines.yml');

  if (azureCi) needs.add('az');
  if (aws.length > 0) needs.add('aws');

  return {
    files: [...o.files.keys()],
    ci,
    scripts: scriptsOf(o.files.get('package.json')),
    envExample: example ?? null,
    envKeys: [...env.keys()],
    logins: loginsWithBoard([...needs], board, azureCi),
    azureCi,
    board,
    fixedPorts: [...new Set(ports)].sort((a, b) => a - b),
    devPorts,
    originAuth,
    sources,
    aws,
    awsProfiles,
    outward: outwardScripts({
      packages: [
        { dir: '.', path: 'package.json' },
        ...workspaces.map((w) => ({ dir: w.dir, path: `${w.dir}/package.json` })),
      ].flatMap(({ dir, path }) => {
        const text = o.files.get(path);

        return text === undefined ? [] : [{ dir, text, scripts: scriptsOf(text) }];
      }),
      files: o.files,
      names: [...new Set([...names, ...(o.kindNames ?? [])])],
    }),
    workspaces,
    workspacesFrom: o.workspacesFrom ?? null,
    capped: [...(o.capped ?? [])],
    boards: boardHintsIn(new Map([...o.files].filter(([path]) => DOC_PATH.test(path)))),
    kind: kindOf({
      files: o.files,
      names: [
        ...new Set([
          ...names,
          ...(o.kindNames ?? []),
          ...[...o.files.keys()].filter((p) => p.endsWith('.tf')),
        ]),
      ],
      workspaces: workspaces.map((w) => w.dir),
      ci: ci.map((c) => c.file),
      deployFiles: deploys.map((d) => d.file),
      said: o.said ?? undefined,
    }),
    deploys,
    // readCheckout's, from the env files' key names
    cloudCredentials: [],
    envFiles: [],
    publicEnv: [],
  };
};

/**
 * Read: the checkout's files through `fs` (paths from its top), its workspaces' too, and the
 * `board` setting in force. Each list is bounded (`DOCS_READ`, `TF_READ`, `WORKSPACES_READ`,
 * `WORKSPACE_FILES_READ`, `SCRIPTS_READ`, `ORIGIN_AUTH_READ` lines searched for an origin-bound
 * auth redirect); a cap reached is in `capped`. Local files only, never the person's own env files.
 */
export const readCheckout = async (
  fs: CheckoutFiles,
  board: BoardSetting | undefined,
  said?: RepoKindSaid | null,
): Promise<ReadFindings> => {
  const capped: ReadCap[] = [];
  const bounded = (paths: readonly string[], cap: number, what: ReadCap['what'], said = cap) => {
    if (paths.length > cap && !capped.some((c) => c.what === what))
      capped.push({ what, cap: said });

    return paths.slice(0, cap);
  };
  const [names, ciNames, docNames, tfNames, kindListed] = await Promise.all([
    fs.list('.'),
    fs.list(CI_DIR),
    fs.list(DOCS_DIR),
    Promise.all(
      TF_DIRS.map(async (d) =>
        (await fs.list(d))
          .filter((n) => n.endsWith('.tf'))
          .sort()
          .map((n) => (d === '.' ? n : `${d}/${n}`)),
      ),
    ),
    Promise.all(KIND_DIRS.map(async (d) => (await fs.list(d)).sort().map((n) => `${d}/${n}`))),
  ]);
  const kindNames = kindListed.flat();
  const ci = ciNames
    .filter((n) => /\.ya?ml$/.test(n))
    .sort()
    .map((n) => `${CI_DIR}/${n}`);
  // the docs a source's link may be in
  const docs = bounded(
    docNames
      .filter((n) => n.endsWith('.md'))
      .sort()
      .map((n) => `${DOCS_DIR}/${n}`),
    DOCS_READ,
    'docs',
  );
  // the Terraform files that may name the aws provider
  const tf = bounded(tfNames.flat(), TF_READ, 'terraform');
  const files = new Map<string, string>();
  const readAll = async (paths: readonly string[]) => {
    const texts = await Promise.all(paths.map(async (p) => [p, await fs.read(p)] as const));

    for (const [path, text] of texts)
      if (text !== undefined && !files.has(path)) files.set(path, text);
  };
  const configs = names.filter((n) => PROFILE_CONFIG.test(n) || DEV_CONFIG.test(n)).sort();

  await readAll([...READ_FILES, ...configs, ...ci, ...docs, ...tf]);
  const found = await findWorkspaces(fs, {
    pkg: files.get('package.json'),
    pnpm: files.get('pnpm-workspace.yaml'),
    names,
  });
  // each workspace's package.json, env example and configs, then the shell scripts they run
  const own = bounded(
    found.dirs.flatMap(({ dir, names: here }) => [
      `${dir}/package.json`,
      ...ENV_EXAMPLES.filter((e) => here.includes(e))
        .slice(0, 1)
        .map((e) => `${dir}/${e}`),
      ...here.filter((n) => PROFILE_CONFIG.test(n) || DEV_CONFIG.test(n)).map((n) => `${dir}/${n}`),
    ]),
    WORKSPACE_FILES_READ,
    'files',
  );

  await readAll(own);
  // the files that say its kind (configs, templates, a Dockerfile), never one with real values
  const kindFiles = [
    ...names,
    ...kindNames,
    ...found.dirs.flatMap(({ dir, names: here }) => here.map((n) => `${dir}/${n}`)),
  ].filter((p) => KIND_FILE.test(baseName(p)) && !neverRead(baseName(p)));
  const ignored = await Promise.all(kindFiles.map(async (p) => (await fs.ignored?.(p)) === true));
  const unignored = kindFiles.filter((_, n) => ignored[n] !== true);

  await readAll(bounded(unignored, KIND_READ, 'config'));
  const runs = [
    ...scriptPaths(Object.values(scriptsOf(files.get('package.json'))), ''),
    ...found.dirs.flatMap(({ dir }) =>
      scriptPaths(Object.values(scriptsOf(files.get(`${dir}/package.json`))), dir),
    ),
    ...scriptPaths(
      ci.flatMap((c) => ciCommands(files.get(c) ?? '')),
      '',
    ),
    // the script CI renders a config with before the deploy: the names it fills from the environment
    ...renderCommands([...ci.map((c) => files.get(c) ?? ''), files.get('package.json') ?? '']).map(
      (c) => c.script,
    ),
  ];
  const room = Math.min(SCRIPTS_READ, WORKSPACE_FILES_READ - own.length);
  const scripts = [...new Set(runs)].filter((p) => !files.has(p));

  await readAll(
    room < SCRIPTS_READ
      ? bounded(scripts, room, 'files', WORKSPACE_FILES_READ)
      : bounded(scripts, room, 'scripts'),
  );

  // the code files a package script runs, and scripts/'s own: read for the outside APIs they call
  const code = [
    ...new Set([
      ...[
        { dir: '.', scripts: scriptsOf(files.get('package.json')) },
        ...found.dirs.map(({ dir }) => ({
          dir,
          scripts: scriptsOf(files.get(`${dir}/package.json`)),
        })),
      ].flatMap(({ dir, scripts }) => runFiles(Object.values(scripts), dir)),
      ...kindNames.filter((n) => n.startsWith('scripts/')),
    ]),
  ].filter((p) => SCRIPT_FILE.test(p) && !files.has(p) && !neverRead(baseName(p)));

  await readAll(bounded(code, SCRIPTS_READ, 'scripts'));

  // an auth redirect that is the page's origin, anywhere git tracks: bounded
  const lines = (await fs.grep?.(ORIGIN_AUTH_PATTERN, ORIGIN_AUTH_READ)) ?? [];
  // the env files with cloud credentials: by their key names (serve's read), else their names
  const envFiles = [
    ...new Set([
      ...names,
      ...kindNames,
      ...found.dirs.flatMap(({ dir, names: here }) => here.map((n) => `${dir}/${n}`)),
    ]),
  ]
    .filter((p) => isEnvFileName(baseName(p)))
    .sort();
  const cloudCredentials: CloudCredentials[] = [];
  const publicEnv: string[] = [];
  const envSeen: EnvFileFound[] = [];

  for (const path of bounded(envFiles, CREDENTIALS_READ, 'files')) {
    const keys = await fs.envKeys?.(path);
    const why = cloudCredentialsWhy(path, keys ?? []);
    const dir = dirOf(path);
    const publicOnly =
      keys !== undefined && publicEnvOnly(keys, await viteEnvPrefixesAt(fs.read, dir));

    if (why !== undefined) cloudCredentials.push({ path, why });
    else if (keys !== undefined && neverRead(baseName(path)) && publicOnly) publicEnv.push(path);
    if (keys !== undefined)
      envSeen.push({
        path,
        keys: [...keys],
        tracked: (await fs.tracked?.(path)) ?? false,
        example: false,
        credential: why ?? null,
        publicOnly,
      });
  }
  // the examples beside them: listed as allowed, never asked
  const examples = [
    ...new Set([
      ...names,
      ...found.dirs.flatMap(({ dir, names: here }) => here.map((n) => `${dir}/${n}`)),
    ]),
  ]
    .filter((p) => isEnvExampleName(baseName(p)))
    .sort();

  for (const path of examples.slice(0, CREDENTIALS_READ)) {
    const keys = await fs.envKeys?.(path);

    if (keys !== undefined)
      envSeen.push({
        path,
        keys: [...keys],
        tracked: (await fs.tracked?.(path)) ?? false,
        example: true,
        credential: null,
        publicOnly: false,
      });
  }

  // what CI or a package script copies an example to, and each env file's example: its folder's,
  // else the top's
  const copies = exampleCopies([
    ...ci.flatMap((c) =>
      ciCommands(files.get(c) ?? '').map((command) => ({ cwd: '.', by: 'ci' as const, command })),
    ),
    ...[{ dir: '.' }, ...found.dirs].flatMap(({ dir }) =>
      Object.values(scriptsOf(files.get(dir === '.' ? 'package.json' : `${dir}/package.json`))).map(
        (command) => ({ cwd: dir, by: 'script' as const, command }),
      ),
    ),
  ]);
  const exampleKeys = new Map(envSeen.filter((f) => f.example).map((f) => [f.path, f.keys]));
  const exampleOf = (dir: string) =>
    ENV_EXAMPLES.map((e) => exampleKeys.get(dir === '.' ? e : `${dir}/${e}`)).find(
      (k) => k !== undefined,
    );
  const envFound = envSeen.map((f): EnvFileFound => {
    if (f.example) return f;
    const example = exampleOf(dirOf(f.path)) ?? exampleOf('.');
    const by = copies.get(f.path);

    return {
      ...f,
      inExample:
        example !== undefined && f.keys.length > 0 && f.keys.every((k) => example.includes(k)),
      ...(by === undefined ? {} : { copiedBy: by }),
    };
  });

  const findings = readFindings({
    files,
    board,
    names,
    workspaces: found.dirs,
    workspacesFrom: found.from,
    capped: [...found.capped, ...capped],
    found: lines,
    kindNames,
    said: said ?? null,
  });

  // each static check that runs none of the repo's code, once on a clean tree: failing ones dropped
  const kind = findings.kind === null ? null : await proveChecks(findings.kind, fs.runChecks);
  const originAbe = await fs.originOnly?.('.abe');

  return {
    ...findings,
    kind,
    cloudCredentials,
    publicEnv,
    envFiles: envFound,
    ...(originAbe === undefined ? {} : { originAbe }),
  };
};
