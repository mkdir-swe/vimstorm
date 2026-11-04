/**
 * A Layer's file opened (#15, spec #19 stories 24, 27, 28; canvas SW-OpenWorkflow, SW-OpenSkill,
 * SW-TeamCopy, SW-ErrorMissing, SW-ErrorOrder, SW-ErrorYaml, SK-YamlProblem): the readable side
 * beside its source (`abe workflow read`), whether it is yours to change or read-only here (a
 * farther Layer's: Edit my copy, then Propose), and each problem's ⌥⏎ fixes as the whole file
 * after it (the Editor puts it in the buffer, one undo).
 */
import { z } from 'zod';
import { WorkflowRetroData } from './ai';
import { builtInStep, type WorkflowLayer } from './kinds';
import { type PreviewAction, WorkflowPreview } from './preview';
import {
  type LoopView,
  type SkillView,
  WORKFLOW_PROBLEM_CODES,
  WorkflowLayerName,
  type WorkflowProblem,
  type WorkflowsData,
  type WorkflowView,
} from './load';

// ── fixes ───────────────────────────────────────────────────────────────────────────────────

/** One ⌥⏎ fix: its title, and the whole file after it. */
export const WorkflowFix = z.object({ title: z.string(), text: z.string() });
export type WorkflowFix = z.infer<typeof WorkflowFix>;

const indentOf = (line: string): number => line.length - line.trimStart().length;
const blank = (line: string) => line.trim() === '';

/** The last line (0-based) of the YAML block that starts on `i`: the lines indented under it. */
const blockEnd = (lines: readonly string[], i: number): number => {
  const own = indentOf(lines[i] ?? '');
  let end = i;

  for (let j = i + 1; j < lines.length; j += 1) {
    const line = lines[j] ?? '';

    if (blank(line)) continue;
    if (indentOf(line) <= own) break;
    end = j;
  }

  return end;
};

const joined = (lines: readonly string[]) => lines.join('\n');

/** `lines` with the block on `at` (0-based) taken out. */
const without = (lines: readonly string[], at: number): string[] => [
  ...lines.slice(0, at),
  ...lines.slice(blockEnd(lines, at) + 1),
];

/** `lines` with the block on `from` moved after the block on `after` (both 0-based). */
const movedAfter = (lines: readonly string[], from: number, after: number): string[] => {
  const end = blockEnd(lines, from);
  const block = lines.slice(from, end + 1);
  const rest = [...lines.slice(0, from), ...lines.slice(end + 1)];
  const target = after > end ? after - block.length : after;
  const targetEnd = blockEnd(rest, target);

  return [...rest.slice(0, targetEnd + 1), ...block, ...rest.slice(targetEnd + 1)];
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How many edits make `a` into `b` (Levenshtein). */
const distance = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];

    for (let j = 1; j <= b.length; j += 1)
      row.push(
        Math.min(
          (prev[j] ?? 0) + 1,
          (row[j - 1] ?? 0) + 1,
          (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      );
    prev = row;
  }

  return prev[b.length] ?? 0;
};

/** The names nearest `name` (two edits at most, fewer than half its letters, or one starts the other), two. */
const nearestNames = (name: string, known: readonly string[]): string[] =>
  [...new Set(known)]
    .filter((k) => k !== name)
    .map((k) => ({ k, d: distance(name, k) }))
    .filter(
      ({ k, d }) => (d <= 2 && d < name.length / 2) || k.startsWith(name) || name.startsWith(k),
    )
    .sort((a, b) => a.d - b.d || a.k.localeCompare(b.k))
    .slice(0, 2)
    .map(({ k }) => k);

/** The step a problem's line names (`- reproduce`, `- verify: { … }`). */
const stepNameOn = (line: string): string | undefined =>
  /^\s*-\s*([A-Za-z0-9_.-]+)\s*(?::|#|$)/.exec(line)?.[1];

/** The steps' first lines (0-based), in order: each `- ` entry under `steps:`. */
const stepLines = (lines: readonly string[]): number[] => {
  const at = lines.findIndex((l) => /^steps:\s*(#.*)?$/.test(l));

  if (at < 0) return [];
  const out: number[] = [];
  let dash: number | undefined;

  for (let j = at + 1; j < lines.length; j += 1) {
    const line = lines[j] ?? '';

    if (blank(line) || line.trimStart().startsWith('#')) continue;
    if (indentOf(line) === 0) break;
    if (line.trimStart().startsWith('-')) {
      dash ??= indentOf(line);
      if (indentOf(line) === dash) out.push(j);
    }
  }

  return out;
};

/** A condition's `judge:` taken out, its `sees:` with it: flow (`{ check: …, judge: … }`) or block. */
const dropJudge = (lines: readonly string[], at: number): string[] | undefined => {
  const line = lines[at] ?? '';

  if (line.includes('{') && /judge\s*:/.test(line)) {
    const flow = line
      .replace(/,\s*sees\s*:\s*\[[^\]]*\]/, '')
      .replace(/,\s*judge\s*:\s*[^,}]*?(\s*[,}])/, '$1')
      .replace(/judge\s*:\s*[^,}]*,\s*/, '');

    return flow === line ? undefined : [...lines.slice(0, at), flow, ...lines.slice(at + 1)];
  }
  if (!/^\s*(-\s*)?judge\s*:/.test(line)) return undefined;
  const own = indentOf(line);
  const sees = lines.findIndex(
    (l, j) => j > at && indentOf(l) === own && /^\s*sees\s*:/.test(l) && j <= at + 3,
  );
  const cut = without(lines, at);

  return sees < 0 ? cut : without(cut, sees - (blockEnd(lines, at) - at + 1));
};

/** `max: 2` added to the loop whose `- ` entry starts on `at`. */
const addMax = (lines: readonly string[], at: number): string[] | undefined => {
  const line = lines[at] ?? '';
  const m = /^(\s*)-\s+/.exec(line);

  if (m === null || line.includes('{')) return undefined;
  const end = blockEnd(lines, at);
  const pad = ' '.repeat(m[0].length);

  return [...lines.slice(0, end + 1), `${pad}max: 2`, ...lines.slice(end + 1)];
};

/** A sequence entry lined up under the nearest `- ` above it at another indent. */
const lineUp = (lines: readonly string[], at: number): string[] | undefined => {
  const line = lines[at] ?? '';

  if (!line.trimStart().startsWith('-')) return undefined;
  for (let j = at - 1; j >= 0; j -= 1) {
    const above = lines[j] ?? '';

    if (blank(above)) continue;
    if (!above.trimStart().startsWith('-')) return undefined;
    if (indentOf(above) === indentOf(line)) return undefined;

    return [
      ...lines.slice(0, at),
      `${' '.repeat(indentOf(above))}${line.trimStart()}`,
      ...lines.slice(at + 1),
    ];
  }

  return undefined;
};

/**
 * The fixes of one problem in `text` (its file now): each the whole file after it, none when no
 * plain one is known. `known`: every skill and built-in step's name a step may run; `view`: the
 * file as loaded (its steps' lines), when it read.
 */
export const fixesOf = (
  text: string,
  p: Pick<WorkflowProblem, 'code' | 'line' | 'text'>,
  o: { known: readonly string[]; view?: WorkflowView | undefined },
): WorkflowFix[] => {
  const lines = text.split('\n');

  if (p.line === null) return [];
  const at = p.line - 1;
  const line = lines[at] ?? '';
  const fix = (title: string, after: readonly string[] | undefined): WorkflowFix[] =>
    after === undefined || joined(after) === text ? [] : [{ title, text: joined(after) }];
  const name = stepNameOn(line);

  switch (p.code) {
    case 'unknown-skill': {
      if (name === undefined) return [];
      const replace = nearestNames(name, o.known).flatMap((other) =>
        fix(`Replace with ${other}`, [
          ...lines.slice(0, at),
          line.replace(new RegExp(`(-\\s*)${escape(name)}\\b`), `$1${other}`),
          ...lines.slice(at + 1),
        ]),
      );

      return [...replace, ...fix(`Remove step ${name}`, without(lines, at))];
    }
    case 'duplicate-step':
      return name === undefined ? [] : fix(`Remove this ${name}`, without(lines, at));
    case 'needs-build': {
      const steps = stepLines(lines);
      const build = steps.find((j) => {
        const n = stepNameOn(lines[j] ?? '');

        return j > at && n !== undefined && builtInStep(n)?.kind === 'build';
      });
      const buildName = build === undefined ? undefined : stepNameOn(lines[build] ?? '');

      return name === undefined || build === undefined || buildName === undefined
        ? []
        : fix(`Move ${name} after ${buildName}`, movedAfter(lines, at, build));
    }
    case 'pr-last': {
      const last = stepLines(lines).at(-1);

      return name === undefined || last === undefined || last === at
        ? []
        : fix(`Move ${name} to the end`, movedAfter(lines, at, last));
    }
    case 'both-kinds':
      return fix('Keep check:, drop judge:', dropJudge(lines, at));
    case 'no-max':
      return fix('Add max: 2', addMax(lines, at));
    case 'not-yaml':
      return fix('Fix indentation', lineUp(lines, at));
    default:
      return [];
  }
};

// ── the readable side ──────────────────────────────────────────────────────────────────────

export const WorkflowReadProblem = z.object({
  line: z.number().int().positive().nullable(),
  code: z.enum(WORKFLOW_PROBLEM_CODES),
  text: z.string(),
  /** Its ⌥⏎ fixes, each the whole file after it; the ones that take this problem away. */
  fixes: z.array(WorkflowFix),
});
export type WorkflowReadProblem = z.infer<typeof WorkflowReadProblem>;

/** `abe workflow read`: a Layer's file as the Editor opens it, its readable side and problems. */
export const WorkflowReadData = z.object({
  /** As `workflow list` names it (`built-in/…` for a built-in one). */
  file: z.string(),
  kind: z.enum(['workflow', 'skill']),
  layer: WorkflowLayerName,
  /** The workflow's id, or the skill's name. */
  id: z.string(),
  /** Abe's built-in one: changed only as your copy (`workflow copy`); the repo's and yours change in place. */
  readOnly: z.boolean(),
  /** Your copy of it (its path), when this is a farther Layer's and you have one. */
  mine: z.string().nullable(),
  /** The Layer Propose sends this file to: yours, over a farther Layer's of the same name. */
  proposeTo: WorkflowLayerName.nullable(),
  /** The readable side, as markdown (the Editor's preview draws it beside the source). */
  markdown: z.string(),
  /** The file's text as read (the `--text` given, else as saved). */
  text: z.string(),
  /**
   * The readable side under no header: a skill's SKILL.md as its words and
   * the workflows that run it, another markdown file as itself; a workflow's, its readable side.
   */
  body: z.string(),
  problems: z.array(WorkflowReadProblem),
  /** The file's last retro (`workflow retro`): its findings' fixes the readable side links. */
  retro: WorkflowRetroData.nullable(),
  /** A workflow's preview, drawn beside its YAML in place of `markdown`; null for a skill's file. */
  preview: WorkflowPreview.nullable().default(null),
  /** Go to definition (⌘B, gd): each step's line and its skill's `SKILL.md` (a workflow's). */
  defs: z
    .array(z.object({ line: z.number().int().positive(), name: z.string(), path: z.string() }))
    .default([]),
  /** Find usages from a skill's file: each workflow step running it, at its line. */
  refs: z
    .array(z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() }))
    .default([]),
  /**
   * Compare (⌘D): your copy beside the farther Layer's file it shadows, both on disk (a built-in
   * one written out read-only); null when there is no other side.
   */
  compare: z
    .object({ layer: WorkflowLayerName, theirs: z.string(), mine: z.string() })
    .nullable()
    .default(null),
});
export type WorkflowReadData = z.infer<typeof WorkflowReadData>;

export const workflowReadText = (d: WorkflowReadData): string =>
  `${d.markdown.trimEnd()}\n${d.problems
    .map(
      (p) =>
        `! ${p.line === null ? '' : `line ${p.line}: `}${p.text}${p.fixes.length === 0 ? '' : ` (⌥⏎ ${p.fixes.map((f) => f.title).join(' · ')})`}\n`,
    )
    .join('')}`;

/** The words for a Layer as the readable side says it (`repo demo-shop`). */
export const layerWords = (d: Pick<WorkflowsData, 'layers'>, layer: WorkflowLayer): string => {
  const name = d.layers.find((l) => l.layer === layer)?.name ?? null;

  return name === null || layer === 'yours' || layer === 'built-in' ? layer : `${layer} ${name}`;
};

/** What the readable side says over the file: whose it is, and what can be done with it. */
export type ReadHeader = {
  layer: WorkflowLayer;
  readOnly: boolean;
  mine: string | null;
  proposeTo: WorkflowLayer | null;
  /** The other side Compare (⌘D) shows: the farther Layer your copy shadows, or yours. */
  compare?: WorkflowLayer | null | undefined;
};

/** The actions' links the Editor's preview runs (`abe:copy`, `abe:propose`, …). */
export const READ_ACTIONS = ['copy', 'mine', 'propose', 'change', 'retro', 'compare'] as const;
export type ReadAction = (typeof READ_ACTIONS)[number];

const link = (text: string, action: string) => `[${text}](abe:${action})`;

/** Whose a file is in one line, and the actions on it (the preview's links, `abe:<action>`). */
export const readHead = (
  d: Pick<WorkflowsData, 'layers'>,
  h: ReadHeader,
  what: string,
): { line: string; actions: PreviewAction[] } => {
  const act = (label: string, action: ReadAction): PreviewAction => ({ label, action });
  const compare =
    h.compare === null || h.compare === undefined
      ? []
      : [
          act(
            `Compare with ${h.compare === 'yours' ? 'mine' : layerWords(d, h.compare)} ⌘D`,
            'compare',
          ),
        ];
  const from = `*from ${layerWords(d, h.layer)}*`;

  if (!h.readOnly && h.layer === 'repo')
    return {
      line:
        h.mine === null
          ? `${from} · The team's file: commit it like the code.`
          : `${from} · The team's file. Your copy wins for you.`,
      actions: [
        act('Change with AI ⌘G', 'change'),
        ...(h.mine === null ? [] : [act('Open my copy', 'mine')]),
        ...compare,
        act('Retro…', 'retro'),
      ],
    };
  if (!h.readOnly) {
    const over = h.proposeTo === null ? null : layerWords(d, h.proposeTo);

    return {
      line:
        over === null
          ? `*yours* · Yours to change: it runs as you save it.`
          : `*your copy* · of ${over}'s ${what}. It runs for you only.`,
      actions: [
        act('Change with AI ⌘G', 'change'),
        ...compare,
        ...(over === null ? [] : [act(`Propose to ${over}…`, 'propose')]),
        act('Retro…', 'retro'),
      ],
    };
  }

  return {
    line:
      h.mine === null
        ? `${from} · Read-only here. An edit makes your copy.`
        : `${from} · Read-only here. Your copy wins for you.`,
    actions: [
      h.mine === null ? act('Edit my copy', 'copy') : act('Open my copy', 'mine'),
      ...compare,
      act('Retro…', 'retro'),
    ],
  };
};

const headerLines = (d: Pick<WorkflowsData, 'layers'>, h: ReadHeader, what: string): string[] => {
  const head = readHead(d, h, what);

  return [head.line, '', head.actions.map((a) => link(a.label, a.action)).join(' · ')];
};

const cardWords = (w: WorkflowView): string | null => {
  const on = w.on;

  if (on === null) return null;
  if (on.default) return 'any card no other workflow takes';
  const types = on.types.length === 0 ? 'a card' : `a ${on.types.join(' or ')} card`;

  return on.tags.length === 0 ? types : `${types} tagged ${on.tags.join(' or ')}`;
};

const conditionWords = (l: LoopView): string =>
  l.when.kind === 'check'
    ? `when \`${l.when.check}\``
    : `the step's agent asks: ${l.when.question} (sees ${l.when.sees.join(', ')})`;

/** A step's one line: the skill's description, else what the built-in does. */
const stepAbout = (s: WorkflowView['steps'][number], skills: readonly SkillView[]): string => {
  if (s.skill === null) return 'serve runs the checks';
  if (s.skillLayer === null) return `No skill named ${s.skill} in any Layer.`;
  const skill =
    skills.find((k) => k.name === s.skill && k.layer === s.skillLayer) ??
    skills.find((k) => k.name === s.skill && k.inForce);
  const about = skill?.description ?? '';

  return about === '' ? `runs ${s.skill}` : about;
};

/** The last retro of a file, as the readable side lists it under the file. */
export type ReadRetro = {
  runs: readonly { card: number | null; outcome: string }[];
  findings: readonly {
    severity: string;
    title: string;
    what: string;
    moments: readonly string[];
    fix: { summary: string } | null;
  }[];
};

const retroLines = (r: ReadRetro | null): string[] => {
  if (r === null) return [];
  const runs = r.runs.map((x) => `${x.card === null ? '' : `#${x.card} `}${x.outcome}`);

  return [
    '',
    `## Retro · ${r.runs.length} run${r.runs.length === 1 ? '' : 's'} read`,
    '',
    ...(runs.length === 0 ? ['No runs of it on this machine yet.'] : [runs.join(' · ')]),
    ...(r.findings.length === 0 ? ['', 'No findings.'] : ['', '### Findings, most severe first']),
    '',
    ...r.findings.map(
      (f, i) =>
        `${i + 1}. **${f.severity}** · ${f.title}: ${f.what}${f.moments.length === 0 ? '' : ` · ${f.moments.join(', ')}`}${f.fix === null ? '' : ` · ${link(`Fix it in the file: ${f.fix.summary}`, `fix/${i + 1}`)}`}`,
    ),
  ];
};

/** Why a workflow that does not pass is not run, as the readable side says it on top. */
const notRun = (w: WorkflowView): string[] => {
  if (w.ok) return [];
  const [first] = w.problems;
  const where = first?.line === undefined || first.line === null ? '' : `line ${first.line}, `;
  const read = first?.code === 'not-yaml' ? "Can't read" : "Can't run";
  const what = first === undefined ? '' : `: ${where}${first.text}`;

  return [
    '',
    `> **${read} ${w.id}.yaml**${what}. It is not offered on a card until it ${first?.code === 'not-yaml' ? 'reads' : 'passes'} again; the last good version is not run either.`,
  ];
};

/** A workflow's readable side: its steps as cards, what runs it, its loops; what you can do. */
export const readableWorkflow = (
  w: WorkflowView,
  d: Pick<WorkflowsData, 'layers' | 'skills'>,
  h: ReadHeader,
  retro: ReadRetro | null = null,
): string => {
  const on = cardWords(w);
  const lines = [
    `# ${w.name}`,
    '',
    ...headerLines(d, h, w.name),
    ...notRun(w),
    ...(w.description === '' ? [] : ['', w.description]),
    ...(w.steps.length === 0
      ? []
      : [
          '',
          '## Steps',
          '',
          ...w.steps.map(
            (s, i) =>
              `${i + 1}. **${s.name}**${s.pin === null ? '' : ` · pinned by ${s.pin}`}${s.skillLayer === null || s.skillLayer === 'built-in' || s.skillLayer === h.layer ? '' : ` · ${s.skillLayer}`}: ${stepAbout(s, d.skills)}`,
          ),
        ]),
    ...(on === null ? [] : ['', '## Runs on', '', on]),
    ...(w.branch === null ? [] : ['', '## Branch', '', `\`${w.branch}\``]),
    ...(w.loops.length === 0
      ? []
      : [
          '',
          '## Loops',
          '',
          ...w.loops.map(
            (l) =>
              `${l.id}. **${l.from} → ${l.to}** ${conditionWords(l)}${l.carries.length === 0 ? '' : `, carries ${l.carries.join(', ')}`}; up to ${l.max}, then ◆ Needs you${l.implied ? ' (built-in)' : ''}`,
          ),
        ]),
    ...retroLines(retro),
  ];

  return `${lines.join('\n')}\n`;
};

/** A skill file's readable side: whose it is over the file's own text, then who uses it. */
export const readableSkill = (
  s: SkillView,
  d: Pick<WorkflowsData, 'layers' | 'workflows'>,
  h: ReadHeader,
  text: string,
  rel = 'SKILL.md',
): string => {
  const files = skillFiles(s, rel);
  const lines = [
    ...headerLines(d, h, s.name),
    ...(files === null ? [] : ['', files]),
    '',
    readableSkillBody(s, d, text).trimEnd(),
  ];

  return `${lines.join('\n')}\n`;
};

/** A skill's files as one strip of links over its page, from the file `rel` shown; null for none. */
const skillFiles = (s: Pick<SkillView, 'files'>, rel: string): string | null => {
  const up = '../'.repeat(rel.split('/').length - 1);

  return s.files.length === 0
    ? null
    : `**Files** · ${s.files.map((f) => (f === rel ? `\`${f}\`` : `[${f}](${encodeURI(`${up}${f}`)})`)).join(' · ')}`;
};

/**
 * A skill file's own readable words, under no header: its text past the front matter (else its
 * name and description), then the workflows that run it.
 */
export const readableSkillBody = (
  s: Pick<SkillView, 'name' | 'description'>,
  d: Pick<WorkflowsData, 'workflows'>,
  text: string,
): string => {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  const users = d.workflows.filter((w) => w.inForce && w.steps.some((t) => t.skill === s.name));
  const lines = [
    ...(body === '' ? [`# ${s.name}`, '', s.description] : [body]),
    ...(users.length === 0 ? [] : ['', '## Used by', '', users.map((w) => w.name).join(' · ')]),
  ];

  return `${lines.join('\n')}\n`;
};
