/**
 * Logins stored once (#55), IO only: the login files under `HOME`, the person's secret in
 * Secrets Manager (or a folder standing in for it, `$ABE_LOGINS_STORE=file://<dir>`), the tools'
 * own checks, and each tool's own login on this terminal. Which file, when and why are core's
 * (`core/src/logins/logins.ts`). A value never goes on a command line or into an error message.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Answered,
  awsCacheKey,
  awsConfigFor,
  awsProfileKind,
  awsWho,
  claudeCredentials,
  claudeForSession,
  checkSaid,
  entraBlock,
  entraBlockText,
  LOGIN_ARGV,
  LOGIN_FILES,
  LOGIN_MARK,
  type AzLoginFolder,
  type LoginData,
  loginArgv,
  loginDocText,
  type LoginStore,
  type LoginTool,
  type LoginTools,
  MAC_LOGIN_ARGV,
  macAwsLoginArgv,
  macAzLoginArgv,
  mergeAwsConfig,
  readLoginDoc,
  regionOfSecret,
  SETUP_TOKEN_MS,
  setupTokenOf,
  withLogin,
} from '@abe/core';
import { z } from 'zod';
import { awsEnv } from './aws';
import { awsConfigHas, boxAwsEnv, boxOwnerFrom } from './boxes';
import { loginsSecretOf } from './browser-store';
import { ADO_RESOURCE } from '../azure-devops/az';
import { readGhAccounts } from '../github/gh';
import { type Env } from '../mac/locations';
import { claudeVersions } from '../claude-code/tool-probe';

const fail = (code: string, message: string) => ({ ok: false, error: { code, message } }) as const;

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * One tool's login files as they are here: base64 by path under `HOME` and the newest mtime, or
 * none of them (`files` empty, `mtimeMs` null) while its `LOGIN_MARK` is not here.
 */
export type LocalLogin = { files: Record<string, string>; mtimeMs: number | null };

/** Writes `bytes` whole (a rename), readable by this user only, its folders too. */
const writePrivate = (path: string, bytes: Uint8Array | string) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.abe-${process.pid}`;

  writeFileSync(tmp, bytes, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

/**
 * The login files under `home`; az's (`.azure/…`) in `azureConfigDir` when one is named (your
 * Layer's or `$AZURE_CONFIG_DIR`, #344), so they are read and put back where az keeps them. A
 * file's name in the secret stays `.azure/…` either way.
 */
export const loginHome = (home: string, azureConfigDir?: string, awsHome?: string) => {
  const at = (rel: string) => {
    if (azureConfigDir !== undefined && azureConfigDir !== '' && rel.startsWith('.azure/'))
      return join(azureConfigDir, rel.slice('.azure/'.length));
    // aws's restored login in a HOME of its own, never over Reach's ~/.aws/config
    if (awsHome !== undefined && rel.startsWith('.aws/')) return join(awsHome, rel);

    return join(home, rel);
  };

  /** A login file's paths under `home`: itself, or a folder's `*.json` files (`.aws/sso/cache/`). */
  const expand = (rel: string): string[] => {
    if (!rel.endsWith('/')) return [rel];
    try {
      return readdirSync(at(rel))
        .filter((f) => /^[\w.-]+\.json$/.test(f))
        .sort()
        .map((f) => `${rel}${f}`);
    } catch {
      return [];
    }
  };

  return {
    home,
    read: (tool: LoginTool): LocalLogin => {
      const files: Record<string, string> = {};
      let mtimeMs: number | null = null;

      if (expand(LOGIN_MARK[tool]).filter((rel) => existsSync(at(rel))).length === 0)
        return { files, mtimeMs };
      for (const rel of LOGIN_FILES[tool].flatMap(expand)) {
        const path = at(rel);

        if (!existsSync(path)) continue;
        files[rel] = readFileSync(path).toString('base64');
        const m = statSync(path).mtimeMs;

        mtimeMs = mtimeMs === null ? m : Math.max(mtimeMs, m);
      }

      return { files, mtimeMs };
    },
    /**
     * A stored login put back: each file as it was stored, dated when it was stored, so only the
     * tool's own rewrite makes it newer than the secret's.
     */
    write: (files: Readonly<Record<string, string>>, storedAt: string) => {
      const when = new Date(storedAt);

      for (const [rel, b64] of Object.entries(files)) {
        writePrivate(at(rel), Buffer.from(b64, 'base64'));
        utimesSync(at(rel), when, when);
      }
    },
    /** Claude Code's credentials file, from a `setup-token` token ending at `expiresAt`. */
    writeClaudeToken: (token: string, expiresAt: number) => {
      writePrivate(at(LOGIN_FILES.claude[0] ?? ''), claudeCredentials(token, expiresAt));
    },
    /** One file's text, if it is here. */
    text: (rel: string): string | undefined => {
      const path = at(rel);

      return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    },
    claudeFile: (): string | undefined => {
      const path = join(home, LOGIN_FILES.claude[0] ?? '');

      return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    },
  };
};

export type LoginHome = ReturnType<typeof loginHome>;

/** A fingerprint of a tool's files: what a box compares to see a refresh. */
export const loginHash = (local: LocalLogin): string =>
  createHash('sha256')
    .update(JSON.stringify(Object.entries(local.files).sort()))
    .digest('hex');

const TIMEOUT_MS = 30_000;

type Spawned = { exit: number; stdout: string; stderr: string };

/** Runs `argv` with `env` and `stdin` (a value goes here, never on argv), killed after the timeout. */
const run = async (
  argv: readonly string[],
  env: Record<string, string>,
  stdin = '',
  timeoutMs = TIMEOUT_MS,
): Promise<Spawned> => {
  const [bin, ...args] = argv;
  const found = bin === undefined ? null : Bun.which(bin, { PATH: env.PATH ?? '' });

  if (found === null)
    return { exit: 127, stdout: '', stderr: `${bin ?? ''} is not installed (not on PATH)` };
  const child = Bun.spawn([found, ...args], {
    env,
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, timeoutMs);
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => {
    clearTimeout(timer);
  });

  return { exit, stdout, stderr };
};

const childEnv = (env: Env, home: string): Record<string, string> => {
  const kept: Record<string, string> = {};

  for (const [k, v] of Object.entries(env)) if (v !== undefined) kept[k] = v;

  return { ...kept, HOME: home, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' };
};

/** A message's first line, at most 160 characters: what a refused check said, in one row. */
const firstLine = (text: string): string => {
  const line = text.trim().split('\n')[0]?.trim() ?? '';

  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
};

const Read = z.object({ text: z.string(), createdAt: z.string().nullish() });
const ClaudeStatus = z.object({ loggedIn: z.boolean(), email: z.string().optional() });

/** `gh auth status`'s account (`Logged in to github.com account octocat`, older gh's `as`). */
/** `~/x` as a path under `home`. */
export const homedIn = (home: string, dir: string) => {
  if (dir === '~') return home;

  return dir.startsWith('~/') ? `${home}${dir.slice(1)}` : dir;
};

const ghAccount = (text: string): string | undefined =>
  /Logged in to \S+ (?:account|as) (\S+)/.exec(text)?.[1];

const parsed = <T>(schema: z.ZodType<T>, text: string): T | undefined => {
  try {
    const r = schema.safeParse(JSON.parse(text));

    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
};

/** Secrets Manager through `aws`, on serve's own credentials: the value in on stdin, out on stdout. */
export const awsLoginStore = (env: Env): LoginStore => {
  const e = childEnv(env, env.HOME ?? '/');
  const region = (secret: string) => {
    const r = regionOfSecret(secret);

    return r === null ? [] : ['--region', r];
  };

  return {
    read: async (secret) => {
      const out = await run(
        [
          'aws',
          'secretsmanager',
          'get-secret-value',
          '--secret-id',
          secret,
          '--query',
          '{text:SecretString,createdAt:CreatedDate}',
          '--output',
          'json',
          ...region(secret),
        ],
        e,
      );

      if (out.exit !== 0) {
        // No such secret, or one with no value yet (made by Terraform, never written).
        if (out.stderr.includes('ResourceNotFoundException')) return { ok: true, data: null };

        return fail(
          'secret-unreadable',
          `${secret}: ${out.stderr.trim() || `aws exited ${out.exit}`}`,
        );
      }
      const doc = parsed(Read, out.stdout);

      return doc === undefined
        ? fail('secret-unreadable', `${secret}: aws answered no text value`)
        : { ok: true, data: { text: doc.text, createdAt: doc.createdAt ?? '' } };
    },
    write: async (secret, text) => {
      const out = await run(
        [
          'aws',
          'secretsmanager',
          'put-secret-value',
          '--secret-id',
          secret,
          '--secret-string',
          'file:///dev/stdin',
          '--query',
          'VersionId',
          '--output',
          'text',
          ...region(secret),
        ],
        e,
        text,
      );

      return out.exit === 0
        ? { ok: true, data: null }
        : fail('secret-unwritable', `${secret}: ${out.stderr.trim() || `aws exited ${out.exit}`}`);
    },
  };
};

/** A folder standing in for Secrets Manager: each secret a file at its name. */
export const fileLoginStore = (dir: string): LoginStore => {
  const at = (secret: string) => join(dir, ...secret.split('/').filter((p) => p !== '..'));

  return {
    read: (secret) => {
      const path = at(secret);

      if (!existsSync(path)) return Promise.resolve({ ok: true, data: null });
      try {
        return Promise.resolve({
          ok: true,
          data: {
            text: readFileSync(path, 'utf8'),
            createdAt: new Date(statSync(path).mtimeMs).toISOString(),
          },
        });
      } catch (err) {
        return Promise.resolve(fail('secret-unreadable', `${secret}: ${why(err)}`));
      }
    },
    write: (secret, text) => {
      try {
        writePrivate(at(secret), text);

        return Promise.resolve({ ok: true, data: null });
      } catch (err) {
        return Promise.resolve(fail('secret-unwritable', `${secret}: ${why(err)}`));
      }
    },
  };
};

/** `$ABE_LOGINS_STORE=file://<dir>` (tests, a Mac trying it out), else Secrets Manager. */
export const loginStoreFrom = (env: Env): LoginStore => {
  const named = env.ABE_LOGINS_STORE ?? '';

  return named.startsWith('file://') ? fileLoginStore(fileURLToPath(named)) : awsLoginStore(env);
};

const CHECKS: Readonly<Record<LoginTool, readonly string[]>> = {
  github: ['gh', 'auth', 'status', '--hostname', 'github.com'],
  claude: ['claude', 'auth', 'status', '--json'],
  // Asks Entra for the board's own token, Azure DevOps' (renewing it if it must), as the board
  // does: a login with no subscription has one. Only its end is printed, never the token.
  az: [
    'az',
    'account',
    'get-access-token',
    '--resource',
    ADO_RESOURCE,
    '--query',
    'expiresOn',
    '--output',
    'tsv',
  ],
  // Who the profile's SSO role is: its Arn only, never a credential.
  aws: ['aws', 'sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text'],
};

/** Who `az` is signed in as (#345): the account's user name, nothing else of it. */
const AZ_WHO = ['az', 'account', 'show', '--query', 'user.name', '--output', 'tsv'];

/** What the Azure DevOps row says when `az account show` answers something other than a name. */
const AZ_WHO_UNREAD = "can't read the account";

/**
 * The account in `az account show --query user.name -o tsv`'s answer: one short line with no
 * spaces, quotes or braces, and no token (`eyJ…`). Anything else (a shim or fake answering JSON, a
 * token) is never shown: `AZ_WHO_UNREAD` stands in for it.
 */
const azAccount = (stdout: string): string => {
  const lines = stdout.trim().split('\n');
  const name = lines[0]?.trim() ?? '';

  return lines.length === 1 && /^[^\s{}[\]"'<>]{1,120}$/.test(name) && !name.startsWith('eyJ')
    ? name
    : AZ_WHO_UNREAD;
};

/** `who` when there is one. */
const withWho = (works: boolean, who: string | undefined): { works: boolean; who?: string } =>
  works && who !== undefined && who !== '' ? { works, who } : { works };

/**
 * aws run on the restored login in `awsHome` (`AWS_LOGIN_HOME` under a box's `HOME`): its `HOME`
 * (where SSO's token cache is) and its config, nothing else of aws's from `env`. The env an
 * install's local start reaches the repo's test environment with.
 */
export const awsLoginEnv = (awsHome: string): Record<string, string> => ({
  HOME: awsHome,
  AWS_CONFIG_FILE: join(awsHome, '.aws', 'config'),
  AWS_SHARED_CREDENTIALS_FILE: join(awsHome, '.aws', 'credentials'),
});

/**
 * The tools' own CLIs with `env` and `HOME` = `home`; aws on the restored login in `awsHome` when
 * named (a box), else on `home`'s own (the Mac).
 */
export const cliLoginTools = (o: { env: Env; home: string; awsHome?: string }): LoginTools => {
  const e = { ...childEnv(o.env, o.home), GH_PROMPT_DISABLED: '1' };
  const awsE = o.awsHome === undefined ? e : { ...e, ...awsLoginEnv(o.awsHome) };

  return {
    check: async (tool, opts) => {
      const argv = CHECKS[tool];
      const [bin = '', ...args] = argv;

      // #160: a tool serve cannot find says nothing of its login.
      if (Bun.which(bin, { PATH: o.env.PATH ?? '' }) === null)
        return { cannot: `${bin} not found on serve's PATH` };
      if (tool === 'aws') {
        // No profile named: the box's own role would answer, which says nothing of yours.
        if (opts?.profile === undefined) return { cannot: 'no aws profile named (logins:)' };
        const out = await run([...argv, '--profile', opts.profile], awsE, '', 20_000);

        return withWho(out.exit === 0, out.exit === 0 ? awsWho(out.stdout) : undefined);
      }
      if (tool === 'az') {
        // your az folder in force at the checkout (ADR 0025), else serve's own
        const dir = opts?.azureConfigDir;
        const azE = dir === undefined ? e : { ...e, AZURE_CONFIG_DIR: homedIn(o.home, dir) };
        const [out, who] = await Promise.all([
          run(argv, azE, '', 20_000),
          run(AZ_WHO, azE, '', 20_000),
        ]);
        const blocked = out.exit === 0 ? undefined : entraBlock(out.stderr);
        const name = who.exit === 0 ? azAccount(who.stdout) : undefined;
        const said = out.exit === 0 || blocked !== undefined ? undefined : checkSaid(out.stderr);

        // #237: Entra's refusal named, so the fix said is the one that helps; else what az said.
        return {
          ...withWho(out.exit === 0, name),
          ...(blocked === undefined ? {} : { blocked }),
          ...(said === undefined ? {} : { said }),
        };
      }
      if (tool !== 'claude') {
        const out = await run(argv, e, '', 20_000);
        const text = `${out.stdout}\n${out.stderr}`;
        const account = opts?.githubAccount;

        // the login named for the checkout (ADR 0025): signed in, active or not
        if (account !== undefined)
          return withWho(readGhAccounts(text).signedIn.includes(account), account);

        return withWho(out.exit === 0, ghAccount(text));
      }
      // The claude sessions run (the first new enough, #179), not an older one ahead of it (#190).
      const picked = claudeForSession(await claudeVersions(o.env), o.env.PATH ?? '');

      if (!picked.ok) return { cannot: picked.message };
      const out = await run([picked.path, ...args], e, '', 20_000);
      const status = parsed(ClaudeStatus, out.stdout);

      // Its JSON says; without it (an old claude, the selected model refused, #190) it could not.
      if (status !== undefined) return withWho(status.loggedIn, status.email);

      return {
        cannot: `claude auth status failed: ${firstLine(out.stderr || out.stdout) || `exit ${out.exit}`}`,
      };
    },
    githubToken: async (token) => {
      const out = await run(
        [
          'gh',
          'auth',
          'login',
          '--hostname',
          'github.com',
          '--git-protocol',
          'https',
          '--insecure-storage',
          '--with-token',
        ],
        e,
        `${token}\n`,
      );

      return out.exit === 0
        ? { ok: true, data: null }
        : fail(
            'login-failed',
            `gh auth login --with-token: ${out.stderr.trim() || `exit ${out.exit}`}`,
          );
    },
  };
};

/**
 * `argv` on this terminal: its stdin, its stdout to stderr (so `--json` prints one line). An
 * `az`'s stderr is passed on as it comes and the end of it kept, where Entra's refusal is read
 * (#237); another's goes to the terminal as it is.
 */
const onTerminal = async (
  argv: readonly string[],
  env: Record<string, string>,
): Promise<Answered<null>> => {
  const [bin, ...args] = argv;
  const found = bin === undefined ? null : Bun.which(bin, { PATH: env.PATH ?? '' });

  if (found === null) return fail('login-failed', `${bin ?? ''} is not installed (not on PATH)`);
  const tee = bin === 'az';
  const child = Bun.spawn([found, ...args], {
    env,
    stdio: ['inherit', 2, tee ? 'pipe' : 'inherit'],
  });
  const text = new TextDecoder();
  let said = '';

  if (child.stderr instanceof ReadableStream)
    for await (const chunk of child.stderr) {
      process.stderr.write(chunk);
      said = (said + text.decode(chunk, { stream: true })).slice(-65_536);
    }
  const exit = await child.exited;

  if (exit === 0) return { ok: true, data: null };
  const blocked = entraBlock(said);

  return blocked === undefined
    ? fail('login-failed', `${argv.slice(0, 3).join(' ')} exited ${exit}`)
    : fail('entra-blocked', entraBlockText(blocked));
};

/**
 * `abe login <tool>` on this terminal: the tool's own login (`az` in `tenant` when named). Claude
 * Code's `setup-token` prints its token rather than keeping it, so it runs under `script` on a
 * wide screen, the token is read from what the screen showed and kept as Claude Code's
 * credentials file; the capture is removed at once.
 */
export const terminalLogin =
  (o: {
    env: Env;
    home: string;
    now: () => number;
    platform?: NodeJS.Platform;
    /** Where the box keeps aws's restored login (`AWS_LOGIN_HOME`): aws signs in there. */
    awsHome?: string;
  }) =>
  async (tool: LoginTool, tenant?: string, profile?: string): Promise<Answered<null>> => {
    const env = childEnv(o.env, o.home);

    if (tool === 'aws' && profile === undefined)
      return fail('usage', 'abe login aws needs --profile <the SSO profile the repo names>');
    if (tool === 'aws' && o.awsHome !== undefined)
      return onTerminal(loginArgv(tool, tenant, profile), { ...env, ...awsLoginEnv(o.awsHome) });
    if (tool !== 'claude') return onTerminal(loginArgv(tool, tenant, profile), env);
    const dir = mkdtempSync(join(tmpdir(), 'abe-login-'));
    const screen = join(dir, 'screen');
    const inner = `stty cols 500 2>/dev/null; exec ${LOGIN_ARGV.claude.join(' ')}`;
    const argv =
      (o.platform ?? process.platform) === 'darwin'
        ? ['script', '-q', screen, 'sh', '-c', inner]
        : ['script', '-q', '-e', '-c', inner, screen];

    // Ctrl-C reaches this process too: the capture (it holds the token) goes before it ends.
    const gone = () => {
      rmSync(dir, { recursive: true, force: true });
      process.exit(130);
    };

    process.once('SIGINT', gone);
    process.once('SIGTERM', gone);
    try {
      const ran = await onTerminal(argv, env);

      if (!ran.ok) return ran;
      const token = existsSync(screen) ? setupTokenOf(readFileSync(screen, 'utf8')) : undefined;

      if (token === undefined) return fail('login-failed', 'claude setup-token printed no token');
      loginHome(o.home).writeClaudeToken(token, o.now() + SETUP_TOKEN_MS);

      return { ok: true, data: null };
    } finally {
      process.off('SIGINT', gone);
      process.off('SIGTERM', gone);
      rmSync(dir, { recursive: true, force: true });
    }
  };

/**
 * Whether this Mac has boxes to store a login for, read from files alone (no aws run): the box
 * profile named (`box.profile`, `$ABE_BOX_PROFILE`) is in the aws config. `$ABE_LOGINS_STORE=
 * file://…` (tests) stands in for them. None: why, in words.
 */
export const macBoxes = (
  env: Env,
  boxProfile: string | null,
): { ok: true } | { ok: false; why: string } => {
  if ((env.ABE_LOGINS_STORE ?? '').startsWith('file://')) return { ok: true };
  if (boxProfile === null || boxProfile === '')
    return {
      ok: false,
      why: "this machine has no boxes (no box.profile names your boxes' aws profile)",
    };
  if (!awsConfigHas(env, env.HOME ?? '', boxProfile))
    return {
      ok: false,
      why: `this machine has no boxes (box.profile ${boxProfile} is not in your aws config)`,
    };

  return { ok: true };
};

/**
 * `abe login github|claude` on the Mac: the tool's own browser login (`MAC_LOGIN_ARGV`), kept where
 * the tool keeps it. Nothing is stored: with no boxes there is no one to give it to, and a box
 * signs in to these on its own.
 */
export const macToolLogin =
  (o: { env: Env; boxProfile: string | null }) =>
  async (tool: 'github' | 'claude'): Promise<Answered<LoginData>> => {
    const ran = await onTerminal(MAC_LOGIN_ARGV[tool], childEnv(o.env, o.env.HOME ?? ''));

    if (!ran.ok) return ran;
    const boxes = macBoxes(o.env, o.boxProfile);

    return {
      ok: true,
      data: {
        tool,
        secret: null,
        files: [],
        from: 'mac',
        here: true,
        unstored: boxes.ok ? `a box signs in on its own (abe --on <box> login ${tool})` : boxes.why,
      },
    };
  };

/**
 * The person's logins secret as the Mac reaches it: `$ABE_LOGINS_STORE=file://…` (tests) at
 * `$ABE_LOGINS_SECRET`, else `abe/<owner>/logins`; otherwise Secrets Manager on the boxes' SSO
 * profile, the secret tagged with its owner.
 */
const macLoginsSecret = async (
  env: Env,
): Promise<Answered<{ secret: string; store: LoginStore }>> => {
  const named = env.ABE_LOGINS_STORE ?? '';

  if (named.startsWith('file://')) {
    const store = fileLoginStore(fileURLToPath(named));
    const given = env.ABE_LOGINS_SECRET ?? '';

    if (given !== '') return { ok: true, data: { secret: given, store } };
    const owner = await boxOwnerFrom(env)();

    return owner.ok ? { ok: true, data: { secret: `abe/${owner.data}/logins`, store } } : owner;
  }
  // The list and the write on the same credentials: `aws`'s env, a Reach profile left out.
  const aws = awsEnv(boxAwsEnv(env));
  const found = await loginsSecretOf({ env: aws, owner: boxOwnerFrom(env) });

  return found.ok
    ? { ok: true, data: { secret: found.data.logins, store: awsLoginStore(aws) } }
    : found;
};

/**
 * `doc` read from `secret` with `az`'s entry put, written, and read again until it holds that
 * entry: a box writing back another tool at the same moment writes the document it read before,
 * and the Mac keeps no copy to put back later (tried three times).
 */
const putMacLogin = async (
  store: LoginStore,
  secret: string,
  tool: 'az' | 'aws',
  /** The files to store, from what is stored now (aws's config adds to the stored one). */
  filesOf: (stored: Readonly<Record<string, string>> | undefined) => Record<string, string>,
  storedAt: string,
): Promise<Answered<null>> => {
  for (let tries = 0; tries <= 3; tries += 1) {
    const read = await store.read(secret);

    if (!read.ok) return read;
    const doc = readLoginDoc(read.data?.text ?? null);

    if (!doc.ok) return fail('bad-login-secret', `${secret}: ${doc.message}`);
    if (doc.doc.logins[tool]?.storedAt === storedAt) return { ok: true, data: null };
    if (tries === 3) break;
    const text = loginDocText(
      withLogin(doc.doc, tool, filesOf(doc.doc.logins[tool]?.files), storedAt),
    );

    if (!text.ok) return fail('login-too-large', text.message);
    const written = await store.write(secret, text.text);

    if (!written.ok) return written;
  }

  return fail('secret-unwritable', `${secret}: another write kept replacing your ${tool} login`);
};

/**
 * `abe login az` on the Mac (#237): the person's secret found and read first (no sign-in for a
 * secret out of reach), then `az`'s browser login into a private folder of its own (never the
 * person's `~/.azure`), its files stored in the secret (only `az`'s entry replaced) for their
 * boxes to restore, and the folder removed. The value goes to the secret on stdin only. With
 * `azureConfigDir` (the az folder in force where it ran, ADR 0025) it signs in there instead,
 * the folder kept: the board there reads that login.
 */
export const macLogin =
  (o: {
    env: Env;
    now: () => number;
    azureConfigDir?: AzLoginFolder;
    /** The box profile named (`box.profile`, `$ABE_BOX_PROFILE`); none: no boxes. */
    boxProfile: string | null;
  }) =>
  async (tenant?: string): Promise<Answered<LoginData>> => {
    const kept = o.azureConfigDir;
    const boxes = macBoxes(o.env, o.boxProfile);

    // no boxes: az's own login, in the folder in force (else az's own), and nothing else
    if (!boxes.ok) return macAzHere(o.env, tenant, kept, boxes.why);
    const where = await macLoginsSecret(o.env);

    // no secret within reach: the board's sign-in alone, in its folder (ADR 0025), else none
    if (!where.ok && kept === undefined) return where;
    const to = where.ok ? where.data : undefined;

    if (to !== undefined) {
      const before = await to.store.read(to.secret);

      if (!before.ok) return before;
      const readable = readLoginDoc(before.data?.text ?? null);

      if (!readable.ok) return fail('bad-login-secret', `${to.secret}: ${readable.message}`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'abe-az-'));
    const gone = (signal: NodeJS.Signals) => {
      rmSync(dir, { recursive: true, force: true });
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    const azDir = kept?.dir ?? join(dir, '.azure');

    process.once('SIGINT', gone);
    process.once('SIGTERM', gone);
    try {
      const env = { ...childEnv(o.env, o.env.HOME ?? dir), AZURE_CONFIG_DIR: azDir };
      const ran = await onTerminal(macAzLoginArgv(tenant), env);

      if (!ran.ok) return ran;
      const local = loginHome(dir, azDir).read('az');
      const files = Object.keys(local.files);

      if (files.length === 0) return fail('login-failed', 'az login kept no login to store');
      const folder = kept === undefined ? {} : { azureConfigDir: kept };

      if (to === undefined)
        return {
          ok: true,
          data: {
            tool: 'az',
            secret: null,
            files,
            from: 'mac',
            ...folder,
            ...(where.ok ? {} : { unstored: where.error.message }),
          },
        };
      const put = await putMacLogin(
        to.store,
        to.secret,
        'az',
        () => local.files,
        new Date(o.now()).toISOString(),
      );

      if (!put.ok) return put;

      return {
        ok: true,
        data: { tool: 'az', secret: to.secret, files, from: 'mac', ...folder },
      };
    } finally {
      process.off('SIGINT', gone);
      process.off('SIGTERM', gone);
      rmSync(dir, { recursive: true, force: true });
    }
  };

/**
 * `abe login az` on a Mac with no boxes: az's own browser login in the folder in force where it
 * ran (else az's own, `~/.azure`), kept there. No aws, no logins secret.
 */
const macAzHere = async (
  env: Env,
  tenant: string | undefined,
  kept: AzLoginFolder | undefined,
  why: string,
): Promise<Answered<LoginData>> => {
  const home = env.HOME ?? '';
  const run = childEnv(env, home);
  const ran = await onTerminal(
    macAzLoginArgv(tenant),
    kept === undefined ? run : { ...run, AZURE_CONFIG_DIR: kept.dir },
  );

  if (!ran.ok) return ran;
  const files = Object.keys(loginHome(home, kept?.dir).read('az').files);

  return {
    ok: true,
    data: {
      tool: 'az',
      secret: null,
      files,
      from: 'mac',
      here: true,
      unstored: why,
      ...(kept === undefined ? {} : { azureConfigDir: kept }),
    },
  };
};

const AWS_CONFIG = '.aws/config';

/**
 * `abe login aws --profile <p>` for a profile with an IAM user's keys (`awsProfileKind` `keys`):
 * nothing to sign in to, so its keys are checked (`aws sts get-caller-identity`) and never stored:
 * a box runs aws on its own role. Keys that do not resolve: `aws configure` sets them.
 */
const macAwsKeysLogin = async (env: Env, profile: string): Promise<Answered<LoginData>> => {
  const out = await run(
    ['aws', 'sts', 'get-caller-identity', '--profile', profile, '--output', 'json'],
    childEnv(env, env.HOME ?? ''),
    '',
    20_000,
  );

  if (out.exit !== 0)
    return fail(
      'login-failed',
      `profile ${profile}'s keys do not resolve (${checkSaid(out.stderr) ?? 'aws refused them'}): aws configure --profile ${profile}`,
    );

  return {
    ok: true,
    data: {
      tool: 'aws',
      secret: null,
      files: [],
      from: 'mac',
      here: true,
      unstored: `profile ${profile} signs in with an IAM user's keys, which stay on this Mac`,
    },
  };
};

/**
 * `abe login aws --profile <p>` on the Mac: the person's secret found and read first, then SSO's
 * own browser login for the profile in their own `~/.aws` (the sign-in they would do anyway),
 * then that profile's config (its `[profile]` and `[sso-session]`, added to the stored config) and
 * SSO's token cache stored in their secret for their boxes. The values go to the secret on stdin
 * only; nothing is printed.
 */
export const macAwsLogin =
  (o: { env: Env; now: () => number; boxProfile: string | null }) =>
  async (profile: string): Promise<Answered<LoginData>> => {
    const home = o.env.HOME ?? '';
    const config = (() => {
      try {
        return readFileSync(o.env.AWS_CONFIG_FILE ?? join(home, AWS_CONFIG), 'utf8');
      } catch {
        return '';
      }
    })();
    const credentials = (() => {
      try {
        return readFileSync(
          o.env.AWS_SHARED_CREDENTIALS_FILE ?? join(home, '.aws', 'credentials'),
          'utf8',
        );
      } catch {
        return '';
      }
    })();

    if (awsProfileKind(config, credentials, profile) === 'keys')
      return macAwsKeysLogin(o.env, profile);
    const boxes = macBoxes(o.env, o.boxProfile);

    // no boxes: SSO's own login for the profile, nothing stored
    if (!boxes.ok) {
      const ran = await onTerminal(macAwsLoginArgv(profile), childEnv(o.env, o.env.HOME ?? ''));

      return ran.ok
        ? {
            ok: true,
            data: {
              tool: 'aws',
              secret: null,
              files: [],
              from: 'mac',
              here: true,
              unstored: boxes.why,
            },
          }
        : ran;
    }
    const where = await macLoginsSecret(o.env);

    if (!where.ok) return where;
    const { secret, store } = where.data;
    const before = await store.read(secret);

    if (!before.ok) return before;
    const readable = readLoginDoc(before.data?.text ?? null);

    if (!readable.ok) return fail('bad-login-secret', `${secret}: ${readable.message}`);
    const picked = awsConfigFor(config, profile);

    if (picked === undefined)
      return fail(
        'no-aws-profile',
        `no [profile ${profile}] in your aws config: set it up first (aws configure sso --profile ${profile})`,
      );
    const key = awsCacheKey(config, profile);

    // Only this profile's own token: the cache holds other SSO sessions' too, which stay here.
    if (key === undefined)
      return fail(
        'aws-token-unpinned',
        `can't tell which SSO token is [profile ${profile}]'s (no sso_session with its [sso-session], nor sso_start_url): nothing stored`,
      );
    const ran = await onTerminal(macAwsLoginArgv(profile), childEnv(o.env, home));

    if (!ran.ok) return ran;
    const rel = `.aws/sso/cache/${createHash('sha1').update(key).digest('hex')}.json`;
    const token = loginHome(home).text(rel);

    if (token === undefined)
      return fail('login-failed', `aws sso login kept no SSO token for ${profile} to store`);
    const cache = { [rel]: Buffer.from(token).toString('base64') };
    const filesOf = (stored: Readonly<Record<string, string>> | undefined) => {
      const was = stored?.[AWS_CONFIG];
      const merged = mergeAwsConfig(
        was === undefined ? undefined : Buffer.from(was, 'base64').toString('utf8'),
        picked,
      );
      // Tokens stored before (each pinned to its own profile's session when stored) stay.
      const before = Object.fromEntries(
        Object.entries(stored ?? {}).filter(([f]) => f !== AWS_CONFIG),
      );

      return { [AWS_CONFIG]: Buffer.from(merged).toString('base64'), ...before, ...cache };
    };
    const put = await putMacLogin(store, secret, 'aws', filesOf, new Date(o.now()).toISOString());

    if (!put.ok) return put;

    return {
      ok: true,
      data: { tool: 'aws', secret, files: [AWS_CONFIG, rel], from: 'mac' },
    };
  };
