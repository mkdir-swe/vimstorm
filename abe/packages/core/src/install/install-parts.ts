/**
 * The install's part checks: each one's verdict, pass, fail or warn with its one line, on the
 * record and the reads serve did for it, passed in as data. Serve does the reads (the logins, the
 * servers, the connection read live, the board, the checks run, the gate) and keeps the table of
 * each part's reads beside its verdict here. Pure.
 */
import { type AbeEnv, ABE_ENVS, abeEnvFile } from './credentials';
import { REPO_PATH } from '../layer/settings/places';
import { NO_CARDS_YET } from '../board/board-provider';
import {
  asksEnvProfiles,
  sourcesToCheck,
  INSTALL_PART_TABLE,
  type Install,
  partFailed,
  partPassed,
  partsLeft,
  type PartVerdict,
  partWarned,
  sourceStops,
  type InstallMove,
  moveInstall,
  unansweredSources,
} from './install';
import { type ConnectionFact } from './install-connection';
import { mergeDeploysWords } from './install-deploys';
import { SOURCE_VALUES_PATH } from './source-servers';
import { BOARD_PROVIDER_WORDS, boardProposal, type BoardWhere } from './install-read';
import { checksUnproven } from './install-check';
import { nothingToRun } from './install-kind';
import { type SetupRan, setupReason } from '../session/setup';
import { WORKTREE_FIX } from '../session/worktree-recipe';
import { hasHeading, REPO_SKILLS_DIR, type RepoHooks, testingSkillWanted } from '../repo-hooks';

/**
 * A part's verdict with the connection's live read of `of` on it: a fact that failed fails it,
 * one that warned warns it; an earlier failure stays.
 */
export const withLiveRead = (
  i: Pick<Install, 'connection'>,
  of: readonly ConnectionFact['of'][],
  v: PartVerdict,
): PartVerdict => {
  const facts = (i.connection?.facts ?? []).filter((f) => of.includes(f.of));
  const said = (f: ConnectionFact) =>
    `${f.name}: ${f.why ?? f.state}${f.fix === null ? '' : ` (${f.fix})`}`;
  const failed = facts.filter((f) => f.state === 'failed');
  const warned = facts.filter((f) => f.state === 'warning');

  if (v.state === 'fail') return v;
  if (failed.length > 0) return partFailed('read-failed', failed.map(said).join('; '));
  if (warned.length > 0)
    return partWarned('read-warning', `${v.line}; ${warned.map(said).join('; ')}`);

  return v;
};

/** The facts each part's check reads live. */
export const LIVE_READS = {
  logins: ['github', 'cloud', 'credentials'],
  board: ['board'],
  sources: ['source'],
} as const satisfies Record<string, readonly ConnectionFact['of'][]>;

const loginsSaid = (i: Pick<Install, 'logins'>): PartVerdict => {
  const logins = i.logins ?? [];
  const notOk = logins.filter((l) => l.state !== 'ok' && l.state !== 'skipped');

  if (notOk.length > 0)
    return partFailed(
      'logins',
      notOk
        .map((l) => `${l.tool} ${l.state}${l.note === undefined ? '' : ` (${l.note})`}: ${l.fix}`)
        .join('; '),
    );
  const ok = logins.filter((l) => l.state === 'ok').map((l) => l.tool);

  return partPassed(ok.length === 0 ? 'No login is needed' : `${ok.join(', ')} answer`);
};

/**
 * Logins: every tool the repo needs answers (one skipped is not needed now), and GitHub, the
 * cloud and each environment's aws profile read right live.
 */
export const loginsPart = (i: Pick<Install, 'logins' | 'connection'>): PartVerdict =>
  withLiveRead(i, LIVE_READS.logins, loginsSaid(i));

const sourcesSaid = (i: Install, team: readonly string[]): PartVerdict => {
  if (i.sourcesHave === null)
    return partFailed('sources-unlooked', 'serve has not looked at the servers yet');
  const open = unansweredSources(i);

  if (open.length > 0)
    return partFailed(
      'sources-unanswered',
      `${open.map((s) => `${s.id} (${s.why})`).join(', ')} not added or skipped: ask the person, then abe install source <id> (--url <its server> when none is known), or --skip`,
    );
  const checked = sourcesToCheck(i, team);
  const signing = checked.filter((s) => i.signingIn.includes(s.id));

  if (signing.length > 0)
    return partFailed(
      'signing-in',
      `${signing.map((s) => s.name).join(', ')} signing in: check again once it ends`,
    );
  const stops = checked.flatMap((s) => {
    const c = i.sourceChecks[s.id];

    if (c === undefined) return [`${s.name} is not checked yet`];
    const stop = sourceStops(s.name, c);

    return stop === null ? [] : [stop];
  });

  if (stops.length > 0)
    return partFailed('source-not-reading', `${stops.join('; ')}; or skip it (--skip)`);
  const added = checked.map((s) => s.name);
  const skipped = Object.entries(i.sources)
    .filter(([, a]) => a === 'skip')
    .map(([id]) => id);

  return partPassed(
    [
      added.length === 0 ? 'No source added' : `${added.join(', ')} added and read`,
      ...(skipped.length === 0 ? [] : [`${skipped.join(', ')} skipped`]),
    ].join('; '),
  );
};

/**
 * Sources: every source Read found is added or skipped, after serve looked at the servers, and
 * each added one and each the repo's `sources:` names (`team`) reads (signed in, its one read
 * ok), live too. A reference in `sources:` with no value of the person's (`unvalued`) fails it
 * first: its server starts without it.
 */
export const sourcesPart = (
  i: Install,
  team: readonly string[] = [],
  unvalued: readonly string[] = [],
): PartVerdict =>
  unvalued.length === 0
    ? withLiveRead(i, LIVE_READS.sources, sourcesSaid(i, team))
    : partFailed(
        'source-value-missing',
        `${unvalued.join(', ')} ${unvalued.length === 1 ? 'has' : 'have'} no value: sources: references ${unvalued.length === 1 ? 'it' : 'them'}; the person adds ${unvalued.map((v) => `${v}=<value>`).join(', ')} to ${SOURCE_VALUES_PATH} (theirs, never committed)`,
      );

/** A source whose check needs no read now: it passed, or its sign-in runs. */
export const sourceSettled = (i: Install, id: string): boolean => {
  const had = i.sourceChecks[id];

  return (had?.mcp === 'connected' && had.probe === 'ok') || i.signingIn.includes(id);
};

/** The workflows a board's card types never preselect, and the one each card takes instead. */
export type UnmetTypes = {
  workflows: readonly { name: string; types: readonly string[] }[];
  fallback: string;
};

/** What the Board check reads: the `board` setting in force, the board login's read of it, the repo's Layer. */
export type BoardReads = {
  /** The `board` setting's problem, as `abe settings problems` says it; null: none. */
  problem: { file: string; message: string } | null;
  /** The board the setting in force names; null: none. */
  inForce: BoardWhere | null;
  /** The board login's refusal (401, 403) of the board the repo's Layer names; null: it reads it, or it was not read. */
  unreadable: { organization: string; why: string } | null;
  /** The `autoMerge` the repo's Layer writes and that applies; null: none. */
  merges: boolean | null;
  /** Whether the repo's Layer says where specs go (no settings read: taken as said). */
  specWritten: boolean;
  /** Where specs go, as the settings in force say. */
  specWhere: string;
  /** The workflows the board's card types never preselect; null: none. */
  unmet: UnmetTypes | null;
};

/** The board in force as the record keeps it: the project's default team a link with none took, still said while it is the one. */
export const boardKept = (was: BoardWhere | null, inForce: BoardWhere | null): BoardWhere | null =>
  inForce !== null &&
  was?.defaultTeam === true &&
  was.provider === inForce.provider &&
  was.name === inForce.name
    ? { ...inForce, defaultTeam: true }
    : inForce;

/** The Board check's reads recorded: the board in force, and taken out when the board login can't read it. */
export const boardRecorded = (i: Install, r: BoardReads, at: string): Install => {
  if (r.problem !== null) return i;
  const moves: InstallMove[] = [
    { kind: 'board', board: boardKept(i.board, r.inForce) },
    ...(r.unreadable === null ? [] : [{ kind: 'board-unreadable' as const, ...r.unreadable }]),
  ];

  return moves.reduce((on, m) => {
    const moved = moveInstall(on, m, at);

    return moved.ok ? moved.data : on;
  }, i);
};

const unmetWords = (unmet: UnmetTypes | null): string[] => {
  if (unmet === null) return [];
  const types = [...new Set(unmet.workflows.flatMap((w) => w.types))];

  return [
    `no ${types.join(' or ')} cards (board.types): ${unmet.workflows.map((w) => w.name).join(', ')} never preselected, every card preselects ${unmet.fallback}; add the board's kind for each to board.types when it has one`,
  ];
};

const boardSaid = (i: Install, r: BoardReads): PartVerdict => {
  if (r.problem !== null)
    return partFailed('bad-board', `${r.problem.file}: board: ${r.problem.message}`);
  const board = r.inForce;

  if (board === null)
    return partFailed(
      'no-board',
      `${REPO_PATH} names no board: write its board (provider: github for the repo's GitHub Issues, an Azure Boards one, or provider: local for one on this machine)`,
    );
  if (board.provider === 'github-projects' || board.provider === 'jira')
    return partFailed(
      'bad-board',
      `${NO_CARDS_YET(BOARD_PROVIDER_WORDS[board.provider])}: write the repo's GitHub Issues (provider: github), an Azure Boards board or one On this machine`,
    );
  if (r.unreadable !== null)
    return partFailed(
      'board-unreadable',
      `${i.unreadable === null ? r.unreadable.why : boardProposal(i.unreadable, i.read?.boards ?? []).said}: write the repo's own board, or sign in to az as an account that reads this one`,
    );
  const deploys = mergeDeploysWords(i.read?.deploys ?? []);

  if (deploys !== null && r.merges === null)
    return partFailed(
      'auto-merge-unwritten',
      `${deploys}: ask the person who merges, then write it in ${REPO_PATH} (overrides: { autoMerge: { value: <true for auto merge when green>, reason: "${deploys}" } })`,
    );
  if (!r.specWritten)
    return partFailed(
      'spec-where-unwritten',
      `${REPO_PATH} does not say where specs go: ask the person, then write spec.where (issue, card or file)`,
    );

  return partPassed(
    [
      `${BOARD_PROVIDER_WORDS[board.provider]} ${board.name}`,
      ...(deploys === null
        ? []
        : [r.merges === true ? 'auto merge when green' : 'a person merges']),
      `specs go to ${r.specWhere}`,
      ...unmetWords(r.unmet),
    ].join('; '),
  );
};

/**
 * Board: the board the repo's settings name now, one Abe has cards from, that the board login
 * reads, with who merges written when a merge deploys and where specs go (ADR 0026), live too.
 */
export const boardPart = (i: Install, r: BoardReads): PartVerdict =>
  withLiveRead(i, LIVE_READS.board, boardSaid(i, r));

/**
 * Env files: the three Abe env files exist (`missing`: those not there) and each environment has
 * an aws profile or none said when the repo uses aws, the person's own; then the team's: every
 * env file of the repo is placed in `abe.yaml` (`unplaced`: those only the env map on this Mac
 * places, or none does, ADR 0040), so a teammate's install reads it rather than judging again.
 */
export const envFilesPart = (
  i: Install,
  missing: readonly AbeEnv[],
  unplaced: readonly string[] = [],
): PartVerdict => {
  if (missing.length > 0)
    return {
      ...partFailed(
        'env-files-missing',
        `${missing.map(abeEnvFile).join(', ')} not there: abe install env-map writes them, prefilled`,
      ),
      personal: true,
    };
  const unsaid = asksEnvProfiles(i)
    ? ABE_ENVS.filter((e) => i.envFiles?.profiles[e] === undefined)
    : [];

  if (unsaid.length > 0)
    return {
      ...partFailed(
        'env-profile-unsaid',
        `The repo uses aws, and ${unsaid.join(', ')} ${unsaid.length === 1 ? 'has' : 'have'} no aws profile said: abe install env-profile <env> <profile|none>`,
      ),
      personal: true,
    };
  if (unplaced.length > 0)
    return partFailed(
      'env-not-in-abe-yaml',
      `${unplaced.join(', ')}: placed in no abe.yaml worktree group nor env.notUsed: abe install env-map writes them there (a file you are not sure of, ask the person first)`,
    );

  return partPassed(
    `${ABE_ENVS.map(abeEnvFile).join(', ')} are there${asksEnvProfiles(i) ? `; aws ${ABE_ENVS.map((e) => `${e}: ${i.envFiles?.profiles[e] ?? 'none'}`).join(', ')}` : ''}`,
  );
};

/**
 * Checks: every check in `checks:` passed when serve ran it, and none is a way past a sandbox
 * (`workarounds`, each said).
 */
export const checksPart = (
  i: Pick<Install, 'checkRuns'>,
  listed: readonly { name: string; run: string }[],
  workarounds: readonly string[],
): PartVerdict => {
  if (workarounds.length > 0)
    return partFailed(
      'sandbox-workaround',
      `${workarounds.join('; ')}. Write CI's own command: a card's session gives it a writable temp folder (TMPDIR, TMP and TEMP)`,
    );
  const unproven = checksUnproven(listed, i.checkRuns);

  if (unproven.length > 0) return partFailed('check-unproven', unproven.join('; '));

  return partPassed(
    listed.length === 0
      ? 'abe.yaml lists no checks'
      : `${listed.map((c) => c.name).join(', ')} pass as serve runs them`,
  );
};

/**
 * The app run locally, Verify's first: the gate passed, there is nothing to run here, or the
 * person chose it can't run here.
 */
export const ranLocally = (i: Install): PartVerdict => {
  const nothing = nothingToRun(i.read?.kind);

  if (i.gate?.passed === true) return partPassed(`The gate passed: ${i.gate.url}`);
  if (nothing !== null) return partPassed(`${nothing.charAt(0).toUpperCase()}${nothing.slice(1)}`);
  if (i.notRun !== null)
    return partPassed(`It can't run here, as the person chose: ${i.notRun.why}`);
  if (i.gate !== null)
    return partFailed(
      'gate',
      `The gate did not pass: ${i.gate.reasons.join('; ')}${i.gate.options.length === 0 ? '' : ` (${i.gate.options.join('; ')})`}`,
    );

  return partFailed(
    'not-run',
    "The app has not run: start it, then abe install gate --url <the app>; or, once the person chose it can't run here, --cannot-run <why>",
  );
};

/** What the Verify check reads, each only once the one before it passed. */
export type VerifyReads = {
  /** The app run locally (`ranLocally`) on the record as it was read. */
  ran: PartVerdict;
  /** The query script run-app's `## Read data` names, not there; null: none asked, or it is. */
  query: PartVerdict | null;
  /** The Verification pack as written, refused; null: it passes, or it was not read. */
  pack: PartVerdict | null;
  /** The checks `checks:` lists, run again after the pack. */
  listed: readonly { name: string; run: string }[];
  /** The repo's verify skill's name. */
  skill: string;
};

/**
 * Verify: the app run locally, the query script there when run-app says `## Read data`, the
 * repo's Verification pack written and one feature proven (unless the app can't run here), then
 * the checks pass again after it is written.
 */
export const verifyPart = (i: Install, r: VerifyReads): PartVerdict => {
  if (r.ran.state !== 'pass') return r.ran;
  if (r.query !== null) return r.query;
  if (r.pack !== null) return r.pack;
  const failing = checksUnproven(r.listed, i.checkRuns);

  if (failing.length > 0)
    return partFailed(
      'checks-after-pack',
      `The checks fail again after the pack: ${failing.join('; ')}`,
    );

  return partPassed(
    `${r.ran.line}; ${r.skill} is written${i.notRun === null ? ' and proven' : ''}; the checks pass again`,
  );
};

/**
 * Done: every other required part passes (or warns); its line names the team's files to commit
 * and push (`toCommit`: abe.yaml and `.claude/skills/` as git status has them).
 */
export const donePart = (i: Install, toCommit: readonly string[]): PartVerdict => {
  const left = partsLeft(i);

  if (left.length > 0)
    return partFailed(
      'parts-left',
      `${left.map((p) => INSTALL_PART_TABLE[p].title).join(', ')} ${left.length === 1 ? 'does' : 'do'} not pass yet`,
    );

  return partPassed(
    toCommit.length === 0
      ? 'Every part passes; nothing to commit'
      : `Every part passes: commit and push ${toCommit.join(', ')}`,
  );
};

/** What the Worktree check found (`abe install check worktree`), serve's reads. */
export type WorktreeTried = {
  /** `abe.yaml` has a `worktree:` (an empty one says the defaults are enough). */
  written: boolean;
  /**
   * Why the settings dropped `abe.yaml`'s `worktree:` (a path out of the checkout, a key it has
   * not), as `abe settings problems` says it: no new worktree gets any of it.
   */
  dropped?: string;
  /**
   * A throwaway worktree of HEAD made ready by the recipe as a card's is (no install): what it
   * did, and the recipe's paths it still lacks after; or why it could not be made.
   */
  tried: { ok: true; ran: SetupRan; absent: readonly string[] } | { ok: false; why: string };
  /**
   * The env files of the main checkout placed (abe.yaml's groups, then the env map) in an environment on for agents that a
   * new worktree would not get (git-ignored there, and in no part of the recipe).
   */
  uncovered: readonly string[];
};

/**
 * Worktree: `abe.yaml` has the repo's recipe, and a throwaway worktree made ready by it has each
 * file it names (none missing from the main checkout) with its script passing; an env file the
 * app or tests read that the recipe leaves out warns.
 */
export const worktreePart = (w: WorktreeTried): PartVerdict => {
  if (!w.written)
    return partFailed(
      'no-recipe',
      "abe.yaml has no worktree: write the repo's recipe (worktree.link: the git-ignored env files the app and tests read; worktree: {} when a new worktree needs nothing more)",
    );
  if (w.dropped !== undefined)
    return partFailed(
      'recipe-dropped',
      `${w.dropped}: the settings drop the whole recipe, so a new worktree gets none of it; fix that entry`,
    );
  if (!w.tried.ok) return partFailed('worktree-not-made', w.tried.why);
  const { ran, absent } = w.tried;
  const missing = ran.missing ?? [];

  if (missing.length > 0)
    return partFailed(
      'recipe-missing',
      `${missing.join(', ')}: in worktree: but not in the main checkout; make them there, or take them out of the recipe`,
    );
  if (absent.length > 0)
    return partFailed(
      'recipe-absent',
      `${absent.join(', ')}: in worktree: but a new worktree still lacks them; check the paths`,
    );
  const failed = setupReason(ran);

  if (failed !== null) return partFailed('recipe-script-failed', failed);
  const links = ran.links ?? [];
  const skipped = Object.entries(ran.skipped ?? {});
  const line = [
    links.length === 0 ? '' : `linked ${links.join(', ')}`,
    ran.copied.length === 0 ? '' : `copied ${ran.copied.join(', ')}`,
    skipped.length === 0 ? '' : `skipped ${skipped.map(([p, why]) => `${p} (${why})`).join(', ')}`,
    ran.how === 'linked' ? 'packages linked' : '',
    ran.script === undefined ? '' : `${ran.script.run} passed`,
  ].filter((s) => s !== '');
  const said = `A new worktree gets ${line.length === 0 ? 'the defaults alone' : line.join('; ')}`;

  return w.uncovered.length === 0
    ? partPassed(said)
    : partWarned(
        'env-not-in-recipe',
        `${said}; ${w.uncovered.join(', ')} feed an environment on for agents but a new worktree lacks them: ${WORKTREE_FIX}, or leave them out on purpose`,
      );
};

/** The repo's notes for its agents, the team's: `CLAUDE.md` at its top. */
export const AGENT_NOTES = 'CLAUDE.md';

/** The Skills check's reads. */
export type SkillsReads = {
  /** The repo's testing skill's `SKILL.md` (the `testing` hook, else any `<name>-testing`); null: none. */
  skill: string | null;
  /** `CLAUDE.md`'s text; null: not there. */
  notes: string | null;
  /** What the checks: list lacks of the checks the files name, a line each. */
  unlisted: readonly string[];
  /** The repo's hook points: its testing skill's name and its find-out heading. */
  hooks: RepoHooks;
  /** The checkout's folder name: the testing skill asked for is `<app>-testing`. */
  app: string;
};

/**
 * Skills: the repo's testing skill and its `CLAUDE.md` are written, with the find-out section
 * there (the data route, the sources, the prod line); a check the files name that `checks:`
 * lacks is said.
 */
export const skillsPart = (r: SkillsReads): PartVerdict => {
  if (r.skill === null)
    return partFailed(
      'no-testing-skill',
      `No testing skill in ${REPO_SKILLS_DIR}: write ${REPO_SKILLS_DIR}/${testingSkillWanted(r.hooks, r.app)}/SKILL.md`,
    );
  if (r.notes === null)
    return partFailed(
      'no-agent-notes',
      `No ${AGENT_NOTES}: write the repo's notes for its agents there`,
    );
  if (!hasHeading(r.hooks, 'find-out', r.notes))
    return partFailed(
      'no-find-out',
      `${AGENT_NOTES} has no ${r.hooks['find-out']} section: write it (the data route, the sources, the prod line)`,
    );

  return partPassed(
    `${r.skill} and ${AGENT_NOTES} are written${r.unlisted.map((l) => `; ${l}`).join('')}`,
  );
};

/**
 * The Workflows part (ADR 0033): the repo's `abe/` folder holds its workflows and Abe's skills.
 * `copied`: the check copied them in now (none there before); `updates`: a newer Abe's changed
 * ones, said, never written (the Abe chat shows the diff and applies it when asked).
 */
export const workflowsPart = (o: {
  there: boolean;
  copied: { workflows: number; skills: number } | null;
  updates: string;
}): PartVerdict => {
  if (!o.there)
    return partFailed(
      'no-abe-files',
      "No workflows and skills in abe/: abe install check workflows copies Abe's in",
    );
  const did =
    o.copied === null
      ? 'abe/ holds the repo’s workflows and skills'
      : `Copied ${o.copied.workflows} workflows and ${o.copied.skills} skills into abe/: the repo’s now, commit them`;

  return o.updates === '' ? partPassed(did) : partWarned('abe-newer', `${did} · ${o.updates}`);
};
