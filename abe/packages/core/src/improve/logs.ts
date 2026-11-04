/**
 * Session logs (spec #37, ADR 0019; ticket #49): what leaves the machine and how it is redacted
 * first. Every session's `meta.json`, `hooks.jsonl`, transcript, the card's checks output and its
 * review and verification reports go to the log store under `<repo>/<github-login>/<session>/`
 * (`<repo>`: the checkout's GitHub repo, `owner_name`).
 * The transcript is shipped as a log, never read for state: redaction treats it as opaque JSON
 * lines (each string redacted, the line kept valid JSON).
 */
import { z } from 'zod';
import { type StoredObject } from '../ports';
import { WORKSPACE_DATABASE } from '../session/session';

/** What a redaction leaves in place of a secret: `[redacted:<kind>]`. */
const mark = (kind: string) => `[redacted:${kind}]`;

/** A known value shorter than this is not looked for: it would redact ordinary words. */
const MIN_VALUE = 6;

/** Each kind, its pattern, and which group is the secret (the rest of the match stays). */
type Rule = { kind: string; pattern: RegExp; secret?: number };

/** The names a value is labelled with just before it (`KEY=…`, `"Key": "…"`, `key = …`). */
const labelled = (names: string) => String.raw`((?:${names})["']?\s*[:=]\s*["']?)`;

const RULES: readonly Rule[] = [
  {
    kind: 'private-key',
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { kind: 'claude-token', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    kind: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|APKA|AROA|ASCA)[A-Z0-9]{16}\b/g,
  },
  {
    kind: 'aws-secret-key',
    pattern: new RegExp(
      `${labelled('aws_secret_access_key|secret_access_key|secretAccessKey|SecretAccessKey')}([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])`,
      'gi',
    ),
    secret: 2,
  },
  {
    kind: 'aws-session-token',
    pattern: new RegExp(
      `${labelled('aws_session_token|aws_security_token|session_token|sessionToken|SessionToken')}([A-Za-z0-9/+=]{16,})`,
      'gi',
    ),
    secret: 2,
  },
  {
    // `scheme://user:password@host`: the password only; a mark already there is left. No `\b`:
    // a lookbehind keeps a long `a-a-a-…` from being tried again at every `-` (quadratic).
    kind: 'db-password',
    pattern: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]*:)(?!\[redacted:)([^\s@/'"]+)(@)/gi,
    secret: 2,
  },
];

/** JSON keys whose whole string value is the secret, whatever it looks like. */
const SECRET_KEYS: readonly { kind: string; key: RegExp }[] = [
  { kind: 'aws-secret-key', key: /^(aws_)?secret_?access_?key$/i },
  { kind: 'aws-session-token', key: /^(aws_)?(session|security)_?token$/i },
];

/** An AWS key id: on its line, an unlabelled secret key or session token is taken too. */
const KEY_ID_LINE = /^.*\b(?:AKIA|ASIA)[A-Z0-9]{16}\b.*$/gm;
const BARE_SECRET = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;
const BARE_TOKEN = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{100,}={0,2}(?![A-Za-z0-9/+=])/g;

type Redacted = { text: string; redacted: number };

/** A value known to be secret (a session's `ABE_*` value, credentials `serve` minted) and its mark. */
export type KnownSecret = { kind: string; value: string };

/**
 * Whether a session's variable is a secret to redact: its `ABE_*` ones, its database and its gh
 * login's token (`logins.gh`).
 */
export const isSessionSecret = (name: string): boolean =>
  name.startsWith('ABE_') || name === WORKSPACE_DATABASE || name === 'GH_TOKEN';

/**
 * A session's `ABE_*` variables and its `DATABASE_URL` as known secrets, each marked by its name;
 * a database URL's password also on its own (`PGPASSWORD=…`), marked `db-password`.
 */
export const abeSecrets = (abe: Readonly<Record<string, string>>): KnownSecret[] =>
  Object.entries(abe).flatMap(([name, value]) => {
    if (!isSessionSecret(name)) return [];
    const password = /^[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^\s@/]+)@/i.exec(value)?.[1];

    return [
      { kind: name, value },
      ...(password === undefined ? [] : [{ kind: 'db-password', value: password }]),
    ];
  });

/** Longest first, so a value inside another is not cut out of it; short ones left out. */
const usable = (known: readonly KnownSecret[]) =>
  known.filter((k) => k.value.length >= MIN_VALUE).sort((a, b) => b.value.length - a.value.length);

const redactWith = (text: string, known: readonly KnownSecret[]): Redacted => {
  let out = text;
  let redacted = 0;

  for (const k of known) {
    const parts = out.split(k.value);

    redacted += parts.length - 1;
    out = parts.join(mark(k.kind));
  }
  // `aws … --output text` / table rows: a key id, then its secret and token unlabelled.
  out = out.replace(KEY_ID_LINE, (line) =>
    line
      .replace(BARE_TOKEN, () => {
        redacted += 1;

        return mark('aws-session-token');
      })
      .replace(BARE_SECRET, () => {
        redacted += 1;

        return mark('aws-secret-key');
      }),
  );
  for (const rule of RULES)
    out = out.replace(rule.pattern, (...m: unknown[]) => {
      redacted += 1;
      if (rule.secret === undefined) return mark(rule.kind);
      const groups = m.slice(1, -2).map((g) => (typeof g === 'string' ? g : ''));

      return groups.map((g, i) => (i + 1 === rule.secret ? mark(rule.kind) : g)).join('');
    });

  return { text: out, redacted };
};

/**
 * `text` with every secret replaced by `[redacted:<kind>]`: each known value (a session's `ABE_*`
 * values, marked by name: `abeSecrets`), AWS access keys, secret keys and session tokens, GitHub tokens
 * (`ghp_` `gho_` `ghs_` `ghu_` `ghr_` `github_pat_`), Claude tokens (`sk-ant-`), JWTs, PEM private
 * keys and the password in a `scheme://user:password@host` URL. An AWS secret key or session token
 * on the same line as an access key id is taken without a label too.
 */
export const redactText = (text: string, known: readonly KnownSecret[]): string =>
  redactWith(text, usable(known)).text;

/** Every string in a parsed JSON value redacted (keys too); a secret key's value whole. */
const redactJson = (
  doc: unknown,
  values: readonly KnownSecret[],
  count: { n: number },
): unknown => {
  const str = (s: string) => {
    const r = redactWith(s, values);

    count.n += r.redacted;

    return r.text;
  };

  if (typeof doc === 'string') return str(doc);
  if (Array.isArray(doc)) return doc.map((d) => redactJson(d, values, count));
  if (typeof doc !== 'object' || doc === null) return doc;

  return Object.fromEntries(
    Object.entries(doc).map(([key, value]) => {
      const secret = SECRET_KEYS.find((s) => s.key.test(key));

      if (secret !== undefined && typeof value === 'string' && value !== '') {
        count.n += 1;

        return [str(key), mark(secret.kind)];
      }

      return [str(key), redactJson(value, values, count)];
    }),
  );
};

const parsed = (text: string): { ok: true; doc: unknown } | { ok: false } => {
  try {
    return { ok: true, doc: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/** One JSON text redacted, re-written only when something was; else as it was, byte for byte. */
const redactJsonText = (
  text: string,
  values: readonly KnownSecret[],
  indent: number | undefined,
): Redacted => {
  const read = parsed(text);

  if (!read.ok) return redactWith(text, values);
  const count = { n: 0 };
  const doc = redactJson(read.doc, values, count);

  return count.n === 0
    ? { text, redacted: 0 }
    : { text: JSON.stringify(doc, null, indent), redacted: count.n };
};

/**
 * A log file redacted by what it is: `.jsonl` line by line (each line's strings, the line still
 * JSON; a line that is not JSON, such as a torn last one, as text), `.json` as one document,
 * anything else (markdown, a report) as text. `redacted` counts the secrets taken out.
 */
export const redactLog = (name: string, text: string, known: readonly KnownSecret[]): Redacted => {
  const values = usable(known);

  if (name.endsWith('.jsonl')) {
    let redacted = 0;
    const lines = text.split('\n').map((line) => {
      if (line.trim() === '') return line;
      const r = redactJsonText(line, values, undefined);

      redacted += r.redacted;

      return r.text;
    });

    return { text: lines.join('\n'), redacted };
  }
  if (name.endsWith('.json')) {
    const trailing = text.endsWith('\n') ? '\n' : '';
    const r = redactJsonText(text.trimEnd(), values, 2);

    return r.redacted === 0
      ? { text, redacted: 0 }
      : { text: `${r.text}${trailing}`, redacted: r.redacted };
  }

  return redactWith(text, values);
};

/**
 * A session's log files where they are, and the folders whose files go under their name. Each is
 * read only when it is, with links resolved, inside its `within` folder: a session cannot point
 * `serve` at another file (`~/.netrc`) through a link or its hooks' `transcript_path`.
 */
export type LogSources = {
  files: { name: string; path: string; within: string }[];
  dirs: { name: string; path: string; within: string }[];
};

/** Log sources as read: each file's text by its name in the store, and those not shipped, why. */
export type LogsRead = {
  files: { name: string; text: string }[];
  skipped: { name: string; why: string }[];
};

/**
 * Whether a hook's `transcript_path` is Claude Code's own for this session:
 * `<home>/.claude/projects/<folder>/<claude session id>.jsonl`, and nothing else.
 */
export const isTranscriptPath = (path: string, home: string, claudeSession: string): boolean => {
  const projects = `${home.replace(/\/+$/, '')}/.claude/projects/`;

  if (!path.startsWith(projects)) return false;
  const rest = path.slice(projects.length).split('/');

  return (
    rest.length === 2 &&
    rest[0] !== undefined &&
    rest[0] !== '' &&
    rest[0] !== '.' &&
    rest[0] !== '..' &&
    rest[1] === `${claudeSession}.jsonl`
  );
};

/**
 * What a session ships, by where it is read. `serve`: the session's folder's `meta.json`,
 * `hooks.jsonl` and a Factory run's `run.json`, on serve's own disk. `session`: where the session
 * ran (on a box, inside the workspace container): Claude Code's transcript (the hooks'
 * `transcript_path` under the session's `HOME`, when `isTranscriptPath`), and in its worktree the
 * card's `.scratch/<card>/` checks output (`checks.md`) and review and verification reports and
 * Evidence (`review/`, `verify/`). One that is not there is skipped.
 */
export const logSourcesOf = (s: {
  sessionDir: string;
  transcriptPath: string | null;
  /** The session's `HOME` and `--session-id`: where its transcript must be. */
  home: string;
  claudeSession: string;
  worktree: string;
  card: number;
}): { serve: LogSources; session: LogSources } => {
  const worktree = s.worktree.replace(/\/+$/, '');
  const scratch = `${worktree}/.scratch/${s.card}`;
  const inWorktree = s.worktree !== '';
  const transcript =
    s.transcriptPath !== null && isTranscriptPath(s.transcriptPath, s.home, s.claudeSession)
      ? s.transcriptPath
      : undefined;

  return {
    serve: {
      files: [
        { name: 'meta.json', path: `${s.sessionDir}/meta.json`, within: s.sessionDir },
        { name: 'hooks.jsonl', path: `${s.sessionDir}/hooks.jsonl`, within: s.sessionDir },
        // A Factory run's stages, reviews, verifications, pull request and deploy (#86's retro).
        { name: 'run.json', path: `${s.sessionDir}/run.json`, within: s.sessionDir },
      ],
      dirs: [],
    },
    session: {
      files: [
        ...(transcript === undefined
          ? []
          : [
              {
                name: 'transcript.jsonl',
                path: transcript,
                within: `${s.home.replace(/\/+$/, '')}/.claude/projects`,
              },
            ]),
        ...(inWorktree
          ? [{ name: 'checks.md', path: `${scratch}/checks.md`, within: worktree }]
          : []),
      ],
      dirs: inWorktree
        ? [
            { name: 'review', path: `${scratch}/review`, within: worktree },
            { name: 'verify', path: `${scratch}/verify`, within: worktree },
          ]
        : [],
    },
  };
};

/** Whose session a log is: the store's prefix is `<repo>/<login>/<session>/`. */
export type LogOwner = { repo: string; login: string; session: string };

/** A key part as the store takes it: anything outside `A-Z a-z 0-9 . _ -` (and `.` / `..`) becomes `_`. */
const keyPart = (p: string) => {
  const safe = p.replace(/[^A-Za-z0-9._-]/g, '_');

  return safe === '' || safe === '.' || safe === '..' ? '_' : safe;
};

export const logPrefix = (o: LogOwner): string =>
  `${keyPart(o.repo)}/${keyPart(o.login)}/${keyPart(o.session)}/`;

/** Where one log file (`meta.json`, `verify/report.md`) goes in the store. */
export const logKey = (o: LogOwner, name: string): string =>
  `${logPrefix(o)}${name.split('/').map(keyPart).join('/')}`;

/** The content type a log file is stored with. */
export const logContentType = (name: string): string => {
  if (name.endsWith('.jsonl')) return 'application/x-ndjson';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';

  return 'text/plain; charset=utf-8';
};

/** Why a session was shipped: `interval` (every five minutes while it runs), `end`, `now` (the command). */
export const SHIP_REASONS = ['interval', 'end', 'now'] as const;
export type ShipReason = (typeof SHIP_REASONS)[number];

/** How often `serve` ships each running session. */
export const LOG_SHIP_EVERY_MS = 5 * 60_000;

export const LogSession = z.object({
  /** The repo's part of the prefix (`owner_name`). */
  repo: z.string(),
  user: z.string(),
  session: z.string(),
  /** The files under it, relative to its prefix. */
  files: z.array(z.string()),
  bytes: z.number().int().nonnegative(),
});
export type LogSession = z.infer<typeof LogSession>;

/** The store's objects as sessions, one per `<repo>/<user>/<session>/`, by repo, user and session. */
export const logSessions = (objects: readonly StoredObject[]): LogSession[] => {
  const by = new Map<string, LogSession>();

  for (const o of objects) {
    const [repo, user, session, ...rest] = o.key.split('/');

    if (repo === undefined || user === undefined || session === undefined || rest.length === 0)
      continue;
    const id = `${repo}/${user}/${session}`;
    const row = by.get(id) ?? { repo, user, session, files: [], bytes: 0 };

    row.files.push(rest.join('/'));
    row.bytes += o.size;
    by.set(id, row);
  }

  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
    .map(([, row]) => ({ ...row, files: row.files.sort() }));
};

/** The prefix `abe log list` reads: a repo's (`owner/name`), or the whole store's (a user is filtered after). */
export const logListPrefix = (repo: string | undefined): string =>
  repo === undefined ? '' : `${keyPart(repo)}/`;

/** One person's sessions of a repo (`owner/name`) in the store: `<repo>/<login>/`. */
export const logUserPrefix = (repo: string, login: string): string =>
  `${keyPart(repo)}/${keyPart(login)}/`;

export const LogListData = z.object({ sessions: z.array(LogSession) });
export type LogListData = z.infer<typeof LogListData>;

export const LogShipData = z.object({
  session: z.string(),
  card: z.number().int().positive(),
  prefix: z.string(),
  reason: z.enum(SHIP_REASONS),
  files: z.array(
    z.object({
      name: z.string(),
      key: z.string(),
      bytes: z.number().int().nonnegative(),
      /** Secrets taken out of it. */
      redacted: z.number().int().nonnegative(),
    }),
  ),
  /** Files there that were not shipped, and why (unreadable, a link out of its folder, not text). */
  skipped: z.array(z.object({ name: z.string(), why: z.string() })),
});
export type LogShipData = z.infer<typeof LogShipData>;

export const logShipText = (d: LogShipData): string =>
  `${[
    `shipped ${d.session} to ${d.prefix}`,
    ...d.files.map(
      (f) => `  ${f.name}  ${f.bytes} B${f.redacted === 0 ? '' : `, ${f.redacted} redacted`}`,
    ),
    ...d.skipped.map((f) => `  ${f.name}  skipped: ${f.why}`),
  ].join('\n')}\n`;

export const logListText = (d: LogListData): string =>
  d.sessions.length === 0
    ? 'no session logs\n'
    : `${d.sessions
        .map((s) => `${s.repo}/${s.user}/${s.session}  ${s.files.length} files, ${s.bytes} B`)
        .join('\n')}\n`;
