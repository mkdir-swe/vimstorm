/**
 * Fakes for logins stored once. `fakeLoginStore` is Secrets Manager in memory, and
 * `fakeLoginTools` holds the tools' checks in memory. `fakeLoginClis` puts fake `gh`, `az` and
 * `claude` on disk, which log in by writing their files under `HOME` as the real ones do.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Answered,
  type LoginCheck,
  type LoginStore,
  type LoginTool,
  type LoginTools,
} from '@abe/core';

/** Fake token values. Tests look for them where they must never be. */
export const FAKE_GITHUB_TOKEN = 'ghp_FAKEfakeFAKEfakeFAKEfakeFAKEfake0001';
export const FAKE_CLAUDE_TOKEN = `sk-ant-oat01-${'FAKEfake'.repeat(10)}AA`;
export const FAKE_AZ_TOKEN = 'eyJ0eXAiOiJKV1QifakeAZ.eyJzdWIiOiJmYWtlIn0fakeAZ.c2lnZmFrZQ';
export const FAKE_AWS_TOKEN = 'aoaAAAAAGfakeAWSfakeAWSfakeAWSfakeAWS0001';

export type FakeLoginStore = LoginStore & {
  /** The secrets as they are now, by name. */
  secrets: Map<string, { text: string; createdAt: string }>;
  /** Every call, by secret name only. */
  calls: { op: 'read' | 'write'; secret: string }[];
  /** Secrets this store refuses, as another owner's would be. */
  denied: Set<string>;
};

const accessDenied = (op: string, secret: string): Answered<never> => ({
  ok: false,
  error: {
    code: op === 'read' ? 'secret-unreadable' : 'secret-unwritable',
    message: `${secret}: An error occurred (AccessDeniedException) when calling the ${op === 'read' ? 'GetSecretValue' : 'PutSecretValue'} operation: explicit deny in a resource-based policy`,
  },
});

export const fakeLoginStore = (
  secrets: Record<string, { text: string; createdAt?: string }> = {},
): FakeLoginStore => {
  const held = new Map(
    Object.entries(secrets).map(([k, v]) => [
      k,
      { text: v.text, createdAt: v.createdAt ?? '2026-10-23T02:30:00.000Z' },
    ]),
  );
  const calls: FakeLoginStore['calls'] = [];
  const denied = new Set<string>();

  return {
    secrets: held,
    calls,
    denied,
    read: (secret) => {
      calls.push({ op: 'read', secret });
      if (denied.has(secret)) return Promise.resolve(accessDenied('read', secret));

      return Promise.resolve({ ok: true, data: held.get(secret) ?? null });
    },
    write: (secret, text) => {
      calls.push({ op: 'write', secret });
      if (denied.has(secret)) return Promise.resolve(accessDenied('write', secret));
      held.set(secret, { text, createdAt: new Date().toISOString() });

      return Promise.resolve({ ok: true, data: null });
    },
  };
};

export type FakeLoginTools = LoginTools & {
  /** What each tool says of its login. */
  set: (tool: LoginTool, works: boolean, who?: string) => void;
  /** Makes the tool's check unable to run, for a reason `why` such as not on serve's PATH. */
  cannot: (tool: LoginTool, why: string) => void;
  /** Tokens handed to `gh auth login --with-token`. */
  githubTokens: string[];
  /** The aws profiles checked, in order. */
  awsProfiles: string[];
  /** The az folders checked in (`azureConfigDir`), in order; serve's own is none. */
  azureConfigDirs: string[];
  /** The tool's check fails, its stderr's first line `said`. */
  fails: (tool: LoginTool, said: string) => void;
};

/** `githubToken` writes `hosts.yml` under `home`, as `gh` does. */
export const fakeLoginTools = (home: string): FakeLoginTools => {
  const state: Record<LoginTool, LoginCheck> = {
    github: { works: false },
    claude: { works: false },
    az: { works: false },
    aws: { works: false },
  };
  const githubTokens: string[] = [];
  const awsProfiles: string[] = [];
  const azureConfigDirs: string[] = [];

  return {
    check: (tool, o) => {
      if (tool === 'az' && o?.azureConfigDir !== undefined) azureConfigDirs.push(o.azureConfigDir);
      if (tool !== 'aws') return Promise.resolve(state[tool]);
      if (o?.profile === undefined)
        return Promise.resolve({ cannot: 'no aws profile named (logins:)' });
      awsProfiles.push(o.profile);

      return Promise.resolve(state.aws);
    },
    awsProfiles,
    azureConfigDirs,
    fails: (tool, said) => {
      state[tool] = { works: false, said };
    },
    set: (tool, works, who) => {
      state[tool] = who === undefined ? { works } : { works, who };
    },
    cannot: (tool, why) => {
      state[tool] = { cannot: why };
    },
    githubTokens,
    githubToken: (token) => {
      githubTokens.push(token);
      mkdirSync(join(home, '.config', 'gh'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'gh', 'hosts.yml'),
        `github.com:\n    oauth_token: ${token}\n    user: octocat\n    git_protocol: https\n`,
      );
      state.github = { works: true };

      return Promise.resolve({ ok: true, data: null });
    },
  };
};

export type FakeLoginClis = {
  dir: string;
  path: string;
  /** Each run so far, as `<tool> <args>`, oldest first. */
  calls: () => string[];
  remove: () => void;
};

/**
 * `gh`, `az`, `claude` and `aws` as shell scripts, each run kept in `calls`. `gh auth login`, by
 * web or `--with-token`, writes `hosts.yml`. `az login`, by device code or browser, writes its
 * profile and token cache in `$AZURE_CONFIG_DIR`, else `~/.azure`. `claude setup-token` prints a
 * token; `claude auth login` writes its credentials. `aws sso login` writes an SSO cache file for
 * a profile in `~/.aws/config`, named `$ABE_FAKE_AWS_CACHE`.json after its SHA-1; a profile with an
 * IAM user's keys in `~/.aws/credentials` (`aws_access_key_id`) is `user/ada` with no sign-in.
 * Their status checks pass while the files are there and hold no `expired`.
 */
export const fakeLoginClis = (): FakeLoginClis => {
  const dir = mkdtempSync(join(tmpdir(), 'login-clis-'));
  const log = join(dir, 'calls');
  const tool = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n${body}\n`, {
      mode: 0o755,
    });
  };

  tool(
    'gh',
    `f="$HOME/.config/gh/hosts.yml"
case "$*" in
  *"auth login"*"--with-token"*) t=$(cat); mkdir -p "$(dirname "$f")"; printf 'github.com:\\n    oauth_token: %s\\n    user: octocat\\n' "$t" > "$f";;
  *"auth login"*) echo "! First copy your one-time code: FAKE-CODE" >&2; echo "Open https://github.com/login/device" >&2; mkdir -p "$(dirname "$f")"; printf 'github.com:\\n    oauth_token: ${FAKE_GITHUB_TOKEN}\\n    user: octocat\\n' > "$f";;
  *"auth status"*) [ -f "$f" ] && ! grep -q expired "$f" || { echo "You are not logged into any GitHub hosts" >&2; exit 1; };;
  *) exit 2;;
esac`,
  );
  tool(
    'az',
    `d="\${AZURE_CONFIG_DIR:-$HOME/.azure}"
case "$*" in
  *"login"*"--use-device-code"*) echo "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code FAKECODE to authenticate." >&2; mkdir -p "$d"; echo '{"subscriptions":[]}' > "$d/azureProfile.json"; printf '{"AccessToken":{"x":{"secret":"${FAKE_AZ_TOKEN}"}}}' > "$d/msal_token_cache.json";;
  *"login"*) echo "A web browser has been opened at https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize." >&2; mkdir -p "$d"; echo '{"subscriptions":[]}' > "$d/azureProfile.json"; printf '{"AccessToken":{"x":{"secret":"${FAKE_AZ_TOKEN}"}}}' > "$d/msal_token_cache.json";;
  *"account show"*) [ -f "$d/msal_token_cache.json" ] && echo ada@example.com || { echo "Please run 'az login' to setup account." >&2; exit 1; };;
  *"account get-access-token"*) [ -f "$d/msal_token_cache.json" ] && ! grep -q expired "$d/msal_token_cache.json" && echo 2099-01-01 || { echo "AADSTS70043: The refresh token has expired" >&2; exit 1; };;
  *) exit 2;;
esac`,
  );
  tool(
    'claude',
    `case "$*" in
  "--version") echo "2.1.310 (Claude Code)";;
  *"setup-token"*) echo "Visit https://claude.ai/oauth/authorize?code=true and paste the code"; printf '\\033[1m%s\\033[22m\\n' '${FAKE_CLAUDE_TOKEN}'; echo "Store this token securely.";;
  *"auth login"*) echo "Opening https://claude.ai/oauth/authorize in your browser" >&2; mkdir -p "$HOME/.claude"; echo '{"claudeAiOauth":{}}' > "$HOME/.claude/.credentials.json";;
  *"auth status"*) if [ -f "$HOME/.claude/.credentials.json" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; else echo '{"loggedIn":false,"authMethod":"none"}'; exit 1; fi;;
  *) exit 2;;
esac`,
  );
  tool(
    'aws',
    `c="$HOME/.aws/sso/cache/\${ABE_FAKE_AWS_CACHE:-fake}.json"
p=""; prev=""
for a in "$@"; do [ "$prev" = "--profile" ] && p="$a"; prev="$a"; done
has() { grep -q "^\\[profile $p\\]" "$HOME/.aws/config" 2>/dev/null; }
key() { sed -n "/^\\[$p\\]/,/^\\[/p" "$HOME/.aws/credentials" 2>/dev/null | grep '^aws_access_key_id'; }
case "$*" in
  *"sts get-caller-identity"*) if key >/dev/null; then key | grep -q expired && { echo "An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid." >&2; exit 254; }; case "$*" in *"--output json"*) echo '{"Arn":"arn:aws:iam::111111111111:user/ada"}';; *) echo "arn:aws:iam::111111111111:user/ada";; esac; exit 0; fi;;
esac
case "$*" in
  *"sso login"*) has || { echo "The config profile ($p) could not be found" >&2; exit 255; }; case "$*" in *--use-device-code*) echo "Then enter the code: FAKE-CODE at https://device.sso.example.com/" >&2;; esac; mkdir -p "$(dirname "$c")"; printf '{"accessToken":"${FAKE_AWS_TOKEN}","expiresAt":"2099-01-01T00:00:00Z"}' > "$c";;
  *"sts get-caller-identity"*) has && [ -f "$c" ] && ! grep -q expired "$c" && echo "arn:aws:sts::111111111111:assumed-role/Dev/ada@example.com" || { echo "Error when retrieving token from sso: Token has expired and refresh failed" >&2; exit 255; };;
  *) exit 2;;
esac`,
  );

  return {
    dir,
    path: `${dir}:/usr/bin:/bin`,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
        : [],
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
