/** Factory install's parts: the record, its moves, each part's check, and the status. */
import { describe, expect, test } from 'bun:test';
import {
  beforeRunWarning,
  cardInstallRefusal,
  checksEnvOf,
  ENV_NOT_MAPPED,
  envFilesPlaced,
  Install,
  INSTALL_PARTS,
  installDone,
  type InstallMove,
  type InstallPart,
  loginsSeen,
  moveInstall,
  newInstall,
  partChecked,
  partFailed,
  partPassed,
} from './install';
import { installAwsOff } from './install-aws-off';
import { type RepoMoved, rehomed, repoMovedText, sighting } from './repo-moves';
import { localModeGuards } from './install-outward';
import { type ConnectionFact } from './install-connection';
import { type GateResult } from './install-gate';
import {
  type BoardReads,
  boardPart,
  boardRecorded,
  checksPart,
  donePart,
  envFilesPart,
  loginsPart,
  ranLocally,
  sourcesPart,
  verifyPart,
  type VerifyReads,
  withLiveRead,
} from './install-parts';
import { type ReadFindings } from './install-read';
import { type KindFindings } from './install-kind';
import {
  installCheckedText,
  installCheckFailed,
  installView,
  installViewText,
} from './install-view';

const AT = '2026-10-26T10:00:00.000Z';
const LATER = '2026-10-27T10:00:00.000Z';
const findings = (o: Partial<ReadFindings> = {}): ReadFindings => ({
  files: ['package.json'],
  ci: [],
  scripts: {},
  envExample: null,
  envKeys: [],
  logins: ['github', 'claude'],
  azureCi: false,
  board: { provider: 'azure-boards', name: 'Shop/Web', from: 'repo' },
  fixedPorts: [],
  devPorts: [],
  originAuth: [],
  sources: [],
  aws: [],
  awsProfiles: [],
  outward: [],
  workspaces: [],
  workspacesFrom: null,
  capped: [],
  boards: [],
  kind: null,
  deploys: [],
  cloudCredentials: [],
  publicEnv: [],
  envFiles: [],
  ...o,
});
/** A tenant config's kind: nothing runs on localhost. */
const CONFIG: KindFindings = {
  kind: 'config',
  parts: [
    { dir: '.', kind: 'config', evidence: [{ at: 'src/tenant.yaml', says: 'a tenant config' }] },
  ],
  runs: false,
  deployTools: [{ at: '.github/workflows/deploy.yml:29', says: 'a0deploy' }],
  systems: [],
  ports: [],
  templates: [],
  mappings: [],
  checks: [],
  failing: [],
  neverRead: [],
};
const SENTRY = {
  id: 'sentry',
  name: 'Sentry',
  what: 'errors and issues',
  why: 'package.json:4 @sentry/react',
  mcp: null,
  remote: null,
};
/** An MCP server the repo's own config names: a command, so no definition to offer. */
const ECHO = {
  id: 'echo',
  name: 'echo',
  what: 'an MCP server',
  why: '.mcp.json:3 mcpServers.echo',
  mcp: 'echo',
  remote: null,
};
const fact = (o: Partial<ConnectionFact> = {}): ConnectionFact => ({
  of: 'board',
  name: 'Board',
  source: null,
  state: 'ok',
  rows: [],
  why: null,
  fix: null,
  ...o,
});
const passed: GateResult = {
  passed: true,
  url: 'http://localhost:4100',
  answered: true,
  backends: [],
  reasons: [],
  options: [],
  unloaded: [],
  notUsed: [],
  warnings: [],
};
/** What `abe run start` asks first: a host start loads that nothing says is test. */
const UNKNOWN_BEFORE: GateResult = {
  ...passed,
  passed: false,
  url: '',
  answered: false,
  reasons: ['API_URL points at api.example.com: nothing says whether it is test or prod'],
  options: ['Change it: point API_URL at a backend on this machine or a test one'],
};
const AWS_USED = {
  logins: ['github', 'claude', 'aws'],
  aws: ['package.json:3 @aws-sdk/client-s3'],
};

const go = (i: Install, ...moves: InstallMove[]): Install =>
  moves.reduce((at, m) => {
    const s = moveInstall(at, m, AT);

    if (!s.ok) throw new Error(s.error.message);

    return s.data;
  }, i);
const refusal = (i: Install, m: InstallMove): string => {
  const s = moveInstall(i, m, AT);

  return s.ok ? 'moved' : `${s.error.code}: ${s.error.message}`;
};
const fresh = (join = false) => newInstall('/r', AT, join);
const read = (o: Partial<ReadFindings> = {}) =>
  go(fresh(), { kind: 'read', findings: findings(o) });
/** Each of `parts` passing, as checked at `at`. */
const passing = (i: Install, parts: readonly InstallPart[] = INSTALL_PARTS, at = AT): Install =>
  parts.reduce((n, p) => partChecked(n, p, partPassed(`${p} ok`), at), i);

describe('the record', () => {
  test('a 3.1 record (a stage machine) is none: never read, never migrated', () => {
    expect(Install.safeParse({ v: 1, repo: '/r', stage: null, done: {} }).success).toBe(false);
  });

  test('a 3.2 record reads as it is', () => {
    const i = passing(read());

    expect(Install.parse(JSON.parse(JSON.stringify(i)))).toEqual(i);
  });
});

describe('parts: Done once every required part passes or warns', () => {
  test('a new install: every part todo, Sources and Prototype optional, not done, a card refused naming the first', () => {
    const v = installView(fresh());

    expect(v.parts.map((p) => [p.id, p.state, p.required])).toEqual(
      INSTALL_PARTS.map((p) => [p, 'todo', p !== 'sources' && p !== 'prototype']),
    );
    expect(v.done).toBe(false);
    expect(cardInstallRefusal(fresh())).toEqual({
      code: 'install-not-done',
      message: 'finish the install first: Logins (abe install opens it)',
    });
    expect(cardInstallRefusal(undefined)?.code).toBe('no-install');
  });

  test('Done without Sources and Prototype; finished once; one failing later is not done, still finished', () => {
    const done = passing(
      fresh(),
      INSTALL_PARTS.filter((p) => p !== 'sources' && p !== 'prototype'),
    );
    const failing = partChecked(done, 'checks', partFailed('check-unproven', 'lint fails'), LATER);

    expect([installDone(done), done.finishedAt]).toEqual([true, AT]);
    expect([installDone(failing), failing.finishedAt, failing.parts.checks]).toEqual([
      false,
      AT,
      { state: 'fail', line: 'lint fails', checkedAt: LATER, why: 'check-unproven' },
    ]);
    expect(cardInstallRefusal(failing)).toBeNull();
  });

  test("a join: a team part that fails warns and Done goes on; the person's own still fail", () => {
    const join = fresh(true);
    const board = partChecked(join, 'board', partFailed('no-board', 'abe.yaml names no board'), AT);
    const logins = partChecked(join, 'logins', partFailed('logins', 'az missing'), AT);

    expect([board.parts.board?.state, logins.parts.logins?.state]).toEqual(['warn', 'fail']);
    // Env files is the team's (abe.yaml places the env files), its Abe env files the person's
    const unplaced = partChecked(join, 'env-files', envFilesPart(join, [], ['backend/.env']), AT);
    const missing = partChecked(join, 'env-files', envFilesPart(join, ['dev']), AT);

    expect([unplaced.parts['env-files']?.state, missing.parts['env-files']?.state]).toEqual([
      'warn',
      'fail',
    ]);
    expect(
      installDone(
        passing(
          board,
          INSTALL_PARTS.filter((p) => p !== 'board'),
        ),
      ),
    ).toBe(true);
  });
});

describe('moveInstall records, never gates', () => {
  test("an environment's aws profile: the person's or the install session's; another may set none", () => {
    const i = read(AWS_USED);

    expect(
      go(i, { kind: 'env-profile', env: 'dev', profile: 'shop-dev', by: 'person' }).envFiles,
    ).toEqual({ profiles: { dev: 'shop-dev' }, mapping: null });
    expect(
      refusal(i, { kind: 'env-profile', env: 'dev', profile: 'shop-dev', by: 'session' }),
    ).toStartWith('only-you:');
    expect(refusal(i, { kind: 'env-profile', env: 'dev', profile: null, by: 'session' })).toBe(
      'moved',
    );
    expect(refusal(i, { kind: 'env-profile', env: 'stage', profile: null, by: 'person' })).toBe(
      'no-environment: stage is none of dev, test, prod',
    );
  });

  test("the checks' environment: the person's over another session's", () => {
    const mine = go(fresh(), { kind: 'checks-env', env: 'test', by: 'person' });

    expect(checksEnvOf(mine)).toBe('test');
    // abe.yaml's checksEnv first (ADR 0040), the record's for an older install, else dev
    expect([checksEnvOf(mine, 'prod'), checksEnvOf(fresh(), null)]).toEqual(['prod', 'dev']);
    expect(
      refusal(mine, { kind: 'checks-env', env: 'dev', why: 'ci.yml:3', by: 'session' }),
    ).toStartWith('only-you:');
  });

  test('a source: added on its known server, or skipped; one a server here names added as it is', () => {
    const i = read({ sources: [SENTRY, ECHO] });

    expect(go(i, { kind: 'source-add', id: 'sentry', by: 'person' }).sourceServers.sentry).toEqual({
      from: 'known',
      transport: 'http',
      url: 'https://mcp.sentry.dev/mcp',
    });
    expect(refusal(i, { kind: 'source-add', id: 'echo', by: 'person' })).toStartWith('no-server:');
    expect(refusal(i, { kind: 'source-add', id: 'sentry', by: 'session' })).toStartWith(
      'only-you:',
    );
    expect(go(i, { kind: 'source-skip', id: 'echo' }).sources).toEqual({ echo: 'skip' });
    expect(go(i, { kind: 'sources', have: ['echo'] }).sources).toEqual({ echo: 'add' });
  });

  test('a sign-in: the person or the install session starts it; its end recorded', () => {
    const i = go(read({ sources: [SENTRY] }), { kind: 'source-add', id: 'sentry', by: 'person' });
    const signing = go(i, { kind: 'sign-in', id: 'sentry', by: 'person' });
    const ended = go(signing, { kind: 'signed-in', id: 'sentry', mcp: 'connected', probe: 'ok' });

    expect(refusal(i, { kind: 'sign-in', id: 'sentry', by: 'session' })).toStartWith('only-you:');
    expect([signing.signingIn, ended.signingIn, ended.sourceChecks.sentry?.probe]).toEqual([
      ['sentry'],
      [],
      'ok',
    ]);
  });

  test("the kind said: Read's findings with it, never by another session", () => {
    const i = go(fresh(), {
      kind: 'repo-kind',
      said: 'config',
      findings: findings({ kind: CONFIG }),
      by: 'person',
    });

    expect([i.kindSaid, i.read?.kind?.kind]).toEqual(['config', 'config']);
    expect(
      refusal(fresh(), { kind: 'repo-kind', said: 'config', findings: findings(), by: 'session' }),
    ).toStartWith('only-you:');
  });

  test("a record from before kinds: its shapeSaid and Read's shape read as the kind, web as web-app", () => {
    const shape = {
      ...CONFIG,
      kind: undefined,
      shape: 'config',
      parts: CONFIG.parts.map(({ kind, ...p }) => ({ ...p, shape: kind })),
    };
    const old = { ...fresh(), shapeSaid: 'web', read: { ...findings(), shape } };
    const i = Install.parse(JSON.parse(JSON.stringify(old)));

    expect([
      i.kindSaid,
      i.read?.kind?.kind,
      i.read?.kind?.parts[0]?.kind,
      'shapeSaid' in i,
    ]).toEqual(['web-app', 'config', 'config', false]);
  });

  test("the app can't run here: said why; a gate that passes later clears it", () => {
    const cant = go(fresh(), { kind: 'cannot-run', why: 'secrets only you have. ' });

    expect(cant.notRun).toEqual({ why: 'secrets only you have', at: AT });
    expect(go(cant, { kind: 'gate', result: passed }).notRun).toBeNull();
    expect(refusal(fresh(), { kind: 'cannot-run', why: ' ' })).toStartWith('usage:');
  });
});

describe("each part's check from the record", () => {
  const connected = (...facts: ConnectionFact[]) =>
    go(fresh(), { kind: 'connection', facts: [...facts] });

  test('Logins: each needed tool answers, GitHub and the cloud read right live', () => {
    const r = { needs: ['github', 'az', 'aws'], missing: ['az'], unchecked: [], ready: false };
    const ok = { logins: loginsSeen({ ...r, missing: [], ready: true }, ['aws']) };

    expect(loginsPart({ logins: loginsSeen(r, ['aws']), connection: null })).toEqual({
      state: 'fail',
      why: 'logins',
      line: 'az missing: abe login az',
    });
    expect(loginsPart({ ...ok, connection: null })).toEqual({
      state: 'pass',
      line: 'github, az answer',
    });
    expect(
      loginsPart({
        ...ok,
        connection: connected(
          fact({ of: 'github', name: 'GitHub', state: 'warning', why: 'not read' }),
        ).connection,
      }),
    ).toEqual({ state: 'warn', why: 'read-warning', line: 'github, az answer; GitHub: not read' });
    expect(
      loginsPart({
        ...ok,
        connection: connected(
          fact({
            of: 'cloud',
            name: 'Cloud',
            state: 'failed',
            why: 'no profile',
            fix: 'abe login aws',
          }),
        ).connection,
      }).line,
    ).toBe('Cloud: no profile (abe login aws)');
  });

  test("Board's live read: the board fact alone, a failure over its pass", () => {
    const i = connected(
      fact({ state: 'failed', why: '401' }),
      fact({ of: 'github', state: 'failed' }),
    );

    expect(withLiveRead(i, ['board'], partPassed('Azure Boards Shop/Web'))).toEqual({
      state: 'fail',
      why: 'read-failed',
      line: 'Board: 401',
    });
  });

  test('Sources: each found one added or skipped, each added one reads', () => {
    const i = go(read({ sources: [SENTRY, ECHO] }), { kind: 'sources', have: [] });
    const added = go(
      i,
      { kind: 'source-add', id: 'sentry', by: 'person' },
      { kind: 'source-skip', id: 'echo' },
    );

    expect(sourcesPart(read({ sources: [SENTRY] })).why).toBe('sources-unlooked');
    expect(sourcesPart(i).line).toBe(
      'sentry (package.json:4 @sentry/react), echo (.mcp.json:3 mcpServers.echo) not added or skipped: ask the person, then abe install source <id> (--url <its server> when none is known), or --skip',
    );
    expect(sourcesPart(added).line).toBe('Sentry is not checked yet; or skip it (--skip)');
    expect(
      sourcesPart(go(added, { kind: 'source-check', id: 'sentry', mcp: 'connected', probe: 'ok' })),
    ).toEqual({ state: 'pass', line: 'Sentry added and read; echo skipped' });
    const erred = go(added, {
      kind: 'source-check',
      id: 'sentry',
      mcp: 'connected',
      probe: 'tool-error',
    });

    expect(sourcesPart(erred).line).toBe(
      'Sentry answers, but its one read gave an error: check its server, then run the check again; or skip it (--skip)',
    );
    expect(
      sourcesPart(
        go(
          added,
          { kind: 'source-check', id: 'sentry', mcp: 'needs-auth', probe: null },
          { kind: 'source-check', id: 'sentry', mcp: 'connected', probe: 'tool-error' },
        ),
      ).line,
    ).toBe(
      'Sentry is signed in, but its one read gave an error: abe source sign-in again as an account that reads it; or skip it (--skip)',
    );
  });

  test('Env files: the three there, and an aws profile or none per environment when the repo uses aws', () => {
    const aws = read(AWS_USED);

    expect(envFilesPart(read(), ['prod']).line).toBe(
      '.abe/abe.prod.env not there: abe install env-map writes them, prefilled',
    );
    expect(envFilesPart(aws, []).line).toBe(
      'The repo uses aws, and dev, test, prod have no aws profile said: abe install env-profile <env> <profile|none>',
    );
    const said = go(
      aws,
      { kind: 'env-profile', env: 'dev', profile: 'shop-dev', by: 'person' },
      { kind: 'env-profile', env: 'test', profile: null, by: 'person' },
      { kind: 'env-profile', env: 'prod', profile: null, by: 'person' },
    );

    expect(envFilesPart(said, []).line).toBe(
      '.abe/abe.dev.env, .abe/abe.test.env, .abe/abe.prod.env are there; aws dev: shop-dev, test: none, prod: none',
    );
    expect(envFilesPart(said, [], ['backend/.env.local']).line).toBe(
      'backend/.env.local: placed in no abe.yaml worktree group nor env.notUsed: abe install env-map writes them there (a file you are not sure of, ask the person first)',
    );
  });

  test("the env files placed: abe.yaml's groups and env.notUsed first, the env map for the rest, Read's unplaced not sure", () => {
    const mapped = go(
      read({
        envFiles: [
          {
            path: 'backend/.env.local',
            example: false,
            keys: ['A'],
            tracked: false,
            credential: null,
            publicOnly: false,
          },
        ],
      }),
      {
        kind: 'env-map',
        files: ['backend/.env.prod -> dev: a guess', 'backend/.env.test -> test: ci.yml:4'],
        ciKeys: [],
        by: 'session',
      },
    );
    const placed = envFilesPlaced(mapped, { link: { prod: ['backend/.env.prod'] } }, [
      { key: 'backend/.env.old', why: 'nothing loads it' },
    ]);

    expect(placed.map((f) => [f.path, f.to, f.from, f.why])).toEqual([
      ['backend/.env.prod', ['prod'], 'recipe', 'abe.yaml worktree.link.prod · a guess'],
      ['backend/.env.old', 'not-used', 'recipe', 'nothing loads it'],
      ['backend/.env.test', ['test'], 'record', 'ci.yml:4'],
      ['backend/.env.local', 'not-sure', 'record', ENV_NOT_MAPPED],
    ]);
  });

  test('Checks: each listed one passed as serve ran it, none a way past a sandbox', () => {
    const lint = { name: 'lint', run: 'npm run lint' };
    const ran = go(fresh(), {
      kind: 'check-ran',
      runs: [{ run: 'npm run lint', ok: true, exit: 0 }],
    });

    expect(checksPart(fresh(), [lint], []).line).toBe(
      'lint (npm run lint) has not run: abe install try lint',
    );
    expect(checksPart(ran, [lint], ['TMPDIR=/tmp npm test'])).toMatchObject({
      state: 'fail',
      why: 'sandbox-workaround',
    });
    expect(checksPart(ran, [lint], [])).toEqual({
      state: 'pass',
      line: 'lint pass as serve runs them',
    });
  });

  test("Verify's run: the gate passed, nothing to run here, or it can't run here as the person chose", () => {
    expect(ranLocally(fresh()).why).toBe('not-run');
    expect(ranLocally(go(fresh(), { kind: 'gate', result: UNKNOWN_BEFORE })).line).toBe(
      'The gate did not pass: API_URL points at api.example.com: nothing says whether it is test or prod (Change it: point API_URL at a backend on this machine or a test one)',
    );
    expect(ranLocally(go(fresh(), { kind: 'gate', result: passed })).line).toBe(
      'The gate passed: http://localhost:4100',
    );
    expect(ranLocally(read({ kind: CONFIG })).line).toBe(
      'Nothing to run here: config as code, deployed by a0deploy',
    );
    expect(ranLocally(go(fresh(), { kind: 'cannot-run', why: 'no VPN here' })).line).toBe(
      "It can't run here, as the person chose: no VPN here",
    );
  });

  // the Board check: what serve read of the setting and the board login, recorded, then judged
  const LAYER_BOARD = {
    provider: 'azure-boards' as const,
    name: 'Shop/Web',
    from: 'repo' as const,
  };
  const BOARD_READ: BoardReads = {
    problem: null,
    inForce: LAYER_BOARD,
    unreadable: null,
    merges: null,
    specWritten: true,
    specWhere: 'issue',
    unmet: null,
  };
  const DEPLOYS = {
    deploys: [{ file: 'ci.yml', line: 3, job: 'deploy', env: 'test', prod: false }],
  };

  test.each<[string, Partial<ReadFindings>, Partial<BoardReads>, string, string | null]>([
    [
      'a setting that does not parse: the board Read found kept',
      {},
      { problem: { file: 'abe.yaml', message: 'not a board' } },
      'fail: abe.yaml: board: not a board',
      'Shop/Web',
    ],
    [
      "the repo's GitHub Issues: its cards are read",
      {},
      { inForce: { provider: 'github-issues', name: 'acme/shop', from: 'repo' } },
      'pass: GitHub Issues acme/shop; specs go to issue',
      'acme/shop',
    ],
    [
      'Jira: no cards from it yet',
      {},
      { inForce: { provider: 'jira', name: 'PROJ', from: 'repo' } },
      "fail: Jira has no cards in Abe yet: write the repo's GitHub Issues (provider: github), an Azure Boards board or one On this machine",
      'PROJ',
    ],
    [
      "the board login can't read it: taken out, the repo's own offered",
      {},
      { unreadable: { organization: 'https://dev.azure.com/acme', why: 'TF400813: 401' } },
      "fail: The repo's settings name acme/Shop/Web, which your az login can't read (401); nothing in the repo names a board: write the repo's own board, or sign in to az as an account that reads this one",
      null,
    ],
    [
      'a merge deploys, who merges unwritten',
      DEPLOYS,
      {},
      'fail: a merge here deploys test: ask the person who merges, then write it in abe.yaml (overrides: { autoMerge: { value: <true for auto merge when green>, reason: "a merge here deploys test" } })',
      'Shop/Web',
    ],
    [
      'passing: who merges, where specs go, the workflows its types never preselect',
      DEPLOYS,
      {
        merges: true,
        specWhere: 'file',
        unmet: { workflows: [{ name: 'Bugfix', types: ['Bug'] }], fallback: 'Feature' },
      },
      "pass: Azure Boards Shop/Web; auto merge when green; specs go to file; no Bug cards (board.types): Bugfix never preselected, every card preselects Feature; add the board's kind for each to board.types when it has one",
      'Shop/Web',
    ],
  ])('Board: %s', (_, findings, reads, said, kept) => {
    const r = { ...BOARD_READ, ...reads };
    const i = boardRecorded(read(findings), r, AT);
    const v = boardPart(i, r);

    expect([`${v.state}: ${v.line}`, i.board?.name ?? null]).toEqual([said, kept]);
  });

  test.each<[string, Partial<VerifyReads>, Install, string]>([
    ['the app never ran: nothing else read', {}, fresh(), 'fail: not-run'],
    [
      'the pack refused',
      { pack: partFailed('no-verify-skill', 'no skill') },
      go(fresh(), { kind: 'cannot-run', why: 'no VPN' }),
      'fail: no-verify-skill',
    ],
    [
      'a check failing again after the pack',
      { listed: [{ name: 'unit', run: 'make unit' }] },
      go(
        fresh(),
        { kind: 'cannot-run', why: 'no VPN' },
        {
          kind: 'check-ran',
          runs: [{ run: 'make unit', ok: false, exit: 1 }],
        },
      ),
      'fail: checks-after-pack',
    ],
    [
      'the checks pass again: written, proven unless it cannot run here',
      { listed: [{ name: 'unit', run: 'make unit' }] },
      go(
        fresh(),
        { kind: 'cannot-run', why: 'no VPN' },
        {
          kind: 'check-ran',
          runs: [{ run: 'make unit', ok: true, exit: 0 }],
        },
      ),
      "pass: It can't run here, as the person chose: no VPN; verify-r is written; the checks pass again",
    ],
  ])('Verify: %s', (_, reads, i, said) => {
    const v = verifyPart(i, {
      ran: ranLocally(i),
      query: null,
      pack: null,
      listed: [],
      skill: 'verify-r',
      ...reads,
    });

    expect(`${v.state}: ${v.state === 'pass' ? v.line : (v.why ?? '')}`).toBe(said);
  });

  test('Done: the required parts pass; its line names the files to commit', () => {
    const rest = INSTALL_PARTS.filter((p) => p !== 'done' && p !== 'sources');

    expect(donePart(passing(fresh(), ['logins']), []).line).toBe(
      'Board, Env files, Worktree, Checks, Workflows, Skills, Verify do not pass yet',
    );
    expect(donePart(passing(fresh(), rest), ['abe.yaml', '.claude/skills/shop-testing'])).toEqual({
      state: 'pass',
      line: 'Every part passes: commit and push abe.yaml, .claude/skills/shop-testing',
    });
  });
});

describe('the status (`abe install status --json`) and its words', () => {
  test('the contract: repo, join, session, each part, done, the files', () => {
    const i = partChecked(
      { ...fresh(true), session: 'install-1a2b' },
      'logins',
      partPassed('github answers'),
      AT,
    );
    const v = installView(i, 'waiting');

    expect({ ...v, parts: v.parts.slice(0, 3) }).toEqual({
      repo: '/r',
      join: true,
      session: { id: 'install-1a2b', state: 'waiting' },
      parts: [
        { id: 'logins', required: true, state: 'pass', line: 'github answers', checkedAt: AT },
        { id: 'board', required: true, state: 'todo', line: null, checkedAt: null },
        { id: 'sources', required: false, state: 'todo', line: null, checkedAt: null },
      ],
      done: false,
      files: [],
      read: null,
      prototype: null,
    });
    expect(installView(fresh()).session).toBeNull();
    expect(installViewText(v).split('\n').slice(0, 5)).toEqual([
      'install /r (join): 1 of 9 required parts pass',
      'session install-1a2b (waiting)',
      '  ✓ Logins: github answers',
      '  ○ Board',
      '  ○ Sources (optional)',
    ]);
  });

  test('a check: its parts said; exit 1 when one it checked fails, never on a warning', () => {
    const i = partChecked(
      partChecked(fresh(true), 'board', partFailed('no-board', 'no board'), AT),
      'logins',
      partFailed('logins', 'az missing: abe login az'),
      AT,
    );
    const warned = { ...installView(i), checked: ['board' as const] };
    const both = { ...installView(i), checked: ['board' as const, 'logins' as const] };

    expect([installCheckFailed(warned), installCheckFailed(both)]).toEqual([false, true]);
    expect(installCheckedText(both)).toBe(
      '✗ Logins: az missing: abe login az\n! Board: no board\n',
    );
  });
});

describe('aws off for what an install runs: until Logins checked it', () => {
  const awsOk = { needs: ['github', 'aws'], missing: [], unchecked: [], ready: true };

  test.each<[string, Install | undefined, 'unchecked' | null]>([
    ['no record', undefined, 'unchecked'],
    ['not checked yet', fresh(), 'unchecked'],
    [
      'aws missing',
      go(read(AWS_USED), {
        kind: 'logins',
        logins: { ...awsOk, missing: ['aws'], ready: false },
        skip: [],
      }),
      'unchecked',
    ],
    ['aws checked ok', go(read(AWS_USED), { kind: 'logins', logins: awsOk, skip: [] }), null],
  ])('%s', (_, i, off) => {
    expect(installAwsOff(i)).toBe(off);
    // a local-mode card session's guards follow it
    expect(localModeGuards(i).awsOff).toBe(i !== undefined && off !== null);
  });
});

describe('abe run starts the app all the same, with what the gate would not pass as its warning', () => {
  const KEYS =
    '.claude/skills/run-app/scripts/start loads .env.aws (its name says aws): the app reaches a real cloud account with those keys';

  test.each<[string, GateResult, string | null]>([
    ['every backend local or test: no warning', { ...passed, url: '' }, null],
    [
      'a backend nothing says is test: the reason and the ways on',
      UNKNOWN_BEFORE,
      'warning, started all the same: API_URL points at api.example.com: nothing says whether it is test or prod. Ways on: Change it: point API_URL at a backend on this machine or a test one',
    ],
    [
      'cloud credentials: it passes, the warning stays',
      { ...passed, url: '', warnings: [KEYS] },
      `warning, started all the same: ${KEYS}`,
    ],
  ])('%s', (_, result, warning) => {
    expect(beforeRunWarning(result)).toBe(warning);
  });
});

describe('a moved repo: what its id met at a folder means, and its paths after', () => {
  const ID = '0123456789abcdef';

  test.each([
    [
      'no id yet',
      { at: '/r/b', id: undefined, seen: undefined, stillThere: false },
      { kind: 'new' },
    ],
    [
      'an id never seen',
      { at: '/r/b', id: ID, seen: undefined, stillThere: false },
      { kind: 'new' },
    ],
    ['seen here', { at: '/r/b', id: ID, seen: '/r/b', stillThere: true }, { kind: 'known' }],
    [
      'seen elsewhere, gone there',
      { at: '/r/b', id: ID, seen: '/r/a', stillThere: false },
      { kind: 'moved', from: '/r/a' },
    ],
    [
      'seen elsewhere, still there',
      { at: '/r/b', id: ID, seen: '/r/a', stillThere: true },
      { kind: 'copy' },
    ],
  ] as const)('%s', (_, o, want) => {
    expect(sighting(o)).toEqual(want);
  });

  test.each([
    ['the repo', '/r/a', '/r/b'],
    ['inside it', '/r/a/.git/hooks/abe', '/r/b/.git/hooks/abe'],
    ['a card worktree beside it', '/r/a-wt/4-sign-in', '/r/a-wt/4-sign-in'],
    ['a folder sharing its prefix', '/r/ab', '/r/ab'],
  ])('%s', (_, path, want) => {
    expect(rehomed(path, '/r/a', '/r/b')).toBe(want);
  });

  const move = (m: Partial<RepoMoved>): RepoMoved => ({
    from: '/r/a',
    to: '/r/b',
    seenAt: '/r/b',
    install: false,
    sessions: 0,
    runs: 0,
    worktrees: [],
    problems: [],
    ...m,
  });

  test.each([
    ['nothing of it kept', move({}), '/r/a moved to /r/b'],
    [
      'what followed',
      move({ install: true, sessions: 2, runs: 1, worktrees: ['/r/a-wt/4'] }),
      '/r/a moved to /r/b: its install, 2 sessions, 1 run, 1 worktree followed',
    ],
    [
      'what did not',
      move({ sessions: 1, problems: ['/r/a-wt/4: not a git repository'] }),
      '/r/a moved to /r/b: 1 session followed; not followed: /r/a-wt/4: not a git repository',
    ],
    [
      'not found',
      move({ to: null, seenAt: '/r/a-wt/4' }),
      '/r/a-wt/4 belongs to /r/a, which is gone: open the repo where it is now and Abe repairs it',
    ],
  ])('%s', (_, m, want) => {
    expect(repoMovedText(m)).toBe(want);
  });
});
