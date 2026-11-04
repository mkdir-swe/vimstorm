/**
 * Logins stored once (spec #37, ADR 0016; ticket #55): a person's GitHub, Claude Code and `az`
 * logins kept in one secret of theirs (Secrets Manager in the tooling account, readable only by
 * their boxes and their own SSO role), restored where each tool reads it when a box starts and
 * written back when a tool refreshes it. The secret holds one JSON document: per tool, the files
 * its login lives in (paths under `HOME`, contents base64) and when they were stored.
 *
 * Seeds: secrets put before #55 beside the person's (`abe/<person>/github-token`, a token for
 * `gh auth login --with-token`; `abe/<person>/claude-token`, a `claude setup-token` token). A box
 * reads one only for a tool the person's secret lacks; what it makes of it is stored from then on.
 */
import { z } from 'zod';
import { withoutAnsi } from '../factory/ansi';

export const LOGIN_TOOLS = ['github', 'claude', 'az', 'aws'] as const;
export type LoginTool = (typeof LOGIN_TOOLS)[number];

/**
 * The logins checked on any machine with no repo asked about: `aws` signs in to a profile, so it
 * is checked only for a profile a repo's `logins:` names.
 */
export const MACHINE_LOGINS = ['github', 'claude', 'az'] as const satisfies readonly LoginTool[];

/** `unchecked`: the tool's own check could not run (not on serve's PATH, failing on something else, #160). */
export const LOGIN_STATES = ['ok', 'expired', 'missing', 'unchecked'] as const;
export const LoginState = z.enum(LOGIN_STATES);
export type LoginState = z.infer<typeof LoginState>;

/**
 * Where each tool keeps its login, relative to `HOME`: what is stored and restored. `gh` writes
 * its token into `hosts.yml` (`--insecure-storage`: a box has no keyring); Claude Code on Linux
 * reads `.credentials.json`; `az` keeps its accounts and MSAL's token cache; `aws` its profiles
 * and SSO's token cache. A path ending in `/` is a folder: the `*.json` files directly in it (SSO
 * names its cache files by a hash).
 */
export const LOGIN_FILES: Readonly<Record<LoginTool, readonly string[]>> = {
  github: ['.config/gh/hosts.yml'],
  claude: ['.claude/.credentials.json'],
  az: ['.azure/azureProfile.json', '.azure/msal_token_cache.json', '.azure/clouds.config'],
  aws: ['.aws/config', '.aws/sso/cache/'],
};

/**
 * The file whose presence means the tool holds a login: `az` writes an empty `azureProfile.json`
 * on any command, so only its token cache counts; `aws` a cache file in its SSO folder.
 */
export const LOGIN_MARK: Readonly<Record<LoginTool, string>> = {
  github: '.config/gh/hosts.yml',
  claude: '.claude/.credentials.json',
  az: '.azure/msal_token_cache.json',
  aws: '.aws/sso/cache/',
};

/**
 * Where a box keeps your restored aws login, under `HOME`: a `HOME` of aws's own
 * (`<it>/.aws/config`, `<it>/.aws/sso/cache/`), apart from the `~/.aws/config` Reach writes for
 * box sessions. Only Abe's own check and sign-in (and an install's local start) run aws with it;
 * no agent session reads it (`box-session.ts`'s deny rules).
 */
export const AWS_LOGIN_HOME = '.abe/logins/aws';

/** `rel` is one of `tool`'s login files: named, or a `*.json` directly in a folder it names. */
export const isLoginFile = (tool: LoginTool, rel: string): boolean =>
  LOGIN_FILES[tool].some((f) =>
    f.endsWith('/')
      ? rel.startsWith(f) && /^[\w.-]+\.json$/.test(rel.slice(f.length)) && !rel.includes('..')
      : rel === f,
  );

/**
 * Each tool's own device or browser login, run on the person's terminal by `abe login <tool>`:
 * it prints the URL and code to open on the Mac. Claude Code's is `setup-token` (a token for a
 * year that never renews itself): a refreshing login would rotate its refresh token on one box
 * and leave the person's other boxes holding a dead one.
 */
export const LOGIN_ARGV: Readonly<Record<LoginTool, readonly string[]>> = {
  github: [
    'gh',
    'auth',
    'login',
    '--hostname',
    'github.com',
    '--git-protocol',
    'https',
    '--web',
    '--insecure-storage',
  ],
  claude: ['claude', 'setup-token'],
  az: ['az', 'login', '--use-device-code', '--allow-no-subscriptions'],
  aws: ['aws', 'sso', 'login', '--use-device-code'],
};

/**
 * `LOGIN_ARGV[tool]`, signing `az` in to `tenant` (an id or domain) and `aws` to `profile` (an
 * SSO profile in its config) when one is named.
 */
export const loginArgv = (
  tool: LoginTool,
  tenant?: string,
  profile?: string,
): readonly string[] => {
  if (tool === 'az' && tenant !== undefined) return [...LOGIN_ARGV.az, '--tenant', tenant];
  if (tool === 'aws' && profile !== undefined) return [...LOGIN_ARGV.aws, '--profile', profile];

  return LOGIN_ARGV[tool];
};

/**
 * `abe login github` and `abe login claude` on the Mac: the tool's own browser login, kept where
 * the tool keeps it (gh's keyring, Claude Code's own). Never stored: a box signs in on its own.
 */
export const MAC_LOGIN_ARGV: Readonly<Record<'github' | 'claude', readonly string[]>> = {
  github: ['gh', 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
  claude: ['claude', 'auth', 'login'],
};

/**
 * `abe login aws` on the Mac: SSO's own browser login for `profile` in the person's own config,
 * then the profile stored in their secret for their boxes (`awsConfigFor`).
 */
export const macAwsLoginArgv = (profile: string): readonly string[] => [
  'aws',
  'sso',
  'login',
  '--profile',
  profile,
];

/**
 * `abe login az` on the Mac (#237): `az`'s own browser login, into a folder of its own (never the
 * person's `~/.azure`), stored in their secret for their boxes. Entra's security defaults refuse
 * a device-code sign-in from a box; a browser sign-in on the Mac is the ordinary kind.
 */
export const macAzLoginArgv = (tenant?: string): readonly string[] => [
  'az',
  'login',
  '--allow-no-subscriptions',
  ...(tenant === undefined ? [] : ['--tenant', tenant]),
];

/**
 * The Entra refusal `text` names, if any (#237): `AADSTS530035` (security defaults block a
 * device-code sign-in) or `AADSTS53000`–`53004` (Conditional Access).
 */
export const entraBlock = (text: string): string | undefined =>
  /AADSTS(?:530035|5300[0-4])(?!\d)/.exec(text)?.[0];

/** What blocks the sign-in and what to do, in plain words, by Entra's code. */
export const entraBlockText = (code: string): string => {
  if (code === 'AADSTS530035')
    return `Microsoft Entra's security defaults refuse a device-code sign-in like a box's (${code}). Sign in on your own machine instead: abe login az there keeps the login for your boxes. Or an Entra admin turns security defaults off.`;
  if (code === 'AADSTS53004')
    return `Microsoft Entra wants you to set up multi-factor authentication first (${code}): do it at https://aka.ms/mfasetup, then sign in again.`;

  return `Microsoft Entra's Conditional Access blocked this sign-in (${code}): a policy refuses this device or place. An Entra admin must allow it.`;
};

/**
 * `az login` as a person runs it: Boards needs no Azure subscription, so none is asked for; into
 * `dir` (`$AZURE_CONFIG_DIR`) when a folder is in force.
 */
export const azLoginCommand = (dir?: string | null): string =>
  `${dir === undefined || dir === null ? '' : `AZURE_CONFIG_DIR=${dir} `}az login --allow-no-subscriptions`;

/**
 * Each login's name, its check and the tool's own login (on the Mac, with no login secret; a box's
 * is `abe login <tool>`, which stores what the tool wrote).
 */
export const LOGINS: Readonly<Record<LoginTool, { label: string; check: string; login: string }>> =
  {
    github: { label: 'GitHub', check: 'gh auth status', login: 'gh auth login --web' },
    claude: { label: 'Claude', check: 'claude auth status', login: 'claude auth login' },
    az: { label: 'Azure DevOps', check: 'az account get-access-token', login: azLoginCommand() },
    aws: { label: 'AWS', check: 'aws sts get-caller-identity', login: 'aws sso login' },
  };

/**
 * The az folder in force at a checkout and whose it is (ADR 0030): serve's own `$AZURE_CONFIG_DIR`,
 * or yours for this repo (`board.azureConfigDir`).
 */
export const AzLoginFolder = z.object({
  dir: z.string(),
  from: z.enum(['environment', 'checkout']),
});
export type AzLoginFolder = z.infer<typeof AzLoginFolder>;

/** The az folder in force, or none: az's own `~/.azure`. */
export type AzFolderFact = AzLoginFolder | { from: 'none'; dir: null };

/** Which az folder a checkout reads, in words; `outside` a checkout, no checkout named. */
export const azFolderWords = (az: AzFolderFact, outside = false): string => {
  const reads = outside ? '' : 'this checkout reads ';

  switch (az.from) {
    case 'checkout':
      return `this checkout reads az from ${az.dir} (board.azureConfigDir here)`;
    case 'environment':
      return `serve's $AZURE_CONFIG_DIR ${az.dir} overrides the Layers`;
    case 'none':
      return `${reads}az's own folder (~/.azure)`;
  }
};

/** A folder for az's login that a restart keeps, as a fix suggests it. */
const KEPT_AZ_DIR = '~/.config/az';

/** An az folder under `/tmp`, which macOS empties on restart: where to keep it instead. */
const azTmpWords = (az: AzLoginFolder): string | undefined => {
  if (!/^\/(?:private\/)?tmp(?:\/|$)/.test(az.dir)) return undefined;
  const wiped = `${az.dir} is wiped on restart`;

  return az.from === 'environment'
    ? `${wiped}: start abe serve with $AZURE_CONFIG_DIR under ~/.config, like ${KEPT_AZ_DIR}`
    : `${wiped}: use a folder under ~/.config (abe settings set board.azureConfigDir ${KEPT_AZ_DIR} --mine)`;
};

/** The longest stderr line a failed check's row shows. */
const SAID_MAX = 200;

/** A failed check's first stderr line, when it is short and holds no token (`eyJ…`, a JWT's start). */
export const checkSaid = (stderr: string): string | undefined => {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');

  return line === undefined || line.length > SAID_MAX || line.includes('eyJ') ? undefined : line;
};

/**
 * Why a login is not usable, beyond its state: az's folder that was checked (and a `/tmp` one's
 * warning), then what the tool's check said. `outside`: asked outside a checkout.
 */
export const loginNote = (
  tool: LoginTool,
  d: Pick<LoginStatusData, 'azureConfigDir' | 'said' | 'outside'>,
): string | undefined => {
  const folder = d.azureConfigDir;
  const parts = [
    ...(tool === 'az'
      ? [
          azFolderWords(folder ?? { from: 'none', dir: null }, d.outside === true),
          ...(folder === undefined ? [] : [azTmpWords(folder)]),
        ]
      : []),
    ...(d.said?.[tool] === undefined ? [] : [`${tool} said: ${d.said[tool]}`]),
  ].filter((p) => p !== undefined);

  return parts.length === 0 ? undefined : parts.join('; ');
};

/** az working in a checkout: who it signed in as, and the folder it was checked in. */
const azOkNote = (d: Pick<LoginStatusData, 'who' | 'azureConfigDir'>): string => {
  const folder = azFolderWords(d.azureConfigDir ?? { from: 'none', dir: null });

  return d.who?.az === undefined ? folder : `signed in as ${d.who.az}; ${folder}`;
};

/**
 * The command that signs `tool` in: with a login secret (a box) abe's own, else the tool's (az's
 * into `az`, the folder in force). `aws` is always abe's, for its profile: on the Mac it signs in
 * there and stores it for your boxes.
 */
export const loginFix = (
  tool: LoginTool,
  secret: string | null,
  profile?: string | null,
  az?: AzLoginFolder,
): string => {
  if (tool === 'aws')
    return `abe login aws${profile === undefined || profile === null ? '' : ` --profile ${profile}`}`;
  if (secret !== null) return `abe login ${tool}`;

  return tool === 'az' ? azLoginCommand(az?.dir) : LOGINS[tool].login;
};

/** What a seed secret is called, beside the person's own: `abe/<person>/<seed>`. */
export const SEEDS: Readonly<Partial<Record<LoginTool, string>>> = {
  github: 'github-token',
  claude: 'claude-token',
};

/** How long a `claude setup-token` token lasts. */
export const SETUP_TOKEN_MS = 365 * 24 * 60 * 60_000;

/** The most a secret's value holds (Secrets Manager's limit, in bytes). */
export const SECRET_MAX_BYTES = 65_536;

/** How often a box looks for a refreshed login to write back (well within a minute). */
export const LOGIN_SYNC_EVERY_MS = 20_000;

/** One tool's stored login: its files (path under `HOME` → base64) and when they were stored. */
export const StoredLogin = z.object({
  storedAt: z.iso.datetime(),
  files: z.record(z.string(), z.string()),
});
export type StoredLogin = z.infer<typeof StoredLogin>;

export const LoginDoc = z.object({
  v: z.literal(1),
  logins: z.object({
    github: StoredLogin.optional(),
    claude: StoredLogin.optional(),
    az: StoredLogin.optional(),
    aws: StoredLogin.optional(),
  }),
});
export type LoginDoc = z.infer<typeof LoginDoc>;

export const emptyLoginDoc = (): LoginDoc => ({ v: 1, logins: {} });

/** The secret's value as a document: none yet is no logins; another shape is refused, never overwritten. */
export const readLoginDoc = (
  text: string | null,
): { ok: true; doc: LoginDoc } | { ok: false; message: string } => {
  if (text === null) return { ok: true, doc: emptyLoginDoc() };
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: 'the login secret holds no JSON' };
  }
  const read = LoginDoc.safeParse(json);

  return read.success
    ? { ok: true, doc: read.data }
    : { ok: false, message: 'the login secret holds a document Abe does not read' };
};

/** `doc` with `tool`'s login replaced; every other tool's as it was. */
export const withLogin = (
  doc: LoginDoc,
  tool: LoginTool,
  files: Readonly<Record<string, string>>,
  storedAt: string,
): LoginDoc => ({ v: 1, logins: { ...doc.logins, [tool]: { storedAt, files: { ...files } } } });

/** UTF-8 length without TextEncoder (core has no DOM or Node types). */
export const utf8Bytes = (text: string): number => {
  let n = 0;

  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;

    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c < 0x10000) n += 3;
    else n += 4;
  }

  return n;
};

/** The document as the secret's value, refused past what a secret holds. */
export const loginDocText = (
  doc: LoginDoc,
): { ok: true; text: string } | { ok: false; message: string } => {
  const text = JSON.stringify(doc);
  const bytes = utf8Bytes(text);

  return bytes > SECRET_MAX_BYTES
    ? {
        ok: false,
        message: `the logins come to ${bytes} bytes; a secret holds ${SECRET_MAX_BYTES}`,
      }
    : { ok: true, text };
};

export type RestorePlan = {
  /** Stored logins written where their tool reads them. */
  write: LoginTool[];
  /** Local logins newer than the stored one (or with none stored): kept, then written back. */
  keep: LoginTool[];
  /** Tools with nothing stored and nothing here: read from their seed, if it exists. */
  seed: LoginTool[];
};

/**
 * What a box does on start, from the stored document and each tool's newest local file's mtime
 * (`null`: none of its files here). A login refreshed here but not yet written back is newer
 * than the stored one and stays.
 */
export const restorePlan = (
  doc: LoginDoc,
  local: Readonly<Partial<Record<LoginTool, number | null>>>,
): RestorePlan => {
  const plan: RestorePlan = { write: [], keep: [], seed: [] };

  for (const tool of LOGIN_TOOLS) {
    const stored = doc.logins[tool];
    const here = local[tool] ?? null;

    if (stored !== undefined) {
      if (here !== null && here > Date.parse(stored.storedAt)) plan.keep.push(tool);
      else plan.write.push(tool);
    } else if (here !== null) plan.keep.push(tool);
    else if (SEEDS[tool] !== undefined) plan.seed.push(tool);
  }

  return plan;
};

/** Only the files a tool keeps its login in: a stored document never names any other path. */
export const restorable = (
  tool: LoginTool,
  files: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(Object.entries(files).filter(([rel]) => isLoginFile(tool, rel)));

/**
 * Which way a login goes when the copy here and the stored one differ: the newer wins. `store`
 * when nothing is stored or this one is newer, `pull` when the stored one is (another box of the
 * person's refreshed it), `same` when they already agree.
 */
export const syncWay = (o: {
  stored: StoredLogin | undefined;
  localMtimeMs: number;
  same: boolean;
}): 'store' | 'pull' | 'same' => {
  if (o.stored === undefined) return 'store';
  if (o.same) return 'same';

  return o.localMtimeMs > Date.parse(o.stored.storedAt) ? 'store' : 'pull';
};

/** A seed's value: the token itself, or `{"token": "…"}` (as #63 reads them). */
export const seedToken = (text: string): string => {
  try {
    const wrapped = z.object({ token: z.string().min(1) }).safeParse(JSON.parse(text));

    if (wrapped.success) return wrapped.data.token;
  } catch {
    // Not JSON: the token itself.
  }

  return text.trim();
};

/** A seed's secret: the person's secret's sibling (`abe/ada/logins` → `abe/ada/github-token`). */
export const seedSecret = (secret: string, tool: LoginTool): string | undefined => {
  const seed = SEEDS[tool];

  if (seed === undefined) return undefined;
  // An ARN ends in Secrets Manager's own six characters (`-AbCdEf`); a sibling's name has its own.
  const name = secret.startsWith('arn:') ? secret.replace(/-[A-Za-z0-9]{6}$/, '') : secret;

  return name.replace(/[^/:]+$/, seed);
};

/** The region an ARN names; a plain name leaves it to `aws`'s own configuration. */
export const regionOfSecret = (secret: string): string | null => {
  const m = /^arn:[^:]+:secretsmanager:([^:]+):/.exec(secret);

  return m?.[1] ?? null;
};

/** The token `claude setup-token` printed, from what its terminal showed (the last one). */
export const setupTokenOf = (screen: string): string | undefined =>
  withoutAnsi(screen)
    .match(/sk-ant-oat\d\d-[A-Za-z0-9_-]{20,}/g)
    ?.at(-1);

/**
 * A `setup-token` token as the credentials file Claude Code reads on Linux: no refresh token, so
 * it never rotates, ending when the token does.
 */
export const claudeCredentials = (token: string, expiresAt: number): string =>
  `${JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      refreshToken: null,
      expiresAt,
      scopes: ['user:inference'],
      subscriptionType: null,
    },
  })}\n`;

const ClaudeFile = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().nullish(),
    expiresAt: z.number().nullish(),
  }),
});

export type ClaudeProbe = { expiresAt: number | null; refreshes: boolean };

/** What Claude Code's credentials file says of its login: when it ends, whether it renews itself. */
export const claudeProbe = (text: string): ClaudeProbe | undefined => {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const read = ClaudeFile.safeParse(json);

  if (!read.success) return undefined;
  const o = read.data.claudeAiOauth;

  return {
    expiresAt: o.expiresAt ?? null,
    refreshes: typeof o.refreshToken === 'string' && o.refreshToken !== '',
  };
};

/** The token in Claude Code's credentials file: a box session's `CLAUDE_CODE_OAUTH_TOKEN`. */
export const claudeTokenOf = (text: string): string | undefined => {
  try {
    const read = ClaudeFile.safeParse(JSON.parse(text));

    return read.success ? read.data.claudeAiOauth.accessToken : undefined;
  } catch {
    return undefined;
  }
};

/** github.com's token in `gh`'s `hosts.yml` (written with `--insecure-storage`): a box session's GitHub login. */
export const githubTokenOf = (hostsYml: string): string | undefined => {
  const host = /^github\.com:\s*$([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(hostsYml)?.[1] ?? '';

  return /^\s+oauth_token:\s*["']?([^\s"']+)["']?\s*$/m.exec(host)?.[1];
};

/**
 * What a tool's own login check said: it ran and the login works or not, or it could not say
 * (`cannot`: why, e.g. `gh not found on serve's PATH`).
 */
/** A login's check; `who`: the account it works as (`ada`, `ada@example.com`), never a secret. */
export type LoginCheck =
  | {
      works: boolean;
      blocked?: string;
      who?: string;
      /** A failed check's first stderr line (`checkSaid`): short, never a token. */
      said?: string;
    }
  | { cannot: string };

export type LoginProbe = {
  /** Any of the tool's login files is here. */
  present: boolean;
  /** The tool's own check (`gh auth status`, `az account get-access-token`, `claude auth status`). */
  check: LoginCheck;
  /** Claude Code's credentials file, read (`claudeProbe`). */
  claude: ClaudeProbe | undefined;
  now: number;
};

/**
 * `ok`, `expired`, `missing` or `unchecked`. `gh` and `az` say themselves whether their login
 * works (they ask GitHub and Entra). Claude Code's status reads only its file, so its file's end
 * decides: a `setup-token` token past its year is expired; a login that renews itself stays ok. A
 * check that could not run says nothing of the login (#160): `unchecked`, never `expired`.
 */
export const loginState = (tool: LoginTool, p: LoginProbe): LoginState => {
  if (tool === 'claude' && p.claude !== undefined)
    return p.claude.expiresAt !== null && p.claude.expiresAt <= p.now && !p.claude.refreshes
      ? 'expired'
      : 'ok';
  if ('cannot' in p.check) return 'unchecked';
  if (p.check.works) return 'ok';

  return p.present && tool !== 'claude' ? 'expired' : 'missing';
};

// The commands' answers.

/** `aws` only when a profile was asked about (`MACHINE_LOGINS`): `awsProfile` names it. */
const toolStates = z.object({
  github: LoginState,
  claude: LoginState,
  az: LoginState,
  aws: LoginState.optional(),
});

// The `logins:` setting: which logins a repo needs.

/** The names `logins:` takes for each tool: `gh` as the CLI is called, or the tool's own. */
export const LOGIN_NAMES = {
  gh: 'github',
  github: 'github',
  claude: 'claude',
  az: 'az',
  aws: 'aws',
} as const satisfies Record<string, LoginTool>;
export type LoginName = keyof typeof LOGIN_NAMES;

const LOGIN_NAME_LIST = ['gh', 'github', 'claude', 'az', 'aws'] as const satisfies LoginName[];
const loginName = z.enum(LOGIN_NAME_LIST);

/** A login's options: `aws` an SSO profile (`sso`: signed in with SSO, the default), `az` a tenant. */
const LoginOptions = z.strictObject({
  profile: z
    .string()
    .regex(/^[\w.@-]+$/, 'an aws profile name')
    .optional(),
  sso: z.boolean().optional(),
  tenant: z
    .string()
    .regex(/^[\w.-]+$/, 'an Entra tenant (id or domain)')
    .optional(),
});

/**
 * One entry of `logins:`: a tool's name (`gh`), or a tool with its options (`aws: { profile:
 * storefront-test, sso: true }`). `profile` and `sso` are aws's, `tenant` az's.
 */
export const LoginEntryValue = z.union([
  loginName,
  z
    .partialRecord(loginName, LoginOptions)
    .refine((o) => Object.keys(o).length === 1, { message: 'one tool per entry' })
    .superRefine((o, ctx) => {
      for (const name of LOGIN_NAME_LIST) {
        const opts = o[name];

        if (opts === undefined) continue;
        const tool = LOGIN_NAMES[name];

        if (tool !== 'aws' && (opts.profile !== undefined || opts.sso !== undefined))
          ctx.addIssue({ code: 'custom', message: `profile and sso are aws's, not ${name}'s` });
        if (tool !== 'az' && opts.tenant !== undefined)
          ctx.addIssue({ code: 'custom', message: `tenant is az's, not ${name}'s` });
      }
    }),
]);
export type LoginEntryValue = z.infer<typeof LoginEntryValue>;

/** A login a repo needs: its tool, the name `logins:` gives it, and its options. */
export type LoginNeed = {
  tool: LoginTool;
  /** As written: `gh`. */
  name: LoginName;
  /** aws's SSO profile; `null` for the others, or aws with none named. */
  profile: string | null;
  /** az's tenant. */
  tenant: string | null;
};

const needOf = (e: LoginEntryValue): LoginNeed => {
  const name =
    typeof e === 'string' ? e : (LOGIN_NAME_LIST.find((n) => e[n] !== undefined) ?? 'gh');
  const opts = typeof e === 'string' ? undefined : e[name];

  return {
    tool: LOGIN_NAMES[name],
    name,
    profile: opts?.profile ?? null,
    tenant: opts?.tenant ?? null,
  };
};

/** The merged `logins:` as the logins it names, one per tool, in order. */
export const loginNeeds = (value: readonly LoginEntryValue[]): LoginNeed[] => value.map(needOf);

/** Down the Layers an entry adds its tool, or replaces the options of a tool named above. */
export const addLogins = (
  above: readonly LoginEntryValue[],
  written: readonly LoginEntryValue[],
): LoginEntryValue[] => {
  const out = [...above];

  for (const w of written) {
    const i = out.findIndex((e) => needOf(e).tool === needOf(w).tool);

    if (i === -1) out.push(w);
    else out[i] = w;
  }

  return out;
};

/** The aws profile the needs name, if any: the one `abe login status` checks aws for. */
export const awsProfileOf = (needs: readonly LoginNeed[]): string | null =>
  needs.find((n) => n.tool === 'aws')?.profile ?? null;

/** One login a repo needs, as checked here. */
export const RepoLoginRow = z.object({
  tool: z.enum(LOGIN_TOOLS),
  /** As `logins:` writes it (`gh`). */
  name: z.string(),
  profile: z.string().nullable(),
  state: LoginState,
  /** Who it is signed in as, while it works. */
  who: z.string().nullable(),
  /** The command that signs it in (opened in Terminal for the person), `null` when ok or none helps. */
  fix: z.string().nullable(),
  /**
   * What else to know: not ok, az's folder that was checked and what the check said; az ok, who it
   * signed in as and that folder.
   */
  note: z.string().optional(),
});
export type RepoLoginRow = z.infer<typeof RepoLoginRow>;

/**
 * Which logins a repo needs and which of them are not usable here: `missing` the tools with no
 * login or an expired one (a sign-in fixes them), `unchecked` those whose check could not run;
 * `ready` when every one is ok. A repo with no `logins:` needs none and is ready.
 */
export const RepoLogins = z.object({
  repo: z.string(),
  needs: z.array(RepoLoginRow),
  missing: z.array(z.enum(LOGIN_TOOLS)),
  unchecked: z.array(z.enum(LOGIN_TOOLS)),
  ready: z.boolean(),
});
export type RepoLogins = z.infer<typeof RepoLogins>;

/**
 * `abe login status`: each tool's state, why an `unchecked` one could not be checked, the Entra
 * refusal (`AADSTS53003`) a check met (#237), and the person's secret (`null`: this serve keeps none).
 */
export const LoginStatusData = z.object({
  secret: z.string().nullable(),
  logins: toolStates,
  unchecked: z.partialRecord(z.enum(LOGIN_TOOLS), z.string()).optional(),
  blocked: z.partialRecord(z.enum(LOGIN_TOOLS), z.string()).optional(),
  /** Who each working login is signed in as (#345), where its tool says. */
  who: z.partialRecord(z.enum(LOGIN_TOOLS), z.string()).optional(),
  /** What a failed check said (`checkSaid`), where it said something short and no token. */
  said: z.partialRecord(z.enum(LOGIN_TOOLS), z.string()).optional(),
  /** The az folder it was checked in; none: az's own `~/.azure`. */
  azureConfigDir: AzLoginFolder.optional(),
  /** Asked outside a checkout: no checkout's folder is in force. */
  outside: z.literal(true).optional(),
  /** The aws profile `logins.aws` was checked for. */
  awsProfile: z.string().optional(),
  /** With `--repo`: the logins its `logins:` names, against these. */
  repo: RepoLogins.optional(),
});
export type LoginStatusData = z.infer<typeof LoginStatusData>;

/**
 * The single answer to "which logins does this repo need, and which are missing here": each need
 * of its `logins:` against `status` (checked with the needs' aws profile, `awsProfileOf`). A tool
 * `status` did not check (aws with no profile asked) is `unchecked`.
 */
export const repoLogins = (
  repo: string,
  needs: readonly LoginNeed[],
  status: Pick<
    LoginStatusData,
    'secret' | 'logins' | 'who' | 'blocked' | 'said' | 'azureConfigDir'
  >,
): RepoLogins => {
  const rows = needs.map((n): RepoLoginRow => {
    const state = status.logins[n.tool] ?? 'unchecked';
    const blocked = status.blocked?.[n.tool];
    const signs = state !== 'ok' && state !== 'unchecked' && blocked === undefined;
    const failed = signs ? loginNote(n.tool, { ...status, outside: undefined }) : undefined;
    // az ok: who it signed in as and where, so a login in another folder or tenant shows
    const note = n.tool === 'az' && state === 'ok' ? azOkNote(status) : failed;

    return {
      tool: n.tool,
      name: n.name,
      profile: n.profile,
      state,
      who: state === 'ok' ? (status.who?.[n.tool] ?? null) : null,
      fix: signs ? loginFix(n.tool, status.secret, n.profile, status.azureConfigDir) : null,
      ...(note === undefined ? {} : { note }),
    };
  });
  const by = (s: (st: LoginState) => boolean) => rows.filter((r) => s(r.state)).map((r) => r.tool);

  return {
    repo,
    needs: rows,
    missing: by((s) => s === 'missing' || s === 'expired'),
    unchecked: by((s) => s === 'unchecked'),
    ready: rows.every((r) => r.state === 'ok'),
  };
};

/** A need as a person reads it: `aws (storefront-test)`, `gh`. */
const needWords = (r: Pick<RepoLoginRow, 'name' | 'profile'>) =>
  r.profile === null ? r.name : `${r.name} (${r.profile})`;

/**
 * Why a card's run or an install stops at Needs you over the repo's logins, or `null` when every
 * one is ok: each one not usable and its sign-in, which the person runs in Terminal themselves.
 */
export const repoLoginsReason = (r: RepoLogins): string | null => {
  const bad = r.needs.filter((n) => n.state !== 'ok');

  if (bad.length === 0) return null;

  return [
    `this repo needs logins that aren't usable here (its logins:). Sign in yourself in Terminal; the agent never types a password or reads a token:`,
    ...bad.map(
      (n) =>
        `- ${needWords(n)}: ${n.state}${n.note === undefined ? '' : ` (${n.note})`}${n.fix === null ? '' : `, sign in with: ${n.fix}`}`,
    ),
  ].join('\n');
};

/**
 * `abe login <tool>`: the tool's login stored in the person's secret; `from: 'mac'` when it was
 * signed in on the Mac for the person's boxes (#237); `azureConfigDir`: the az folder it signed
 * in to, the one in force where it ran.
 */
export const LoginData = z.object({
  tool: z.enum(LOGIN_TOOLS),
  /** The secret it is stored in; null: none within reach, the board's sign-in alone (ADR 0025). */
  secret: z.string().nullable(),
  files: z.array(z.string()),
  from: z.literal('mac').optional(),
  azureConfigDir: AzLoginFolder.optional(),
  /** Why it was not stored for your boxes (`secret` null). */
  unstored: z.string().optional(),
  /** Signed in for this Mac alone (no boxes, or a tool a box signs in to itself): `unstored` says why. */
  here: z.literal(true).optional(),
});
export type LoginData = z.infer<typeof LoginData>;

/** `abe login restore` (and a box's start): what went where. */
export const LoginRestoreData = z.object({
  secret: z.string(),
  restored: z.array(z.enum(LOGIN_TOOLS)),
  seeded: z.array(z.enum(LOGIN_TOOLS)),
  kept: z.array(z.enum(LOGIN_TOOLS)),
  missing: z.array(z.enum(LOGIN_TOOLS)),
});
export type LoginRestoreData = z.infer<typeof LoginRestoreData>;

/** Why a login was written to the secret. */
export const STORE_CAUSES = ['login', 'refreshed', 'seeded'] as const;
export type StoreCause = (typeof STORE_CAUSES)[number];

const pad = (tool: string) => tool.padEnd(7);

/** The tools a status answer checked: the machine's, and aws when a profile was asked about. */
export const checkedLogins = (d: Pick<LoginStatusData, 'logins'>): LoginTool[] => [
  ...MACHINE_LOGINS,
  ...(d.logins.aws === undefined ? [] : (['aws'] as const)),
];

/** The repo's `logins:` as a table: each need, its state, and its sign-in when not ok. */
const repoLoginsText = (r: RepoLogins): string[] => {
  if (r.needs.length === 0) return [`${r.repo} needs no logins (no logins: in its settings)`];
  const width = Math.max(...r.needs.map((n) => needWords(n).length)) + 2;

  return [
    `${r.repo} needs (logins:):`,
    ...r.needs.map(
      (n) =>
        `  ${needWords(n).padEnd(width)}${n.state === 'ok' ? `ok${n.who === null || n.note !== undefined ? '' : ` · ${n.who}`}` : n.state}${n.note === undefined ? '' : `: ${n.note}`}${n.fix === null ? '' : `  (${n.fix})`}`,
    ),
    r.ready
      ? 'every login it needs is here'
      : `not here: ${[...r.missing, ...r.unchecked].join(', ')}`,
  ];
};

/** Each tool's state and, when not ok, its way out: its login (`loginFix`), or the tools' check. */
export const loginStatusText = (d: LoginStatusData): string =>
  `${[
    ...checkedLogins(d).map((t) => {
      const s = d.logins[t] ?? 'unchecked';
      const name = t === 'aws' && d.awsProfile !== undefined ? `aws (${d.awsProfile})` : t;
      const at = name.length >= 7 ? `${name} ` : pad(name);

      if (s === 'ok') return `${at}ok`;
      const blocked = d.blocked?.[t];

      if (blocked !== undefined) return `${at}${s}: ${entraBlockText(blocked)}`;
      if (s === 'unchecked')
        return `${at}can't check: ${d.unchecked?.[t] ?? `${LOGINS[t].check} did not run`}  (abe tools check)`;

      const note = loginNote(t, d);

      return `${at}${s}${note === undefined ? '' : `: ${note}`}  (${loginFix(t, d.secret, d.awsProfile, d.azureConfigDir)})`;
    }),
    d.secret === null
      ? 'kept in no secret: this abe serve stores no logins'
      : `kept in ${d.secret}`,
    ...(d.repo === undefined ? [] : repoLoginsText(d.repo)),
  ].join('\n')}\n`;

/** Whose az folder it is, as `abe login az` says it. */
const AZ_FOLDER_WORDS: Readonly<Record<AzLoginFolder['from'], string>> = {
  environment: '$AZURE_CONFIG_DIR',
  checkout: "this checkout's board.azureConfigDir",
};

const signedInHere = (d: LoginData): string =>
  `${
    d.azureConfigDir === undefined
      ? `${d.tool} signed in on this machine`
      : `az signed in to ${d.azureConfigDir.dir} (${AZ_FOLDER_WORDS[d.azureConfigDir.from]})`
  }\nnot stored: ${d.unstored ?? 'this machine has no boxes'}\n`;

export const loginText = (d: LoginData): string =>
  d.here === true
    ? signedInHere(d)
    : `${
        d.azureConfigDir === undefined
          ? ''
          : `az signed in to ${d.azureConfigDir.dir} (${AZ_FOLDER_WORDS[d.azureConfigDir.from]})\n`
      }${
        d.secret === null
          ? `not stored for your boxes: they get no secret (${d.unstored ?? 'no login secret within reach'})\n`
          : `your ${d.tool} login is stored in ${d.secret} (${d.files.join(', ')})\n${
              d.from === 'mac'
                ? 'your boxes restore it when they start; a running one now: abe --on <box> login restore\n'
                : ''
            }`
      }`;

const list = (tools: readonly string[]) => (tools.length === 0 ? 'none' : tools.join(', '));

export const loginRestoreText = (d: LoginRestoreData): string =>
  `${[
    `restored from ${d.secret}: ${list(d.restored)}`,
    `from seeds: ${list(d.seeded)}`,
    `kept (newer here): ${list(d.kept)}`,
    ...(d.missing.length === 0
      ? []
      : [
          `missing: ${d.missing.join(', ')} (${d.missing.map((t) => `abe login ${t}`).join(', ')})`,
        ]),
  ].join('\n')}\n`;

// aws's config, as stored for your boxes.

type IniSection = { header: string; lines: string[] };

/** An ini file's sections, each from its `[header]` line to the next (lines before any dropped). */
const iniSections = (text: string): IniSection[] => {
  const out: IniSection[] = [];

  for (const line of text.split('\n')) {
    const h = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1];

    if (h !== undefined) out.push({ header: h.trim().replace(/\s+/g, ' '), lines: [] });
    else if (out.length > 0 && line.trim() !== '') out.at(-1)?.lines.push(line);
  }

  return out;
};

const iniText = (sections: readonly IniSection[]): string =>
  sections.map((s) => [`[${s.header}]`, ...s.lines].join('\n')).join('\n\n') + '\n';

/** A section's `key = value`. */
const iniValue = (s: IniSection, key: string): string | undefined =>
  s.lines.map((l) => /^\s*([\w-]+)\s*=\s*(.*?)\s*$/.exec(l)).find((m) => m?.[1] === key)?.[2];

/**
 * What `abe login aws` stores of the person's `~/.aws/config` for `profile`: its `[profile …]`
 * section and the `[sso-session …]` it names, nothing else (never `[default]`: a box's own aws
 * runs on its role). `undefined`: no such profile.
 */
export const awsConfigFor = (text: string, profile: string): string | undefined => {
  const sections = iniSections(text);
  const own = sections.find((s) => s.header === `profile ${profile}`);

  if (own === undefined) return undefined;
  const session = iniValue(own, 'sso_session');
  const sso = sections.find((s) => session !== undefined && s.header === `sso-session ${session}`);

  return iniText(sso === undefined ? [own] : [own, sso]);
};

/** The stored config with `picked`'s sections put in (one of the same name replaced), `[default]` never. */
export const mergeAwsConfig = (stored: string | undefined, picked: string): string => {
  const out = iniSections(stored ?? '').filter((s) => s.header !== 'default');

  for (const s of iniSections(picked)) {
    const i = out.findIndex((o) => o.header === s.header);

    if (i === -1) out.push(s);
    else out[i] = s;
  }

  return iniText(out);
};

/**
 * Who an `aws sts get-caller-identity` Arn is: an assumed role's session name (`ada@example.com`,
 * an Identity Center login) or an IAM user's name (`ada`, a profile with the user's keys).
 */
export const awsWho = (arn: string): string | undefined => {
  const a = arn.trim();
  const m =
    /^arn:aws[\w-]*:sts::\d+:assumed-role\/[^/]+\/(.+)$/.exec(a) ??
    /^arn:aws[\w-]*:iam::\d+:user\/(?:[^/]+\/)*([^/]+)$/.exec(a);

  return m?.[1];
};

/**
 * How `profile` signs in, from the aws config and credentials files' text: `sso` (Identity Center:
 * any `sso_*` key in its section, `aws sso login`), `keys` (an IAM user's keys in the
 * credentials file, or a config section with neither: `aws configure`), `unknown` when neither
 * file names it.
 */
export const awsProfileKind = (
  config: string,
  credentials: string,
  profile: string,
): 'sso' | 'keys' | 'unknown' => {
  const headers = profile === 'default' ? ['default', 'profile default'] : [`profile ${profile}`];
  const own = iniSections(config).find((s) => headers.includes(s.header));

  if (own?.lines.some((l) => /^\s*sso_[\w-]*\s*=/.test(l)) === true) return 'sso';
  const keys = iniSections(credentials).find((s) => s.header === profile);

  if (keys !== undefined && iniValue(keys, 'aws_access_key_id') !== undefined) return 'keys';

  return own === undefined ? 'unknown' : 'keys';
};

/**
 * The command that signs `profile` in again (null: the default one): `aws configure` for an IAM
 * user's keys, else Identity Center's `aws sso login`.
 */
export const awsSignIn = (profile: string | null, keys: boolean): string =>
  `aws ${keys ? 'configure' : 'sso login'}${profile === null ? '' : ` --profile ${profile}`}`;

/**
 * What names `profile`'s own SSO token in `~/.aws/sso/cache/` (the file is its SHA-1, hex, plus
 * `.json`): its `sso_session`'s name (that session's section must be there), or a legacy
 * profile's own `sso_start_url`. `undefined`: it can't be pinned to one file, so none is stored
 * (the cache holds other sessions' tokens, which never leave the Mac).
 */
export const awsCacheKey = (text: string, profile: string): string | undefined => {
  const sections = iniSections(text);
  const own = sections.find((s) => s.header === `profile ${profile}`);

  if (own === undefined) return undefined;
  const session = iniValue(own, 'sso_session');

  if (session !== undefined)
    return sections.some((s) => s.header === `sso-session ${session}`) && session !== ''
      ? session
      : undefined;
  const url = iniValue(own, 'sso_start_url');

  return url === undefined || url === '' ? undefined : url;
};
