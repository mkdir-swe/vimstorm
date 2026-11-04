/**
 * A source's account in the Connection check: who its MCP server is signed in as (Sentry's org
 * and project, Figma's user). The server's login is Claude Code's, never Abe's, so the person's
 * own `claude -p` asks it: only that server (from the config file that names it), all its tools,
 * no built-in tools, one tool call and then the answer. Only names and ids are
 * kept. Pure: the argv, the prompt and reading the answer; `InstallRepo.sourceAccount` runs it.
 */
import { z } from 'zod';
import { sourceRules } from './source-tools';
import { askingJson, readJsonAnswer } from '../triage/one-shot';
import { type SourceProbeRead } from './source-sign-in';

/** What the server told of its account, only the parts it named; `{}`: none, or not asked. */
export type SourceAccount = { account?: string; org?: string; project?: string };

/**
 * A source's probe (ADR 0027): whether its one reading tool call returned without error, and the
 * account it told. `timeout`: no answer in time, or claude not there to ask.
 */
export type SourceProbe = { read: SourceProbeRead; account: SourceAccount };

/** How long the ask may take before it is killed and the MCP status is shown alone. */
export const SOURCE_ACCOUNT_TIMEOUT_MS = 60_000;

/** One turn for the tool call, one for the answer. */
export const SOURCE_ACCOUNT_TURNS = 2;

/** The models it is asked on, best first: one tool call and a name want the smallest. */
export const SOURCE_ACCOUNT_MODELS = ['haiku', 'sonnet'] as const;

/** The first of `SOURCE_ACCOUNT_MODELS` that `allowedModels` allows, else the first allowed. */
export const sourceAccountModel = (allowed: readonly string[]): string | undefined =>
  SOURCE_ACCOUNT_MODELS.find((m) => allowed.includes(m)) ?? allowed[0];

/**
 * The settings on its command line: only `mcp` is started (`allowedMcpServers`), every tool of
 * it allowed (a server may tell who it is through any tool: Sentry's `execute_sentry_tool`).
 */
export const sourceAccountSettings = (mcp: string) => {
  const rules = sourceRules([mcp]);

  return { allowedMcpServers: [{ serverName: mcp }], permissions: rules };
};

const SYSTEM =
  'You only say who an MCP server is signed in as. Never repeat a token, key, secret, header or URL.';

/**
 * `claude -p` for it; the prompt goes on stdin. `--tools ''` takes the built-in tools away and
 * leaves the MCP ones; `config` is the file naming the server (the person's `~/.claude.json`,
 * never a repo's `.mcp.json`), read where it is. No settings files, no slash commands, nothing kept.
 */
export const sourceAccountArgv = (o: {
  claude: string;
  model: string;
  mcp: string;
  config: string;
}): string[] => [
  o.claude,
  '-p',
  '--model',
  o.model,
  '--tools',
  '',
  '--mcp-config',
  o.config,
  '--strict-mcp-config',
  '--settings',
  JSON.stringify(sourceAccountSettings(o.mcp)),
  '--setting-sources',
  '',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--max-turns',
  String(SOURCE_ACCOUNT_TURNS),
  '--output-format',
  'text',
  '--append-system-prompt',
  SYSTEM,
];

/** The ask: one tool that tells who it is, once, and the names it told. */
export const sourceAccountPrompt = (mcp: string): string =>
  askingJson(
    `Call one tool of the MCP server ${mcp} that tells who it is signed in as (whoami, the current user, or its organizations), once, and no other tool. Then say whether that call returned without an error, and the account, organization and project it named. Say null for what it did not name.`,
    '{"read": "ok when the tool answered without an error, else error", "account": "the user name or login it is signed in as, or null", "org": "the organization, or null", "project": "the project, or null"}',
  );

/** A name or id on one line; anything longer or with a URL in it is not kept. */
const NAME = /^[^\n\r\t]{1,100}$/;
const named = (v: string | null | undefined) => {
  const t = v?.trim() ?? '';

  return NAME.test(t) && !t.includes('://') && t.toLowerCase() !== 'null' ? t : undefined;
};

const Answer = z.object({
  read: z.string().nullish(),
  account: z.string().nullish(),
  org: z.string().nullish(),
  project: z.string().nullish(),
});

/** The names in its answer; an answer that is not the JSON asked for is `{}`. */
export const readSourceAccount = (text: string): SourceAccount => {
  const r = readJsonAnswer(text, Answer);

  if (!r.ok) return {};
  const account = named(r.data.account);
  const org = named(r.data.org);
  const project = named(r.data.project);

  return {
    ...(account === undefined ? {} : { account }),
    ...(org === undefined ? {} : { org }),
    ...(project === undefined ? {} : { project }),
  };
};

/** The probe's answer: `ok` only when it said so; an answer that is not the JSON asked for is a tool error. */
export const readSourceProbe = (text: string): SourceProbe => {
  const r = readJsonAnswer(text, Answer);

  if (!r.ok) return { read: 'tool-error', account: {} };

  return {
    read: r.data.read?.trim().toLowerCase() === 'ok' ? 'ok' : 'tool-error',
    account: readSourceAccount(text),
  };
};
