/**
 * Improve (spec #36 I1–I7, ticket #84): `abe improve <wish>` asks one one-shot with core's improve
 * skill to change VimStorm for you, and answers a proposal: a before and after of files in your
 * personal Layer only (settings, keys, personal commands, personal skills; the Neovim config for a
 * developer). Nothing is written until `apply`; `undo` goes back one applied state at a time. A
 * wish that needs VimStorm's code becomes a VimStorm issue and changes nothing. The rules are here:
 * which paths, roles, the prompt and the answer's shape, undo's depth, the daily limit.
 */
import { z } from 'zod';
import { askingJson, readJsonAnswer } from '../triage/one-shot';
import { COMMANDS_FILE, personalCommandProblem, personalCommandsOf } from './personal-commands';
import { type SettingProblem } from '../layer/settings/contract';
import { SETTINGS, settingKeys } from '../layer/settings/keys';
import { LAYER_FILE } from '../layer/settings/places';
import { skillBody } from '../skills/skills';
import { viewNodeRows } from './views';
import improveSkill from '../../skills/improve/one-shot.md' with { type: 'text' };

/** Core's improve skill as the one-shot's system prompt. */
export const IMPROVE_SKILL: string = skillBody(improveSkill);

/** Your key bindings' file in the personal Layer. */
export const KEYS_FILE = 'keys.json';
/** Personal skills: `skills/<name>/SKILL.md`. */
export const SKILLS_DIR = 'skills';
/** Your Neovim config in the personal Layer, loaded after VimStorm's own. */
export const NVIM_DIR = 'nvim';

export const PERSONAL_KINDS = ['settings', 'keys', 'commands', 'skill', 'nvim'] as const;
export type PersonalKind = (typeof PERSONAL_KINDS)[number];

/** The design-system components a view is built from (`ui/src/runtime/components.ts`'s `Node` kinds). */
export const VIEW_COMPONENTS = ['screen', 'fields', 'text'] as const;

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_SEGMENT = /^[\w@+-][\w@+.-]*$/;

export type PathRefusal = { ok: false; code: 'outside-personal-layer'; message: string };

const outside = (path: string, why?: string): PathRefusal => ({
  ok: false,
  code: 'outside-personal-layer',
  message: why === undefined ? path : `${path} (${why})`,
});

/**
 * A path the agent named, relative to the personal Layer's folder: which kind of file it is, or
 * refused. Absolute paths, `~`, `..` and `.` segments, hidden files and anything but the Layer's
 * own files are outside it.
 */
export const personalPath = (
  path: string,
): { ok: true; path: string; kind: PersonalKind } | PathRefusal => {
  const segments = path.split('/');

  if (path === '' || !segments.every((s) => SAFE_SEGMENT.test(s))) return outside(path);
  const [first, second, third] = segments;
  const one = (kind: PersonalKind) =>
    segments.length === 1 ? { ok: true as const, path, kind } : outside(path);

  if (first === LAYER_FILE) return one('settings');
  if (first === KEYS_FILE) return one('keys');
  if (first === COMMANDS_FILE) return one('commands');
  if (first === SKILLS_DIR)
    return segments.length === 3 && SKILL_NAME.test(second ?? '') && third === 'SKILL.md'
      ? { ok: true, path, kind: 'skill' }
      : outside(path);
  if (first === NVIM_DIR && segments.length >= 2) return { ok: true, path, kind: 'nvim' };

  return outside(path);
};

/** One file as the agent answers it: its whole new text, or null to delete it. */
export const FileChange = z.object({ path: z.string(), after: z.string().nullable() });
export type FileChange = z.infer<typeof FileChange>;

/** Every path of the answer inside the personal Layer, each once; else every one refused, named. */
export const checkPaths = (
  files: readonly FileChange[],
): { ok: true } | PathRefusal | { ok: false; code: 'invalid-proposal'; message: string } => {
  const refused = files.map((f) => personalPath(f.path)).flatMap((r) => (r.ok ? [] : [r.message]));

  if (refused.length > 0)
    return {
      ok: false,
      code: 'outside-personal-layer',
      message: `outside your personal Layer: ${refused.join('; ')}`,
    };
  const twice = files.filter((f, i) => files.findIndex((g) => g.path === f.path) !== i);

  return twice.length === 0
    ? { ok: true }
    : {
        ok: false,
        code: 'invalid-proposal',
        message: `more than one change for ${[...new Set(twice.map((f) => f.path))].join(', ')}`,
      };
};

const words = z.string().trim().min(1);

/** What the one-shot answers: a change, a wish that needs code, or nothing to do. */
export const ImproveAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('change'), summary: words, files: z.array(FileChange).min(1) }),
  z.object({ kind: z.literal('needs-code'), title: words, body: words }),
  z.object({ kind: z.literal('nothing'), reason: words }),
]);
export type ImproveAnswer = z.infer<typeof ImproveAnswer>;

/** The one-shot's text as an `ImproveAnswer`, or why it is none. */
export const readImprove = (
  text: string,
): { ok: true; answer: ImproveAnswer } | { ok: false; message: string } => {
  const read = readJsonAnswer(text, ImproveAnswer);

  return read.ok ? { ok: true, answer: read.data } : read;
};

/** A proposal's id: `imp-` and six hex digits. */
export const PROPOSAL_ID = /^imp-[0-9a-f]{6}$/;

export const ProposalFile = z.object({
  path: z.string(),
  /** The file as it was when proposed; null: there was none. */
  before: z.string().nullable(),
  /** null: the proposal deletes it. */
  after: z.string().nullable(),
});
export type ProposalFile = z.infer<typeof ProposalFile>;

/** A proposal: a before and after of files in your personal Layer, nothing written yet. */
export const ImproveProposal = z.object({
  id: z.string().regex(PROPOSAL_ID),
  wish: z.string(),
  files: z.array(ProposalFile).min(1),
  summary: z.string(),
});
export type ImproveProposal = z.infer<typeof ImproveProposal>;

/** A proposal as `serve` keeps it (`<state>/improve/proposals/<id>.json`). */
export const ProposalRecord = ImproveProposal.extend({
  v: z.literal(1),
  at: z.iso.datetime(),
  /** What made it: `wish`, `suggest`, or another caller's word (`retro`, #86). */
  from: z.string().min(1),
  /** The one-shot's model; null when no agent made it. */
  model: z.string().nullable(),
  /** When `apply` wrote it; null while it was not. */
  applied: z.iso.datetime().nullable(),
});
export type ProposalRecord = z.infer<typeof ProposalRecord>;

/** Each file's text now by path; null: there is none. */
export type Current = Readonly<Record<string, string | null>>;

/** The answer's files as a before and after, leaving out a file it leaves as it is. */
export const changedFiles = (files: readonly FileChange[], current: Current): ProposalFile[] =>
  files.flatMap((f) => {
    const before = current[f.path] ?? null;

    return before === f.after ? [] : [{ path: f.path, before, after: f.after }];
  });

/** The files no longer as the proposal found them: applying it would lose that change. */
export const staleFiles = (files: readonly ProposalFile[], current: Current): string[] =>
  files.filter((f) => (current[f.path] ?? null) !== f.before).map((f) => f.path);

/** How many applied states `undo` can go back through. */
export const UNDO_DEPTH = 20;

/** One applied proposal: each file as it was before (null: there was none). */
export const UndoEntry = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  files: z.array(
    z.object({
      path: z.string(),
      before: z.string().nullable(),
      /** As the apply left it: undo puts `before` back only over this. */
      after: z.string().nullable(),
    }),
  ),
});
export type UndoEntry = z.infer<typeof UndoEntry>;

/** The applied states, oldest first (`<state>/improve/undo.json`). */
export const UndoStack = z.object({ v: z.literal(1), entries: z.array(UndoEntry) });
export type UndoStack = z.infer<typeof UndoStack>;

/** `entries` with `entry` last, keeping the newest `UNDO_DEPTH`. */
export const pushUndo = (entries: readonly UndoEntry[], entry: UndoEntry): UndoEntry[] =>
  [...entries, entry].slice(-UNDO_DEPTH);

/** Improve suggests at most once in this long (spec #36 story 48). */
export const SUGGEST_EVERY_MS = 24 * 60 * 60 * 1000;

/** When the last suggestion was asked (`<state>/improve/suggested.json`). */
export const SuggestStamp = z.object({ v: z.literal(1), at: z.iso.datetime() });

/** Whether Improve may suggest now: only opted in (`improve.suggest`), and once in 24 hours. */
export const maySuggest = (o: {
  enabled: boolean;
  /** The last suggestion's time (epoch ms), if any. */
  last: number | undefined;
  now: number;
}):
  | { ok: true }
  | { ok: false; code: 'suggest-off' | 'suggested-today'; message: string; next?: number } => {
  if (!o.enabled)
    return {
      ok: false,
      code: 'suggest-off',
      message: 'Improve suggests only when you opt in: abe settings set improve.suggest true',
    };
  if (o.last !== undefined && o.now - o.last < SUGGEST_EVERY_MS) {
    const next = o.last + SUGGEST_EVERY_MS;

    return {
      ok: false,
      code: 'suggested-today',
      message: `Improve suggested once in the last 24 hours; the next after ${new Date(next).toISOString()}`,
      next,
    };
  }

  return { ok: true };
};

/** A map file's entries a change sets (with their value) and removes, by path (`['overrides', key]`). */
export type EntryDiff = { set: [string[], unknown][]; removed: string[][] };

/** Keys whose entries sit one level down: a settings file's Overrides. */
const NESTED = new Set(['overrides']);

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const entriesOf = (doc: unknown): Map<string, [string[], unknown]> => {
  const out = new Map<string, [string[], unknown]>();

  if (!isMap(doc)) return out;
  for (const [key, value] of Object.entries(doc)) {
    if (NESTED.has(key) && isMap(value))
      for (const [inner, v] of Object.entries(value))
        out.set(JSON.stringify([key, inner]), [[key, inner], v]);
    else out.set(JSON.stringify([key]), [[key], value]);
  }

  return out;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What a change of a map file (settings, keys, commands) does, entry by entry. */
export const entryDiff = (before: unknown, after: unknown): EntryDiff => {
  const was = entriesOf(before);
  const will = entriesOf(after);

  return {
    set: [...will]
      .filter(([key, [, value]]) => !same(was.get(key)?.[1], value) || !was.has(key))
      .map(([, entry]) => entry),
    removed: [...was].filter(([key]) => !will.has(key)).map(([, [path]]) => path),
  };
};

const without = (map: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));

/** `doc` (a map file's document; `undefined`: none yet) with the diff's entries set and removed, the rest kept. */
export const applyEntryDiff = (doc: unknown, diff: EntryDiff): Record<string, unknown> => {
  let root: Record<string, unknown> = isMap(doc) ? { ...doc } : {};

  for (const [[key, inner], value] of diff.set) {
    if (key === undefined) continue;
    const within = root[key];

    root = {
      ...root,
      [key]: inner === undefined ? value : { ...(isMap(within) ? within : {}), [inner]: value },
    };
  }
  for (const [key, inner] of diff.removed) {
    if (key === undefined) continue;
    const within = root[key];

    if (inner === undefined) root = without(root, key);
    else if (isMap(within)) {
      const left = without(within, inner);

      root = Object.keys(left).length === 0 ? without(root, key) : { ...root, [key]: left };
    }
  }

  return root;
};

/** Each file's text in the prompt is cut here. */
const FILE_TEXT_MAX = 8000;

const clip = (text: string) =>
  text.length <= FILE_TEXT_MAX ? text : `${text.slice(0, FILE_TEXT_MAX)}\n…(cut)`;

const fence = (text: string) => `\`\`\`\n${clip(text).trimEnd()}\n\`\`\``;

/** The settings a person may write in their own Layer, as the prompt lists them. */
export const personalSettingRows = (): string[] =>
  settingKeys().map(
    (k) => `- \`${k}\` (default ${JSON.stringify(SETTINGS[k].default)}): ${SETTINGS[k].summary}`,
  );

const ANSWER_SHAPE = `One of:

{"kind": "change", "summary": "<one line a person reads first>", "files": [{"path": "<relative to the personal Layer, e.g. keys.json>", "after": "<the whole new file, or null to delete it>"}]}

{"kind": "needs-code", "title": "<a VimStorm issue's title>", "body": "<its body: what they want, why, what was tried>"}

{"kind": "nothing", "reason": "<why there is nothing to change>"}`;

/** A file of the personal Layer as the prompt shows it. */
export type ShownFile = { path: string; text: string };

/**
 * The one-shot's prompt: the wish (or, for a suggestion, what was done lately), the
 * settings, the formats, the components, your Layer's files as they are, then the answer's shape.
 */
export const improvePrompt = (o: {
  wish: string;
  files: readonly ShownFile[];
  /** The Neovim config's files. */
  nvim: readonly ShownFile[];
  /** For a suggestion: the commands run lately, newest last. */
  recent?: readonly string[];
  /** Asked for changes (`--again`): the proposal the wish changes, its files as proposed. */
  again?: { summary: string; files: readonly ProposalFile[] };
}): string => {
  const asked =
    o.recent === undefined
      ? ['## The wish', '', o.wish]
      : [
          '## A suggestion',
          '',
          'Nobody asked for anything: suggest at most one small change to the personal Layer that would help, judging by what was run lately, or answer nothing. Never needs-code here.',
          '',
          ...(o.recent.length === 0 ? ['(nothing run lately)'] : o.recent.map((r) => `- ${r}`)),
        ];
  const files =
    o.files.length === 0 ? ['(none yet)'] : o.files.map((f) => `### ${f.path}\n\n${fence(f.text)}`);
  const again =
    o.again === undefined
      ? []
      : [
          '## The proposal to change',
          '',
          `The wish asks for changes to this earlier proposal (nothing of it was written): “${o.again.summary}”. Answer a whole proposal in its place, keeping what the wish does not change.`,
          '',
          ...o.again.files.map((f) =>
            f.after === null ? `### ${f.path}\n\n(deleted)` : `### ${f.path}\n\n${fence(f.after)}`,
          ),
          '',
        ];
  const nvim = [
    '## The Neovim config (`nvim/`)',
    '',
    ...(o.nvim.length === 0
      ? ['(none yet: `nvim/init.lua` is loaded first)']
      : o.nvim.map((f) => `### ${f.path}\n\n${fence(f.text)}`)),
  ];

  return askingJson(
    [
      `Change VimStorm for this person with your improve skill, as a proposal to their personal Layer only.`,
      '',
      ...asked,
      '',
      ...again,
      '## The settings (`settings.yaml`)',
      '',
      ...personalSettingRows(),
      '',
      '## Personal commands (`commands.yaml`)',
      '',
      'A word → an `abe` argv, run as `abe <word>`; listed in Command mode. The word is lower case and no `abe` command; the argv starts with an `abe` command:',
      '',
      fence(
        'mine: [card, list]\nstandup: { argv: [factory, status], summary: my runs and where they stand }',
      ),
      '',
      '## Views (`views` in `settings.yaml`)',
      '',
      `Views are built only from these components: ${VIEW_COMPONENTS.join(', ')}. A view tweak hides, reorders or relabels one part of a screen by its node id, and nothing more: \`{ screen, node, hide: true }\`, \`{ screen, node, order: <its place among its siblings, 0 first> }\` or \`{ screen, node, label: <words> }\`. \`views\` is a list of them, applied in order; keep the ones already there. The parts by screen and node id:`,
      '',
      ...viewNodeRows(),
      '',
      "A node id not listed, a new part or any other change to a view needs VimStorm's code.",
      '',
      '## Their personal Layer now',
      '',
      ...files,
      '',
      ...nvim,
    ].join('\n'),
    ANSWER_SHAPE,
  );
};

const Model = z.string();

/** A setting a proposal changes: its value before and after (null: none written there). */
export const SettingCell = z.object({
  key: z.string(),
  before: z.json().nullable(),
  after: z.json().nullable(),
});
export type SettingCell = z.infer<typeof SettingCell>;

/** A proposal's file as a client shows it: what writing it does, its lines, a setting's cells. */
export const ProposalShown = z.object({
  path: z.string(),
  change: z.enum(['created', 'changed', 'deleted']),
  /** Removed (`- `) and added (`+ `) lines, those both share at either end left out. */
  diff: z.array(z.string()),
  /** `settings.yaml`: each setting it changes, before and after; empty for any other file. */
  settings: z.array(SettingCell),
});
export type ProposalShown = z.infer<typeof ProposalShown>;

/**
 * Where Abe's own issues go (`improve.issueRepo`), said with every answer: a Send to Abe draft of
 * the agent's own is filed there too, never on a repo it asks the person for.
 */
const Issues = z.string();

/**
 * `abe improve <wish>`: a proposal, a code wish drafted as an issue on Abe's repo (Send to Abe:
 * shown to the person, filed with `abe issue create` only once they say so), or nothing to change.
 */
export const ImproveData = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('proposal'),
    proposal: ImproveProposal,
    model: Model.nullable(),
    shown: z.array(ProposalShown),
    issues: Issues,
  }),
  z.object({
    kind: z.literal('needs-code'),
    wish: z.string(),
    /** The draft: Abe's repo (`improve.issueRepo`), its title and its whole body. */
    draft: z.object({ repo: z.string(), title: z.string(), body: z.string() }),
    model: Model,
    issues: Issues,
  }),
  z.object({
    kind: z.literal('nothing'),
    wish: z.string(),
    reason: z.string(),
    model: Model,
    issues: Issues,
  }),
]);
export type ImproveData = z.infer<typeof ImproveData>;

/** `abe improve suggest`: a suggestion (a proposal or nothing) and when the next may come. */
export const ImproveSuggestData = z.object({
  next: z.iso.datetime(),
  suggestion: ImproveData,
});
export type ImproveSuggestData = z.infer<typeof ImproveSuggestData>;

const Written = z.object({
  path: z.string(),
  /** Where it is on disk. */
  file: z.string(),
  change: z.enum(['created', 'changed', 'deleted']),
});

/** `abe improve apply <id>`: each file written and how many applied states undo can go back. */
export const ImproveApplyData = z.object({
  id: z.string(),
  files: z.array(Written),
  undo: z.number().int().nonnegative(),
});
export type ImproveApplyData = z.infer<typeof ImproveApplyData>;

/** `abe improve undo`: the proposal taken back, each file as it was, and how many more are kept. */
export const ImproveUndoData = z.object({
  id: z.string(),
  /** The proposal's summary, as it was shown; null when its record is gone. */
  summary: z.string().nullable(),
  files: z.array(Written),
  left: z.number().int().nonnegative(),
});
export type ImproveUndoData = z.infer<typeof ImproveUndoData>;

const lines = (text: string | null) =>
  text === null || text === '' ? [] : text.replace(/\n$/, '').split('\n');

/** A file's before and after as removed and added lines, the lines both share at either end left out. */
export const lineDiff = (before: string | null, after: string | null): string[] => {
  const a = lines(before);
  const b = lines(after);
  let start = 0;

  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;

  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end += 1;

  return [
    ...a.slice(start, a.length - end).map((l) => `- ${l}`),
    ...b.slice(start, b.length - end).map((l) => `+ ${l}`),
  ];
};

/** What writing `after` over `before` does to a file. */
export const fileChange = (
  before: string | null,
  after: string | null,
): 'created' | 'changed' | 'deleted' => {
  if (before === null) return 'created';

  return after === null ? 'deleted' : 'changed';
};

export const proposalText = (p: ImproveProposal): string =>
  `${[
    `**Fix here** · your own files: ${p.summary}`,
    '',
    ...p.files.flatMap((f) => [
      `${f.path} (${fileChange(f.before, f.after)})`,
      ...lineDiff(f.before, f.after).map((l) => `  ${l}`),
      '',
    ]),
    `abe improve apply ${p.id} writes it; abe improve undo takes it back.`,
  ].join('\n')}\n`;

/** The line after the block to show: what the agent does next, never shown to the person. */
const nextLine = (next: string) => `\nNext (for you, not to show): ${next}\n`;

/** Where a Send to Abe draft goes, said after a proposal or nothing to change. */
const issuesWords = (repo: string) =>
  `Abe's own issues go to ${repo}: a Send to Abe draft is shown in full first, then filed only on File it with abe issue create --repo ${repo} --title <title> --body-file .abe/abe-issue.md`;

/**
 * The answer as a block to paste in the chat word for word before asking (its label, Fix here or
 * Send to Abe, and the whole change or the whole draft), then a `Next` line for the agent.
 */
export const improveText = (d: ImproveData): string => {
  if (d.kind === 'proposal')
    return `${proposalText(d.proposal)}${nextLine(`paste the block above as it is, then ask Apply, Change it, Not this. ${issuesWords(d.issues)}`)}`;
  if (d.kind === 'needs-code')
    return `${[
      `**Send to Abe** · a draft issue on ${d.draft.repo}, not filed`,
      '',
      `**${d.draft.title}**`,
      '',
      d.draft.body.trimEnd(),
    ].join(
      '\n',
    )}\n${nextLine(`paste the block above as it is, then ask Don't file, Change it, File it, in that order (never File it first). Only on File it: write the body to .abe/abe-issue.md, abe issue create --repo ${d.draft.repo} --title <title> --body-file .abe/abe-issue.md, remove the file`)}`;

  return `Nothing to change: ${d.reason}\n${nextLine(issuesWords(d.issues))}`;
};

export const improveSuggestText = (d: ImproveSuggestData): string =>
  `${improveText(d.suggestion)}next suggestion after ${d.next}\n`;

const writtenText = (files: readonly z.infer<typeof Written>[]) =>
  files.map((f) => `${f.path} ${f.change}`).join(', ');

export const improveApplyText = (d: ImproveApplyData): string =>
  `applied ${d.id}: ${writtenText(d.files)}\nabe improve undo takes it back (${d.undo} applied kept)\n`;

export const improveUndoText = (d: ImproveUndoData): string =>
  `undid ${d.summary === null ? d.id : `“${d.summary}” (${d.id})`}: ${writtenText(d.files)}${d.left === 0 ? '' : ` (${d.left} more to undo)`}\n`;

/** A code wish's issue body: the agent's words, then where it came from. */
export const needsCodeBody = (o: { wish: string; body: string }): string =>
  `${o.body.trimEnd()}\n\n---\n\nFrom \`abe improve\`: “${o.wish}”. Improve changes only the personal Layer, so this needs VimStorm's code.\n`;

/** The personal Layer's own files at its top; skills and the Neovim config sit in their folders. */
export const PERSONAL_TOP_FILES = [LAYER_FILE, KEYS_FILE, COMMANDS_FILE] as const;

/** Which kind of personal file `path` is, whoever asks (`undefined`: none). */
export const personalKindOf = (path: string): PersonalKind | undefined => {
  const read = personalPath(path);

  return read.ok ? read.kind : undefined;
};

/** A document as read: its value, or why it does not read. */
export type DocRead = { doc: unknown } | { error: string };

/** `keys.json`'s text read as JSON. */
export const readKeysText = (text: string): DocRead => {
  try {
    const doc: unknown = JSON.parse(text);

    return { doc };
  } catch {
    return { error: 'keys.json is not JSON' };
  }
};

/**
 * Why a personal map file's new document is refused: keys must be a JSON object of key → action,
 * commands must read and run commands of the table (`nouns`). Settings are checked by the merge.
 */
export const mapFileProblem = (
  kind: PersonalKind,
  read: DocRead,
  nouns: ReadonlySet<string>,
): string | undefined => {
  if ('error' in read) return read.error;
  if (kind === 'keys')
    return isMap(read.doc) ? undefined : 'keys.json is a JSON object: a key → its action';
  if (kind !== 'commands') return undefined;
  const commands = personalCommandsOf(read.doc);

  if (!commands.ok) return `commands.yaml: ${commands.message}`;
  const problems = commands.commands.flatMap((c) => personalCommandProblem(c, nouns) ?? []);

  return problems.length === 0 ? undefined : `commands.yaml: ${problems.join('; ')}`;
};

/** Your own file's settings problems: each refuses a proposal. */
export const ownSettingsProblems = (
  problems: readonly SettingProblem[],
  file: string,
): SettingProblem[] => problems.filter((p) => p.file === file);

const jsonOf = (v: unknown): z.infer<ReturnType<typeof z.json>> => {
  const read = z.json().safeParse(v);

  return read.success ? read.data : String(v);
};

/** The value at `path` of a map file's document (`undefined`: none). */
const valueAt = (doc: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((at, key) => (isMap(at) ? at[key] : undefined), doc);

/**
 * A settings file's change as cells, setting by setting: an Override's key reads `<key>
 * (override)`, a setting no longer written has no after.
 */
export const settingCells = (before: unknown, after: unknown): SettingCell[] => {
  const diff = entryDiff(before, after);
  const keyOf = (path: readonly string[]) =>
    path[0] === 'overrides' ? `${path[1] ?? ''} (override)` : path.join('.');
  const was = (path: readonly string[]) => {
    const v = valueAt(before, path);

    return v === undefined ? null : jsonOf(v);
  };

  return [
    ...diff.set.map(([path, value]) => ({
      key: keyOf(path),
      before: was(path),
      after: jsonOf(value),
    })),
    ...diff.removed.map((path) => ({ key: keyOf(path), before: was(path), after: null })),
  ];
};

/** A proposal's file as shown; `docs`: a settings file's before and after read, for its cells. */
export const shownFile = (
  f: ProposalFile,
  docs?: { before: unknown; after: unknown },
): ProposalShown => ({
  path: f.path,
  change: fileChange(f.before, f.after),
  diff: lineDiff(f.before, f.after),
  settings: docs === undefined ? [] : settingCells(docs.before, docs.after),
});
