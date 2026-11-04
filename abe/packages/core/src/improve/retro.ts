/**
 * Improve retro (spec #36 stories 53–60, ADR 0019; ticket #86): Improve looking back. A retro
 * reads the log store's sessions of its scope (me: your own in this repo) since the last retro of
 * that scope, and one one-shot with core's retro skill names
 * findings: most severe first, each traced to moments in the logs (`<session>/<file>#<line>`) and
 * naming the Layer its fix belongs in. The rules here: the prefixes a scope reads, the prompt and
 * the answer's shape, moment resolution (a finding whose moment does not resolve is dropped and
 * counted), the removal rule for earlier fixes, and what `make` writes where. A retro applies
 * nothing: `make` writes a fix into the checkout uncommitted (`--pr`: opens its pull request), files a
 * Send to Abe finding's issue, or makes a personal one an Improve proposal.
 */
import { z } from 'zod';
import { DEFAULT_HOOKS, REPO_SKILLS_DIR, type RepoHooks, runAppSkill } from '../repo-hooks';
import { LAYER_FILE, REPO_PATH, REPO_WORKFLOWS_DIR } from '../layer/settings/places';
import { logUserPrefix } from './logs';
import { askingJson, readJsonAnswer } from '../triage/one-shot';
import { skillBody } from '../skills/skills';
import { parseRef, showRef } from '../board/tracking';
import retroSkill from '../../skills/retro/one-shot.md' with { type: 'text' };

/** Core's retro skill as the one-shot's system prompt (upstream retro, our sources and Layers on top). */
export const RETRO_SKILL: string = skillBody(retroSkill);

/** Whose sessions a retro reads: yours (me). */
export const RETRO_SCOPES = ['me'] as const;
export type RetroScope = (typeof RETRO_SCOPES)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Where a fix goes. Fix here: the repo's files (`repo`) or yours (`individual`). Send to Abe
 * (`abe`): a bug or missing feature in Abe itself, never a retro's to change, drafted as an issue.
 */
export const FIX_LAYERS = ['repo', 'individual', 'abe'] as const;
export type FixLayer = (typeof FIX_LAYERS)[number];

/** The label every pull request `make` opens carries: how a later retro finds earlier fixes. */
export const RETRO_LABEL = 'abe-retro';

/** The words the label is made with in a repo that has none yet. */
export const RETRO_LABEL_DESCRIPTION = 'A fix proposed by abe improve retro';

/** What a later retro says of an earlier fix. `unclear`: not judged, or its evidence did not resolve. */
export const EARLIER_VERDICTS = ['helping', 'recurring', 'noisy', 'unclear'] as const;
export type EarlierVerdict = (typeof EARLIER_VERDICTS)[number];

/** Who a retro reads for: the repo it runs in (`owner/name`) and the GitHub login of the person. */
export type RetroWho = { repo: string; login: string };

/** The log store prefixes a scope reads, and nothing else: me `<repo>/<you>/`. */
export const retroPrefixes = (_scope: RetroScope, who: RetroWho): string[] => [
  logUserPrefix(who.repo, who.login),
];

/** Whether a store key lies under one of the scope's prefixes. */
export const inPrefixes = (key: string, prefixes: readonly string[]): boolean =>
  prefixes.some((p) => key.startsWith(p));

/** One retro per scope remembers its time: the key its last time is kept under. */
export const retroScopeKey = (scope: RetroScope, who: RetroWho): string =>
  `${scope}-${who.repo}-${who.login}`;

/** What a retro reads of a stored `meta.json`: the card, its title and when it last moved. */
export const StoredMeta = z.object({
  card: z.number().int().positive(),
  title: z.string().default(''),
  since: z.iso.datetime(),
});
export type StoredMeta = z.infer<typeof StoredMeta>;

/** What a retro reads of a stored `run.json`: the run's pull request, for its comments. */
export const StoredRun = z.object({
  pr: z.object({ repo: z.string(), number: z.number().int().positive() }).nullable().default(null),
});

/** A session counts once it moved after the last retro of the scope (none yet: every session). */
export const movedSince = (meta: StoredMeta, since: string | null): boolean =>
  since === null || Date.parse(meta.since) > Date.parse(since);

/** One file a retro reads: a stored log, or one of the retro's own (pull request comments, Overrides). */
export type RetroSource = { session: string; name: string; text: string };

/** A session as the prompt shows it. */
export type RetroSession = {
  session: string;
  /** The repo's part of its store prefix (`owner_name`). */
  repo: string;
  user: string;
  card: number;
  title: string;
  since: string;
  files: { name: string; text: string }[];
};

/** The pseudo-session the retro's Layer sources (the Overrides in force) sit under. */
export const LAYERS_SESSION = 'layers';

/** The lines a file has: what a moment's line must be within. A trailing newline ends the last. */
export const lineCount = (text: string): number => {
  if (text === '') return 0;
  const lines = text.split('\n');

  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
};

/** The n-th line (1-based), or `undefined` past the end. */
export const lineAt = (text: string, n: number): string | undefined =>
  n >= 1 && n <= lineCount(text) ? text.split('\n')[n - 1] : undefined;

const MOMENT = /^([A-Za-z0-9._-]+)\/([^#\s]+)#([1-9]\d*)$/;

export const Moment = z.object({
  /** As cited: `<session>/<file>#<line>`. */
  ref: z.string(),
  session: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  /** When it was said (a JSON line's own time, `HH:MM:SS`); none for a plain line. */
  at: z.string().optional(),
  /** What it says, readable (`momentWords`), cut to `MOMENT_TEXT_MAX`. */
  text: z.string(),
});
export type Moment = z.infer<typeof Moment>;

const MOMENT_TEXT_MAX = 160;

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** What a transcript's content says: its text, a tool call's name and command, a result's text. */
const contentWords = (content: unknown): string[] => {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];

  return content.flatMap((b): string[] => {
    if (typeof b === 'string') return [b];
    if (!isRecord(b)) return [];
    if (b.type === 'text' && typeof b.text === 'string') return [b.text];
    if (b.type === 'tool_result') return contentWords(b.content);
    if (b.type !== 'tool_use') return [];
    const input = isRecord(b.input) ? b.input : {};
    const what = ['command', 'file_path', 'pattern', 'description', 'prompt']
      .map((k) => input[k])
      .find((v) => typeof v === 'string');

    return [`${String(b.name)}${typeof what === 'string' ? `: ${what}` : ''}`];
  });
};

const parsed = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/** A JSON value as words: a string unescaped, an opening brace or bracket as nothing. */
const valueWords = (raw: string): string => {
  if (raw === '{' || raw === '[' || raw === '{}' || raw === '[]') return '';
  const v = parsed(raw);
  if (!v.ok) return raw;
  if (typeof v.value === 'string') return v.value;
  if (typeof v.value === 'number' || typeof v.value === 'boolean' || v.value === null)
    return String(v.value);
  const words: string[] = [];

  strings(v.value, words);

  return words.join(' · ');
};

const JSON_KEY = /^"((?:[^"\\]|\\.)*)"\s*:\s*(.*)$/;

/**
 * A pretty-printed JSON file's line as words: `"doneWhen": "An \"id\"",` reads `doneWhen: An "id"`,
 * a bare value its words, never a quote escaped; else the line as it is, its comma gone.
 */
const jsonFileWords = (line: string): string => {
  const t = line.trim().replace(/,$/, '');
  const kv = JSON_KEY.exec(t);

  if (kv !== null) {
    const key = parsed(`"${kv[1] ?? ''}"`);
    const value = valueWords((kv[2] ?? '').trim());

    return `${key.ok && typeof key.value === 'string' ? key.value : (kv[1] ?? '')}:${value === '' ? '' : ` ${value}`}`;
  }

  return t.startsWith('"') || t.startsWith('{') || t.startsWith('[') ? valueWords(t) : t;
};

/** How many lines under a JSON file's opening key are looked through for its first value. */
const UNDER_KEY_MAX = 20;

/**
 * A JSON file's line as words; one opening an object or a list (`summary:`) with the first value
 * under it (`summary: text: The run…`), from the `after` lines.
 */
const jsonMomentWords = (line: string, after: readonly string[]): string => {
  const words = jsonFileWords(line);

  if (!/[{[]$/.test(line.trim())) return words;
  let depth = 0;

  for (const next of after.slice(0, UNDER_KEY_MAX)) {
    const t = next.trim().replace(/,$/, '');
    const w = jsonFileWords(next);

    if (t === '}' || t === ']') depth -= 1;
    else if (t === '{' || t === '[' || w.endsWith(':')) depth += 1;
    else if (w !== '') return `${words} ${w}`;
    // its own object or list closed with no value in it
    if (depth < 0) return words;
  }

  return words;
};

/**
 * A cited line as a person reads it: a JSON line's time and what it says (a transcript message's
 * text or tool call, else its words), a JSON file's line as `key: value` (an opening key with the
 * first value under it, from `after`, the lines after it), plain text as it is; one line, cut to
 * `MOMENT_TEXT_MAX`.
 */
export const momentWords = (
  name: string,
  line: string,
  after: readonly string[] = [],
): { at?: string; text: string } => {
  const plain = (t: string) => cut(t.trim().replace(/\s+/g, ' '), MOMENT_TEXT_MAX);

  if (name.endsWith('.json')) return { text: plain(jsonMomentWords(line, after)) };
  if (!name.endsWith('.jsonl') || !line.trim().startsWith('{')) return { text: plain(line) };
  const read = parsed(line);
  if (!read.ok || !isRecord(read.value)) return { text: plain(line) };
  const doc = read.value;
  const time = [doc.timestamp, doc.at, doc.time].find((v) => typeof v === 'string');
  const at = typeof time === 'string' ? /T(\d\d:\d\d:\d\d)/.exec(time)?.[1] : undefined;
  const said = isRecord(doc.message) ? contentWords(doc.message.content) : [];
  const words: string[] = [];

  if (said.length === 0) strings(doc, words);
  const who = isRecord(doc.message) && typeof doc.message.role === 'string' ? doc.message.role : '';
  const text = plain(
    said.length > 0 ? `${who === '' ? '' : `${who}: `}${said.join(' · ')}` : words.join(' · '),
  );

  return at === undefined ? { text } : { at, text };
};

/** A moment as one readable line: its time and ref, what it says quoted. */
export const momentLine = (m: Pick<Moment, 'ref' | 'at' | 'text'>): string =>
  `${m.at === undefined ? '' : `${m.at}  `}${m.ref}  "${m.text}"`;

/**
 * A cited moment as a real line of a file the retro read, or why not: no such file in no such
 * session, or a line past its end.
 */
export const resolveMoment = (
  ref: string,
  sources: readonly RetroSource[],
): { ok: true; moment: Moment } | { ok: false; why: string } => {
  const m = MOMENT.exec(ref.trim());

  if (m === null) return { ok: false, why: `${ref} is not <session>/<file>#<line>` };
  const [, session = '', file = '', n = '0'] = m;
  const source = sources.find((s) => s.session === session && s.name === file);

  if (source === undefined) return { ok: false, why: `${ref}: no file ${file} in ${session}` };
  const line = Number(n);
  const text = lineAt(source.text, line);

  if (text === undefined)
    return { ok: false, why: `${ref}: ${file} has ${lineCount(source.text)} lines` };

  return {
    ok: true,
    moment: {
      ref: `${session}/${file}#${line}`,
      session,
      file,
      line,
      ...momentWords(file, text, source.text.split('\n').slice(line, line + UNDER_KEY_MAX)),
    },
  };
};

/** Why a fix's path cannot be written in its Layer: it must stay under the Layer's root. */
export const fixPathProblem = (path: string): string | undefined => {
  if (path === '') return 'an empty path';
  if (path.startsWith('/') || path.includes('\\')) return `${path} is not relative to the Layer`;
  if (path.split('/').some((p) => p === '' || p === '.' || p === '..'))
    return `${path} leaves its folder`;

  return undefined;
};

/**
 * Where the repo Layer's file sits in its repo (ADR 0031, 0033): its settings in the team's file
 * (`REPO_PATH`), its workflows in `abe/workflows/`, its skills in `.claude/skills/`, the app's
 * scripts in the run-app skill's (`hooks`' `run-app`); only the rest, local, under `.abe/`.
 */
export const layerRepoPath = (path: string, hooks: RepoHooks = DEFAULT_HOOKS): string => {
  if (path === LAYER_FILE) return REPO_PATH;
  if (path.startsWith('workflows/'))
    return `${REPO_WORKFLOWS_DIR}/${path.slice('workflows/'.length)}`;
  if (path.startsWith('skills/')) return `${REPO_SKILLS_DIR}/${path.slice('skills/'.length)}`;
  if (path.startsWith('scripts/'))
    return `${runAppSkill(hooks).scripts}/${path.slice('scripts/'.length)}`;

  return `.abe/${path}`;
};

const LayerWords: Readonly<Record<FixLayer, string>> = {
  repo: 'fix here: repo (abe.yaml, abe/workflows, .claude/skills)',
  individual: 'fix here: personal (abe improve)',
  abe: 'send to Abe: an issue',
};

/** Fix here (the repo's or your own files) or Send to Abe (an issue on Abe itself). */
export const fixHere = (layer: FixLayer): boolean => layer !== 'abe';

// ── The prompt ──────────────────────────────────────────────────────────────────────────────

/** A long line is cut here, so one huge JSON line cannot crowd out the rest. */
const LINE_MAX = 300;
/** A file longer than this shows its first `HEAD` and last `TAIL` lines; the rest is left out. */
const FILE_LINES = 240;
const HEAD = 80;
const TAIL = 160;
/** All the sessions' text together stays under this; the oldest past it are left out, counted. */
export const RETRO_SOURCES_MAX = 300_000;

/** Keys of a JSON line that say nothing a retro reads: ids and paths. */
const QUIET = new Set([
  'uuid',
  'parentUuid',
  'sessionId',
  'session_id',
  'requestId',
  'id',
  'cwd',
  'transcript_path',
  'version',
  'gitBranch',
  'userType',
  'signature',
]);

const strings = (doc: unknown, out: string[]): void => {
  if (typeof doc === 'string') {
    if (doc.trim() !== '') out.push(doc.trim().replace(/\s+/g, ' '));

    return;
  }
  if (typeof doc === 'number' || typeof doc === 'boolean') return;
  if (Array.isArray(doc)) {
    for (const d of doc) strings(d, out);

    return;
  }
  if (typeof doc !== 'object' || doc === null) return;
  for (const [key, value] of Object.entries(doc)) if (!QUIET.has(key)) strings(value, out);
};

/**
 * One line as the prompt shows it: a JSON line (a transcript's, a hook event's) as its words
 * joined by ` · `, anything else as it is; cut to `LINE_MAX`.
 */
export const lineDigest = (name: string, line: string): string => {
  if (name.endsWith('.jsonl') && line.trim().startsWith('{')) {
    try {
      const words: string[] = [];

      strings(JSON.parse(line), words);

      return cut(words.join(' · '), LINE_MAX);
    } catch {
      // Not JSON after all: shown as text.
    }
  }

  return cut(line, LINE_MAX);
};

const numbered = (n: number, text: string) => `${String(n).padStart(5)}  ${text}`;

/** A file's lines with their numbers (what a moment cites), a long one's middle left out. */
export const fileBlock = (session: string, name: string, text: string): string => {
  const total = lineCount(text);
  const lines = text.split('\n').slice(0, total);
  const show = (from: number, to: number) =>
    lines.slice(from - 1, to).map((l, i) => numbered(from + i, lineDigest(name, l)));
  const body =
    total <= FILE_LINES
      ? show(1, total)
      : [
          ...show(1, HEAD),
          `       … lines ${HEAD + 1}–${total - TAIL} left out`,
          ...show(total - TAIL + 1, total),
        ];

  return [`### ${session}/${name} (${total} lines)`, '', ...body].join('\n');
};

const sessionBlock = (s: RetroSession) =>
  [
    `## Session ${s.session} · AB#${s.card} ${s.title} · ${s.repo}/${s.user} · last moved ${s.since}`,
    ...s.files.map((f) => fileBlock(s.session, f.name, f.text)),
  ].join('\n\n');

/**
 * The sessions the prompt holds, oldest first, while their text stays under `max` (the first
 * always); from the first that does not fit on, the newer ones are left out, counted, and read by
 * the next retro (`scopeTimeAfter`).
 */
export const sessionsToRead = (
  sessions: readonly RetroSession[],
  max: number = RETRO_SOURCES_MAX,
): { read: RetroSession[]; leftOut: RetroSession[] } => {
  const oldest = [...sessions].sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  const read: RetroSession[] = [];
  let size = 0;

  for (const s of oldest) {
    const block = sessionBlock(s).length;

    if (size + block > max && read.length > 0) break;
    read.push(s);
    size += block;
  }

  return { read, leftOut: oldest.slice(read.length) };
};

/**
 * The time the scope's next retro reads after: now, once every session was read; else the newest
 * read session's, so the ones left out come next time.
 */
export const scopeTimeAfter = (
  read: readonly RetroSession[],
  leftOut: readonly RetroSession[],
  at: string,
): string =>
  leftOut.length === 0
    ? at
    : new Date(Math.max(...read.map((s) => Date.parse(s.since)))).toISOString();

/** An earlier retro's pull request, merged: a fix in force, judged again. */
export const EarlierPull = z.object({
  pr: z.string(),
  url: z.string(),
  title: z.string(),
  mergedAt: z.iso.datetime(),
});
export type EarlierPull = z.infer<typeof EarlierPull>;

/** A Layer's files as they are now: what a fix's whole new file is written over. */
export type LayerFiles = {
  layer: 'repo';
  /** The GitHub repo the Layer lives in. */
  repo: string;
  files: { path: string; text: string }[];
};

const SCOPE_WORDS: Readonly<Record<RetroScope, (w: RetroWho) => string>> = {
  me: (w) => `${w.login} in ${w.repo}`,
};

const ANSWER_SHAPE = `{"findings": [{"severity": "critical | high | medium | low", "title": "<one line>", "whatHappened": "<what went wrong, in a sentence or two>", "moments": ["<session>/<file>#<line>, exactly as numbered in the sources"], "layer": "repo | individual | abe", "fix": {"summary": "<one line: the change>", "files": [{"path": "<the file's path from its Layer's root>", "content": "<the whole new file, or null to remove it>"}] (none for abe), "diff": "<the change as a unified diff, or empty for abe>", "issue": {"title": "<the Abe issue's title>", "body": "<what Abe should do and why, in generic words: no repo, host, person or card names>"} (abe only, else null)}, "recurringOf": "<owner/repo>#<n> of the earlier fix this problem came back after, or null", "removes": "<owner/repo>#<n> of the earlier fix this finding takes out, or null"}],
 "earlier": [{"pr": "<owner/repo>#<n>", "verdict": "helping | recurring | noisy", "why": "<one line>", "moments": ["<session>/<file>#<line>"]}]}

Findings most severe first. One "earlier" entry per earlier fix listed.`;

const layerBlock = (l: LayerFiles) =>
  [
    `## ${LayerWords[l.layer]} in ${l.repo}`,
    ...(l.files.length === 0
      ? ['(no files yet)']
      : l.files.map((f) => [`### ${f.path}`, '', '```', f.text.trimEnd(), '```'].join('\n'))),
  ].join('\n\n');

/** The one-shot's prompt: the sessions with numbered lines, the earlier fixes, the Layers' files. */
export const retroPrompt = (o: {
  scope: RetroScope;
  who: RetroWho;
  sessions: readonly RetroSession[];
  /** The retro's own sources: each session's pull request comments, the Overrides in force. */
  extra: readonly RetroSource[];
  earlier: readonly EarlierPull[];
  layers: readonly LayerFiles[];
}): string =>
  askingJson(
    [
      `Run a retrospective with your retro skill over these ${o.sessions.length} sessions (scope ${o.scope}: ${SCOPE_WORDS[o.scope](o.who)}).`,
      '# Sources',
      ...o.sessions.map(sessionBlock),
      ...o.extra.map((x) => fileBlock(x.session, x.name, x.text)),
      '# Earlier fixes',
      o.earlier.length === 0
        ? '(none: no earlier retro fix is merged)'
        : o.earlier.map((e) => `- ${e.pr} merged ${e.mergedAt}: ${e.title} (${e.url})`).join('\n'),
      '# Layer files (what a fix writes over; paths from each Layer root)',
      ...o.layers.map(layerBlock),
    ].join('\n\n'),
    ANSWER_SHAPE,
  );

// ── The answer ──────────────────────────────────────────────────────────────────────────────

const FixFile = z.object({ path: z.string().trim(), content: z.string().nullable() });
/** A Send to Abe finding's issue, drafted for Abe's repo: shown to the person before it is filed. */
export const FixIssue = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
});
export type FixIssue = z.infer<typeof FixIssue>;

const FindingAnswer = z.object({
  severity: z.enum(SEVERITIES),
  title: z.string().trim().min(1),
  whatHappened: z.string().trim().min(1),
  moments: z.array(z.string()),
  layer: z.enum(FIX_LAYERS),
  fix: z.object({
    summary: z.string().trim().min(1),
    files: z.array(FixFile).default([]),
    diff: z.string().default(''),
    issue: FixIssue.nullish(),
  }),
  recurringOf: z.string().nullish(),
  removes: z.string().nullish(),
});

const EarlierAnswer = z.object({
  pr: z.string(),
  verdict: z.enum(['helping', 'recurring', 'noisy']),
  why: z.string().trim().default(''),
  moments: z.array(z.string()).default([]),
});

/** What the one-shot must answer. */
export const RetroAnswer = z.object({
  findings: z.array(FindingAnswer),
  earlier: z.array(EarlierAnswer).default([]),
});

/** A `make` done: the pull request in its Layer, or the personal `abe improve` proposal. */
export const Made = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pr'),
    pr: z.string(),
    url: z.string(),
    branch: z.string(),
    /** The files written, as paths in the repo. */
    files: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('proposal'),
    /** `abe improve`'s proposal: `abe improve apply <id>` writes it. */
    id: z.string(),
    /** The files, as paths in your personal Layer. */
    files: z.array(z.string()),
  }),
  /** Written into the checkout, uncommitted, for the person to see in `git diff` (no `--pr`). */
  z.object({ kind: z.literal('written'), files: z.array(z.string()) }),
  /** Send to Abe: the issue filed on Abe's repo. */
  z.object({ kind: z.literal('issue'), issue: z.string(), url: z.string() }),
]);
export type Made = z.infer<typeof Made>;

export const Finding = z.object({
  /** Its place, most severe first, from 1: what `make` names. */
  n: z.number().int().positive(),
  severity: z.enum(SEVERITIES),
  title: z.string(),
  whatHappened: z.string(),
  moments: z.array(Moment).min(1),
  layer: z.enum(FIX_LAYERS),
  fix: z.object({
    summary: z.string(),
    files: z.array(FixFile),
    diff: z.string(),
    /** Send to Abe: the issue drafted; null for a fix here. */
    issue: FixIssue.nullable().default(null),
  }),
  /** The earlier fix's pull request this problem came back after. */
  recurringOf: z.string().nullable(),
  /** The earlier fix's pull request this finding takes out. */
  removes: z.string().nullable(),
  made: Made.nullable(),
});
export type Finding = z.infer<typeof Finding>;

export const EarlierFix = EarlierPull.extend({
  verdict: z.enum(EARLIER_VERDICTS),
  why: z.string(),
  moments: z.array(Moment),
  /** Recurring or noisy: proposed for removal. */
  removal: z.boolean(),
  /** The finding that takes it out, when the answer gave one. */
  removedBy: z.number().int().positive().nullable(),
});
export type EarlierFix = z.infer<typeof EarlierFix>;

export const Dropped = z.object({ title: z.string(), why: z.string() });
export type Dropped = z.infer<typeof Dropped>;

/** The removal rule: an earlier fix whose problem recurs, or that is noisy, is proposed for removal. */
export const proposesRemoval = (verdict: EarlierVerdict): boolean =>
  verdict === 'recurring' || verdict === 'noisy';

/**
 * Where an earlier fix stands: a finding recurring of it makes it recurring whatever was said;
 * else the answer's verdict, kept only when it is `helping` or its moments resolve (else
 * `unclear`, counted as dropped); not judged is `unclear`.
 */
export const judgeEarlier = (
  pull: EarlierPull,
  said: z.output<typeof EarlierAnswer> | undefined,
  recurringIn: readonly Finding[],
  sources: readonly RetroSource[],
): { fix: EarlierFix; dropped: Dropped | undefined } => {
  const recurring = recurringIn.filter((f) => samePr(f.recurringOf, pull.pr));
  const base = { ...pull, removedBy: null };

  if (recurring.length > 0)
    return {
      fix: {
        ...base,
        verdict: 'recurring',
        why: `came back: ${recurring.map((f) => `finding ${f.n}`).join(', ')}`,
        moments: recurring.flatMap((f) => f.moments),
        removal: true,
      },
      dropped: undefined,
    };
  if (said === undefined)
    return {
      fix: { ...base, verdict: 'unclear', why: 'not judged', moments: [], removal: false },
      dropped: undefined,
    };
  const resolved = said.moments.map((m) => resolveMoment(m, sources));
  const moments = resolved.flatMap((r) => (r.ok ? [r.moment] : []));
  const failed = resolved.flatMap((r) => (r.ok ? [] : [r.why]));

  if (said.verdict !== 'helping' && (failed.length > 0 || moments.length === 0))
    return {
      fix: { ...base, verdict: 'unclear', why: said.why, moments, removal: false },
      dropped: {
        title: `${pull.pr} ${said.verdict}`,
        why: failed[0] ?? 'no moment shows it',
      },
    };

  return {
    fix: {
      ...base,
      verdict: said.verdict,
      why: said.why,
      moments,
      removal: proposesRemoval(said.verdict),
    },
    dropped: undefined,
  };
};

const samePr = (a: string | null | undefined, b: string) => {
  const x = a === null || a === undefined ? undefined : parseRef(a);
  const y = parseRef(b);

  return (
    x !== undefined && y !== undefined && showRef(x).toLowerCase() === showRef(y).toLowerCase()
  );
};

const severityRank = (s: Severity) => SEVERITIES.indexOf(s);

/**
 * The one-shot's text as findings and earlier fixes judged. A finding is dropped (and counted,
 * with why) when a moment does not resolve or it cites none, a fix path leaves its Layer, or its
 * `recurringOf` / `removes` names no earlier fix listed. The rest, most severe first, are numbered.
 */
export const readRetro = (
  text: string,
  o: { sources: readonly RetroSource[]; earlier: readonly EarlierPull[] },
):
  | { ok: true; findings: Finding[]; earlier: EarlierFix[]; dropped: Dropped[] }
  | { ok: false; message: string } => {
  const read = readJsonAnswer(text, RetroAnswer);

  if (!read.ok) return read;
  const dropped: Dropped[] = [];
  const listed = (pr: string | null | undefined) =>
    pr === null || pr === undefined || pr === '' || o.earlier.some((e) => samePr(pr, e.pr));
  const kept = read.data.findings.flatMap((f) => {
    const resolved = f.moments.map((m) => resolveMoment(m, o.sources));
    const unresolved = resolved.find((r) => !r.ok);
    const badPath = f.fix.files
      .map((file) => fixPathProblem(file.path))
      .find((p) => p !== undefined);
    const abeFix = f.layer === 'abe';
    const noFix =
      (abeFix && (f.fix.issue ?? undefined) === undefined
        ? 'a Send to Abe finding drafts no issue'
        : undefined) ?? (!abeFix && f.fix.files.length === 0 ? 'its fix has no files' : undefined);
    const why = [
      f.moments.length === 0 ? 'it cites no moment' : undefined,
      noFix,
      unresolved?.ok === false ? unresolved.why : undefined,
      badPath,
      listed(f.recurringOf)
        ? undefined
        : `recurring of ${f.recurringOf ?? ''}, which is no earlier fix`,
      listed(f.removes) ? undefined : `removes ${f.removes ?? ''}, which is no earlier fix`,
    ].find((w) => w !== undefined);

    if (why !== undefined) {
      dropped.push({ title: f.title, why });

      return [];
    }

    return [
      {
        f,
        moments: resolved.flatMap((r) => (r.ok ? [r.moment] : [])),
      },
    ];
  });
  const findings: Finding[] = kept
    .map((k, i) => ({ ...k, i }))
    .sort((a, b) => severityRank(a.f.severity) - severityRank(b.f.severity) || a.i - b.i)
    .map(({ f, moments }, i) => {
      const pr = (ref: string | null | undefined) =>
        ref === null || ref === undefined || ref === ''
          ? null
          : (o.earlier.find((e) => samePr(ref, e.pr))?.pr ?? null);

      return {
        n: i + 1,
        severity: f.severity,
        title: f.title,
        whatHappened: f.whatHappened,
        moments,
        layer: f.layer,
        fix:
          f.layer === 'abe'
            ? { summary: f.fix.summary, files: [], diff: '', issue: f.fix.issue ?? null }
            : { summary: f.fix.summary, files: f.fix.files, diff: f.fix.diff, issue: null },
        recurringOf: pr(f.recurringOf),
        removes: pr(f.removes),
        made: null,
      };
    });
  const earlier = o.earlier.map((pull) => {
    const said = read.data.earlier.find((e) => samePr(e.pr, pull.pr));
    const judged = judgeEarlier(pull, said, findings, o.sources);

    if (judged.dropped !== undefined) dropped.push(judged.dropped);
    const by = findings.find((f) => f.removes === pull.pr);

    return { ...judged.fix, removedBy: judged.fix.removal ? (by?.n ?? null) : null };
  });

  return { ok: true, findings, earlier, dropped };
};

// ── Records and answers ─────────────────────────────────────────────────────────────────────

export const RetroSessionRow = z.object({
  session: z.string(),
  repo: z.string(),
  user: z.string(),
  card: z.number().int().positive(),
  title: z.string(),
  since: z.iso.datetime(),
  files: z.number().int().nonnegative(),
});
export type RetroSessionRow = z.infer<typeof RetroSessionRow>;

/** `abe improve retro <scope>`: what it read and what it found. */
export const RetroData = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  scope: z.enum(RETRO_SCOPES),
  /** The repo it ran in (`owner/name`). */
  repo: z.string(),
  login: z.string(),
  /** The last retro of this scope, whose sessions are not read again; null for the first. */
  since: z.iso.datetime().nullable(),
  /** The log store prefixes read: the scope's, and only those. */
  prefixes: z.array(z.string()),
  sessions: z.array(RetroSessionRow),
  /** Sessions moved since but left out: too much to read at once (the next retro reads them). */
  leftOut: z.number().int().nonnegative(),
  /** Sources that could not be read (a pull request's comments `gh` could not read, a session id twice), and why. */
  unread: z.array(z.object({ source: z.string(), why: z.string() })).default([]),
  /** The model the one-shot ran on; empty when there was nothing to read. */
  model: z.string(),
  findings: z.array(Finding),
  earlier: z.array(EarlierFix),
  dropped: z.array(Dropped),
});
export type RetroData = z.infer<typeof RetroData>;

/** A retro as `serve` keeps it: `make` acts on it. */
export const RetroRecord = RetroData.extend({
  v: z.literal(1),
  /** Where it ran: the checkout whose repo Layer `make` writes. */
  checkout: z.string(),
});
export type RetroRecord = z.infer<typeof RetroRecord>;

/** `abe improve retro make <n>`: the pull request opened now, or the one opened before. */
export const RetroMakeData = z.object({
  retro: z.string(),
  finding: z.number().int().positive(),
  title: z.string(),
  layer: z.enum(FIX_LAYERS),
  /** `asked`: from its Improve retro chat, a make card asks you first (#136); nothing made yet. */
  result: z.enum(['opened', 'proposed', 'written', 'filed', 'already-made', 'asked']),
  /** What was made; null while it is asked. */
  made: Made.nullable(),
  /** The make card that asks it (`asked`). */
  card: z.string().optional(),
});
export type RetroMakeData = z.infer<typeof RetroMakeData>;

/** The branch a finding's pull request is made on. */
export const retroBranch = (retro: string, n: number): string => `abe/${retro}-${n}`;

/** A finding's pull request title: the finding, then which retro and finding it is. */
export const retroPrTitle = (r: { at: string }, f: Pick<Finding, 'n' | 'title'>): string =>
  `${f.title} (improve retro ${r.at.slice(0, 10)}, finding ${f.n})`;

const SCOPE_TITLES: Readonly<Record<RetroScope, (w: RetroWho) => string>> = {
  me: (w) => `me (${w.login} in ${w.repo})`,
};

const scopeWords = (r: Pick<RetroData, 'scope' | 'repo' | 'login'>) =>
  SCOPE_TITLES[r.scope]({ repo: r.repo, login: r.login });

/** A finding's pull request body: what happened, its moments, the retro and its sessions. */
export const retroPrBody = (r: RetroData, f: Finding): string =>
  [
    f.whatHappened,
    '',
    `**Fix:** ${f.fix.summary}`,
    '',
    '**Moments:**',
    '',
    ...f.moments.map((m) => `- ${m.at === undefined ? '' : `${m.at} `}\`${m.ref}\`: ${m.text}`),
    ...(f.recurringOf === null ? [] : ['', `Recurring of ${f.recurringOf}.`]),
    ...(f.removes === null ? [] : ['', `Removes the earlier fix ${f.removes}.`]),
    '',
    `Improve retro ${r.id} (${scopeWords(r)}, ${r.at.slice(0, 10)}), finding ${f.n} of ${r.findings.length}, ${f.severity}.`,
    `Sessions: ${r.sessions.map((s) => s.session).join(', ')}`,
  ].join('\n');

/** The commit a finding's pull request holds. */
export const retroCommitMessage = (r: { id: string }, f: Pick<Finding, 'n' | 'title'>): string =>
  `Improve retro ${r.id}, finding ${f.n}: ${f.title}`;

/** The finding `text` names in a retro: its number. */
export const findFinding = (r: RetroData, text: string): Finding | undefined => {
  const n = Number(text.replace(/^#/, ''));

  return Number.isInteger(n) ? r.findings.find((f) => f.n === n) : undefined;
};

// ── Events and text ─────────────────────────────────────────────────────────────────────────

export const ImproveRetroEvent = z.discriminatedUnion('step', [
  z.object({
    step: z.literal('found'),
    retro: z.string(),
    scope: z.enum(RETRO_SCOPES),
    repo: z.string(),
    sessions: z.number().int().nonnegative(),
    findings: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    removals: z.number().int().nonnegative(),
  }),
  z.object({
    step: z.literal('made'),
    retro: z.string(),
    finding: z.number().int().positive(),
    layer: z.enum(FIX_LAYERS),
    /** The pull request or issue (`owner/repo#n`), the proposal id, or the files written. */
    made: z.string(),
  }),
]);
export type ImproveRetroEvent = z.infer<typeof ImproveRetroEvent>;

export const improveRetroText = (d: ImproveRetroEvent): string =>
  d.step === 'found'
    ? `Improve retro ${d.retro} (${d.scope} ${d.repo}): ${d.findings} findings over ${d.sessions} sessions${d.dropped === 0 ? '' : `, ${d.dropped} dropped`}${d.removals === 0 ? '' : `, ${d.removals} earlier fixes proposed for removal`}`
    : `Improve retro ${d.retro} finding ${d.finding} made: ${d.made} (${d.layer})`;

const madeWords = (m: Made) => {
  if (m.kind === 'pr' || m.kind === 'issue') return `${m.kind === 'pr' ? m.pr : m.issue} ${m.url}`;
  if (m.kind === 'written') return `written here, uncommitted (git diff): ${m.files.join(', ')}`;

  return `abe improve proposal ${m.id} (${m.files.join(', ')}): abe improve apply ${m.id}`;
};

const findingText = (f: Finding) =>
  [
    `${String(f.n).padStart(2)}  ${f.severity.padEnd(8)}  ${f.title}`,
    `    ${f.whatHappened}`,
    ...f.moments.map((m) => `    ${momentLine(m)}`),
    f.fix.issue === null
      ? `    → ${LayerWords[f.layer]}: ${f.fix.summary} (${f.fix.files.map((x) => x.path).join(', ')})`
      : `    → ${LayerWords[f.layer]}: ${f.fix.issue.title}`,
    ...(f.recurringOf === null ? [] : [`    recurring of ${f.recurringOf}`]),
    ...(f.removes === null ? [] : [`    removes ${f.removes}`]),
    ...(f.made === null ? [] : [`    made: ${madeWords(f.made)}`]),
  ].join('\n');

const groupText = (name: string, findings: readonly Finding[]): string[] =>
  findings.length === 0 ? [] : [`${name}:`, '', ...findings.map(findingText), ''];

export const retroText = (r: RetroData): string => {
  const head = `Improve retro ${r.id} · ${scopeWords(r)} · ${r.sessions.length} sessions${r.since === null ? '' : ` since ${r.since}`}${r.leftOut === 0 ? '' : ` (${r.leftOut} more left out)`}`;

  if (r.sessions.length === 0)
    return `${head}\nno session moved since the last Improve retro of this scope\n`;
  const earlier =
    r.earlier.length === 0
      ? []
      : [
          '',
          'Earlier fixes:',
          ...r.earlier.map(
            (e) =>
              `  ${e.pr}  ${e.verdict}  ${e.title}${e.removal ? ` · proposed for removal${e.removedBy === null ? '' : `: finding ${e.removedBy}`}` : ''}`,
          ),
        ];

  return `${[
    head,
    '',
    r.findings.length === 0
      ? 'no findings'
      : `${r.findings.length} findings, most severe first${r.dropped.length === 0 ? '' : ` (${r.dropped.length} dropped: ${r.dropped.map((d) => d.why).join('; ')})`}`,
    '',
    ...groupText(
      'Fix here',
      r.findings.filter((f) => fixHere(f.layer)),
    ),
    ...groupText(
      'Send to Abe',
      r.findings.filter((f) => !fixHere(f.layer)),
    ),
    ...earlier,
    ...(r.unread.length === 0
      ? []
      : ['', 'Not read:', ...r.unread.map((u) => `  ${u.source}: ${u.why}`)]),
    '',
    r.findings.length === 0
      ? ''
      : 'abe improve retro make <n> writes a fix into this checkout (uncommitted; --pr opens a pull request instead). A Send to Abe one files its issue with --file, once the person saw its body and said File it',
  ]
    .join('\n')
    .trimEnd()}\n`;
};

export const retroMakeText = (d: RetroMakeData): string =>
  d.made === null
    ? `finding ${d.finding} (${d.title}): asked on a card (${d.card ?? '?'}); the answer comes as your next message\n`
    : `finding ${d.finding} (${d.title}): ${d.result === 'already-made' ? 'made already' : d.result}: ${madeWords(d.made)}\n`;
