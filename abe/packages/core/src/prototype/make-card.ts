/**
 * The org store's prototypes (ADR 0023) and Make card's plain card. `abe prototype make-card`
 * (from the prototype session, or the person) makes a card of a prototype session's work: a new
 * card (New, tagged `prototype`) whose description carries a `## Prototype` section, its diff and
 * screenshots uploaded to the org store under `prototypes/<repo>/<card>/v<n>/` as the card's
 * reference, which every run of the card reads (`referencePrompt`, `prototypeReadme`). The rules
 * here: the store's keys and records, the link line and section, and the answer.
 */
import { z } from 'zod';
import { type RunReference } from '../factory/factory';
import { PrototypeId } from './prototype';
import { skillBody } from '../skills/skills';
import { githubRepoOf } from '../board/tracking';
import makeCardSkill from '../../skills/make-card/SKILL.md' with { type: 'text' };
import makeCardProtocol from '../../skills/make-card/PROTOCOL.md' with { type: 'text' };

/** Core's make-card skill as a one-shot's system prompt (`abe card draft`'s), Abe's side after it. */
export const MAKE_CARD_SKILL = `${skillBody(makeCardSkill)}\n${makeCardProtocol}`;

const Count = z.number().int().positive();
const Many = z.number().int().nonnegative();
const At = z.iso.datetime();
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Line = z.string().trim().min(1);

/** A card as drafted (`abe card draft`, the make-card skill): Why, What and its criteria. */
export const CardDraft = z.object({
  title: Line,
  why: Line,
  what: Line,
  criteria: z.array(Line).min(1),
});
export type CardDraft = z.infer<typeof CardDraft>;

const short = (sha: string) => sha.slice(0, 7);

// ---------------------------------------------------------------------------------------------
// The org store

/** A GitHub issue as linked: `o/shop#88` and its page (a version made before #351 names one). */
export const SpecLink = z.object({ repo: z.string(), number: Count, url: z.string() });
export type SpecLink = z.infer<typeof SpecLink>;

const KEY_PART = /[^A-Za-z0-9._-]/g;

/**
 * The repo's name in store keys: its GitHub name (`o/demo-shop` → `demo-shop`), else the
 * checkout's folder name, with anything a key may not hold as `-`.
 */
export const storeRepoName = (o: { remote: string | null; repo: string }): string => {
  const github = o.remote === null ? undefined : githubRepoOf(o.remote);
  const name =
    github?.split('/')[1] ??
    o.repo
      .split('/')
      .filter((p) => p !== '')
      .at(-1) ??
    '';
  const clean = name.replace(KEY_PART, '-').replace(/^\.+/, '');

  return clean === '' ? 'repo' : clean;
};

/** Every card's prototypes in the store. */
export const PROTOTYPES_PREFIX = 'prototypes/';

/** A card's prototype versions in the store. */
export const cardPrototypesPrefix = (repo: string, card: number): string =>
  `${PROTOTYPES_PREFIX}${repo}/${card}/`;

/** One version's folder: `prototypes/<repo>/<card>/v<n>/`. */
export const versionPrefix = (repo: string, card: number, n: number): string =>
  `${cardPrototypesPrefix(repo, card)}v${n}/`;

/** The card's prototype record beside its versions. */
export const prototypeIndexKey = (repo: string, card: number): string =>
  `${cardPrototypesPrefix(repo, card)}prototype.json`;

/**
 * The card Create makes, before it has a number: a preview's `card`. Only previews use it; no key
 * is ever made with it.
 */
export const NEW_CARD = 0;

const cardPart = (card: number) => (card === NEW_CARD ? '<new card>' : String(card));

/** `prototype://demo-shop/4/v3`: a version in the store, as its link line names it. */
export const prototypeAddress = (repo: string, card: number, n: number): string =>
  `prototype://${repo}/${cardPart(card)}/v${n}`;

const StoredBase = { n: Count, what: z.string().min(1), at: At, file: z.string().min(1) };

export const StoredChange = z.object({
  ...StoredBase,
  kind: z.enum(['css', 'js']),
  target: z.string().nullable(),
});
export const StoredMock = z.object({ ...StoredBase, route: z.string() });
export const StoredScreenshot = z.object(StoredBase);

/** A version's `meta.json` in the store: everything but the files' contents, which sit beside it. */
export const OrgPrototypeVersion = z.object({
  v: z.literal(1),
  prototype: PrototypeId,
  version: Count,
  at: At,
  card: Count,
  /** The repo's name in the keys (`storeRepoName`). */
  repo: z.string(),
  remote: z.string().nullable(),
  branch: z.string(),
  commit: Sha,
  /** Before #351 Make card opened a spec issue; none since (ADR 0023). */
  spec: SpecLink.nullable().default(null),
  /** Paths relative to the version's folder. */
  changes: z.array(StoredChange),
  mocks: z.array(StoredMock),
  screenshots: z.array(StoredScreenshot),
  /**
   * A prototype in code (make-card): its throwaway branch and the diff's file beside
   * `meta.json`; it has no changes or mocks. Null: an injected-changes one from before 3.3.
   */
  code: z
    .object({ branch: z.string().min(1), diff: z.string().min(1) })
    .nullable()
    .default(null),
});
export type OrgPrototypeVersion = z.infer<typeof OrgPrototypeVersion>;

export const OrgVersionSummary = z.object({
  n: Count,
  at: At,
  commit: Sha,
  prototype: PrototypeId,
  changes: Many,
  mocks: Many,
  screenshots: Many,
});

/** `prototype.json` under the card: every version uploaded (and a spec issue made before #351). */
export const OrgPrototype = z.object({
  v: z.literal(1),
  card: Count,
  repo: z.string(),
  remote: z.string().nullable(),
  spec: SpecLink.nullable().default(null),
  versions: z.array(OrgVersionSummary).min(1),
});
export type OrgPrototype = z.infer<typeof OrgPrototype>;

/** One object of a version's upload: text, or a screenshot read from the prototype's folder. */
export type Upload = { key: string; contentType: string } & (
  { text: string } | { screenshot: string }
);

/** `prototype.json` with one more version (again: replaced); a spec issue it named stays. */
export const withUploaded = (
  before: OrgPrototype | undefined,
  meta: OrgPrototypeVersion,
): OrgPrototype => ({
  v: 1,
  card: meta.card,
  repo: meta.repo,
  remote: meta.remote,
  spec: meta.spec ?? before?.spec ?? null,
  versions: [
    ...(before?.versions ?? []).filter((v) => v.n !== meta.version),
    {
      n: meta.version,
      at: meta.at,
      commit: meta.commit,
      prototype: meta.prototype,
      changes: meta.changes.length,
      mocks: meta.mocks.length,
      screenshots: meta.screenshots.length,
    },
  ].sort((a, b) => a.n - b.n),
});

// ---------------------------------------------------------------------------------------------
// The link line

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** `Prototype v3 · 4 changes · mock GET /api/vat · at 3f2a9c1 · prototype://demo-shop/4/v3`. */
export const prototypeLinkLine = (meta: OrgPrototypeVersion): string =>
  [
    `Prototype v${meta.version}`,
    meta.code === null
      ? plural(meta.changes.length + meta.mocks.length, 'change')
      : `code on ${meta.code.branch}`,
    ...meta.mocks.map((m) => `mock ${m.route}`),
    `at ${short(meta.commit)}`,
    prototypeAddress(meta.repo, meta.card, meta.version),
  ].join(' · ');

/** Whether a comment already carries the version's link line (its address): written once. */
export const hasPrototypeLine = (
  comments: readonly { text: string }[],
  meta: Pick<OrgPrototypeVersion, 'repo' | 'card' | 'version'>,
): boolean => {
  const address = prototypeAddress(meta.repo, meta.card, meta.version);

  return comments.some((c) => c.text.includes(address));
};

const SECTION = '## Prototype';

/**
 * A card's description with its `## Prototype` section (Make card on a card that exists, #351
 * Q3): the newest link line, in place of the one there, else after its own text, which stays.
 */
export const withPrototypeSection = (description: string, meta: OrgPrototypeVersion): string => {
  const section = `${SECTION}\n\n${prototypeLinkLine(meta)}`;
  const lines = description.split('\n');
  const at = lines.findIndex((l) => l.trim() === SECTION);

  if (at < 0) return description.trim() === '' ? section : `${description.trimEnd()}\n\n${section}`;
  const next = lines.findIndex((l, i) => i > at && /^#{1,2} /.test(l));
  const after = next < 0 ? [] : lines.slice(next);
  const before = lines.slice(0, at).join('\n').trimEnd();

  return [before, section, after.join('\n')].filter((x) => x !== '').join('\n\n');
};

// ---------------------------------------------------------------------------------------------
// What Make card answers

/** `abe prototype make-card`: the card made, and the prototype's version in the org store. */
export const MakeCardData = z.object({
  prototype: PrototypeId,
  card: Count,
  title: z.string(),
  /** The card on the board. */
  url: z.string(),
  /** The org store's version holding its diff and screenshots; null: no org store, kept local. */
  version: Count.nullable(),
  /** The `## Prototype` link line in its description. */
  line: z.string(),
});
export type MakeCardData = z.infer<typeof MakeCardData>;

export const makeCardText = (d: MakeCardData): string =>
  `made AB#${d.card} ${d.title} from ${d.prototype}${d.version === null ? ' (no org store: its diff stays in the worktree)' : `, prototype v${d.version} its reference`}\n${d.url}\n`;

// ---------------------------------------------------------------------------------------------
// The Factory's reference (ADR 0023)

/**
 * Where a Factory run's reference is copied, relative to its worktree: `.scratch/` is
 * git-excluded, so nothing of it reaches the branch.
 */
export const referenceDir = (card: number): string => `.scratch/${card}/prototype`;

/**
 * The reference a run on the card keeps for its newest version: a product owner's by its
 * address, a developer's by its branch and commit.
 */
export const runReference = (meta: OrgPrototypeVersion): RunReference => ({
  spec: null,
  prototype:
    meta.code === null
      ? { kind: 'store', url: prototypeAddress(meta.repo, meta.card, meta.version) }
      : { kind: 'code', branch: meta.code.branch, sha: short(meta.commit) },
  dir: referenceDir(meta.card),
});

/** The reference folder's first file: what the prototype is, in words. */
export const REFERENCE_README = 'PROTOTYPE.md';

const MOCKUP =
  "A mock-up: question it, never copy it. It shows an idea; the Grill and the Spec decide what is built, and Build writes it in the app's own code with tests.";

/**
 * `PROTOTYPE.md` in a run's reference folder: the link line, each change in words with its
 * target, each mock's route and file, each screenshot's words, and that it is a mock-up. One in
 * code (make-card's) names its diff instead of changes.
 */
export const prototypeReadme = (meta: OrgPrototypeVersion): string => {
  const changes = [...meta.changes, ...meta.mocks].sort((a, b) => a.n - b.n);
  const code = meta.code;

  return [
    `# Prototype v${meta.version} of AB#${meta.card}`,
    '',
    prototypeLinkLine(meta),
    '',
    code === null
      ? `An older prototype: changes injected into the app at ${short(meta.commit)} on ${meta.branch} (CSS, JS) and API answers it mocked.`
      : `A prototype in throwaway code on ${code.branch}, against ${meta.branch} at ${short(meta.commit)}: \`${code.diff}\` is its diff.`,
    '',
    MOCKUP,
    ...(changes.length === 0
      ? []
      : [
          '',
          '## Changes',
          '',
          ...changes.map((c) =>
            'route' in c
              ? `${c.n}. Mock ${c.route}: ${c.what} (\`${c.file}\`; a data question: does the real API answer this?)`
              : `${c.n}. ${c.kind === 'css' ? 'CSS' : 'JS'}: ${c.what}${c.target === null ? '' : ` (on \`${c.target}\`)`} (\`${c.file}\`)`,
          ),
        ]),
    ...(meta.screenshots.length === 0
      ? []
      : [
          '',
          '## Screenshots',
          '',
          ...meta.screenshots.map((s) => `${s.n}. ${s.what} (\`${s.file}\`)`),
        ]),
    '',
  ].join('\n');
};

/**
 * What a Factory run's launch prompt adds when its card has a prototype in the org store (ADR
 * 0023): a question, not a spec. Spec runs as for any card; every stage reads the reference.
 */
export const referencePrompt = (r: { meta: OrgPrototypeVersion; dir: string }): string => {
  const m = r.meta;
  const files =
    m.code === null
      ? [
          "`meta.json` (the commit, each change's words and target)",
          ...(m.changes.length === 0 ? [] : ['`changes/` (its injected CSS and JS)']),
          ...(m.mocks.length === 0 ? [] : ['`mocks/` (the API answers it mocked)']),
        ]
      : [`\`${m.code.diff}\` (throwaway code against ${m.branch})`];
  const screenshots =
    m.screenshots.length === 0
      ? []
      : ["`screenshots/` (what it looked like: Verify's After is compared with them)"];

  return [
    '## Prototype (a question, not a spec)',
    '',
    `${prototypeLinkLine(m)} is this card's reference, in ${r.dir}: \`${REFERENCE_README}\` first, then ${[...files, ...screenshots].join(', ')}.`,
    '',
    `${m.code === null ? 'An older prototype of injected changes shows the idea' : 'A prototype shows the idea in throwaway code'}. Spec is not skipped: decide with a spec and name the prototype in the decision; grill what it leaves open (each mock is a data question; errors, empty states and other screens it does not show); the spec gets a \`## Prototype\` section. Build reads it for intent and shape only and writes the real thing in the app's own code, with tests: ${m.code === null ? 'never paste its CSS, JS or mocks' : 'never paste its diff'}.`,
  ].join('\n');
};
