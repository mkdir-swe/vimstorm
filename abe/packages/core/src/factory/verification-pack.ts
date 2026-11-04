/**
 * The repo's Verification pack (GLOSSARY): its own skill `.claude/skills/verify-<app>/`
 * (`<app>` the checkout folder's name), with Launch, Doctor, Drive, Evidence and Cleanup, and its
 * Feature map, `features/`: a README index and one file per user-facing feature. The install's
 * Verify stage writes it with create-verification-skill and proves one feature end to end
 * (`.scratch/install/verify/<feature>/`); a run's Verify drives the features a change touches and
 * says, per mapped feature, its verdict and how it was judged with its screenshot and recording,
 * or why it was not driven. maintain-verification-skill keeps the map true on a card's branch.
 * Pure: texts in, findings out; serve reads the files.
 */
import { z } from 'zod';
import { DEFAULT_HOOKS, REPO_SKILLS_DIR, type RepoHooks, verifySkill } from '../repo-hooks';
import { verifyHtmlOf } from './verify-html';

/** The pack's files, from the checkout's top: the repo's `verify` skill (`verify-<app>` undeclared). */
export const packPaths = (repo: string, hooks: RepoHooks = DEFAULT_HOOKS) => {
  const dir = `${REPO_SKILLS_DIR}/${verifySkill(hooks, repo)}`;

  return {
    dir,
    skill: `${dir}/SKILL.md`,
    features: `${dir}/features`,
    map: `${dir}/features/README.md`,
  };
};

/** Where the install's Verify keeps the proof of the one feature it drove, per feature. */
export const INSTALL_PROOF_DIR = '.scratch/install/verify';

/** The sections the pack's skill has, as its H2s begin. */
export const PACK_SECTIONS = ['Launch', 'Doctor', 'Drive', 'Evidence', 'Cleanup'] as const;

/** A feature file's four H2s, in order (the last two words of the third name the harness). */
export const FEATURE_SECTIONS = [
  'Sub-features',
  'How to get to it (user POV)',
  'Driving it with',
  'Gotchas',
] as const;

/** Why a pack, a proof or a run's verdicts can't be taken as written. */
export const PACK_FINDINGS = [
  'no-verify-skill',
  'verify-skill-shape',
  'no-feature-map',
  'feature-shape',
  'install-unproven',
  'feature-not-listed',
  'feature-unknown',
  'feature-unjudged',
  'feature-unproven',
  'not-driven-no-reason',
  'no-verify-html',
  'feature-html-differs',
] as const;
export type PackFindingCode = (typeof PACK_FINDINGS)[number];

/** One thing that can't stand: the file (from the checkout's or the report's top) and why. */
export type PackFinding = { code: PackFindingCode; file: string; why: string };

const h2s = (text: string): string[] => {
  const out: string[] = [];
  let fenced = false;

  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    const h = fenced ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);

    if (h !== null) out.push(h[1] ?? '');
  }

  return out;
};

const frontmatter = (text: string): Map<string, string> => {
  const lines = text.split('\n');

  if (lines[0]?.trim() !== '---') return new Map();
  const end = lines.findIndex((l, n) => n > 0 && l.trim() === '---');

  return new Map(
    lines.slice(1, end === -1 ? 1 : end).flatMap((l) => {
      const kv = /^([A-Za-z_-]+):\s*(.*?)\s*$/.exec(l);

      return kv === null ? [] : [[kv[1] ?? '', (kv[2] ?? '').replace(/^['"]|['"]$/g, '')]];
    }),
  );
};

/** What a person touches: a UI (driven in a browser), or none (a CLI, an API). */
export const PACK_SURFACES = ['web', 'cli', 'api'] as const;
export type PackSurface = (typeof PACK_SURFACES)[number];

/** A `surface:` as written, as a surface (`http` is an api); another word: undefined. */
const asSurface = (said: string | undefined): PackSurface | undefined =>
  said === 'http' ? 'api' : PACK_SURFACES.find((x) => x === said);

/** What proves a driven feature of each surface, for the words. */
const PROVEN_BY: Readonly<Record<PackSurface, string>> = {
  web: 'a screenshot and a recording',
  cli: 'a transcript (.txt, .log, .cast, .json) or a screenshot',
  api: 'a transcript (.txt, .log, .cast, .json: a request/response, a step log) or a screenshot',
};

/** The `surface:` a file's frontmatter says (top level or under `metadata:`), as written; none: undefined. */
const surfaceSaid = (skill: string): string | undefined => {
  const lines = skill.split('\n');

  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex((l, n) => n > 0 && l.trim() === '---');

  return lines
    .slice(1, end === -1 ? 1 : end)
    .map((l) => /^\s*surface:\s*['"]?([^'"\s]*)['"]?\s*$/.exec(l)?.[1])
    .find((v) => v !== undefined);
};

/** The pack's surface: `web` unless its skill's frontmatter says `cli` or `api`. */
export const packSurface = (skill: string | undefined): PackSurface =>
  asSurface(skill === undefined ? undefined : surfaceSaid(skill)) ?? 'web';

/**
 * Each feature's surface: its file's frontmatter `surface:` (`surface: api` for one driven over
 * HTTP with no browser, in a web app's pack), else the pack's (`packSurface`).
 */
export const featureSurfaces = (
  features: ReadonlyMap<string, string | undefined>,
  pack: PackSurface,
): Map<string, PackSurface> =>
  new Map(
    [...features].map(([id, text]) => [
      id,
      asSurface(text === undefined ? undefined : surfaceSaid(text)) ?? pack,
    ]),
  );

/** The feature files a map's README links (`[Search](./search.md)`), by id (`search`), in order. */
export const featuresOf = (readme: string): string[] => [
  ...new Set(
    [...readme.matchAll(/\]\((?:\.\/)?([A-Za-z0-9][A-Za-z0-9._-]*)\.md\)/g)]
      .map((m) => m[1] ?? '')
      .filter((id) => id.toLowerCase() !== 'readme'),
  ),
];

/**
 * What in a written pack can't stand: no skill, one not named `verify-<app>` or missing a
 * section; no feature map, or one linking no feature; a feature file linked but not there, there
 * but not linked (`listed`: the names in `features/`), or without its four H2s in order.
 */
export const packFindings = (o: {
  repo: string;
  skill: string | undefined;
  map: string | undefined;
  /** Each linked feature's text, undefined when it is not there. */
  features: ReadonlyMap<string, string | undefined>;
  /** The files `features/` holds. */
  listed: readonly string[];
  /** The repo's hook points: its `verify` skill's name. */
  hooks?: RepoHooks;
}): PackFinding[] => {
  const p = packPaths(o.repo, o.hooks);
  const name = verifySkill(o.hooks ?? DEFAULT_HOOKS, o.repo);

  if (o.skill === undefined)
    return [{ code: 'no-verify-skill', file: p.skill, why: 'is not there' }];
  const front = frontmatter(o.skill);
  const heads = h2s(o.skill).map((h) => h.toLowerCase());
  const out: PackFinding[] = [];

  if (front.get('name') !== name || (front.get('description') ?? '') === '')
    out.push({
      code: 'verify-skill-shape',
      file: p.skill,
      why: `needs frontmatter with name: ${name} and a description, or the skill never registers`,
    });
  const surface = surfaceSaid(o.skill);

  if (surface !== undefined && asSurface(surface) === undefined)
    out.push({
      code: 'verify-skill-shape',
      file: p.skill,
      why: `says surface: ${surface}; it is web, cli or api (http: api)`,
    });
  for (const s of PACK_SECTIONS)
    if (!heads.some((h) => h.startsWith(s.toLowerCase())))
      out.push({ code: 'verify-skill-shape', file: p.skill, why: `has no ## ${s} section` });
  const ids = o.map === undefined ? [] : featuresOf(o.map);

  if (ids.length === 0)
    out.push({
      code: 'no-feature-map',
      file: p.map,
      why:
        o.map === undefined
          ? 'is not there: write the map of every user-facing feature'
          : 'links no feature file',
    });
  for (const id of ids) {
    const file = `${p.features}/${id}.md`;
    const text = o.features.get(id);

    if (text === undefined) {
      out.push({ code: 'feature-shape', file, why: 'is linked from the map but not there' });
      continue;
    }
    const said = surfaceSaid(text);

    if (said !== undefined && asSurface(said) === undefined)
      out.push({
        code: 'feature-shape',
        file,
        why: `says surface: ${said}; it is web, cli or api (http: api)`,
      });
    const got = h2s(text);
    const inOrder = FEATURE_SECTIONS.every((s, i) => got[i]?.startsWith(s) === true);

    if (!inOrder)
      out.push({
        code: 'feature-shape',
        file,
        why: `needs exactly the H2s ${FEATURE_SECTIONS.map((s) => (s === 'Driving it with' ? `${s} <harness>` : s)).join(', ')}, in that order`,
      });
  }
  // a file the map does not link (a map that links none is said once above)
  for (const f of ids.length === 0 ? [] : o.listed)
    if (f.endsWith('.md') && f !== 'README.md' && !ids.includes(f.slice(0, -3)))
      out.push({
        code: 'feature-shape',
        file: `${p.features}/${f}`,
        why: 'is not linked from the map',
      });

  return out;
};

const IMAGE = /\.(?:png|jpe?g|webp)$/i;
const RECORDING = /\.(?:webm|mp4|mov|cast)$/i;
const TRANSCRIPT = /\.(?:txt|log|cast|json)$/i;

/**
 * What a driven feature's evidence lacks. A web app's: a screenshot and a recording. One with no
 * UI (`cli`, `api`): a screenshot or a text transcript (a terminal's, a log, a response), a
 * recording optional. Empty when it has what it needs.
 */
export const evidenceLacks = (files: readonly string[], surface: PackSurface = 'web'): string[] => {
  const has = (re: RegExp) => files.some((f) => re.test(f));

  if (surface !== 'web')
    return has(IMAGE) || has(TRANSCRIPT)
      ? []
      : ['a screenshot or a transcript (.txt, .log, .cast, .json)'];

  return [
    ...(has(IMAGE) ? [] : ['a screenshot (.png, .jpg, .webp)']),
    ...(has(RECORDING) ? [] : ['a recording (.webm, .mp4, .mov, .cast)']),
  ];
};

/**
 * The install's proof: one mapped feature driven end to end, its screenshot and recording kept
 * under `.scratch/install/verify/<feature>/` past cleanup (`proofs`: the files each such folder
 * holds). Empty when one has both.
 */
export const installProofFindings = (o: {
  features: readonly string[];
  proofs: ReadonlyMap<string, readonly string[]>;
  surface?: PackSurface;
  /** Each feature's own (`featureSurfaces`), over the pack's. */
  surfaces?: ReadonlyMap<string, PackSurface>;
}): PackFinding[] => {
  const lacks = (f: string) =>
    evidenceLacks(o.proofs.get(f) ?? [], o.surfaces?.get(f) ?? o.surface);
  const tried = o.features.filter((f) => (o.proofs.get(f) ?? []).length > 0);

  if (tried.some((f) => lacks(f).length === 0)) return [];
  const why =
    tried.length === 0
      ? `holds no proof of a mapped feature (${o.features.join(', ') || 'none mapped'}): drive one end to end and keep its evidence in ${INSTALL_PROOF_DIR}/<feature>/`
      : tried.map((f) => `${f} lacks ${lacks(f).join(' and ')}`).join('; ');

  return [{ code: 'install-unproven', file: INSTALL_PROOF_DIR, why }];
};

/** One mapped feature as a run's Verify report says it. */
export type FeatureVerdict =
  | {
      feature: string;
      driven: true;
      verdict: 'pass' | 'fail';
      judged: string;
      evidence: string[];
    }
  | { feature: string; driven: false; why: string };

const ITEM = /^\s*[-*]\s+`([^`]+)`:?\s+(pass|fail|not driven)\b[.:]?\s*(.*)$/i;
const JUDGED = /judged by:\s*(.*?)\s*(?:evidence:|where:|$)/i;
const EVIDENCE = /evidence:\s*(.*?)\s*(?:where:|$)/i;
const WHY = /why:\s*(.*)$/i;

/** The lines of a report's `## Features` section, with their line numbers (from 1). */
const featureSection = (report: string): { line: number; text: string }[] | null => {
  const lines = report.split('\n');
  const at = lines.findIndex((l) => /^##\s+features\s*$/i.test(l.trim()));

  if (at === -1) return null;
  const end = lines.findIndex((l, n) => n > at && /^#{1,2}\s/.test(l));

  return lines
    .slice(at + 1, end === -1 ? undefined : end)
    .map((text, i) => ({ line: at + i + 2, text }))
    .filter((l) => l.text.trim() !== '');
};

/**
 * A run's Verify report's verdicts, one per bullet of its `## Features`:
 *
 *     - `create-note` pass. Judged by: <how>. Evidence: <paths>. Where: <env> · <url> · as <who>
 *     - `search` not driven. Why: <reason>
 *
 * Evidence paths are from `.scratch/<card>/` (`verify/evidence/create-note/save.png`); `Where:` is
 * for the reader, not read here. A bullet that is neither is said as `bad`.
 */
export const featureVerdicts = (
  report: string,
): { verdicts: FeatureVerdict[]; bad: { line: number; text: string }[] } | null => {
  const section = featureSection(report);

  if (section === null) return null;
  const verdicts: FeatureVerdict[] = [];
  const bad: { line: number; text: string }[] = [];

  for (const l of section) {
    const item = ITEM.exec(l.text);

    if (item === null) {
      if (/^\s*[-*]\s/.test(l.text)) bad.push({ line: l.line, text: l.text.trim() });
      continue;
    }
    const feature = item[1] ?? '';
    const kind = (item[2] ?? '').toLowerCase();
    const rest = item[3] ?? '';

    if (kind === 'not driven') {
      verdicts.push({ feature, driven: false, why: (WHY.exec(rest)?.[1] ?? '').trim() });
      continue;
    }
    verdicts.push({
      feature,
      driven: true,
      verdict: kind === 'fail' ? 'fail' : 'pass',
      judged: (JUDGED.exec(rest)?.[1] ?? '').replace(/\.$/, '').trim(),
      evidence: (EVIDENCE.exec(rest)?.[1] ?? '')
        .split(',')
        .map((e) => e.trim().replace(/^`|`$/g, '').replace(/\.$/, ''))
        .filter((e) => e !== ''),
    });
  }

  return { verdicts, bad };
};

/** A mapped feature's verdict as a run keeps it (its After verification, the run record). */
export const FeatureResult = z.object({
  feature: z.string(),
  verdict: z.enum(['pass', 'fail', 'not-driven']),
  /** How it was judged; null when not driven. */
  judged: z.string().nullable(),
  /** Why it was not driven; null when driven. */
  why: z.string().nullable(),
  /** Its Evidence, from `.scratch/<card>/`. */
  evidence: z.array(z.string()),
});
export type FeatureResult = z.infer<typeof FeatureResult>;

/** A report's `## Features` verdicts as the run keeps them; empty when it has none. */
export const featureResults = (report: string): FeatureResult[] =>
  (featureVerdicts(report)?.verdicts ?? []).map((v) =>
    v.driven
      ? {
          feature: v.feature,
          verdict: v.verdict,
          judged: v.judged,
          why: null,
          evidence: v.evidence,
        }
      : { feature: v.feature, verdict: 'not-driven', judged: null, why: v.why, evidence: [] },
  );

/** An evidence path that stays in `.scratch/<card>/`: relative, never up out of it. */
const inScratch = (path: string) =>
  !path.startsWith('/') && !path.startsWith('~') && !path.split('/').includes('..');

/**
 * What a run's Verify report can't claim: a mapped feature it does not list, one it lists that the
 * map has not, a driven one with no "Judged by", or without a screenshot and a recording that are
 * there (`there`: whether an evidence path from `.scratch/<card>/` is a file), a not driven one
 * with no "Why". `report`: its path, for the words.
 */
export const featureReportFindings = (o: {
  features: readonly string[];
  report: string;
  text: string;
  there: (path: string) => boolean;
  /** The pack's (`packSurface`): a web app's driven feature needs a recording too. */
  surface?: PackSurface;
  /** Each feature's own (`featureSurfaces`), over the pack's. */
  surfaces?: ReadonlyMap<string, PackSurface>;
}): PackFinding[] => {
  const read = featureVerdicts(o.text);
  const file = o.report;

  if (read === null)
    return [
      {
        code: 'feature-not-listed',
        file,
        why: `has no ## Features section: list every mapped feature (${o.features.join(', ')})`,
      },
    ];
  const out: PackFinding[] = read.bad.map((b) => ({
    code: 'feature-unjudged',
    file,
    why: `line ${b.line} "${b.text}" is no verdict: - \`<feature>\` pass|fail. Judged by: <how>. Evidence: <paths>, or - \`<feature>\` not driven. Why: <reason>`,
  }));
  const listed = read.verdicts.map((v) => v.feature);

  for (const f of o.features)
    if (!listed.includes(f))
      out.push({
        code: 'feature-not-listed',
        file,
        why: `does not list ${f}: drive it, or say not driven and why`,
      });
  for (const v of read.verdicts) {
    if (!o.features.includes(v.feature)) {
      out.push({
        code: 'feature-unknown',
        file,
        why: `lists ${v.feature}, which the map has not (${o.features.join(', ')})`,
      });
      continue;
    }
    if (!v.driven) {
      if (v.why === '')
        out.push({
          code: 'not-driven-no-reason',
          file,
          why: `says ${v.feature} not driven with no Why: <reason>`,
        });
      continue;
    }
    if (v.judged === '')
      out.push({
        code: 'feature-unjudged',
        file,
        why: `gives ${v.feature} ${v.verdict} with no Judged by: <how>`,
      });
    const gone = v.evidence.filter((e) => !inScratch(e) || !o.there(e));
    const surface = o.surfaces?.get(v.feature) ?? o.surface ?? 'web';
    const lacks = evidenceLacks(
      v.evidence.filter((e) => !gone.includes(e)),
      surface,
    );

    if (gone.length > 0 || lacks.length > 0)
      out.push({
        code: 'feature-unproven',
        file,
        why: [
          ...(gone.length === 0
            ? []
            : [`${v.feature}'s evidence ${gone.join(', ')} is not in .scratch/<card>/`]),
          ...(lacks.length === 0
            ? []
            : [
                `${v.feature} (surface ${surface}, proven by ${PROVEN_BY[surface]}) has no ${lacks.join(' and no ')}`,
              ]),
        ].join('; '),
      });
  }

  return out;
};

/**
 * What an After pass's HTML report (`verify-html.ts`) can't claim against its report's
 * `## Features`: none given, or a feature whose section's verdict is not its line's, a feature
 * one has and the other has not. A section the sanitiser drops (no verdict the kit knows) counts
 * as not there. `report`, `html.path`: their paths, for the words.
 */
export const featureHtmlFindings = (o: {
  report: string;
  text: string;
  html: { path: string; text: string } | undefined;
}): PackFinding[] => {
  if (o.html === undefined)
    return [{ code: 'no-verify-html', file: o.report, why: 'has no HTML report (--html <file>)' }];
  const file = o.html.path;
  const listed = new Map(featureResults(o.text).map((r) => [r.feature, r.verdict]));
  const drawn = new Map<string, string>();

  // a feature's first section
  for (const f of verifyHtmlOf(o.html.text).features)
    if (!drawn.has(f.feature)) drawn.set(f.feature, f.verdict);
  const out: PackFinding[] = [];
  const differs = (why: string) => out.push({ code: 'feature-html-differs', file, why });

  for (const [feature, verdict] of listed) {
    const said = drawn.get(feature);

    if (said === undefined)
      differs(`has no section for ${feature}, which ## Features says ${verdict}`);
    else if (said !== verdict) differs(`says ${feature} ${said}, ## Features says ${verdict}`);
  }
  for (const feature of drawn.keys())
    if (!listed.has(feature))
      differs(`has a section for ${feature}, which ## Features does not list`);

  return out;
};

/** What each finding asks the session to do. */
const FIX: Readonly<Record<PackFindingCode, string>> = {
  'no-verify-skill': 'Write it with create-verification-skill',
  'verify-skill-shape': 'Fix the verify skill as create-verification-skill says',
  'no-feature-map': 'Write the Feature map as create-verification-skill says',
  'feature-shape': 'Fix the Feature map as create-verification-skill says',
  'install-unproven':
    'Run the Verification pack once end to end (launch, doctor, drive one feature, keep its evidence, clean up)',
  'feature-not-listed': 'List every mapped feature under ## Features',
  'feature-unknown': 'Name features by their file in the Feature map',
  'feature-unjudged': 'Say how each verdict was judged',
  'feature-unproven':
    "Keep each driven feature's proof in its Evidence, as its surface asks. A feature driven with no browser (an HTTP API, a CLI) declares it in its feature file's front matter (`surface: api` or `surface: cli`, in .claude/skills/verify-<app>/features/<feature>.md, committed on the card branch); then a transcript proves it. One that truly can't be proven: list it not driven, with why",
  'not-driven-no-reason': 'Say why each feature was not driven',
  'no-verify-html':
    "Write the HTML report from the verify kit (the verify skill's The HTML report: one section per mapped feature, its verdict as ## Features says) and record it with --html",
  'feature-html-differs':
    "Give each feature's section in the HTML report the verdict its ## Features line says",
};

/** The refusal for findings: the first one's code, each of that code said. Null: none. */
export const packRefusal = (
  findings: readonly PackFinding[],
): { code: PackFindingCode; message: string } | null => {
  const code = findings[0]?.code;

  if (code === undefined) return null;
  const said = findings
    .filter((f) => f.code === code)
    .map((f) => `${f.file} ${f.why}`)
    .join('; ');

  return { code, message: `${said}. ${FIX[code]}` };
};
