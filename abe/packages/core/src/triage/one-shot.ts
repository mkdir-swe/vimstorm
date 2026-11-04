/**
 * One-shots (spec #35 story 121): a tiny ask answered by `claude -p` in one go, with no tools, no
 * session and no hooks, for jobs too small for a session (triage's verdicts, Improve's proposals,
 * Improve retro's findings; later Make card). The rules here: the model a role gets under `allowedModels`, the clean
 * environment (a session's, without its socket), the argv, a prompt asking for one JSON answer of
 * a given shape, and reading that answer back.
 */
import { type z } from 'zod';
import { sessionEnv, type Env, WORKSPACE_DATABASE } from '../session/session';

/**
 * The agent roles and the models each prefers, best first (spec #35 stories 44, 122): the
 * coordinator and writers on Opus, readers on Sonnet or Haiku. `allowedModels` lowers them.
 */
export const ROLE_MODELS = {
  coordinator: ['opus'],
  writer: ['opus'],
  reader: ['sonnet', 'haiku'],
  /** A step's summary and the run's brief: the fastest first. */
  summarizer: ['haiku', 'sonnet'],
} as const satisfies Record<string, readonly string[]>;
export type Role = keyof typeof ROLE_MODELS;

/** The role's first preferred model that is allowed, else the first allowed one (`allowedModels`). */
export const modelFor = (role: Role, allowed: readonly string[]): string | undefined =>
  ROLE_MODELS[role].find((m) => allowed.includes(m)) ?? allowed[0];

/** How long a one-shot may take before it is killed (`one-shot-timeout`). */
export const ONE_SHOT_TIMEOUT_MS = 180_000;

/**
 * A one-shot's whole environment: a session's (`sessionEnv`: `HOME`, `USER`, `PATH` with `abe`'s
 * folder first, `TERM`, the locale, the Reach names given) without `ABE_SOCKET`, since a one-shot
 * is no session and runs no `abe hook`, and without the workspace's `DATABASE_URL` (it has no tools).
 */
export const oneShotEnv = (o: {
  parent: Env;
  bin: string;
  reach: Readonly<Record<string, string>>;
}): ReturnType<typeof sessionEnv> => {
  const env = sessionEnv({ ...o, socket: '' });

  return env.ok
    ? {
        ok: true,
        env: Object.fromEntries(
          Object.entries(env.env).filter(
            ([name]) => name !== 'ABE_SOCKET' && name !== WORKSPACE_DATABASE,
          ),
        ),
      }
    : env;
};

/**
 * `claude -p` for a one-shot; the prompt goes on stdin. No tools, no MCP servers, no slash
 * commands, no settings files (so none of the person's hooks or plugins), nothing kept on disk.
 */
export const oneShotArgv = (o: { claude: string; model: string; system: string }): string[] => [
  o.claude,
  '-p',
  '--model',
  o.model,
  '--tools',
  '',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--setting-sources',
  '',
  '--no-session-persistence',
  '--output-format',
  'text',
  ...(o.system === '' ? [] : ['--append-system-prompt', o.system]),
];

/** `prompt`, then the ask for exactly one JSON document of `shape` (an example or a description). */
export const askingJson = (prompt: string, shape: string): string =>
  `${prompt.trimEnd()}

Answer with exactly one JSON document of this shape and nothing else: no prose before or after it, no code fence.

${shape.trim()}
`;

/** Why an answer is not what was asked for. */
export type Unreadable = { ok: false; message: string };

/**
 * The JSON document in a one-shot's text answer, read with `schema`: the whole text, else the one
 * inside a code fence, else from its first `{` to its last `}` (a model that added a line around
 * it). Anything else is unreadable, with zod's reason.
 */
export const readJsonAnswer = <T extends z.ZodType>(
  text: string,
  schema: T,
): { ok: true; data: z.output<T> } | Unreadable => {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(trimmed)?.[1];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  const candidates = [
    trimmed,
    ...(fenced === undefined ? [] : [fenced]),
    ...(first >= 0 && last > first ? [trimmed.slice(first, last + 1)] : []),
  ];
  let reason = 'no JSON document in the answer';

  for (const candidate of candidates) {
    let json: unknown;

    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = schema.safeParse(json);

    if (parsed.success) return { ok: true, data: parsed.data };
    reason = parsed.error.issues
      .map((i) => `${i.path.length === 0 ? '(top)' : i.path.join('.')}: ${i.message}`)
      .join('; ');
  }

  return { ok: false, message: reason };
};
