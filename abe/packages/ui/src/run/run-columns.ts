/**
 * The focus pane's two columns (design C, every step the same way): what the step read on the left,
 * what it made on the right, and its state above them (the loop it sent the run back by, what it
 * was sent back with). One function per kind of step: the spec (the card, its sources and answers
 * → the spec as a document), to-tickets (the spec's lines → the tickets by wave, each with its
 * data and the spec lines it comes from), build (the card and tickets → one lane per writer, the
 * milestones, the checks it ran itself), checks (abe.yaml's checks and the env → each result), review
 * (the diff, the spec, the round → the findings, fixed or open per build round), verify (the
 * criteria, the pack, the diff → the kit's shots and recordings), playbook (the judge's call, the
 * diff → its steps), pr (the branch, commits and notes → the ladder, the pull request, its body),
 * reproduce (the repro steps → Before's steps, shots and recording), investigate and a report (the
 * question → the report, the spike's commits). Facts a run does not keep (an older serve) say so,
 * dim. Pure: the record in, the columns out.
 */
import type {
  BuildLane,
  ChecksKept,
  CheckResult,
  Judgement,
  MadeCommit,
  MadeTicket,
  RunRecordData,
  RunRecordStep,
  ReviewRound,
  StepMade,
  TrackedFinding,
  VerifyHtml,
  VerifyKitPart,
  VerifyShot,
  VerifyWhere,
} from '@abe/core';
import type { RunFlowStep } from '@abe/core/run-flow';
import { screenClock } from '@abe/core/when';
import type { Hue } from '../runtime/components';
import { timeIn } from '../board/flow';
import type {
  RunBlock,
  RunColumn,
  RunFocus,
  RunKitFeature,
  RunLaneCard,
  RunPart,
} from './run-components';

type Mark = { glyph: string; hue: Hue };
type Word = { text: string; hue: Hue };
type Kit = Extract<RunPart, { kind: 'kit' }>['features'];
type KitPart = RunKitFeature['parts'][number];

/** A step as the pane shows it, with what the screen worked out around it. */
export type ColumnsStep = {
  r: RunRecordData;
  x: RunRecordStep;
  flow: RunFlowStep | undefined;
  /** Its workflow name (`build`, `to-tickets`). */
  name: string;
  /** Its round of its workflow step. */
  round: { n: number; of: number };
  /** The step that sent the run back to it, when one did. */
  sender: { x: RunRecordStep; name: string; round: { n: number; of: number } } | undefined;
  /** The step after it in time: where a loop it fired went. */
  next: string | undefined;
  now: string | undefined;
  /** Diffs shown: `<step>:<n>`; tickets open: `<step>:<id>`; recordings paused (their ids). */
  open: readonly string[];
  tickets: readonly string[];
  paused: readonly string[];
};

export type Columns = { read: RunColumn; made: RunColumn };

// ── Parts ──────────────────────────────────────────────────────────────────────────────────

const GOOD: Mark = { glyph: '✓', hue: 'good' };
const BAD: Mark = { glyph: '✗', hue: 'bad' };
const RUNS: Mark = { glyph: '●', hue: 'warn' };
const TODO: Mark = { glyph: '○', hue: 'dim' };
const DASH: Mark = { glyph: '–', hue: 'dim' };

const CRITERION: Readonly<Record<string, Mark>> = {
  todo: TODO,
  checking: RUNS,
  pass: GOOD,
  fail: BAD,
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const said = (s: string | null | undefined): s is string =>
  s !== null && s !== undefined && s !== '';

/** `41 s`, `1 m 52 s`. */
export const secondsOf = (ms: number): string => {
  const s = Math.round(ms / 1000);

  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m${s % 60 === 0 ? '' : ` ${s % 60} s`}`;
};

const rb = (title: string, parts: RunPart[]): RunBlock => ({ title, boxed: false, parts });

const mb = (title: string, parts: RunPart[], verdict?: Word): RunBlock => ({
  title,
  boxed: true,
  parts,
  ...(verdict === undefined ? {} : { verdict }),
});

const text = (t: string, tone: 'plain' | 'dim' | 'quote' = 'plain'): RunPart => ({
  kind: 'text',
  text: t,
  tone,
});

type Row = { text: string; note?: string; mark?: Mark | undefined };

const list = (rows: readonly Row[], numbered = false): RunPart => ({
  kind: 'list',
  numbered,
  rows: rows.map((r) => ({
    text: r.text,
    note: r.note ?? '',
    ...(r.mark === undefined ? {} : { mark: r.mark }),
  })),
});

const facts = (rows: readonly (readonly [string, string])[]): RunPart => ({
  kind: 'facts',
  rows: rows.map(([label, value]) => ({ label, value })),
});

const commitsPart = (rows: readonly MadeCommit[], note: (c: MadeCommit) => string): RunPart => ({
  kind: 'commits',
  rows: rows.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject, note: note(c) })),
});

const col = (note: string, blocks: readonly (RunBlock | undefined)[]): RunColumn => ({
  note,
  blocks: blocks.filter((b): b is RunBlock => b !== undefined && b.parts.length > 0),
});

/** `gets card · spec · diff`: what a fresh step's subagent starts with. */
const getsOf = (s: ColumnsStep, extra: readonly string[] = []): string => {
  const fresh =
    s.flow !== undefined &&
    (s.flow.fresh === 'always' || (s.flow.fresh === 'loop' && s.sender !== undefined));

  if (!fresh) return '';
  const gets = [
    'card',
    ...(s.r.spec === null ? [] : ['spec']),
    ...(s.x.stage === 'build' && s.sender === undefined ? [] : ['diff']),
    ...(s.sender === undefined ? [] : ['findings']),
    ...extra,
  ];

  return ` · gets ${[...new Set(gets)].join(' · ')}`;
};

const within = <T extends { at: string }>(
  list: readonly T[],
  x: Pick<RunRecordStep, 'at' | 'endedAt'>,
): T[] =>
  list.filter(
    (y) =>
      Date.parse(y.at) >= Date.parse(x.at) &&
      (x.endedAt === null || Date.parse(y.at) <= Date.parse(x.endedAt) + 5_000),
  );

// ── The spec's lines ───────────────────────────────────────────────────────────────────────

const HEADING = /^#{1,6}\s+/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;

/** The items (else the paragraphs) under the spec's heading matching `name`. */
export const specLines = (body: string, name: RegExp): string[] => {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex(
    (l) => HEADING.test(l.trim()) && name.test(l.replace(HEADING, '').trim()),
  );

  if (at === -1) return [];
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => HEADING.test(l.trim()));
  const section = end === -1 ? rest : rest.slice(0, end);
  const items: string[] = [];

  for (const l of section) {
    const m = ITEM.exec(l);

    if (m !== null) items.push((m[1] ?? '').trim());
    else if (l.trim() !== '' && /^\s+/.test(l) && items.length > 0)
      items[items.length - 1] = `${items.at(-1) ?? ''} ${l.trim()}`;
  }
  if (items.length > 0) return items;

  return section
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p !== '');
};

const STORIES = /^user stories$/i;
const DECISIONS = /^implementation decisions$/i;
const CRITERIA = /^acceptance criteria$/i;

/** Its first sentence. */
const sentence = (t: string) => {
  const at = t.search(/[.!?](\s|$)/);

  return at === -1 ? t : t.slice(0, at + 1);
};

/** `7 decisions · 5 criteria`, else its sections' headings (`Why · What · Out of scope`). */
const specWords = (body: string): string => {
  const counts = [
    [specLines(body, DECISIONS).length, 'decision', 'decisions'],
    [specLines(body, CRITERIA).length, 'criterion', 'criteria'],
  ] as const;
  const said = counts.filter(([n]) => n > 0).map(([n, one, many]) => plural(n, one, many));

  if (counts[0][0] > 0) return said.join(' · ');
  const heads = body
    .split(/\r?\n/)
    .filter((l) => /^#{2,3}\s/.test(l.trim()))
    .map((l) => l.replace(HEADING, '').trim());

  return heads.length === 0 ? said.join(' · ') : heads.join(' · ');
};

/** The sources the spec's decisions cite: `Found in <citation>: …`. */
const citationsOf = (body: string): string[] => [
  ...new Set(
    specLines(body, DECISIONS).flatMap((d) => {
      const m = /found in ([^:]+):/i.exec(d);

      return m === null ? [] : [(m[1] ?? '').trim()];
    }),
  ),
];

/** `Story 1`, `Criterion 2`, `Decision 4: links expire after 15 minutes`. */
const fromLabel = (body: string, line: string): string => {
  const [kind = '', n = ''] = line.split('-');
  const i = Number(n) - 1;

  if (kind === 'story') return `Story ${n}`;
  if (kind === 'criterion') return `Criterion ${n}`;
  const d = specLines(body, DECISIONS)[i];

  return d === undefined ? `Decision ${n}` : `Decision ${n}: ${sentence(d)}`;
};

// ── Shared reads ───────────────────────────────────────────────────────────────────────────

const cardRef = (r: RunRecordData) =>
  [`AB#${r.card}`, (r.cardDetail?.type ?? r.type ?? '').toLowerCase(), r.cardDetail?.state ?? '']
    .filter((w) => w !== '')
    .join(' · ');

const cardPart = (r: RunRecordData, words = true): RunPart => ({
  kind: 'card',
  ref: cardRef(r),
  title: r.title,
  text: words ? cut(r.cardDetail?.text.trim() ?? '', 700) : '',
});

const cardCriteria = (r: RunRecordData): RunBlock | undefined => {
  const lines = r.cardDetail?.criteria ?? [];

  return lines.length === 0
    ? undefined
    : rb('Acceptance criteria on the card', [
        list(
          lines.map((t) => ({ text: t })),
          true,
        ),
      ]);
};

const specRef = (r: RunRecordData): string => {
  const s = r.spec;

  if (s === null) return 'Spec';
  if (s.ref !== null) return `Spec ${s.ref.slice(s.ref.lastIndexOf('#'))}`;

  return s.path === undefined ? 'Spec · the run’s report' : `Spec · ${s.path}`;
};

const answersPart = (s: ColumnsStep, calls: readonly Judgement[] = []): RunPart => ({
  kind: 'qa',
  rows: [
    ...s.x.answers.map((a) => ({
      q: a.question,
      a: a.answer,
      by: `· ${screenClock(a.at, s.now)}`,
    })),
    ...calls.map((j) => ({
      q: j.question,
      a: `${j.answer ? 'Yes' : 'No'}: ${j.reason}`,
      by: `· judge ${screenClock(j.at, s.now)}`,
    })),
  ],
});

/** The judges' calls in a step's time (a loop's, its done_when's, a gate's that let it run). */
const callsOf = (s: ColumnsStep): Judgement[] =>
  s.flow === undefined
    ? []
    : s.r.run.judgements.filter(
        (j) =>
          j.step === s.flow?.name &&
          Date.parse(j.at) >= Date.parse(s.x.at) - 60_000 &&
          (s.x.endedAt === null || Date.parse(j.at) <= Date.parse(s.x.endedAt) + 60_000),
      );

const qaBlock = (s: ColumnsStep, title = 'Asked'): RunBlock | undefined => {
  const qa = answersPart(s, callsOf(s));

  return qa.kind === 'qa' && qa.rows.length > 0
    ? rb(`${title} · ${qa.rows.length}`, [qa])
    : undefined;
};

const decisionsBlock = (x: RunRecordStep): RunBlock | undefined =>
  x.decisions.length === 0
    ? undefined
    : rb(x.decisions.length === 1 ? 'Decision it took' : 'Decisions it took', [
        { kind: 'decisions', rows: x.decisions },
      ]);

const DIFF_LINES = 40;

/** The run's own `.scratch/`: never in the pull request. */
export const inScratch = (path: string): boolean =>
  path.startsWith('.scratch/') || path.includes('/.scratch/');

const filesBlock = (s: ColumnsStep, title = 'Files changed'): RunBlock | undefined => {
  const rows = s.x.files
    .map((f, n) => ({ f, n }))
    .filter(({ f }) => !inScratch(f.path))
    .map(({ f, n }) => ({
      id: `run:file:${s.x.id}:${n}`,
      path: f.path,
      added: f.added,
      removed: f.removed,
      ...(s.open.includes(`${s.x.id}:${n}`)
        ? { lines: f.hunks.flatMap((h) => h.lines).slice(0, DIFF_LINES) }
        : {}),
    }));

  return rows.length === 0 ? undefined : rb(`${title} · ${rows.length}`, [{ kind: 'files', rows }]);
};

/** `12 files · +412 −38`. */
const changedWords = (r: RunRecordData): string | undefined => {
  const c = r.changed;

  return c === null || c.files === 0
    ? undefined
    : `${plural(c.files, 'file')} · +${c.added} −${c.removed}`;
};

/** Whether a commit was made before `at`: its build started by then (one no build names: yes). */
const madeBefore = (r: RunRecordData, c: MadeCommit, at: string): boolean => {
  const build = r.steps.find(
    (x) =>
      x.made?.kind === 'build' &&
      x.made.lanes.some((l) => l.commits.some((y) => y.sha.slice(0, 7) === c.sha.slice(0, 7))),
  );

  return build === undefined || Date.parse(build.at) <= Date.parse(at);
};

/** Which step made a commit: its ticket (`T1`), else its build (`build #2`). */
const commitNote = (r: RunRecordData) => {
  const by = new Map<string, string>();
  const builds = r.steps.filter((x) => x.kind === 'stage' && x.stage === 'build');

  builds.forEach((b, i) => {
    if (b.made?.kind !== 'build') return;
    for (const lane of b.made.lanes)
      for (const c of lane.commits)
        by.set(
          c.sha.slice(0, 7),
          lane.ticket ?? (builds.length > 1 ? `build #${i + 1}` : lane.label || 'build'),
        );
  });

  return (c: MadeCommit) => by.get(c.sha.slice(0, 7)) ?? '';
};

const diffBlock = (
  r: RunRecordData,
  withCommits: boolean,
  before?: string,
): RunBlock | undefined => {
  const changed = changedWords(r);
  const commits = (r.commits ?? []).filter((c) => before === undefined || madeBefore(r, c, before));
  const parts: RunPart[] = [
    ...(changed === undefined ? [] : [text(changed)]),
    ...(withCommits && commits.length > 0 ? [commitsPart(commits, commitNote(r))] : []),
  ];

  return parts.length === 0 ? undefined : rb('Diff since the merge base', parts);
};

/** Its Read side when a fact it should have is not kept: an older run, said dim. */
const notKept = (what: string): RunPart =>
  text(`${what} not kept: a run from before Abe kept it.`, 'dim');

// ── Kit and proof ──────────────────────────────────────────────────────────────────────────

const KIT_MARK = {
  pass: { mark: GOOD, verdict: 'Pass' },
  fail: { mark: BAD, verdict: 'Fail' },
  'not-driven': { mark: TODO, verdict: 'Not driven' },
};

/**
 * A kept HTML report as the kit's features, its Evidence under the run's `.scratch/<card>/`. A
 * recording with a GIF plays it in place until paused; one without, or a click on it, opens in the
 * local player. A shot opens full size; its page, its URL, in the browser.
 */
export const kitOf = (
  r: RunRecordData,
  html: VerifyHtml,
  step: string,
  paused: readonly string[],
): Kit => {
  const scratch = `${r.run.worktree.replace(/\/+$/, '')}/.scratch/${r.card}`;
  const at = (src: string) => `${scratch}/${src}`;
  // `<step>:<feature>:<part>:<n>`: a shot's and its page's clicks
  const where = (w: VerifyWhere, keys: string) => ({
    url: w.url ?? '',
    urlId: `run:url:${keys}`,
    account: w.account ?? '',
  });
  const shot = (v: VerifyShot, keys: string) => ({
    id: `run:shot:${keys}`,
    path: at(v.src),
    alt: v.alt,
    caption: v.caption,
    ...where(v, keys),
  });
  const part = (p: VerifyKitPart, keys: string): KitPart => {
    const id = `run:recording:${keys}`;

    switch (p.kind) {
      case 'pair':
        return {
          kind: 'pair',
          before: shot(p.before, `${keys}:0`),
          after: shot(p.after, `${keys}:1`),
        };
      case 'shot':
        return { kind: 'shot', shot: shot(p.shot, `${keys}:0`) };
      case 'recording': {
        const playing = p.gif !== null && !paused.includes(id);
        const toggle = playing ? '❚❚ Pause' : '▶ Play';

        return {
          kind: 'recording',
          id,
          gif: p.gif === null ? '' : at(p.gif),
          still: p.poster === null ? '' : at(p.poster),
          path: at(p.src),
          playing,
          control: p.gif === null ? '▶ Open in player' : toggle,
          videoId: `run:shot:${keys}:0`,
          openVideo: p.gif !== null && p.src !== p.gif,
          caption: p.caption,
          ...where(p, `${keys}:0`),
        };
      }
      case 'judged':
        return { kind: 'judged', head: 'How it was judged', text: p.text };
      case 'not-driven':
        return { kind: 'not-driven', head: 'Not driven', text: p.text };
      case 'transcript':
        return {
          kind: 'transcript',
          path: at(p.src),
          caption: p.caption,
          lines: p.text === '' ? [] : p.text.replace(/\n$/, '').split('\n'),
        };
    }
  };

  return html.features.map((f, fi) => ({
    feature: f.feature,
    title: f.title,
    ...KIT_MARK[f.verdict],
    file: `features/${f.feature}.md`,
    env: f.env ?? '',
    parts: f.parts.map((p, pi) => part(p, `${step}:${fi}:${pi}`)),
  }));
};

/** What serve stripped from the agent's HTML, said once. */
const strippedWords = (stripped: readonly string[]): string =>
  stripped.length === 0
    ? ''
    : `Stripped from the agent’s HTML: ${stripped.slice(0, 3).join('; ')}${stripped.length > 3 ? `; ${stripped.length - 3} more` : ''}`;

/** macOS's `/tmp` and `/var` are `/private`'s: a path realpath'd and one not are one place. */
const unprivate = (path: string) => path.replace(/^\/private(?=\/(?:tmp|var)\/)/, '');

/** A path the run names (a report), as shown: relative to the card's worktree when under it. */
const shownPath = (r: RunRecordData, path: string): string => {
  const base = `${unprivate(r.run.worktree).replace(/\/+$/, '')}/`;
  const at = unprivate(path);

  return at.startsWith(base) ? at.slice(base.length) : path;
};

/** Evidence paths absolute, so a screenshot is drawn. */
const evidenceAt = (r: RunRecordData, e: { kind: 'output' | 'screenshot'; text: string }) =>
  e.kind === 'screenshot' && !e.text.startsWith('/')
    ? { kind: e.kind, text: `${r.run.worktree.replace(/\/+$/, '')}/.scratch/${r.card}/${e.text}` }
    : e;

// ── The state block ────────────────────────────────────────────────────────────────────────

/** `↩ back to build · loop review → build · review.findings > 0 · round 1 of max 2 · carries …`. */
export const loopOf = (s: ColumnsStep): RunFocus['props']['loop'] => {
  if (s.x.mark !== 'failed' || s.next === undefined) return undefined;
  const loop = s.r.run.workflow?.loops?.find((l) => l.from === s.name && l.to === s.next);

  return {
    head: `↩ back to ${s.next}`,
    words:
      loop === undefined
        ? [`round ${s.round.n}`]
        : [
            `loop ${loop.from} → ${loop.to}`,
            loop.when,
            `round ${s.round.n} of max ${loop.max}`,
            ...(loop.carries.length === 0 ? [] : [`carries ${loop.carries.join(', ')}`]),
          ],
  };
};

const findingLine = (f: TrackedFinding, n: number) =>
  `${n}. ${f.file}${f.line === null ? '' : `:${f.line}`} · ${f.text}${f.fix === '' ? '' : ` → ${f.fix}`}`;

/** What the step that sent it back carried: its findings, its red checks, else its words. */
export const carriedOf = (s: ColumnsStep): RunFocus['props']['carried'] => {
  const from = s.sender;

  if (from === undefined) return undefined;
  const head = `Sent back with · from ${from.name}${from.round.of > 1 ? ` · round ${from.round.n}` : ''}`;
  const live = s.r.run.context?.carried;

  if (
    s.x.endedAt === null &&
    live !== null &&
    live !== undefined &&
    live.items.length > 0 &&
    from.x.stage !== 'review' &&
    from.x.stage !== 'checks'
  )
    return { head, items: live.items };
  if (from.x.stage === 'review') {
    const round = within(s.r.reviews, from.x).at(-1);
    const must = round?.items.filter((f) => f.severity === 'must') ?? [];

    if (must.length > 0) return { head, items: must.map((f, i) => findingLine(f, i + 1)) };
  }
  if (from.x.stage === 'checks') {
    const kept = within(s.r.run.checks ?? [], from.x)
      .filter((k) => k.cause === 'checks')
      .at(-1);
    const red = kept?.results.filter((c) => c.status === 'red') ?? [];

    if (red.length > 0)
      return {
        head,
        items: red.map((c) => {
          const line =
            c.output
              .trim()
              .split('\n')
              .find((l) => /error|fail|✗/i.test(l)) ??
            c.output.trim().split('\n').at(-1) ??
            '';

          return `${c.name}: ${line.trim()}`;
        }),
      };
  }

  return { head, items: [from.x.summary ?? from.x.headline] };
};

// ── Each kind of step ──────────────────────────────────────────────────────────────────────

/** Where the spec the Made side shows is: its issue, its file on the card branch, the report. */
const specWhere = (r: RunRecordData): string => {
  const spec = r.spec;

  if (spec === null) return 'no spec read';
  if (spec.ref !== null)
    return `issue ${spec.ref.slice(spec.ref.lastIndexOf('#'))}, linked from the card`;

  return spec.path === undefined ? 'the run’s report' : `${spec.path} on the card branch`;
};

const specColumns = (s: ColumnsStep): Columns => {
  const { r } = s;
  const spec = r.spec;
  const sources = spec === null ? [] : citationsOf(spec.body);
  const where = specWhere(r);

  return {
    read: col('the card, the sources, the answers', [
      rb('', [cardPart(r)]),
      cardCriteria(r),
      sources.length === 0 ? undefined : rb('Found in', [list(sources.map((t) => ({ text: t })))]),
      qaBlock(s),
      decisionsBlock(s.x),
    ]),
    made: col(where, [
      spec === null
        ? rb('Spec', [text('No spec to show: its issue and its file could not be read.', 'dim')])
        : rb('', [
            {
              kind: 'doc',
              eyebrow: [specRef(r), `from AB#${r.card}`].join(' · '),
              title: spec.title,
              meta: [spec.url ?? '', 'by create-specification'].filter((w) => w !== '').join(' · '),
              markdown: spec.body,
            },
          ]),
    ]),
  };
};

const specLinesBlocks = (r: RunRecordData): RunBlock[] => {
  const body = r.spec?.body ?? '';
  const stories = specLines(body, STORIES);
  const decisions = specLines(body, DECISIONS);
  const criteria = specLines(body, CRITERIA);

  return [
    ...(stories.length === 0
      ? []
      : [
          rb('User stories', [
            list(
              stories.map((t) => ({ text: t })),
              true,
            ),
          ]),
        ]),
    ...(decisions.length === 0
      ? []
      : [
          rb('Implementation decisions', [
            list(
              decisions.map((t) => ({ text: sentence(t) })),
              true,
            ),
          ]),
        ]),
    ...(criteria.length === 0
      ? []
      : [
          rb('Acceptance criteria', [
            list(
              criteria.map((t) => ({ text: t })),
              true,
            ),
          ]),
        ]),
  ];
};

/** The tickets to-tickets made in this run: its last made tickets. */
const ticketsOf = (r: RunRecordData) =>
  r.steps.flatMap((x) => (x.made?.kind === 'tickets' ? [x.made] : [])).at(-1);

type TicketsMade = Extract<StepMade, { kind: 'tickets' }>;

const ticketCard = (s: ColumnsStep, made: TicketsMade, t: MadeTicket): RunLaneCard => {
  const by = (id: string) => made.tickets.find((y) => y.id === id);
  const body = s.r.spec?.body ?? '';
  const ms = made.milestones.find((m) => m.n === t.milestone);

  return {
    id: `run:ticket:${s.x.id}:${t.id}`,
    ref: [t.ref, t.id].filter(said).join(' · '),
    title: t.title,
    time: t.big ? 'Big' : '',
    summary: t.what,
    tags: [
      t.blockedBy.length === 0
        ? { text: 'starts now', hue: 'good' }
        : { text: `after ${t.blockedBy.join(' and ')}`, hue: 'dim' },
      ...t.area.map((a) => ({ text: a, hue: 'accent' as const })),
    ],
    rows: [
      ...(made.parent === null
        ? []
        : [
            {
              label: 'Parent',
              value: `${made.parent}${s.r.spec === null ? '' : ` · ${s.r.spec.title}`}`,
            },
          ]),
      ...(t.what === '' ? [] : [{ label: 'What to build', value: t.what }]),
      ...(t.area.length === 0 ? [] : [{ label: 'Area', value: t.area.join(', ') }]),
      ...t.criteria.map((c, i) => ({
        label: i === 0 ? 'Acceptance criteria' : '',
        value: `☐ ${c}`,
      })),
      {
        label: 'Blocked by',
        value:
          t.blockedBy.length === 0
            ? 'None (can start immediately)'
            : t.blockedBy
                .map((b) => {
                  const y = by(b);

                  return y === undefined ? b : [y.ref, b, y.title].filter(said).join(' · ');
                })
                .join('; '),
      },
      ...(t.milestone === null
        ? []
        : [
            {
              label: 'Milestone',
              value: `Milestone ${t.milestone}${ms === undefined ? '' : ` · ${ms.text}`}${t.big ? ' · Big' : ''}`,
            },
          ]),
    ],
    chips: t.from.map((f) => fromLabel(body, f)),
    open: s.tickets.includes(`${s.x.id}:${t.id}`),
  };
};

/** `starts now`, `3 side by side`, `1 ticket`. */
const waveNote = (wave: number, n: number): string => {
  if (wave === 1) return 'starts now';

  return n === 1 ? '1 ticket' : `${n} side by side`;
};

const ticketLanes = (s: ColumnsStep, made: TicketsMade): RunPart => {
  const waves = [...new Set(made.tickets.map((t) => t.wave))].sort((a, b) => a - b);
  const lastWaveOf = (n: number) =>
    Math.max(0, ...made.tickets.filter((t) => t.milestone === n).map((t) => t.wave));

  return {
    kind: 'lanes',
    lanes: waves.map((w) => {
      const ts = made.tickets.filter((t) => t.wave === w);
      const ms = made.milestones.find((m) => lastWaveOf(m.n) === w);

      return {
        label: `Wave ${w}`,
        note: waveNote(w, ts.length),
        cards: ts.map((t) => ticketCard(s, made, t)),
        ...(ms === undefined
          ? {}
          : {
              milestone: { label: `◆ Milestone ${ms.n}`, text: `${ms.text} Heavy tests run here.` },
            }),
      };
    }),
  };
};

const ticketsColumns = (s: ColumnsStep): Columns => {
  const { r } = s;
  const made = s.x.made?.kind === 'tickets' ? s.x.made : undefined;
  const report = s.x.report === null ? '' : shownPath(r, s.x.report);
  const where =
    made === undefined
      ? ''
      : { issue: 'sub-issues', card: 'child cards', file: 'files' }[made.where];
  const spec = r.spec;

  return {
    read: col('the spec and the code its modules are in', [
      spec === null
        ? rb('', [cardPart(r, false)])
        : rb('', [{ kind: 'card', ref: `${specRef(r)} · issue`, title: spec.title, text: '' }]),
      ...specLinesBlocks(r),
    ]),
    made: col(
      made === undefined
        ? report
        : `${plural(made.tickets.length, 'ticket')}${made.parent === null ? '' : `, ${where} of ${made.parent}`}, by wave · open a ticket`,
      [
        made === undefined
          ? rb('Tickets', [notKept('Its tickets were')])
          : rb('', [ticketLanes(s, made)]),
      ],
    ),
  };
};

const testsWords = (tests: BuildLane['tests']) =>
  tests
    .map((t) => `${t.ok ? '✓' : '✗'} ${t.name}${t.count === null ? '' : ` · ${t.count}`}`)
    .join(' · ');

/** Merged; still running; or not merged. */
const mergedMark = (lane: BuildLane, live: boolean): Mark => {
  if (lane.merged) return GOOD;

  return live ? RUNS : BAD;
};

const writerCard = (lane: BuildLane, live: boolean): RunLaneCard => ({
  ref: [lane.ticket, lane.ref, lane.label].filter(said).join(' · '),
  title: lane.title,
  time: lane.tookMs === null ? '' : `${Math.max(1, Math.round(lane.tookMs / 60_000))} min`,
  summary: '',
  tags: [],
  rows: [
    {
      label: 'writer',
      value: `${lane.writer}${lane.worktree === null ? '' : ` · worktree ${lane.worktree}`}`,
    },
    ...(lane.commits.length === 0
      ? [{ label: 'commits', value: live ? 'none yet' : 'none' }]
      : lane.commits.map((c, i) => ({
          label: i === 0 ? 'commits' : '',
          value: `${c.sha.slice(0, 7)} ${c.subject}`,
        }))),
    ...(lane.files === null
      ? []
      : [
          {
            label: 'files',
            value: `${lane.files.count} · +${lane.files.added} −${lane.files.removed}${lane.areas.length === 0 ? '' : ` · ${lane.areas.join(', ')}`}`,
          },
        ]),
    ...(lane.tests.length === 0
      ? []
      : [
          {
            label: 'tests',
            value: testsWords(lane.tests),
          },
        ]),
    {
      label: 'merged',
      value: lane.merged ? 'into the card branch' : 'not merged',
      mark: mergedMark(lane, live),
    },
  ],
  chips: [],
  open: true,
});

const buildLanes = (
  made: Extract<StepMade, { kind: 'build' }>,
  fixes: boolean,
  live: boolean,
): RunPart => {
  const waves = [...new Set(made.lanes.map((l) => l.wave))].sort((a, b) => a - b);

  return {
    kind: 'lanes',
    lanes: waves.map((w) => {
      const lanes = made.lanes.filter((l) => l.wave === w);
      const ms = made.milestones.find((m) => m.afterWave === w);
      const tests = ms === undefined ? '' : testsWords(ms.tests);
      const fix = lanes.length === 1 ? 'Fix' : 'Fixes';

      return {
        label: fixes ? fix : `Wave ${w}`,
        note: lanes.length === 1 ? '1 writer' : `${lanes.length} writers at once`,
        cards: lanes.map((l) => writerCard(l, live)),
        ...(ms === undefined
          ? {}
          : {
              milestone: {
                label: `◆ Milestone ${ms.n}`,
                text: [ms.text, tests, ms.looked === null ? '' : `app looked at: ${ms.looked}`]
                  .filter((p) => p !== '')
                  .join(' · '),
              },
            }),
      };
    }),
  };
};

const STATUS_MARK: Readonly<Record<CheckResult['status'], Mark>> = {
  green: GOOD,
  red: BAD,
  'not-configured': DASH,
};

const checksLine = (k: ChecksKept): string =>
  k.results.map((c) => `${c.name} ${STATUS_MARK[c.status].glyph}`).join(' · ');

const VERDICT: Readonly<Record<ChecksKept['verdict'], Word>> = {
  green: { text: '✓ green', hue: 'good' },
  red: { text: '✗ red', hue: 'warn' },
  none: { text: '– nothing run', hue: 'dim' },
};

const buildColumns = (s: ColumnsStep): Columns => {
  const { r, x } = s;
  const tickets = ticketsOf(r);
  const made = x.made?.kind === 'build' ? x.made : undefined;
  const live = x.endedAt === null;
  const own = within(r.run.checks ?? [], x)
    .filter((k) => k.cause === 'on-demand')
    .at(-1);
  const commits = made?.lanes.flatMap((l) => l.commits).length ?? 0;
  const files = x.files.filter((f) => !inScratch(f.path));
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const lanes = made?.lanes.length ?? 0;
  const waves = new Set(made?.lanes.map((l) => l.wave) ?? []).size;
  const madeNote = [
    ...(made === undefined
      ? []
      : [
          `${plural(lanes, 'writer')}${waves > 1 ? ` in ${waves} waves` : ''}`,
          plural(commits, 'commit'),
        ]),
    ...(files.length === 0 ? [] : [`${plural(files.length, 'file')} · +${added} −${removed}`]),
  ];
  const fromReview = s.sender?.x.stage === 'review';
  const fromChecks = s.sender?.x.stage === 'checks';
  const report = (): RunBlock | undefined => {
    if (s.sender === undefined) return undefined;
    if (fromReview) {
      const round = within(r.reviews, s.sender.x).at(-1);

      return rb('Review report', [
        list([
          {
            text:
              round?.report === null || round?.report === undefined
                ? `.scratch/${r.card}/review.md`
                : shownPath(r, round.report),
            note: `Findings: ${round?.findings ?? '?'}${round?.risk === null || round?.risk === undefined ? '' : ` · Risk: ${round.risk.risky ? 'risky' : 'not risky'} · ${round.risk.why}`}`,
          },
        ]),
      ]);
    }
    if (fromChecks) {
      const kept = within(r.run.checks ?? [], s.sender.x).at(-1);
      const red = kept?.results.filter((c) => c.status === 'red').length ?? 0;

      return rb('Checks report', [
        list([
          {
            text: kept?.file ?? `.scratch/${r.card}/checks.md`,
            note: red === 0 ? '' : `${plural(red, 'check')} red`,
          },
        ]),
      ]);
    }

    return undefined;
  };

  return {
    read: col(
      `the card${r.spec === null ? '' : ', the spec'}${tickets === undefined ? '' : ', the tickets'}${getsOf(s, tickets === undefined ? [] : ['tickets'])}`,
      [
        report(),
        s.sender === undefined
          ? undefined
          : rb('Fresh context', [
              text(
                `fresh: loop · the writer starts without the build’s reasoning; it gets the card${r.spec === null ? '' : ', the spec'}, the diff and the findings.`,
                'dim',
              ),
            ]),
        rb('', [cardPart(r, r.spec === null && tickets === undefined)]),
        tickets === undefined
          ? undefined
          : rb(`Tickets · .scratch/${r.card}/tickets.md`, [
              list(
                tickets.tickets.map((t) => ({
                  text: `${t.id}${t.ref === null ? '' : ` ${t.ref}`} · ${t.title}`,
                  note: [
                    `wave ${t.wave}`,
                    ...(t.milestone === null ? [] : [`M${t.milestone}`]),
                    ...(t.blockedBy.length === 0 ? [] : [`after ${t.blockedBy.join(', ')}`]),
                    ...t.area,
                  ].join(' · '),
                })),
              ),
            ]),
        r.spec === null && tickets === undefined ? cardCriteria(r) : undefined,
        r.spec === null && tickets === undefined && s.sender === undefined
          ? rb('No spec, no tickets', [
              text(
                'This workflow builds straight away: the card is the ticket. The writer cuts it in slices itself.',
                'dim',
              ),
            ])
          : undefined,
        r.spec === null || tickets !== undefined
          ? undefined
          : rb(specRef(r), [list([{ text: r.spec.title, note: specWords(r.spec.body) }])]),
        decisionsBlock(x),
      ],
    ),
    made: col(
      live
        ? `so far${madeNote.length === 0 ? '' : ` · ${madeNote.join(' · ')}`}`
        : madeNote.join(' · '),
      [
        made === undefined
          ? rb('', [
              text(
                live
                  ? 'Its writers’ lanes come when the step ends.'
                  : 'Its writers’ lanes not kept: a run from before Abe kept them.',
                'dim',
              ),
            ])
          : rb('', [buildLanes(made, s.sender !== undefined, live)]),
        own === undefined
          ? undefined
          : mb(
              'Checks run itself',
              [text(`abe factory checks ${r.card}: ${checksLine(own)} · ${own.file}`, 'dim')],
              VERDICT[own.verdict],
            ),
        filesBlock(s, live ? 'Files so far' : 'Files changed'),
      ],
    ),
  };
};

/** A check's last line worth saying under it (`61 passed, 0 failed`). */
const moreOf = (c: CheckResult): string => {
  if (c.status === 'red') return 'the tail of what it printed · full output in checks.md';
  if (c.status === 'not-configured') return 'not configured: no Layer gives it a command';
  const last = c.output.trim().split('\n').at(-1)?.trim() ?? '';

  return last.length > 0 && last.length <= 80 && c.kind === 'command' ? last : '';
};

/** `exit 0`, `killed`; nothing for a built-in or one not configured. */
const exitOf = (c: CheckResult): string => {
  if (c.kind === 'built-in' || c.status === 'not-configured') return '';

  return c.exit === null ? 'killed' : `exit ${c.exit}`;
};

const checkRow = (c: CheckResult): Extract<RunPart, { kind: 'checks' }>['rows'][number] => ({
  mark: STATUS_MARK[c.status],
  name: c.name,
  command: c.run ?? (c.kind === 'built-in' ? 'built in · against the merge base' : 'no command'),
  time: secondsOf(c.durationMs),
  exit: exitOf(c),
  output: c.status === 'red' && c.output.trim() !== '' ? c.output.trimEnd().split('\n') : [],
  more: moreOf(c),
  red: c.status === 'red',
});

const checksColumns = (s: ColumnsStep): Columns => {
  const { r, x } = s;
  const kept = within(r.run.checks ?? [], x)
    .filter((k) => k.cause === 'checks')
    .at(-1);

  if (kept === undefined)
    return {
      read: col('abe.yaml’s checks and the env', [
        rb('abe.yaml · checks', [notKept('Its checks were')]),
      ]),
      made: col(x.headline, [
        rb('', [text(x.summary ?? x.headline, 'dim')]),
        rb('', [
          list([{ text: `.scratch/${r.card}/checks.md`, note: 'every result and its output' }]),
        ]),
      ]),
    };
  const red = kept.results.filter((c) => c.status === 'red').length;
  const took = secondsOf(kept.results.reduce((n, c) => n + c.durationMs, 0));
  const env = kept.env;
  // serve keeps no env when no command ran (every check not configured, or built in)
  const ranCommand = kept.results.some((c) => c.kind === 'command' && c.run !== null);

  return {
    read: col('abe.yaml’s checks and the env', [
      rb('abe.yaml · checks', [
        list(
          kept.results.map((c) => ({
            text: `${c.name}${c.kind === 'built-in' ? ' · built in' : ''}`,
            note: c.run ?? (c.kind === 'built-in' ? 'against the merge base' : 'not configured'),
          })),
        ),
      ]),
      rb(
        'Env it ran with',
        ranCommand
          ? [
              text(
                env === null
                  ? 'Not kept: a run from before Abe kept it.'
                  : [
                      env.name === null ? 'no Abe env file' : `the ${env.name} env file`,
                      env.keys.length === 0 ? '' : env.keys.join(' · '),
                    ]
                      .filter((w) => w !== '')
                      .join(' · '),
                env === null ? 'dim' : 'plain',
              ),
              text(
                'Names only, never values · in the card’s worktree · 15 min limit per check',
                'dim',
              ),
            ]
          : [text('None: no check ran a command.', 'dim')],
      ),
    ]),
    made: col(
      `${kept.verdict} · ${red === 0 ? plural(kept.results.length, 'check') : `${red} of ${kept.results.length} failed`} · ${took}`,
      [
        mb(
          'Checks',
          [
            { kind: 'checks', rows: kept.results.map(checkRow) },
            text(`Written to ${kept.file} · the build step reads it when sent back.`, 'dim'),
          ],
          red === 0 ? VERDICT[kept.verdict] : { text: `✗ red · ${red} failed`, hue: 'warn' },
        ),
      ],
    ),
  };
};

const AXIS: Readonly<Record<string, Word>> = {
  standards: { text: 'Standards', hue: 'accent' },
  spec: { text: 'Spec', hue: 'needs-you' },
};

/** The first commit of the build that fixed it (`build #2 · f6b2d09`). */
const fixedWord = (r: RunRecordData, f: TrackedFinding): Word => {
  if (f.state === 'open') return { text: 'open', hue: 'warn' };
  if (f.fixedIn === null) return { text: '✓ fixed', hue: 'good' };
  const build = r.steps.filter((x) => x.kind === 'stage' && x.stage === 'build')[f.fixedIn - 1];
  const sha =
    build?.made?.kind === 'build' ? build.made.lanes.flatMap((l) => l.commits)[0]?.sha : undefined;

  return {
    text: `✓ fixed in build #${f.fixedIn}${sha === undefined ? '' : ` · ${sha.slice(0, 7)}`}`,
    hue: 'good',
  };
};

const findingRows = (r: RunRecordData, list: readonly TrackedFinding[]): RunPart => ({
  kind: 'findings',
  rows: list.map((f) => ({
    axis:
      f.severity === 'noted'
        ? { text: 'Noted', hue: 'dim' }
        : (AXIS[f.axis] ?? { text: f.axis, hue: 'dim' }),
    loc: `${f.file}${f.line === null ? '' : `:${f.line}`}`,
    what: f.text,
    fix: f.fix,
    ...(f.state === null ? {} : { state: fixedWord(r, f) }),
  })),
});

/** A round's findings box: its must findings with their state, or why none are listed. */
const findingsBox = (r: RunRecordData, round: ReviewRound, sentBack: boolean): RunBlock => {
  const must = round.items.filter((f) => f.severity === 'must');
  const verdict = (): Word | undefined => {
    if (sentBack) return { text: '● sent back', hue: 'warn' };

    return round.findings === 0 ? { text: '✓ clean', hue: 'good' } : undefined;
  };
  const parts = (): RunPart[] => {
    if (must.length > 0) return [findingRows(r, must)];
    if (round.findings === 0)
      return [text('Standards: nothing. Spec: nothing missing, wrong or unasked for.', 'dim')];

    return [
      text(
        `Its findings are in its report${round.report === null ? '' : `: ${shownPath(r, round.report)}`}. Not kept one by one: a run from before Abe kept them.`,
        'dim',
      ),
    ];
  };

  return mb(`Findings · ${round.findings}`, parts(), verdict());
};

const reviewColumns = (s: ColumnsStep): Columns => {
  const { r, x } = s;
  const round = within(r.reviews, x).at(-1);
  const spec = r.spec;
  const noted = round?.items.filter((f) => f.severity === 'noted') ?? [];
  const sentBack = x.mark === 'failed';
  const findings = round?.findings ?? 0;
  const earlier = round === undefined ? [] : r.reviews.filter((y) => y.n < round.n);

  return {
    read: col(`the diff, the spec, the standards${getsOf(s)}`, [
      diffBlock(r, true, x.at),
      rb('Spec', [
        list([
          {
            text: `AB#${r.card} · the card`,
            note: spec === null ? 'no spec: the Spec axis reads the card' : '',
          },
          ...(spec === null
            ? []
            : [
                {
                  text: `${specRef(r)} · ${spec.title}`,
                  note: specWords(spec.body),
                },
              ]),
        ]),
      ]),
      rb('Round', [
        earlier.length === 0
          ? text(`Round ${round?.n ?? s.round.n}. No earlier report.`, 'dim')
          : list(
              earlier.map((y) => ({
                text: y.report === null ? `review ${y.n}` : shownPath(r, y.report),
                note: `${plural(y.findings, 'finding')} · the first thing checked: did they come back?`,
              })),
            ),
      ]),
    ]),
    made: col(
      [
        findings === 0 ? 'no findings' : plural(findings, 'finding'),
        ...(noted.length === 0 ? [] : [`${noted.length} noted`]),
        ...(round?.checked.length
          ? [`${round.checked.filter((f) => f.state === 'fixed').length} fixed`]
          : []),
        ...(round?.report === null || round?.report === undefined
          ? []
          : [shownPath(r, round.report)]),
      ].join(' · '),
      [
        round === undefined
          ? rb('', [text(x.summary ?? x.headline, 'dim')])
          : findingsBox(r, round, sentBack),
        round === undefined || round.checked.length === 0
          ? undefined
          : mb(`Earlier findings · ${round.checked.length}`, [findingRows(r, round.checked)]),
        noted.length === 0 ? undefined : mb(`Noted · ${noted.length}`, [findingRows(r, noted)]),
        round === undefined || (round.risk === null && round.regression.length === 0)
          ? undefined
          : mb(round.regression.length > 0 ? 'Risk · regression' : 'Risk', [
              text(
                [
                  round.risk?.risky === false ? 'not risky' : 'risky',
                  ...(round.risk === null || round.risk.why === '' ? [] : [round.risk.why]),
                  ...(round.regression.length === 0
                    ? []
                    : [`regression named: ${round.regression.join(', ')}`]),
                ].join(' · '),
              ),
            ]),
        round === undefined
          ? undefined
          : mb('Recorded', [
              text(
                [
                  `abe factory review --findings ${findings}${round.regression.length === 0 ? '' : ` --regression ${round.regression.join(',')}`}`,
                  ...(round.report === null ? [] : [shownPath(r, round.report)]),
                  ...(s.next === undefined ? [] : [`next step: ${s.next}`]),
                ].join(' · '),
                'dim',
              ),
            ]),
      ],
    ),
  };
};

/** The level a verify step picked: Before+after, After, or none recorded. */
const levelOf = (vs: readonly { phase: string }[]): string => {
  if (vs.some((v) => v.phase === 'before')) return 'Before+after';

  return vs.some((v) => v.phase === 'after') ? 'After' : '';
};

/** The last verify's evidence: the kit's features, else its proof rows and recording. */
const evidenceBlock = (r: RunRecordData, kit: Kit, last: boolean): RunBlock | undefined => {
  if (kit.length > 0) return rb('', [{ kind: 'kit', features: kit }]);
  if (!last || !r.criteria.some((c) => c.how !== null)) return undefined;

  return rb('Proof', [
    {
      kind: 'proof',
      rows: r.criteria.map((c) => ({
        n: c.n,
        mark: CRITERION[c.mark] ?? TODO,
        text: c.text,
        how: [c.how, c.seen].filter(said).join(' → '),
        evidence: c.evidence.map((e) => evidenceAt(r, e)),
        chapter: c.chapter === null ? '' : `▶ ${c.chapter}`,
      })),
      ...(r.recording === null
        ? {}
        : {
            recording: {
              length: `▶ ${r.recording.length ?? ''}`.trim(),
              path: r.recording.path,
              chapters: r.criteria.flatMap((c) => (c.chapter === null ? [] : [String(c.n)])),
            },
          }),
    },
  ]);
};

const verifyColumns = (s: ColumnsStep, last: boolean): Columns => {
  const { r, x } = s;
  const vs = within(r.run.verifications, x);
  const after = vs.findLast((v) => v.phase === 'after');
  const level = levelOf(vs);
  const passed = r.criteria.filter((c) => c.mark === 'pass').length;
  const kit =
    last && r.report !== null && r.report.features.length > 0
      ? kitOf(r, r.report, x.id, s.paused)
      : [];
  const driven = r.features.filter((f) => f.verdict !== 'not-driven').map((f) => f.feature);
  const notDriven = r.features.filter((f) => f.verdict === 'not-driven').map((f) => f.feature);
  const verified = r.run.pr?.body
    ?.split('\n')
    .find((l) => l.trimStart().startsWith('**Verified:**'));

  return {
    read: col('the criteria, the pack, the diff', [
      last && r.criteria.length > 0
        ? rb('Acceptance criteria', [
            {
              kind: 'criteria',
              rows: r.criteria.map((c) => ({
                n: c.n,
                mark: CRITERION[c.mark] ?? TODO,
                text: c.text,
                proof: c.how !== null,
              })),
            },
          ])
        : undefined,
      r.features.length === 0
        ? undefined
        : rb('Verification pack', [
            list([
              {
                text: `Feature map · ${plural(r.features.length, 'feature')}`,
                note: [
                  ...(driven.length === 0 ? [] : [`${driven.join(', ')} · driven`]),
                  ...(notDriven.length === 0 ? [] : [`${notDriven.join(', ')} · not driven`]),
                ].join(' · '),
              },
            ]),
          ]),
      diffBlock(r, false),
      level === ''
        ? undefined
        : rb('Level it picked', [
            text(
              `${level}${r.run.regression.length === 0 ? '.' : `: risky, so regression tests run.`}`,
              'dim',
            ),
          ]),
    ]),
    made: col(
      after === undefined
        ? (x.summary ?? x.headline)
        : `${after.result}${last && r.criteria.length > 0 ? ` · ${passed} of ${r.criteria.length}` : ''}${kit.length > 0 ? ' · evidence per feature' : ''}`,
      [
        after === undefined
          ? undefined
          : rb('', [
              text(
                [`Result: ${after.result}`, ...(r.branch === null ? [] : [r.branch])].join(' · '),
              ),
            ]),
        evidenceBlock(r, kit, last),
        last && r.report !== null && r.report.stripped.length > 0
          ? rb('', [text(strippedWords(r.report.stripped), 'dim')])
          : undefined,
        last && r.run.regression.length > 0
          ? mb('Regression', [list(r.run.regression.map((t) => ({ text: t, mark: GOOD })))], {
              text: `✓ ${r.run.regression.length} of ${r.run.regression.length}`,
              hue: 'good',
            })
          : undefined,
        verified === undefined || !last
          ? undefined
          : mb('For the pull request', [text(verified.replace(/\*\*/g, ''))]),
      ],
    ),
  };
};

const playbookColumns = (s: ColumnsStep): Columns => {
  const { r } = s;
  const gate = r.run.judgements.findLast(
    (j) => j.step === s.flow?.name && j.kind === 'gate' && j.answer,
  );
  const pb = r.run.playbook;
  const yours = pb?.steps.filter((x) => x.by === 'you').length ?? 0;

  return {
    read: col('the diff and the judge’s call · sees diff', [
      gate === undefined
        ? undefined
        : rb('Judge · gate', [
            text(
              `${gate.question}\nYes: ${gate.reason}\njudge · ${screenClock(gate.at, s.now)}`,
              'quote',
            ),
          ]),
      diffBlock(r, false),
    ]),
    made: col(
      pb === null
        ? 'nothing written'
        : `${pb.path} · ${plural(pb.steps.length, 'step')} · ${yours} yours`,
      [
        pb === null
          ? rb('', [text('No Playbook file: the change needs no steps by hand.', 'dim')])
          : mb(
              `${pb.title}: playbook`,
              [
                facts([
                  ...(pb.doneWhen === null ? [] : [['Done when', pb.doneWhen] as const]),
                  ['Path', `${pb.path} · committed with the card’s changes`],
                ]),
                {
                  kind: 'steps',
                  rows: pb.steps.map((x) => ({
                    n: x.n,
                    title: x.title,
                    meta: [
                      x.by === 'you'
                        ? {
                            text: `Who: you${x.theirs === null ? '' : ` · ${x.theirs}`}`,
                            hue: x.theirs === null ? 'needs-you' : 'warn',
                          }
                        : { text: 'Who: Abe', hue: 'accent' },
                      { text: `Where: ${x.where === '' ? '—' : x.where}`, hue: 'dim' },
                      { text: `Runnable: ${x.runnable ? 'yes' : 'no'}`, hue: 'dim' },
                    ],
                    text: [
                      x.check === null || x.check === undefined ? '' : `Check: ${x.check}`,
                      x.undo === null || x.undo === undefined ? '' : `Undo: ${x.undo}`,
                    ]
                      .filter((w) => w !== '')
                      .join(' '),
                    command: x.command ?? '',
                  })),
                },
              ],
              { text: '✓ holds', hue: 'good' },
            ),
      ],
    ),
  };
};

const CHECKS_RUNG: Readonly<Record<string, Mark>> = {
  success: GOOD,
  pending: RUNS,
  failure: BAD,
  none: TODO,
};

const REVIEW_STATE: Readonly<Record<string, string>> = {
  requested: 'requested',
  commented: 'commented',
  approved: 'approved',
  'changes-requested': 'asked for changes',
  dismissed: 'dismissed',
};

const reviewersWords = (rs: readonly { login: string; state: string }[] | undefined): string =>
  rs === undefined || rs.length === 0
    ? 'none yet'
    : rs.map((x) => `${x.login} ${REVIEW_STATE[x.state] ?? x.state}`).join(' · ');

type Pr = NonNullable<RunRecordData['run']['pr']>;
type Rung = { mark: Mark; label: string; note: string; on: boolean };

const prState = (pr: Pr): Word => {
  if (pr.state === 'merged') return { text: '✓ merged', hue: 'good' };
  if (pr.state === 'closed') return { text: '✗ closed', hue: 'bad' };

  return pr.mergeable === 'conflicting'
    ? { text: '◆ needs you', hue: 'needs-you' }
    : { text: '● open', hue: 'good' };
};

const reviewMark = (merged: boolean, on: boolean): Mark => {
  if (merged) return GOOD;

  return on ? { glyph: '●', hue: 'accent' } : TODO;
};

const mergeRung = (pr: Pr, merged: boolean, conflicting: boolean, base: string): Rung => {
  if (merged)
    return {
      mark: GOOD,
      label: 'Merge',
      note: pr.merge === 'auto' ? 'by Abe' : 'by a person',
      on: false,
    };
  if (conflicting)
    return {
      mark: BAD,
      label: 'Merge',
      note: `conflicting with ${base === '' ? 'its base' : base}`,
      on: false,
    };

  return {
    mark: TODO,
    label: 'Merge',
    note: `auto merge ${pr.merge === 'auto' ? 'on' : 'off'}${pr.mergeable === 'mergeable' ? ' · mergeable' : ''}`,
    on: false,
  };
};

const doneRung = (pr: Pr, merged: boolean, done: string): Rung => {
  const note = done === 'merged' ? 'at the merge' : `deployed to ${done}`;

  if (pr.deploy === 'success')
    return { mark: GOOD, label: 'Done', note: done === 'merged' ? note : `on ${done}`, on: false };
  if (pr.deploy === 'failure') return { mark: BAD, label: 'Done', note, on: false };

  return { mark: merged ? RUNS : TODO, label: 'Done', note, on: merged };
};

const prColumns = (s: ColumnsStep): Columns => {
  const { r } = s;
  const pr = r.run.pr;
  const commits = r.commits ?? [];
  const head = pr?.head ?? r.branch ?? '';
  const base = pr?.base ?? '';
  const rounds = r.reviews.length;
  const found = r.reviews.reduce((n, y) => n + y.findings, 0);
  const risk = r.reviews.findLast((y) => y.risk !== null)?.risk ?? null;
  const verified = pr?.body?.split('\n').find((l) => l.trimStart().startsWith('**Verified:**'));
  const merged = pr?.state === 'merged';
  const conflicting = pr?.mergeable === 'conflicting';
  const read = col('the branch, the commits, the review and verify notes', [
    rb('Branch', [
      facts([
        ...(head === ''
          ? []
          : [
              [
                'Head',
                `${head}${commits.length === 0 ? '' : ` · ${plural(commits.length, 'commit')} ahead`}`,
              ] as const,
            ]),
        ...(base === '' ? [] : [['Base', base] as const]),
        ...(changedWords(r) === undefined ? [] : [['Changed', changedWords(r) ?? ''] as const]),
      ]),
    ]),
    commits.length === 0
      ? undefined
      : rb(`Commits · ${commits.length}`, [commitsPart(commits, commitNote(r))]),
    rounds === 0
      ? undefined
      : rb('Review notes', [
          list([
            {
              text: `${plural(rounds, 'round')} · ${found === 0 ? 'no findings' : `${plural(found, 'finding')}${r.reviews.at(-1)?.findings === 0 ? ', fixed' : ''}`}`,
              note: r.reviews
                .flatMap((y) => (y.report === null ? [] : [shownPath(r, y.report)]))
                .join(' · '),
            },
            ...(risk === null
              ? []
              : [
                  {
                    text: risk.risky ? `Risky · ${risk.why}` : `Not risky · ${risk.why}`,
                    note:
                      r.run.regression.length === 0
                        ? ''
                        : `regression: ${r.run.regression.join(', ')}`,
                  },
                ]),
          ]),
        ]),
    verified === undefined
      ? undefined
      : rb('Verify · for the pull request', [text(verified.replace(/\*\*/g, ''))]),
    r.run.playbook === null
      ? undefined
      : rb('Playbook', [
          list([
            { text: `${r.run.playbook.path} · ${plural(r.run.playbook.steps.length, 'step')}` },
          ]),
        ]),
  ]);

  if (pr === null)
    return {
      read,
      made: col('no pull request yet', [
        rb('', [text('Serve opens it once the pr skill hands it the title and body.', 'dim')]),
      ]),
    };
  const done = pr.done ?? 'test';
  const reviewOn =
    pr.state === 'open' && pr.checks !== 'pending' && !conflicting && pr.merge === 'person';
  const rung = (mark: Mark, label: string, note: string, on = false) => ({ mark, label, note, on });
  const state = prState(pr);

  return {
    read,
    made: col(
      `PR #${pr.number} · ${pr.state}${conflicting ? ' · conflicting' : ''}${reviewOn ? ' · ready for review' : ''}`,
      [
        rb('', [
          {
            kind: 'ladder',
            rungs: [
              rung(GOOD, 'Pushed', `${head === '' ? 'the card branch' : head} → origin`),
              rung(
                GOOD,
                'Opened',
                `#${pr.number}${pr.openedAt === undefined ? '' : ` · ${screenClock(pr.openedAt, s.now)}`} · linked from AB#${r.card}`,
              ),
              rung(
                CHECKS_RUNG[pr.checks] ?? TODO,
                'Checks',
                pr.checks === 'none' ? 'none yet' : pr.checks,
                pr.checks === 'pending',
              ),
              rung(
                reviewMark(merged, reviewOn),
                'Review',
                `${pr.merge === 'auto' ? 'auto merge' : 'a person merges'} · reviewers: ${reviewersWords(pr.reviewers)}`,
                reviewOn,
              ),
              mergeRung(pr, merged, conflicting, base),
              doneRung(pr, merged, done),
            ],
          },
        ]),
        mb(
          pr.title ?? `Pull request #${pr.number}`,
          [
            facts([
              ['Link', pr.url],
              [
                'Head → base',
                `${head} → ${base === '' ? 'its base' : base}${pr.headSha === undefined || pr.headSha === '' ? '' : ` · head ${pr.headSha.slice(0, 7)}`}${pr.mergeable === undefined || pr.mergeable === 'unknown' ? '' : ` · ${pr.mergeable}`}`,
              ],
              ['Checks', pr.checks],
              ['Reviewers', reviewersWords(pr.reviewers)],
              [
                'Merge',
                `${pr.merge === 'auto' ? 'by Abe once green' : 'by a person'}${pr.mergeFailed === null || pr.mergeFailed === undefined ? '' : ` · refused: ${pr.mergeFailed}`} · done = ${done === 'merged' ? 'merged' : `deployed to ${done}`}`,
              ],
            ]),
          ],
          state,
        ),
        pr.body === undefined
          ? rb('Body', [text('Its body not kept: a run from before Abe kept it.', 'dim')])
          : rb('', [
              {
                kind: 'doc',
                eyebrow: `Pull request #${pr.number} · its body as sent`,
                title: pr.title ?? '',
                meta: '',
                markdown: pr.body,
              },
            ]),
      ],
    ),
  };
};

const BEFORE_WORDS: Readonly<Record<string, Word>> = {
  pass: { text: '✓ reproduced', hue: 'good' },
  'not-reproduced': { text: '✗ not reproduced', hue: 'warn' },
  fail: { text: '✗ could not run', hue: 'bad' },
};

const reproduceColumns = (s: ColumnsStep): Columns => {
  const { r, x } = s;
  const b = r.before !== null && within([r.before], x).length > 0 ? r.before : null;
  const kit =
    b?.report === null || b?.report === undefined ? [] : kitOf(r, b.report, x.id, s.paused);
  const shots =
    b?.rows.flatMap((y) => y.evidence.filter((e) => e.kind === 'screenshot')).length ?? 0;

  return {
    read: col('the card’s repro steps', [rb('', [cardPart(r)]), cardCriteria(r)]),
    made: col(
      b === null
        ? (x.summary ?? x.headline)
        : [
            `Before · ${BEFORE_WORDS[b.result]?.text.slice(2) ?? b.result}`,
            ...(b.rows.length === 0 ? [] : [plural(b.rows.length, 'step')]),
            ...(shots === 0 ? [] : [plural(shots, 'shot')]),
            ...(b.recording?.length === null || b.recording === null ? [] : [b.recording.length]),
          ].join(' · '),
      [
        b === null
          ? rb('', [text('Its Before was not kept here.', 'dim')])
          : mb(
              b.result === 'not-reproduced' ? 'What was tried' : 'Steps',
              [
                {
                  kind: 'proof',
                  rows: b.rows.map((y) => ({
                    n: y.n,
                    mark: y.failed ? BAD : GOOD,
                    text: y.how,
                    how: y.seen ?? '',
                    evidence: y.evidence.map((e) => evidenceAt(r, e)),
                    chapter: y.chapter === null ? '' : `▶ ${y.chapter}`,
                  })),
                  ...(b.recording === null
                    ? {}
                    : {
                        recording: {
                          length: `▶ ${b.recording.length ?? ''}`.trim(),
                          path: b.recording.path,
                          chapters: b.rows.flatMap((y) =>
                            y.chapter === null ? [] : [String(y.n)],
                          ),
                        },
                      }),
                },
              ],
              BEFORE_WORDS[b.result],
            ),
        kit.length === 0 ? undefined : rb('', [{ kind: 'kit', features: kit }]),
        b === null
          ? undefined
          : mb('Recorded', [
              text(
                `abe factory verify --phase before --result ${b.result} · ${b.result === 'pass' ? 'next step: build' : 'the workflow’s ends: ends the run with the report'}`,
                'dim',
              ),
            ]),
      ],
    ),
  };
};

/** A spike's commits as the run reported them. */
const spikeBlock = (r: RunRecordData): RunBlock | undefined => {
  const spike = r.run.reported?.spike;

  return spike === null || spike === undefined
    ? undefined
    : mb(`Spike · ${spike.branch}`, [
        commitsPart(spike.commits, () => ''),
        text(
          `Evidence, never merged; ${spike.pushed ? 'serve pushed the branch and the card’s comment links it' : 'not pushed'}.`,
          'dim',
        ),
      ]);
};

/** A report's markdown without its first heading when that is the title the doc shows already. */
const withoutTitle = (markdown: string, title: string): string => {
  const lines = markdown.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== '');
  const head = lines[first]?.trim() ?? '';

  return /^#\s/.test(head) && head.replace(/^#\s+/, '').trim() === title.trim()
    ? lines
        .slice(first + 1)
        .join('\n')
        .trim()
    : markdown;
};

const reportDoc = (r: RunRecordData, eyebrow: string): RunBlock | undefined =>
  r.reported === null
    ? undefined
    : rb('', [
        {
          kind: 'doc',
          eyebrow,
          title: r.title,
          meta: r.run.reported?.report ?? '',
          markdown: withoutTitle(r.reported, r.title),
        },
      ]);

const investigateColumns = (s: ColumnsStep): Columns => {
  const { r, x } = s;

  return {
    read: col('the question, what an answer must say', [
      rb('', [cardPart(r)]),
      rb('An answer must say', [
        list(
          [{ text: 'The cause, cited.' }, { text: 'Options with cost and risk, one recommended.' }],
          true,
        ),
      ]),
      qaBlock(s),
    ]),
    made: col(
      [
        x.report === null ? '' : shownPath(r, x.report),
        r.run.reported?.spike === null || r.run.reported?.spike === undefined
          ? ''
          : `spike ${r.run.reported.spike.branch} · ${plural(r.run.reported.spike.commits.length, 'commit')}`,
      ]
        .filter((w) => w !== '')
        .join(' · '),
      [
        reportDoc(
          r,
          `Report · ${x.report === null ? 'the step’s report' : shownPath(r, x.report)}`,
        ) ?? rb('', [text(x.summary ?? x.headline, 'dim')]),
        spikeBlock(r),
        filesBlock(s),
      ],
    ),
  };
};

const plainColumns = (s: ColumnsStep): Columns => {
  const report = s.x.report === null ? null : shownPath(s.r, s.x.report);

  return {
    read: col('the card', [rb('', [cardPart(s.r)]), qaBlock(s), decisionsBlock(s.x)]),
    made: col(report ?? '', [
      report === null ? undefined : rb('Its report', [list([{ text: report }])]),
      filesBlock(s),
    ]),
  };
};

const outcomeWords = (s: ColumnsStep): string => {
  const ended = s.r.run.ended;

  if (ended !== null) return `${ended.as.replace('-', ' ')} · ${screenClock(ended.at, s.now)}`;

  return s.x.kind === 'merge' ? 'merged' : s.x.headline;
};

/** A person's step (Needs you, an end, the merge): what came of the run. */
const personColumns = (s: ColumnsStep): Columns => {
  const { r, x } = s;
  const ended = r.run.ended;

  return {
    read: col('the run', [rb('', [cardPart(r, false)])]),
    made: col(x.headline, [
      mb('Run', [
        facts([
          ['Outcome', outcomeWords(s)],
          ...(ended === null
            ? []
            : [['Why', ended.reason] as const, ['Ended in', ended.from] as const]),
          ...(r.run.pr === null
            ? []
            : [['Pull request', `#${r.run.pr.number} ${r.run.pr.state}`] as const]),
        ]),
      ]),
    ]),
  };
};

/** The two columns of a step run. */
export const columnsOf = (s: ColumnsStep, o: { lastVerify: boolean }): Columns => {
  if (s.x.kind !== 'stage') return personColumns(s);
  switch (s.x.stage) {
    case 'spec':
      return specColumns(s);
    case 'build':
      return buildColumns(s);
    case 'checks':
      return checksColumns(s);
    case 'review':
      return reviewColumns(s);
    case 'verify':
      return verifyColumns(s, o.lastVerify);
    case 'pr':
      return prColumns(s);
    case 'reproduce':
      return reproduceColumns(s);
    case 'step': {
      const skill = s.flow?.skill ?? '';

      if (skill === 'to-tickets' || s.x.made?.kind === 'tickets') return ticketsColumns(s);
      if (skill === 'playbook') return playbookColumns(s);
      if (skill === 'investigate') return investigateColumns(s);

      return plainColumns(s);
    }
    case 'done':
      return plainColumns(s);
  }
};

/** A step its gate skipped: the judge's call and what it saw, nothing made. */
export const skippedColumns = (
  r: RunRecordData,
  call: Judgement,
  now: string | undefined,
): Columns => ({
  read: col(
    `the ${call.sees.length === 0 ? 'facts' : call.sees.join(' and ')} and the judge’s call`,
    [
      rb('Judge · gate', [
        text(`${call.question}\nNo: ${call.reason}\njudge · ${screenClock(call.at, now)}`, 'quote'),
      ]),
      call.sees.includes('diff') ? diffBlock(r, false) : undefined,
    ],
  ),
  made: col('nothing · skipped', [
    mb('Skipped', [text('Nothing written. The run went on to the next step.', 'dim')], {
      text: '– skipped',
      hue: 'dim',
    }),
  ]),
});

/** The run ended by a step's `ends:`: its report, the run's end. */
export const reportedColumns = (r: RunRecordData, now: string | undefined): Columns => {
  const rep = r.run.reported;
  const spike = rep?.spike ?? null;
  const workflow = r.run.workflow?.name ?? r.run.workflow?.id ?? 'The';

  return {
    read: col('the step’s report', [
      rb('From', [
        list([
          {
            text: `${rep?.step ?? 'the step'}${r.before?.result === 'not-reproduced' ? ' · not reproduced' : ''}`,
            note: rep?.report ?? '',
          },
          {
            text: `Workflow · ${workflow}`,
            note: `ends: → report${r.run.pr === null ? ' · no pull request' : ''}`,
          },
        ]),
      ]),
    ]),
    made: col(
      `a comment on AB#${r.card}${spike === null ? '' : ' · the branch pushed'} · the run ended`,
      [
        reportDoc(r, `Comment on AB#${r.card}`) ??
          rb('', [text('Its report could not be read here.', 'dim')]),
        mb(
          'Run ended',
          [
            facts([
              ['Outcome', `reported${rep === null ? '' : ` · ${screenClock(rep.at, now)}`}`],
              [
                'Card',
                rep?.done === false
                  ? 'stays in its column for a person to decide · comment posted'
                  : 'moved to Done · comment posted',
              ],
              [
                'Branch',
                spike === null
                  ? 'nothing pushed'
                  : `${spike.branch} · ${plural(spike.commits.length, 'commit')} · ${spike.pushed ? 'pushed by serve' : 'not pushed'} · no pull request`,
              ],
            ]),
          ],
          rep?.done === false
            ? { text: '■ not reproduced', hue: 'dim' }
            : { text: '✓ done', hue: 'good' },
        ),
      ],
    ),
  };
};

/** The live step's state: the agent's last words, so far. */
export const nowOf = (x: RunRecordStep, now: string | undefined): RunFocus['props']['now'] =>
  !x.live || x.summary === null
    ? undefined
    : {
        head: `● Now · ${[`${timeIn(x.at, now)} so far`.trim(), x.subagent ? 'subagent' : ''].filter((w) => w !== '' && w !== 'so far').join(' · ')}`,
        words: x.summary,
        note: 'The agent’s last words in the step; its Step summary comes when the step ends.',
      };
