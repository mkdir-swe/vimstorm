/**
 * Changing a Layer's files (#15, spec #19 stories 26, 27, 36; canvas SW-EditAI, SW-New,
 * SW-TeamCopy, SW-Propose, SW-Retro): Change with AI (one file, nothing written until the
 * Editor's buffer is saved), Edit my copy (a farther Layer's file copied into yours), Propose (your copy as a pull
 * request on that Layer's repo) and Retro on a file (its runs, findings, a fix in the file).
 */
import { z } from 'zod';
import { askingJson } from '../../triage/one-shot';
import { WORKFLOW_GUIDE } from './built-in';
import { WorkflowLayerName, WorkflowView } from './load';

// ── Edit my copy, Propose ───────────────────────────────────────────────────────────────────

/** `abe workflow copy`: your copy of a farther Layer's file, in your Layer. */
export const WorkflowCopyData = z.object({
  /** The file copied, as `workflow list` names it. */
  from: z.string(),
  layer: WorkflowLayerName,
  /** Your copy of that file (a skill's whole folder is copied). */
  path: z.string(),
  /** You had a copy already: nothing written. */
  existed: z.boolean(),
});
export type WorkflowCopyData = z.infer<typeof WorkflowCopyData>;

export const workflowCopyText = (d: WorkflowCopyData): string =>
  `${d.existed ? 'your copy already: ' : 'copied to '}${d.path}\n`;

/** `abe workflow propose`: your copy as one pull request on the Layer it is a copy of. */
export const WorkflowProposeData = z.object({
  /** Your copy, proposed. */
  path: z.string(),
  /** The Layer it goes to, and its name (`repo demo-shop`). */
  to: WorkflowLayerName,
  where: z.string(),
  repo: z.string(),
  branch: z.string(),
  /** The paths written, in that repo. */
  files: z.array(z.string()),
  pr: z.object({ number: z.number().int(), url: z.string() }),
  /** It was open already: updated, no second one opened. */
  existing: z.boolean(),
  /** Local mode (#24): held on this Mac, never sent (`abe local status` lists it). */
  held: z.boolean().default(false),
});
export type WorkflowProposeData = z.infer<typeof WorkflowProposeData>;

const proposedWord = (d: WorkflowProposeData): string => {
  if (d.held) return 'held on this machine (local mode):';

  return d.existing ? 'updated' : 'opened';
};

export const workflowProposeText = (d: WorkflowProposeData): string =>
  `${proposedWord(d)} #${d.pr.number} on ${d.repo} for ${d.where}: ${d.pr.url}\n`;

/** The branch a proposal of your copy goes on. */
export const proposeBranch = (kind: 'workflow' | 'skill', id: string): string =>
  `abe/propose-${kind}-${id}`;

export const proposeTitle = (where: string, file: string): string =>
  `${where}: ${file} from a copy`;

export const proposeBody = (o: { where: string; files: readonly string[]; why: string }): string =>
  `${o.why.trim()}\n\nProposed from a copy in Abe, for ${o.where} to review.\n\n${o.files.map((f) => `- \`${f}\``).join('\n')}\n`;

// ── Change with AI ──────────────────────────────────────────────────────────────────────────

/** What the one-shot answers Change with AI: the whole file after the change. */
export const ChangeAnswer = z.object({
  summary: z.string().min(1),
  text: z.string().min(1),
});
export type ChangeAnswer = z.infer<typeof ChangeAnswer>;

/** `abe workflow change`: the file after the change, nothing written (unless `--write`). */
export const WorkflowChangeData = z.object({
  file: z.string(),
  summary: z.string(),
  before: z.string(),
  text: z.string(),
  /** How many load-check problems the changed text has. */
  problems: z.number().int().nonnegative(),
  /** With `--write`: the file written (your copy when it was a farther Layer's); else null. */
  written: z.string().nullable(),
  /** A workflow's: the changed text as the load check reads it. */
  view: WorkflowView.nullable().default(null),
});
export type WorkflowChangeData = z.infer<typeof WorkflowChangeData>;

export const workflowChangeText = (d: WorkflowChangeData): string =>
  `${d.summary}${d.problems === 0 ? '' : ` (${d.problems} problem${d.problems === 1 ? '' : 's'})`}\n${d.written === null ? d.text : `wrote ${d.written}\n`}`;

export const CHANGE_SYSTEM = `You change one file of an Abe Layer: a workflow (YAML: steps in order and the loops back between them) or a skill (a SKILL.md and its notes). Change only what the wish asks for, keep everything else as it is (comments, order, spacing), and never invent a skill a workflow's step runs when the Layers list none of that name: use one they list, or say so in the summary.`;

export const changePrompt = (o: {
  file: string;
  kind: 'workflow' | 'skill';
  text: string;
  wish: string;
  skills: readonly { name: string; description: string }[];
}): string =>
  askingJson(
    `Change this ${o.kind} file: ${o.wish.trim()}

### ${o.file}

\`\`\`
${o.text.trimEnd()}
\`\`\`

### The skills the Layers have

${o.skills.map((s) => `- ${s.name}${s.description === '' ? '' : `: ${s.description}`}`).join('\n')}
${o.kind === 'workflow' ? `\n### The workflow YAML guide\n\n${WORKFLOW_GUIDE.trim()}\n` : ''}`,
    '{"summary": "<one line: what changed>", "text": "<the whole file after the change>"}',
  );

// ── Retro on a file ─────────────────────────────────────────────────────────────────────────

export const FileRetroFinding = z.object({
  severity: z.enum(['high', 'medium', 'low']),
  /** Where the fix goes: `Steps`, `Loops`, `Instructions`, … */
  title: z.string().min(1),
  what: z.string().min(1),
  /** The runs' moments it rests on (`#1272 verify`). */
  moments: z.array(z.string()).default([]),
  /** The file after the fix, when the fix is in it. */
  fix: z
    .object({ summary: z.string().min(1), text: z.string().min(1) })
    .nullable()
    .default(null),
});
export type FileRetroFinding = z.infer<typeof FileRetroFinding>;

export const FileRetroAnswer = z.object({ findings: z.array(FileRetroFinding) });

/** One run of the file read by its retro. */
export const FileRetroRun = z.object({
  session: z.string(),
  card: z.number().int().nullable(),
  title: z.string(),
  /** `merged`, `stopped at verify`, `at review`. */
  outcome: z.string(),
  at: z.string(),
});
export type FileRetroRun = z.infer<typeof FileRetroRun>;

/** `abe workflow retro`: a file's runs on this Mac and what they show, kept as its last retro. */
export const WorkflowRetroData = z.object({
  file: z.string(),
  id: z.string(),
  at: z.string(),
  runs: z.array(FileRetroRun),
  findings: z.array(FileRetroFinding),
});
export type WorkflowRetroData = z.infer<typeof WorkflowRetroData>;

export const workflowRetroText = (d: WorkflowRetroData): string =>
  `${d.runs.length} run${d.runs.length === 1 ? '' : 's'} of ${d.id} read\n${d.findings
    .map(
      (f, i) =>
        `${i + 1}. ${f.severity} · ${f.title}: ${f.what}${f.fix === null ? '' : ` (fix: ${f.fix.summary})`}\n`,
    )
    .join('')}`;

export const FILE_RETRO_SYSTEM = `You run a retro on one Abe workflow or skill file: from its runs, find what went wrong or slow that a change to this file would fix, most severe first. Each finding names the runs' moments it rests on; when the fix is a change to this file, give the whole file after it. No finding without a moment.`;

export const fileRetroPrompt = (o: {
  file: string;
  text: string;
  runs: readonly (FileRetroRun & { path: string })[];
}): string =>
  askingJson(
    `Retro on ${o.file}.

### ${o.file}

\`\`\`
${o.text.trimEnd()}
\`\`\`

### Its runs on this machine, newest first

${o.runs.length === 0 ? '(none)' : o.runs.map((r) => `- ${r.card === null ? '' : `#${r.card} `}${r.title}: ${r.outcome} (${r.at}; path ${r.path})`).join('\n')}
`,
    '{"findings": [{"severity": "high" | "medium" | "low", "title": "<where: Steps, Loops, Instructions>", "what": "<what happened>", "moments": ["#<card> <step>"], "fix": {"summary": "<one line>", "text": "<the whole file after the fix>"} | null}]}',
  );
