/**
 * Factory install's repo kind (ADR 0026): what kind of repo Read found, from evidence in its
 * files, and so how the stages run. A web app or a service runs on localhost and passes the gate;
 * config as code, infrastructure as code, a library or a CLI has nothing to run there: Run locally
 * is "nothing to run here", Verify is static checks, and Checks offers cheap static ones for the
 * kind (syntax, JSON and YAML parse, every template placeholder mapped in each environment's
 * mapping file) that run with no secrets and no network. A monorepo has a kind per workspace and
 * runs when one of them does. Pure: serve hands it the files Read read and the names it listed;
 * only names and key names are kept, never a value.
 */
import { z } from 'zod';
import { jsonError } from './check-files';
import { argNames, renderCommands, renderNames } from './install-render';

export const REPO_KINDS = [
  'web-app',
  'service',
  'config',
  'iac',
  'library',
  'cli',
  'unknown',
] as const;

/** A repo kind; `web`, its name before 3.5.28, is read as `web-app`. */
export const RepoKind = z.preprocess((v) => (v === 'web' ? 'web-app' : v), z.enum(REPO_KINDS));
export type RepoKind = z.infer<typeof RepoKind>;

/**
 * The kind the person says the repo is (`kind:` in `abe.yaml`, ADR 0040): one kind, or a
 * monorepo's per part, its folder (`.` the top) to its kind.
 */
export const RepoKindSaid = z.union([RepoKind, z.record(z.string().min(1), RepoKind)]);
export type RepoKindSaid = z.infer<typeof RepoKindSaid>;

/** Each kind in words, as the page and status say it. */
export const KIND_WORDS: Readonly<Record<RepoKind | 'monorepo', string>> = {
  'web-app': 'web app',
  service: 'service / API',
  config: 'config as code',
  iac: 'infrastructure as code',
  library: 'library',
  cli: 'CLI',
  unknown: 'not known: taken for an app',
  monorepo: 'monorepo',
};

/**
 * The stages by kind (ADR 0026's table): whether Run locally starts it and the gate asks its URL,
 * what Verify shows, what Checks takes. `unknown` runs as an app did before kinds.
 */
export const KIND_STAGES: Readonly<
  Record<RepoKind, { runs: boolean; verify: string; checks: string }>
> = {
  'web-app': {
    runs: true,
    verify: 'the app on localhost: its pages in the browser',
    checks: "CI's tests, types and lint",
  },
  service: {
    runs: true,
    verify: 'the service on localhost: its endpoints answered',
    checks: "CI's tests, types and lint",
  },
  config: {
    runs: false,
    verify: 'static checks and the diff read: what only the deployed system runs is said, not run',
    checks: 'static checks: syntax, JSON and YAML parse, placeholders mapped',
  },
  iac: {
    runs: false,
    verify:
      'static only: types, unit tests that need no synth, terraform fmt -check; never synth, plan, deploy or apply',
    checks: 'static checks: types, unit tests with no synth, format, YAML parse, offline',
  },
  library: {
    runs: false,
    verify: 'its tests and its build',
    checks: "CI's tests, types and lint",
  },
  cli: {
    runs: false,
    verify: 'the CLI run on test input, and its tests',
    checks: "CI's tests, types and lint",
  },
  unknown: {
    runs: true,
    verify: 'the app on localhost',
    checks: "CI's checks",
  },
};

/** A file that says so: where (`file` or `file:line`) and what is there. */
export const Evidence = z.object({ at: z.string(), says: z.string() });
export type Evidence = z.infer<typeof Evidence>;

/** A part of the repo (the repo itself `.`, or a workspace) and its kind. */
export const KindPart = z.object({
  dir: z.string(),
  kind: RepoKind,
  evidence: z.array(Evidence),
});
export type KindPart = z.infer<typeof KindPart>;

/** A static check the install can run with no secrets and no network: its name, command, why. */
export const StaticCheck = z.object({
  name: z.string(),
  run: z.string(),
  why: z.string(),
  /**
   * Whether it runs none of the repo's code (it parses files, or reads them with Abe's own
   * program): Read runs it once on a clean tree. Types and tests run the repo's tools: the session
   * runs those in its sandbox.
   */
  inert: z.boolean().default(false),
});
export type StaticCheck = z.infer<typeof StaticCheck>;

/** A check Read ran on a clean tree and that failed: dropped, with what it said. */
export const FailedCheck = z.object({ name: z.string(), run: z.string(), says: z.string() });
export type FailedCheck = z.infer<typeof FailedCheck>;

/** How one check ran: whether it passed, and the tail of what it said. */
export type CheckRun = { ok: boolean; says: string };

/** The longest `says` kept of a failed check. */
export const CHECK_SAYS = 300;

/**
 * Runs `commands` once each on a clean tree of the checkout's HEAD, in order; `undefined`: there is
 * no clean tree to run in.
 */
export type RunChecks = (commands: readonly string[]) => Promise<readonly CheckRun[] | undefined>;

/**
 * The kind's findings with each inert static check run once through `run`: one that fails on a clean main
 * moves from `checks` to `failing` (it would block every card). Without a runner, or when it
 * answers none, the checks stay offered.
 */
export const proveChecks = async (
  found: KindFindings,
  run: RunChecks | undefined,
): Promise<KindFindings> => {
  const inert = found.checks.filter((c) => c.inert);

  if (run === undefined || inert.length === 0) return found;
  const ran = (await run(inert.map((c) => c.run))) ?? [];

  if (ran.length !== inert.length) return found;
  const failed = inert.flatMap((c, n) => {
    const r = ran[n];

    return r?.ok !== false
      ? []
      : [{ name: c.name, run: c.run, says: r.says.trim().slice(-CHECK_SAYS) }];
  });

  return {
    ...found,
    checks: found.checks.filter((c) => !failed.some((f) => f.run === c.run)),
    failing: failed,
  };
};

/** A template's placeholders (`##SHOP_DOMAIN##`, `@@SHOP_DOMAIN@@`), and each environment's mapping file. */
export const Template = z.object({ file: z.string(), placeholders: z.array(z.string()) });
export const Mapping = z.object({
  file: z.string(),
  /** The environment its name says (`config.prod.json`: prod). */
  env: z.string(),
  /** The placeholders it does not map. */
  missing: z.array(z.string()),
  /** The script CI renders it with before the deploy: it fills keys from the environment. */
  renderedBy: z.string().optional(),
});

export const KindFindings = z.object({
  /** The repo's kind: its one part's, or `monorepo` (its parts each one's). */
  kind: z.union([RepoKind, z.literal('monorepo')]),
  parts: z.array(KindPart),
  /** Whether anything runs on localhost (a web app or service part): the gate asks its URL. */
  runs: z.boolean(),
  /** The deploy tools it uses (`a0deploy`, `terraform`), each where first seen. */
  deployTools: z.array(Evidence),
  /** The outside systems its deps and configs name (Auth0, SendGrid, Sentry), each where first seen. */
  systems: z.array(Evidence),
  /** Fixed ports: a Dockerfile's `EXPOSE`, a script's `--port`. */
  ports: z.array(z.object({ port: z.number().int(), at: z.string() })),
  templates: z.array(Template),
  mappings: z.array(Mapping),
  /** The static checks Checks offers for the kind (none for a kind that runs). */
  checks: z.array(StaticCheck),
  /** The static checks Read ran on a clean tree that failed: not offered, said as findings. */
  failing: z.array(FailedCheck).default([]),
  /**
   * The paths there that are never read, by Read or the session: a tool's state (`cdk.context.json`,
   * `cdk.out`, `*.tfstate`, `*.tfvars`), a rendered config, an env file.
   */
  neverRead: z.array(z.string()).default([]),
});
export type KindFindings = z.infer<typeof KindFindings>;

/** Folders whose names Read lists for the kind, besides the top and the workspaces. */
export const KIND_DIRS = [
  'src',
  'config',
  'env',
  'environments',
  'scripts',
  'infra',
  'terraform',
] as const;

/** The files Read reads for the kind (in the top, a workspace or `KIND_DIRS`): at most `KIND_READ`. */
export const KIND_FILE =
  /^(Dockerfile|Chart\.ya?ml|Pulumi\.ya?ml|template\.ya?ml|tenant\.(ya?ml|json)|.+\.template\.(json|ya?ml)|config(\.[\w-]+)?\.json|[\w-]+\.(dev|development|test|qa|uat|stage|staging|prod|production|ci|local)\.json|(dev|development|test|qa|uat|stage|staging|prod|production|ci)\.json)$/i;
export const KIND_READ = 30;

/**
 * A file Read never reads for the kind: one that holds real values (rendered config, secrets, the
 * person's own `.local` files, env files), whatever its name says otherwise.
 */
export const SECRET_FILE = /(generated|secret|credential|\.local\.|^\.env)/i;

/**
 * What a deploy tool keeps beside the code and Read never reads (nor the session): CDK's cached
 * account lookups and synthesized templates, Terraform's state, its folder and its variable files.
 */
export const NEVER_READ =
  /^(cdk\.context\.json|cdk\.out|\.terraform|terraform\.tfstate\.d|.+\.tfstate(\.backup)?|.+\.tfvars(\.json)?)$/;

/** A name Read never reads: a tool's state, a rendered config, an env file (not its example). */
export const neverRead = (name: string): boolean =>
  NEVER_READ.test(name) ||
  (SECRET_FILE.test(name) &&
    !name.endsWith('.md') &&
    !/\.(example|sample|template|dist)$/.test(name));

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const Package = z.object({
  dependencies: z.record(z.string(), z.unknown()).optional(),
  devDependencies: z.record(z.string(), z.unknown()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  main: z.string().optional(),
  module: z.string().optional(),
  exports: z.unknown().optional(),
  types: z.string().optional(),
});
type Package = z.infer<typeof Package>;

const lineOf = (text: string, at: number): number =>
  text.slice(0, Math.max(0, at)).split('\n').length;

/** `file:line` of the first `needle` in `text`, else `file`. */
const where = (file: string, text: string | undefined, needle: string | RegExp): string => {
  if (text === undefined) return file;
  const at = typeof needle === 'string' ? text.indexOf(needle) : (needle.exec(text)?.index ?? -1);

  return at < 0 ? file : `${file}:${lineOf(text, at)}`;
};

/** A folder or file of code that runs, beside a stack: IaC only when a part holds the stack alone. */
const RUNTIME_NAME =
  /^(src|app|server|api|handlers?|functions?|lambdas?|fastify|express|routes|controllers?|(server|handler|lambda)\.[cm]?[jt]s)$/;

const WEB_DEPS =
  /^(react-dom|next|vue|nuxt|svelte|@sveltejs\/kit|@angular\/core|astro|gatsby|solid-js|@remix-run\/react|vite)$/;
const SERVICE_DEPS =
  /^(express|fastify|@nestjs\/core|hono|koa|@hapi\/hapi|restify|@apollo\/server|apollo-server)$/;

/** Bun: its server, a script that runs a file under it, and its packages (only beside one of those). */
const BUN_SERVE = /\bBun\.serve\s*\(/;
const BUN_RUNS =
  /^bun(?:\s+--?[\w-]+(?:=\S+)?)*\s+(?:run\s+)?(?:\.\/)?[\w@./-]+\.[cm]?[jt]sx?(?=$|\s)/;
const BUN_DEPS = /^(bun|@types\/bun|bun-types)$/;
/** The package scripts that start an app. */
const APP_SCRIPTS = ['dev', 'start', 'serve'] as const;

/** Deploy tools by what names them: a command, a dependency, a file. */
const DEPLOY_TOOLS: readonly { tool: string; text: RegExp; dep?: RegExp; file?: RegExp }[] = [
  { tool: 'a0deploy', text: /\ba0deploy\b|auth0-deploy-cli/, dep: /^auth0-deploy-cli$/ },
  // init, plan and validate deploy nothing: a checks job runs them too
  { tool: 'terraform', text: /\bterraform\s+apply\b/, file: /\.tf$/ },
  { tool: 'cdk', text: /\bcdk\s+(deploy|synth)\b/, dep: /^aws-cdk(-lib)?$/, file: /^cdk\.json$/ },
  {
    tool: 'serverless',
    text: /\b(serverless|sls)\s+deploy\b/,
    dep: /^serverless$/,
    file: /^serverless\.(ya?ml|ts|js)$/,
  },
  { tool: 'helm', text: /\bhelm\s+(upgrade|install)\b/, file: /^Chart\.ya?ml$/ },
  { tool: 'pulumi', text: /\bpulumi\s+up\b/, file: /^Pulumi\.ya?ml$/ },
  { tool: 'kubectl', text: /\bkubectl\s+apply\b/ },
  { tool: 'sam', text: /\bsam\s+deploy\b/, file: /^template\.ya?ml$/ },
];

/** Outside systems by a dependency or a key name (`AUTH0_DOMAIN`, `secrets.SENDGRID_API_KEY`). */
const SYSTEMS: readonly { name: string; dep: RegExp; key: RegExp; text?: RegExp }[] = [
  {
    name: 'Auth0',
    dep: /^(auth0|@auth0\/.+|auth0-deploy-cli)$/,
    key: /^AUTH0_/,
    text: /\ba0deploy\b/,
  },
  { name: 'SendGrid', dep: /^@sendgrid\//, key: /^SENDGRID_/ },
  { name: 'Sentry', dep: /^@sentry\//, key: /^SENTRY_/ },
  { name: 'Stripe', dep: /^stripe$/, key: /^STRIPE_/ },
  { name: 'Twilio', dep: /^twilio$/, key: /^TWILIO_/ },
  { name: 'Azure', dep: /^@azure\//, key: /^AZURE_/ },
  { name: 'Datadog', dep: /^(dd-trace|@datadog\/)/, key: /^(DD|DATADOG)_/ },
  { name: 'Contentful', dep: /^contentful/, key: /^CONTENTFUL_/ },
  { name: 'Firebase', dep: /^firebase/, key: /^FIREBASE_/ },
  { name: 'Slack', dep: /^@slack\//, key: /^SLACK_/ },
];

const KEY_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const PLACEHOLDER = /##([A-Z][A-Z0-9_]*)##|@@([A-Z][A-Z0-9_]*)@@/g;
const DOLLAR_PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g;
const isTemplateName = (f: string) => /\.(template|tpl|tmpl)\.[\w]+$/.test(f);

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const inDir = (dir: string, name: string) => (dir === '.' ? name : `${dir}/${name}`);

/** A template's placeholders: `##KEY##` or `@@KEY@@` anywhere, `${KEY}` in a `*.template.*` file. */
const placeholdersOf = (file: string, text: string): string[] => [
  ...new Set([
    ...[...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? m[2] ?? ''),
    ...(isTemplateName(file) ? [...text.matchAll(DOLLAR_PLACEHOLDER)].map((m) => m[1] ?? '') : []),
  ]),
];

/** A mapping file's keys, by name only (it may not be JSON yet: `config.CI.json` with sed marks). */
const keysOf = (text: string): Set<string> =>
  new Set([...text.matchAll(/"([A-Za-z][A-Za-z0-9_]*)"\s*:/g)].map((m) => m[1] ?? ''));

/** The environment a mapping file's name says: `config.prod.json` prod, `prod.json` prod. */
const envOfName = (file: string): string => {
  const parts = baseName(file).split('.');

  return parts.length > 2 ? (parts.at(-2) ?? file) : (parts[0] ?? file);
};

const isJsonName = (f: string) => f.endsWith('.json');

/** The part's evidence and kind, from its package.json, its names and the files read in it. */
const partOf = (o: {
  dir: string;
  pkg: Package | undefined;
  pkgText: string | undefined;
  names: readonly string[];
  files: ReadonlyMap<string, string>;
  /** The files read in the part itself (a workspace's not the top's). */
  own: readonly (readonly [string, string])[];
  templates: readonly { file: string; placeholders: string[] }[];
  /** The CI files: the top's part is deployed by what they run. */
  ci: readonly string[];
}): KindPart => {
  const at = (kind: RepoKind, evidence: Evidence[]): KindPart => ({ dir: o.dir, kind, evidence });
  const pkgFile = inDir(o.dir, 'package.json');
  const deps = Object.keys({ ...o.pkg?.dependencies, ...o.pkg?.devDependencies });
  const depSaid = (re: RegExp): Evidence[] =>
    deps
      .filter((d) => re.test(d))
      .slice(0, 1)
      .map((d) => ({ at: where(pkgFile, o.pkgText, `"${d}"`), says: `${d} in its dependencies` }));
  const named = (re: RegExp, says: string): Evidence[] =>
    o.names
      .filter((n) => re.test(baseName(n)))
      .slice(0, 1)
      .map((n) => ({ at: n, says }));
  const dockerPath = inDir(o.dir, 'Dockerfile');
  const dockerfile = o.files.get(dockerPath);
  const web = depSaid(WEB_DEPS);

  if (web.length > 0) return at('web-app', web);
  const expose = dockerfile === undefined ? null : /^\s*EXPOSE\s+(\d+)/m.exec(dockerfile);
  const bunServes = o.own
    .filter(([, text]) => BUN_SERVE.test(text))
    .slice(0, 1)
    .map(([f, text]) => ({ at: where(f, text, BUN_SERVE), says: 'Bun.serve: a server' }));
  const bunRuns = APP_SCRIPTS.flatMap((name) => {
    const command = o.pkg?.scripts?.[name];

    return command !== undefined && BUN_RUNS.test(command)
      ? [{ at: where(pkgFile, o.pkgText, `"${name}"`), says: `${command}: code bun runs` }]
      : [];
  }).slice(0, 1);
  const bun =
    bunServes.length + bunRuns.length === 0 ? [] : [...bunServes, ...bunRuns, ...depSaid(BUN_DEPS)];
  const service = [
    ...depSaid(SERVICE_DEPS),
    ...(expose === null
      ? []
      : [{ at: where(dockerPath, dockerfile, expose[0]), says: `EXPOSE ${expose[1] ?? ''}` }]),
    ...bun,
  ];

  if (service.length > 0) return at('service', service);
  const a0 = /\ba0deploy\b|auth0-deploy-cli/;
  // a0deploy run by CI or a script deploys it; one a Dockerfile only installs (a CI image shared
  // by several repos) is weaker than any infrastructure file
  const a0In = (f: string, says: string): Evidence[] => {
    const text = o.files.get(f);

    return text !== undefined && a0.test(text)
      ? [{ at: where(f, text, a0), says: `a0deploy ${says}` }]
      : [];
  };
  const strong = [
    ...named(/^tenant\.(ya?ml|json)$/, 'a tenant config'),
    ...depSaid(/^auth0-deploy-cli$/),
    ...(o.dir === '.' ? o.ci : []).flatMap((f) => a0In(f, 'deploys it')),
    ...a0In(pkgFile, 'in its scripts'),
  ];
  const weak = [
    ...a0In(dockerPath, 'installed by its Dockerfile'),
    ...o.templates.map((t): Evidence => {
      const n = t.placeholders.length;

      return { at: t.file, says: `a template: ${n} placeholder${n === 1 ? '' : 's'}` };
    }),
  ];

  if (strong.length > 0) return at('config', [...strong, ...weak]);
  const iac = [
    ...named(/^cdk\.json$/, 'CDK'),
    ...named(/\.tf$/, 'Terraform'),
    ...named(/^Pulumi\.ya?ml$/, 'Pulumi'),
    ...named(/^Chart\.ya?ml$/, 'a Helm chart'),
  ];

  // its stack beside code that runs (handlers, a server, a function's entry): a service it deploys
  const runtime = named(RUNTIME_NAME, 'code that runs: handlers, a server, a function');

  if (iac.length > 0 && runtime.length > 0) return at('service', [...runtime, ...iac]);
  if (iac.length > 0) return at('iac', iac);
  if (weak.length > 0) return at('config', weak);
  if (o.pkg?.bin !== undefined)
    return at('cli', [
      { at: where(pkgFile, o.pkgText, '"bin"'), says: 'bin: a command it installs' },
    ]);
  const entry = (['exports', 'main', 'module', 'types'] as const).find(
    (k) => o.pkg?.[k] !== undefined,
  );

  return entry === undefined
    ? at('unknown', [])
    : at('library', [
        { at: where(pkgFile, o.pkgText, `"${entry}"`), says: `${entry}: what it exports` },
      ]);
};

const shellQuote = (s: string) =>
  /^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;

/**
 * `node -e`'s program: every placeholder in the templates (before `--`) is a key in each mapping
 * file after it. `file=script` is a mapping a render script fills from the environment: the names
 * that script lists (`environmentMappings`, `process.env.NAME`) count as keys of it.
 */
const PLACEHOLDERS_PROGRAM = [
  'const fs = require("fs"); const a = process.argv.slice(1); const i = a.indexOf("--");',
  'const used = new Set(); for (const f of a.slice(0, i)) for (const m of fs.readFileSync(f, "utf8").matchAll(/##([A-Z][A-Z0-9_]*)##|@@([A-Z][A-Z0-9_]*)@@/g)) used.add(m[1] || m[2]);',
  'const names = (t) => { const k = new Set([...t.matchAll(/process[.]env(?:[.]|\\[\\s*[\\x27"])([A-Z][A-Z0-9_]*)/g)].map((m) => m[1])); const l = /\\benvironmentMappings\\b\\s*[:=]\\s*[[{]/.exec(t);',
  'if (l) { const e = t.indexOf(l[0].endsWith("[") ? "]" : "}", l.index + l[0].length); for (const m of t.slice(l.index + l[0].length, e < 0 ? undefined : e).matchAll(/[\\x27"]([A-Z][A-Z0-9_]*)[\\x27"]|^\\s*([A-Z][A-Z0-9_]*)\\s*:/gm)) k.add(m[1] || m[2]); } return k; };',
  'let bad = 0; for (const arg of a.slice(i + 1)) { const [f, script] = arg.split("=");',
  'const keys = new Set([...fs.readFileSync(f, "utf8").matchAll(/"([A-Za-z][A-Za-z0-9_]*)"\\s*:/g)].map((m) => m[1])); if (script) for (const k of names(fs.readFileSync(script, "utf8"))) keys.add(k);',
  'const miss = [...used].filter((k) => !keys.has(k)); if (miss.length > 0) { bad = 1; console.error(f + ": no " + miss.join(", ")); } } process.exit(bad);',
].join(' ');

/** The static checks for the kind: what is there decides which (no JS, no `node --check`). */
const staticChecks = (o: {
  parts: readonly KindPart[];
  names: readonly string[];
  files: ReadonlyMap<string, string>;
  node: boolean;
  /** Whether it has CI workflows (YAML). */
  ci: boolean;
  /** Whether the top is TypeScript (`typescript` and a `tsconfig.json`). */
  typescript: boolean;
  /** The top's `test` script, when it runs tests offline (no cdk, synth or deploy in it). */
  test: string | undefined;
  templates: readonly { file: string; placeholders: string[] }[];
  mappings: readonly { file: string; renderedBy?: string | undefined }[];
}): StaticCheck[] => {
  const config = o.parts.some((p) => p.kind === 'config');
  const iac = o.parts.some((p) => p.kind === 'iac');

  // a repo that runs has CI's checks and its app: static ones only for one with nothing to run
  if ((!config && !iac) || o.parts.some((p) => KIND_STAGES[p.kind].runs)) return [];
  const out: StaticCheck[] = [];
  const has = (re: RegExp) => o.names.some((n) => re.test(n));
  const renders = [
    ...new Set(o.mappings.flatMap((m) => (m.renderedBy === undefined ? [] : [m.renderedBy]))),
  ];

  if (config && o.node && has(/\.(c|m)?js$/))
    out.push({
      name: 'syntax',
      inert: true,
      run: "git ls-files -z -- '*.js' '*.cjs' '*.mjs' | xargs -0 -n1 node --check",
      why: 'every script parses (node --check runs none of it)',
    });
  // a JSON template not JSON yet (sed marks in it) is left out: it would fail on a clean main
  const notJson = [...o.files]
    .filter(([f, text]) => isJsonName(f) && jsonError(text) !== null)
    .map(([f]) => f)
    .sort();

  // JSON and YAML parsed by Abe itself (`abe check`): no tool of the machine's, no network
  if (config && has(/\.json$/))
    out.push({
      name: 'json',
      inert: true,
      run: `git ls-files -z -- '*.json'${notJson.map((f) => ` ${shellQuote(`:!${f}`)}`).join('')} | xargs -0 abe check json`,
      why: `every JSON file parses${notJson.length === 0 ? '' : ` (not ${notJson.join(', ')}: a template, not JSON until rendered)`}`,
    });
  // a YAML template holds placeholders and is not YAML until rendered: left out like a JSON one
  const yamlTemplates = o.templates.filter((t) => /\.ya?ml$/.test(t.file)).map((t) => t.file);

  if (o.ci || has(/\.ya?ml$/))
    out.push({
      name: 'yaml',
      inert: true,
      run: `git ls-files -z -- '*.yml' '*.yaml'${yamlTemplates.map((f) => ` ${shellQuote(`:!${f}`)}`).join('')} | xargs -0 abe check yaml`,
      why: `every YAML file parses, the CI workflows too${yamlTemplates.length === 0 ? '' : ` (not ${yamlTemplates.join(', ')}: a template, not YAML until rendered)`}`,
    });
  if (config && o.node && o.templates.length > 0 && o.mappings.length > 0)
    out.push({
      name: 'placeholders',
      inert: true,
      run: `node -e '${PLACEHOLDERS_PROGRAM}' ${o.templates.map((t) => shellQuote(t.file)).join(' ')} -- ${o.mappings.map((m) => shellQuote(m.renderedBy === undefined ? m.file : `${m.file}=${m.renderedBy}`)).join(' ')}`,
      why: `every ##KEY## and @@KEY@@ in ${o.templates.map((t) => t.file).join(', ')} is mapped in each environment's file${renders.length === 0 ? '' : `, or by the script that renders it (${renders.join(', ')})`}`,
    });
  if (iac && o.typescript)
    out.push({
      name: 'types',
      inert: false,
      run: 'npx --no-install tsc --noEmit',
      why: 'the infrastructure code type-checks (nothing synthesized, no lookups)',
    });
  if (iac && o.test !== undefined)
    out.push({
      name: 'tests',
      inert: false,
      run: 'npm test',
      why: `its unit tests (${o.test}): none synthesizes a stack or reaches a cloud`,
    });
  if (iac && has(/\.tf$/))
    out.push({
      name: 'terraform-fmt',
      inert: true,
      run: 'terraform fmt -check -recursive',
      why: 'Terraform formatted (no init, no plan, no network)',
    });
  for (const chart of iac ? o.names.filter((n) => /(^|\/)Chart\.ya?ml$/.test(n)) : [])
    out.push({
      name: 'helm-lint',
      inert: true,
      run: `helm lint ${shellQuote(chart.includes('/') ? chart.slice(0, chart.lastIndexOf('/')) : '.')}`,
      why: 'the Helm chart renders (offline)',
    });

  return out;
};

/** A `test` script that runs offline: not npm's placeholder, nothing that synthesizes or deploys. */
const offlineTest = (test: string | undefined): string | undefined =>
  test === undefined || /no test specified|\bcdk\b|synth|deploy|terraform|pulumi/.test(test)
    ? undefined
    : test;

/** Ports a script fixes (`--port 3020`, `PORT=3020`, a serve script's port argument). */
const scriptPorts = (pkgFile: string, text: string | undefined, pkg: Package | undefined) =>
  Object.entries(pkg?.scripts ?? {}).flatMap(([name, command]) => {
    // only what serves the repo itself: a studio or a storybook beside it fixes nothing
    if (!/serve|dev|start|preview/.test(name)) return [];
    const flag = /(?:--port[= ]|\bPORT=|\s-p\s)(\d{2,5})\b/.exec(command)?.[1];
    const port = Number(flag ?? /\s(\d{4,5})(?:\s|$)/.exec(command)?.[1]);

    return Number.isInteger(port) && port >= 1024 && port <= 65535
      ? [{ port, at: `${where(pkgFile, text, `"${name}"`)} ${name}` }]
      : [];
  });

/**
 * The repo's kind from the files Read read (path → text), the names it listed (paths from the
 * top: its top's, its workspaces', `KIND_DIRS`'), its workspaces' folders and its CI files.
 */
export const kindOf = (o: {
  files: ReadonlyMap<string, string>;
  names: readonly string[];
  workspaces: readonly string[];
  ci: readonly string[];
  /** The workflows that deploy on a merge (`mergeDeploysOf`): their tools said first. */
  deployFiles?: readonly string[];
  /** The kind the person said it is (one, or per part), over what the files say. */
  said?: RepoKindSaid | undefined;
}): KindFindings => {
  const pkgs = new Map<string, Package>();

  for (const [f, text] of o.files)
    if (baseName(f) === 'package.json') {
      const p = Package.safeParse(parseJson(text));

      if (p.success) pkgs.set(f, p.data);
    }
  const sorted = [...o.files].sort(([a], [b]) => (a < b ? -1 : 1));
  const templates = sorted
    .filter(([f]) => !SECRET_FILE.test(baseName(f)))
    .map(([file, text]) => ({ file, placeholders: placeholdersOf(file, text) }))
    .filter(
      // a script's own `##` (a comment rule, a shell expansion) is no placeholder
      (t) =>
        t.placeholders.length > 0 &&
        !t.file.startsWith('.github/') &&
        !/\.(md|sh|[cm]?[jt]s|py)$/.test(t.file),
    );
  const used = new Set(templates.flatMap((t) => t.placeholders));
  // the render step CI runs before the deploy: the script read fills its input file from the environment
  const renders = renderCommands([
    ...o.ci.map((f) => o.files.get(f) ?? ''),
    ...sorted.filter(([f]) => baseName(f) === 'package.json').map(([, text]) => text),
  ]).filter((c) => o.files.has(c.script));
  const mappings = sorted
    .filter(([f]) => isJsonName(f) && KIND_FILE.test(baseName(f)) && !SECRET_FILE.test(baseName(f)))
    .filter(([f]) => !templates.some((t) => t.file === f))
    .flatMap(([file, text]) => {
      const keys = keysOf(text);
      // a script that lists no name (a copy, a sed) fills nothing from the environment
      const by = renders.find(
        (c) =>
          c.args.some((a) => argNames(a, file)) &&
          renderNames(o.files.get(c.script) ?? '').length > 0,
      )?.script;

      if (by !== undefined) for (const k of renderNames(o.files.get(by) ?? '')) keys.add(k);

      return [...used].some((k) => keys.has(k))
        ? [
            {
              file,
              env: envOfName(file),
              missing: [...used].filter((k) => !keys.has(k)).sort(),
              ...(by === undefined ? {} : { renderedBy: by }),
            },
          ]
        : [];
    });
  const namesIn = (dir: string) =>
    dir === '.'
      ? o.names.filter((n) => !o.workspaces.some((w) => n.startsWith(`${w}/`)))
      : o.names.filter((n) => n.startsWith(`${dir}/`));
  const part = (dir: string) => {
    const pkgFile = inDir(dir, 'package.json');

    return partOf({
      dir,
      pkg: pkgs.get(pkgFile),
      pkgText: o.files.get(pkgFile),
      names: namesIn(dir),
      files: o.files,
      own: [...o.files].filter(([f]) =>
        dir === '.' ? !o.workspaces.some((w) => f.startsWith(`${w}/`)) : f.startsWith(`${dir}/`),
      ),
      templates: templates.filter((t) =>
        dir === '.'
          ? !o.workspaces.some((w) => t.file.startsWith(`${w}/`))
          : t.file.startsWith(`${dir}/`),
      ),
      ci: o.ci,
    });
  };
  const ws = o.workspaces.map((w) => part(w));
  // a monorepo's own top: only when it holds more than the workspaces (Terraform, a tenant)
  const root = part('.');
  const found =
    ws.length === 0
      ? [root]
      : [...(root.kind === 'iac' || root.kind === 'config' ? [topPart(root)] : []), ...ws];
  const parts = saidOver(found, o.said);
  const allDeps = [...pkgs.values()].flatMap((p) =>
    Object.keys({ ...p.dependencies, ...p.devDependencies }),
  );
  // the workflows a merge runs first: the deploy that matters is the one on main
  const ciFirst = [
    ...(o.deployFiles ?? []).filter((f) => o.ci.includes(f)),
    ...o.ci.filter((f) => !(o.deployFiles ?? []).includes(f)),
  ];
  const deployTools = DEPLOY_TOOLS.flatMap((t): Evidence[] => {
    for (const c of ciFirst) {
      const text = o.files.get(c);

      if (text !== undefined && t.text.test(text))
        return [{ at: where(c, text, t.text), says: t.tool }];
    }
    for (const [f, text] of o.files)
      // a Dockerfile that installs a tool deploys nothing: a CI image shared by several repos
      if (baseName(f) === 'package.json' && t.text.test(text))
        return [{ at: where(f, text, t.text), says: t.tool }];
    for (const [f, p] of pkgs) {
      const d =
        t.dep === undefined
          ? undefined
          : Object.keys({ ...p.dependencies, ...p.devDependencies }).find((x) => t.dep?.test(x));

      if (d !== undefined) return [{ at: where(f, o.files.get(f), `"${d}"`), says: t.tool }];
    }
    const file = t.file === undefined ? undefined : o.names.find((n) => t.file?.test(baseName(n)));

    return file === undefined ? [] : [{ at: file, says: t.tool }];
  });
  const systems = SYSTEMS.flatMap((s): Evidence[] => {
    for (const [f, p] of pkgs) {
      const d = Object.keys({ ...p.dependencies, ...p.devDependencies }).find((x) => s.dep.test(x));

      if (d !== undefined) return [{ at: where(f, o.files.get(f), `"${d}"`), says: s.name }];
    }
    for (const [f, text] of o.files) {
      if (SECRET_FILE.test(baseName(f))) continue;
      const key = [...text.matchAll(KEY_NAME)].map((m) => m[0]).find((k) => s.key.test(k));

      if (key !== undefined) return [{ at: where(f, text, key), says: s.name }];
      if (s.text?.test(text) === true) return [{ at: where(f, text, s.text), says: s.name }];
    }

    return [];
  });
  const ports = [
    ...[...o.files].flatMap(([f, text]) =>
      baseName(f) === 'Dockerfile'
        ? [...text.matchAll(/^\s*EXPOSE\s+(\d+)/gm)].map((m) => ({
            port: Number(m[1]),
            at: `${f}:${lineOf(text, m.index)} EXPOSE`,
          }))
        : [],
    ),
    ...[...pkgs].flatMap(([f, p]) => scriptPorts(f, o.files.get(f), p)),
  ];
  const runs = parts.some((p) => KIND_STAGES[p.kind].runs);
  const node = pkgs.size > 0 || o.names.includes('.nvmrc');

  return {
    kind: parts.length > 1 ? 'monorepo' : (parts[0]?.kind ?? 'unknown'),
    parts,
    runs,
    deployTools,
    systems,
    ports,
    templates,
    mappings,
    checks: staticChecks({
      parts,
      names: o.names,
      files: o.files,
      node,
      ci: o.ci.length > 0,
      typescript: allDeps.includes('typescript') && o.names.includes('tsconfig.json'),
      test: offlineTest(pkgs.get('package.json')?.scripts?.test),
      templates,
      mappings,
    }),
    failing: [],
    neverRead: o.names.filter((n) => neverRead(baseName(n))).sort(),
  };
};

/**
 * The parts with what the person said over the files' (Read read it wrong), the files' evidence
 * kept: one kind makes the repo one part of it; per part, each part said takes its kind, one
 * said that Read did not find is added.
 */
const saidOver = (found: readonly KindPart[], said: RepoKindSaid | undefined): KindPart[] => {
  if (said === undefined) return [...found];
  const you = (k: RepoKind): Evidence => ({ at: 'you', says: `said it is ${KIND_WORDS[k]}` });

  if (typeof said === 'string')
    return [{ dir: '.', kind: said, evidence: [you(said), ...found.flatMap((p) => p.evidence)] }];
  const parts = found.map((p) => {
    const k = said[p.dir];

    return k === undefined ? p : { ...p, kind: k, evidence: [you(k), ...p.evidence] };
  });
  const added = Object.entries(said)
    .filter(([dir]) => !found.some((p) => p.dir === dir))
    .map(([dir, k]): KindPart => ({ dir, kind: k, evidence: [you(k)] }));

  return [...parts, ...added];
};

/** A monorepo's own infrastructure part named by its folder when it lives in one (`infra`). */
const topPart = (p: KindPart): KindPart => {
  const dirs = new Set(p.evidence.map((e) => (e.at.includes('/') ? e.at.split('/')[0] : '.')));
  const [only] = dirs;

  return p.kind === 'iac' && dirs.size === 1 && only !== undefined ? { ...p, dir: only } : p;
};

/** The kind in words, with its parts: `monorepo: apps/web (web app), infra (infrastructure as code)`. */
export const kindWords = (s: KindFindings): string =>
  s.kind === 'monorepo'
    ? `monorepo: ${s.parts.map((p) => `${p.dir} (${KIND_WORDS[p.kind]})`).join(', ')}`
    : KIND_WORDS[s.kind];

/**
 * Why Run locally has nothing to run, when the kind says so: null for a kind that runs (or no
 * kind read: an install from before kinds runs as an app).
 */
export const nothingToRun = (s: KindFindings | null | undefined): string | null => {
  if (s === null || s === undefined || s.runs) return null;
  const tools = s.deployTools.map((t) => t.says);

  return `nothing to run here: ${kindWords(s)}${tools.length === 0 ? '' : `, deployed by ${tools.join(', ')}`}`;
};
