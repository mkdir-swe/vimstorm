/**
 * `abe workspace up|status` on a box's `serve`, through the socket protocol with a fake Docker:
 * a fresh up (image, clone, database, container, socket), an idempotent re-run, a box stop and
 * start, and the workspace's own socket.
 */
import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunData,
  type BoxHost,
  type LoginSet,
  type Logins,
  readEnvelope,
  type Reply,
  type AbeRelease,
  StatusData,
  WorkspaceData,
  WorkspaceList,
  WorkspaceRemoved,
} from '@abe/core';
import {
  fakeCompose,
  type FakeDocker,
  heldEvents,
  LOCAL_DOCKER,
  scenario,
  type ServeScenario,
} from '@abe/testing';
import { type z } from 'zod';

const REPO = 'mkdir-swe/demo-shop';
const IMAGE = 'abe-workspace-mkdir-swe-demo-shop:latest';

const data = <T extends z.ZodType>(schema: T, reply: Reply): z.output<T> => {
  const doc = readEnvelope(schema, JSON.parse(reply.stdout));

  if (!doc.ok) throw new Error(`${doc.error.code}: ${doc.error.message}`);

  return doc.data;
};

const errorOf = (reply: Reply) => {
  const doc = readEnvelope(WorkspaceData, JSON.parse(reply.stdout));

  if (doc.ok) throw new Error(`expected a refusal, got ${reply.stdout}`);

  return doc.error.code;
};

const onBox = async (log?: (message: string) => void) => {
  const s = await scenario({ box: true, ...(log === undefined ? {} : { log }) });

  s.box.mirrors.trees.set(REPO, 'tree1');

  return s;
};

/** A box whose machine is `host`, read on its real 10 min timer (shorter, it reads before the test). */
const onBoxWith = async (host: BoxHost, log?: (message: string) => void) => {
  const s = await scenario({
    box: true,
    boxHost: host,
    ...(log === undefined ? {} : { log }),
  });

  s.box.mirrors.trees.set(REPO, 'tree1');

  return s;
};

const up = (s: ServeScenario, card = '101', title = 'Cart total is wrong') =>
  s.request('workspace', 'up', '--repo', REPO, '--card', card, '--title', title, '--json');

const loginsOf = (github: string): Logins => ({
  read: () => Promise.resolve({ ok: true, data: { claude: 'fake-claude-login', github } }),
});

const GH_SETUP_GIT = 'gh auth setup-git --hostname github.com';

/** Each `gh auth login --with-token` in a container: where, and what went on stdin. */
const ghLogins = (s: ServeScenario) =>
  s.box.docker.execs
    .filter((e) => e.argv.join(' ') === 'gh auth login --hostname github.com --with-token')
    .map((e) => ({ name: e.name, stdin: e.stdin }));

/** What each base build's `abe-bin` context held as its binary, read while it builds. */
const bakedBinaries = (docker: FakeDocker) => {
  const baked: string[] = [];
  const build = docker.build;

  docker.build = (b) => {
    const dir = b.contexts?.['abe-bin'];

    if (dir !== undefined) baked.push(readFileSync(join(dir, 'abe-linux-arm64'), 'utf8'));

    return build(b);
  };

  return baked;
};

/** The SQL that makes the workspace's role and database (not the access rules' reload). */
const pgSql = (s: ServeScenario) =>
  s.box.docker.execs.filter(
    (e) => e.name === 'abe-pg' && e.argv[0] === 'psql' && e.stdin?.includes('ROLE') === true,
  );

describe('abe workspace up', () => {
  test("a fresh box: the image, the clone on the card's branch, a database and the container", async () => {
    await using s = await onBox();
    const reply = await up(s);

    expect(reply.exit).toBe(0);
    expect(data(WorkspaceData, reply)).toEqual({
      repo: REPO,
      card: '101',
      branch: 'card/101-cart-total-is-wrong',
      state: 'running',
      container: 'abe-ws-101',
      image: IMAGE,
      database: 'ws_101',
      imageCurrent: true,
    });
    const { docker } = s.box;

    // The workspace image, built from the mirror's .abe/session on the base.
    expect(docker.builds).toEqual([
      {
        tag: IMAGE,
        context: `/box/build/${REPO}`,
        dockerfile: `/box/build/${REPO}/.abe/session/Dockerfile`,
        args: { BASE_IMAGE: 'abe-base:latest', SESSION_USER: 'abe' },
        labels: { 'abe.image.tree': 'tree1', 'abe.base.id': 'sha256:base1' },
      },
    ]);
    // The clone: the workspace image, no network, the mirror read-only, into the volume.
    expect(docker.onces).toHaveLength(1);
    expect(docker.onces[0]).toMatchObject({
      image: IMAGE,
      network: 'none',
      mounts: [
        { type: 'volume', source: 'abe-ws-101', target: '/workspace' },
        { type: 'bind', source: `/box/mirrors/${REPO}.git`, target: '/src.git', readOnly: true },
      ],
    });
    expect(docker.onces[0]?.argv?.join(' ')).toContain(
      "git checkout -q -b 'card/101-cart-total-is-wrong'",
    );
    // The box's one Postgres and the workspace's database in it.
    expect(docker.containersByName.get('abe-pg')?.spec).toMatchObject({
      image: 'postgres:17-alpine',
      network: 'abe-net',
      restart: 'unless-stopped',
      mounts: [
        { type: 'volume', source: 'abe-pg-data', target: '/var/lib/postgresql/data' },
        { type: 'volume', source: 'abe-pg-socket', target: '/var/run/postgresql' },
      ],
    });
    const [sql] = pgSql(s);

    // serve is Postgres' superuser by peer only (docker exec as postgres); each workspace's role
    // logs in to the database of its own name with its password, and no other role over TCP.
    expect(sql?.user).toBe('postgres');
    const hba = s.box.docker.execs.find(
      (e) => e.name === 'abe-pg' && e.stdin?.includes('local all postgres peer') === true,
    );

    expect(hba?.user).toBe('postgres');
    expect(hba?.stdin).toContain('local sameuser all scram-sha-256');
    expect(hba?.stdin).toContain('host all all all reject');
    expect(
      s.box.docker.execs.some(
        (e) => e.user === 'postgres' && e.stdin?.includes('pg_reload_conf()') === true,
      ),
    ).toBe(true);
    expect(sql?.stdin).toContain('ALTER ROLE ws_101 LOGIN PASSWORD');
    expect(sql?.stdin).toContain('REVOKE ALL ON DATABASE ws_101 FROM PUBLIC;');
    // The container: hardened, bounded, the socket mounted, the database handed in.
    const ws = docker.containersByName.get('abe-ws-101');

    expect(ws?.state).toBe('running');
    expect(ws?.spec).toMatchObject({
      image: IMAGE,
      // Its own network (ADR 0022): no other card's container on it.
      network: 'abe-ws-101',
      hardened: true,
      limits: { memory: '3g', pids: 1024, shm: '256m' },
      seccomp: join(s.state.dir, 'seccomp-chromium.json'),
      // Docker's AppArmor profile denies every mount, so Claude Code's bwrap could not start; its
      // own allows only bwrap's (#67, images/box/apparmor).
      apparmor: 'abe-workspace',
      // Docker's masked /proc paths stop the jail's bwrap mounting a /proc of its own.
      systemPaths: 'unconfined',
      labels: {
        'abe.role': 'workspace',
        'abe.card': '101',
        'abe.image.id': 'sha256:built1',
        'abe.apparmor': 'abe-workspace',
        'abe.systempaths': 'unconfined',
      },
      mounts: [
        { type: 'volume', source: 'abe-ws-101', target: '/workspace' },
        // serve's sockets: connecting needs no write, so nothing inside can plant a file there.
        {
          type: 'bind',
          source: join(s.state.dir, 'workspaces', '101'),
          target: '/run/abe',
          readOnly: true,
        },
        // Postgres' socket: a sandboxed command reaches no TCP but a unix socket (#67).
        { type: 'volume', source: 'abe-pg-socket', target: '/run/postgresql', readOnly: true },
      ],
    });
    expect(ws?.spec.restart).toBeUndefined();
    expect(ws?.spec.env.ABE_WORKSPACE).toBe('101');
    expect(ws?.spec.env.DATABASE_URL).toMatch(
      /^postgresql:\/\/ws_101:[0-9a-f]{32}@\/ws_101\?host=\/run\/postgresql$/,
    );
    expect(sql?.stdin).toContain(ws?.spec.env.DATABASE_URL?.split(/[:@]/)[2] ?? 'missing');
    // Checked first: Docker puts a container of the image under abe-workspace, in force.
    expect(docker.confinements).toEqual([{ image: IMAGE, apparmor: 'abe-workspace' }]);
    const profile = readFileSync(join(s.state.dir, 'seccomp-chromium.json'), 'utf8');
    const namespaceFlags = 0x7e020000; // CLONE_NEWNS | CLONE_NEWCGROUP … CLONE_NEWNET
    expect(profile).toContain(`"value":${namespaceFlags}`);
    expect(profile).not.toContain('CLONE_NAMESPACE_FLAGS');
    expect(statSync(join(s.state.dir, 'workspaces', '101', 'serve.sock')).mode & 0o777).toBe(0o666);
    // The sessions' socket folder, there before any session: the jail mounts a tmpfs over it, and
    // /run/abe is read-only inside, so bwrap could not make it.
    const sessions = statSync(join(s.state.dir, 'workspaces', '101', 's'));

    expect(sessions.isDirectory()).toBe(true);
    expect(sessions.mode & 0o777).toBe(0o755);
  });

  test("a box's Postgres from before the socket is made again on its data volume", async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await docker.network('abe-net');
    await docker.run({
      name: 'abe-pg',
      image: 'postgres:17-alpine',
      labels: { 'abe.role': 'postgres' },
      env: { POSTGRES_PASSWORD: 'x' },
      mounts: [{ type: 'volume', source: 'abe-pg-data', target: '/var/lib/postgresql/data' }],
      network: 'abe-net',
      limits: { memory: '512m', pids: 512, shm: '128m' },
      restart: 'unless-stopped',
    });
    expect((await up(s)).exit).toBe(0);
    const pg = docker.containersByName.get('abe-pg')?.spec;

    expect(pg?.mounts.map((m) => m.source)).toEqual(['abe-pg-data', 'abe-pg-socket']);
    expect(docker.runs.filter((r) => r.name === 'abe-pg')).toHaveLength(2);
  });

  test("a workspace from before Postgres' socket is made again on its volume, with the socket's URL", async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s);
    const ws = docker.containersByName.get('abe-ws-101');

    if (ws === undefined) throw new Error('no workspace');
    // As one made before #67: no socket mount, a TCP DATABASE_URL, no socket label.
    const labels = Object.fromEntries(
      Object.entries(ws.spec.labels).filter(([key]) => key !== 'abe.pg.socket'),
    );

    ws.spec = {
      ...ws.spec,
      labels,
      env: { ...ws.spec.env, DATABASE_URL: 'postgres://workspace:x@abe-pg:5432/workspace' },
    };
    await up(s);
    const now = docker.containersByName.get('abe-ws-101')?.spec;

    expect(docker.runs.filter((r) => r.name === 'abe-ws-101')).toHaveLength(2);
    expect(now?.env.DATABASE_URL).toContain('host=/run/postgresql');
  });

  test.each([
    ["under Docker's AppArmor profile (no label)", undefined],
    ['unconfined (2.0.0-alpha.0-3760364d)', 'unconfined'],
  ])('a workspace %s is made again under abe-workspace, once nobody is in it', async (_, was) => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s);
    const ws = docker.containersByName.get('abe-ws-101');

    if (ws === undefined) throw new Error('no workspace');
    const labels = Object.fromEntries(
      Object.entries(ws.spec.labels).filter(([key]) => key !== 'abe.apparmor'),
    );
    const spec = {
      ...ws.spec,
      labels: was === undefined ? labels : { ...labels, 'abe.apparmor': was },
    };

    // Only its label tells up how it was made (an old one ran with apparmor=unconfined).
    delete spec.apparmor;
    ws.spec = spec;
    await up(s);
    const now = docker.containersByName.get('abe-ws-101')?.spec;

    expect(docker.runs.filter((r) => r.name === 'abe-ws-101')).toHaveLength(2);
    expect(now?.apparmor).toBe('abe-workspace');
    expect(now?.labels['abe.apparmor']).toBe('abe-workspace');
    // Made again only once: the new one is current.
    await up(s);
    expect(docker.runs.filter((r) => r.name === 'abe-ws-101')).toHaveLength(2);
  });

  test("a workspace made with Docker's masked /proc (no label) is made again unmasked, once nobody is in it", async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s);
    const ws = docker.containersByName.get('abe-ws-101');

    if (ws === undefined) throw new Error('no workspace');
    const spec = {
      ...ws.spec,
      labels: Object.fromEntries(
        Object.entries(ws.spec.labels).filter(([key]) => key !== 'abe.systempaths'),
      ),
    };

    // Only its label tells up how it was made: under it, the jail's bwrap mounts no /proc.
    delete spec.systemPaths;
    ws.spec = spec;
    await up(s);
    const now = docker.containersByName.get('abe-ws-101')?.spec;

    expect(docker.runs.filter((r) => r.name === 'abe-ws-101')).toHaveLength(2);
    expect(now?.systemPaths).toBe('unconfined');
    expect(now?.labels['abe.systempaths']).toBe('unconfined');
    // Made again only once: the new one is current.
    await up(s);
    expect(docker.runs.filter((r) => r.name === 'abe-ws-101')).toHaveLength(2);
  });

  test('a box where abe-workspace is not in force refuses up and makes no workspace', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    // AppArmor off on the host (or the profile not loaded): Docker would run it unconfined.
    docker.apparmor.clear();
    const reply = await up(s);

    expect(reply.exit).not.toBe(0);
    expect(errorOf(reply)).toBe('no-apparmor');
    expect(docker.confinements).toEqual([{ image: IMAGE, apparmor: 'abe-workspace' }]);
    expect(docker.runs.filter((r) => r.name === 'abe-ws-101')).toEqual([]);
  });

  test('a stopped workspace is not started again once abe-workspace is not in force', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    expect((await up(s)).exit).toBe(0);
    docker.boxStop();
    docker.apparmor.clear();
    expect(errorOf(await up(s))).toBe('no-apparmor');
    expect(docker.containersByName.get('abe-ws-101')?.state).toBe('exited');
  });

  test('Docker refusing the probe (AppArmor on, the profile never loaded) is no-apparmor too', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    docker.confinement = () =>
      Promise.reject(new Error('docker run failed: the abe-workspace profile could not be loaded'));
    expect(errorOf(await up(s))).toBe('no-apparmor');
    expect(docker.runs.filter((r) => r.name === 'abe-ws-101')).toEqual([]);
  });

  test("the clone's commits are the person's: git's identity from their GitHub login", async () => {
    const github = 'fake-github-login';
    const set: LoginSet = { claude: 'fake-claude-login', github };
    await using s = await scenario({
      box: true,
      logins: { read: () => Promise.resolve({ ok: true, data: set }) },
    });
    const { docker } = s.box;

    s.box.mirrors.trees.set(REPO, 'tree1');
    docker.onExec = (name, argv) =>
      name === 'abe-ws-101' && argv.join(' ').includes('gh api user')
        ? {
            exit: 0,
            stdout: JSON.stringify({ login: 'octocat', id: 583231, name: 'The Octocat' }),
            stderr: '',
          }
        : { exit: 0, stdout: '', stderr: '' };

    expect(data(WorkspaceData, await up(s)).author).toBe(
      'The Octocat <583231+octocat@users.noreply.github.com>',
    );
    const asked = docker.execs.find((e) => e.argv.join(' ').includes('gh api user'));

    // The token on stdin, never on a command line; as the workspace's user, in the container.
    expect(asked).toMatchObject({ name: 'abe-ws-101', stdin: `${github}\n` });
    expect(asked?.user).toBeUndefined();
    expect(docker.execs.flatMap((e) => e.argv).join(' ')).not.toContain(github);
    const config = docker.execs.find((e) => e.argv.join(' ').includes('config user.name'));

    // In the clone (the container's workdir): what Claude Code's commits are authored as.
    expect(config?.argv.slice(-3)).toEqual([
      '/workspace/repo',
      'The Octocat',
      '583231+octocat@users.noreply.github.com',
    ]);
  });

  test("up logs the workspace's gh in with the person's GitHub login, on stdin only", async () => {
    const github = 'fake-github-login';
    await using s = await scenario({ box: true, logins: loginsOf(github) });
    const { docker } = s.box;

    s.box.mirrors.trees.set(REPO, 'tree1');
    expect((await up(s)).exit).toBe(0);
    expect(ghLogins(s)).toEqual([{ name: 'abe-ws-101', stdin: `${github}\n` }]);
    // Then git asks gh for that login: the pr stage's push and gh in the container.
    expect(docker.execs.some((e) => e.argv.join(' ') === GH_SETUP_GIT)).toBe(true);
    expect(docker.execs.flatMap((e) => e.argv).join(' ')).not.toContain(github);
  });

  test('a serve started again on a box with a workspace logs its gh in before it answers, with no launch', async () => {
    const github = 'fake-github-login';
    const logins = loginsOf(github);
    const s = await scenario({ box: true, logins });

    s.box.mirrors.trees.set(REPO, 'tree1');
    await up(s);
    await s.serve.stop();
    // The container keeps running; only serve restarts (an upgrade, a crash).
    s.box.docker.execs.length = 0;
    await using again = await scenario({ state: s.state, box: s.box, logins });

    // Done once serve is up: the pr stage's first read and the deploy poll come after.
    expect(ghLogins(again)).toEqual([{ name: 'abe-ws-101', stdin: `${github}\n` }]);
    expect(again.box.docker.execs.some((e) => e.argv.join(' ') === GH_SETUP_GIT)).toBe(true);
    expect(again.box.docker.execs.some((e) => e.argv.includes('new-session'))).toBe(false);
    expect(again.box.docker.execs.flatMap((e) => e.argv).join(' ')).not.toContain(github);
  });

  test('a serve started again with no workspace, or no logins, logs nothing in', async () => {
    await using bare = await scenario({ box: true, logins: loginsOf('fake-github-login') });

    expect(ghLogins(bare)).toEqual([]);
    const s = await onBox();

    await up(s);
    await s.serve.stop();
    s.box.docker.execs.length = 0;
    await using again = await scenario({ state: s.state, box: s.box });

    expect(ghLogins(again)).toEqual([]);
  });

  test('a serve started again whose logins cannot be read starts all the same, and says so', async () => {
    const s = await scenario({ box: true, logins: loginsOf('fake-github-login') });

    s.box.mirrors.trees.set(REPO, 'tree1');
    await up(s);
    await s.serve.stop();
    s.box.docker.execs.length = 0;
    const said: string[] = [];
    await using again = await scenario({
      state: s.state,
      box: s.box,
      log: (m) => said.push(m),
      logins: { read: () => Promise.reject(new Error('the restore failed')) },
    });

    expect(ghLogins(again)).toEqual([]);
    expect(said).toContain("the workspace's gh was not logged in: the restore failed");
    expect((await again.request('workspace', 'status', '--json')).exit).toBe(0);
  });

  test("a gh login that fails leaves up done, and says so in serve's log", async () => {
    const said: string[] = [];
    await using s = await scenario({
      box: true,
      log: (m) => said.push(m),
      logins: loginsOf('fake-github-login'),
    });

    s.box.mirrors.trees.set(REPO, 'tree1');
    s.box.docker.onExec = (_, argv) =>
      argv.join(' ').startsWith('gh auth login')
        ? { exit: 1, stdout: '', stderr: 'error connecting to api.github.com' }
        : { exit: 0, stdout: '', stderr: '' };

    expect(data(WorkspaceData, await up(s)).state).toBe('running');
    expect(
      said.some((m) => m.startsWith("the workspace's gh was not logged in: gh auth login")),
    ).toBe(true);
  });

  test('with no logins (or GitHub not answering) up still makes the workspace, no author', async () => {
    await using s = await onBox();

    expect(data(WorkspaceData, await up(s)).author).toBeUndefined();
    expect(s.box.docker.execs.some((e) => e.argv.join(' ').includes('gh api user'))).toBe(false);
  });

  test('run again it changes nothing: no build, no new container, the clone kept', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s);
    const again = await up(s);

    expect(data(WorkspaceData, again).state).toBe('running');
    expect(docker.builds).toHaveLength(1);
    expect(docker.runs.filter((r) => r.name === 'abe-ws-101')).toHaveLength(1);
    expect(pgSql(s)).toHaveLength(1);
  });

  test('after a box stop and start it brings the container back with its volume', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s);
    docker.boxStop();
    expect(
      data(WorkspaceList, await s.request('workspace', 'status', '--json')).workspaces[0]?.state,
    ).toBe('stopped');
    const back = await up(s);

    expect(data(WorkspaceData, back)).toMatchObject({
      state: 'running',
      branch: 'card/101-cart-total-is-wrong',
    });
    expect(docker.volumes.has('abe-ws-101')).toBe(true);
    expect(docker.runs.filter((r) => r.name === 'abe-ws-101')).toHaveLength(1);
  });

  test('after the box starts again Docker brings Postgres back, the workspace waits for up; up makes nothing new', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s);
    docker.boxStop();
    docker.boxStart();
    // No restart policy on the workspace: only up, after its AppArmor check, starts it again.
    expect(docker.containersByName.get('abe-pg')?.state).toBe('running');
    expect(docker.containersByName.get('abe-ws-101')?.state).toBe('exited');
    expect(data(WorkspaceData, await up(s)).state).toBe('running');
    expect(docker.runs.map((r) => r.name)).toEqual(['abe-pg', 'abe-ws-101']);
    expect(pgSql(s)).toHaveLength(1);
  });

  test('a box that starts with abe-workspace not in force keeps its workspace down', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    expect((await up(s)).exit).toBe(0);
    docker.boxStop();
    docker.apparmor.clear();
    docker.boxStart();
    expect(errorOf(await up(s))).toBe('no-apparmor');
    expect(docker.containersByName.get('abe-ws-101')?.state).toBe('exited');
  });

  test("a container made again is labelled with the clone's own branch, whatever the title", async () => {
    await using s = await onBox();
    const { docker, mirrors } = s.box;

    docker.onOnce = () => ({ exit: 0, stdout: 'card/101-cart-total-is-wrong\n', stderr: '' });
    await up(s);
    mirrors.trees.set(REPO, 'tree2');
    const again = await s.request('workspace', 'up', '--repo', REPO, '--card', '101', '--json');

    expect(data(WorkspaceData, again).branch).toBe('card/101-cart-total-is-wrong');
    expect(docker.runs.at(-1)?.labels['abe.branch']).toBe('card/101-cart-total-is-wrong');
  });

  test('a newer image waits while a session runs; the next up with nobody there switches', async () => {
    await using s = await onBox();
    const { docker, mirrors } = s.box;
    let probe = 'p bash\np claude\n';

    docker.onExec = (name, argv) =>
      name === 'abe-ws-101' && argv[0] === 'sh'
        ? { exit: 0, stdout: probe, stderr: '' }
        : { exit: 0, stdout: '', stderr: '' };
    await up(s);
    mirrors.trees.set(REPO, 'tree2');
    expect(data(WorkspaceData, await up(s))).toMatchObject({
      state: 'running',
      imageCurrent: false,
    });
    expect(docker.runs.filter((r) => r.name === 'abe-ws-101')).toHaveLength(1);
    probe = 'p bash\n';
    expect(data(WorkspaceData, await up(s)).imageCurrent).toBe(true);
    expect(docker.runs.filter((r) => r.name === 'abe-ws-101')).toHaveLength(2);
  });

  test('a wake with GitHub unreachable still brings it back from the clone on the box', async () => {
    const logged: string[] = [];
    await using s = await onBox((message) => logged.push(message));
    const { docker, mirrors } = s.box;

    await up(s);
    docker.boxStop();
    mirrors.failing.set(REPO, 'Could not resolve host: github.com');
    expect(data(WorkspaceData, await up(s)).state).toBe('running');
    // Not a refusal, but said in serve.log: the mirror stays as it was.
    expect(logged).toContain(
      `the mirror of ${REPO} was not fetched: Could not resolve host: github.com`,
    );
  });

  test('an abe upgrade builds the base image anew, then the workspace image on it, and the container again', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'abe-bin-'));

    writeFileSync(join(bin, 'abe'), 'the installed abe\n');
    const base = (release: AbeRelease) => ({
      dir: '/opt/abe/images/base',
      bin: join(bin, 'abe'),
      release,
    });
    const old: AbeRelease = { version: '2.0.0-alpha.0-f7728053', hash: 'a1'.repeat(32) };
    const s = await scenario({ box: true, boxBase: base(old) });
    const { docker } = s.box;
    const baked = bakedBinaries(docker);

    s.box.mirrors.trees.set(REPO, 'tree1');
    // The fake box's base is from before the labels: built anew with them, the binary its last layer.
    expect((await up(s)).exit).toBe(0);
    expect(docker.builds.map((b) => b.tag)).toEqual(['abe-base:latest', IMAGE]);
    expect(docker.builds[0]).toEqual({
      tag: 'abe-base:latest',
      context: '/opt/abe/images/base',
      dockerfile: '/opt/abe/images/base/Dockerfile',
      // no VimStorm config beside this release: an empty one, Neovim alone (#89)
      contexts: {
        'abe-bin': join(s.state.dir, 'base-bin'),
        'vimstorm-nvim': join(s.state.dir, 'base-nvim'),
      },
      args: { ABE_VERSION: old.version, ABE_HASH: old.hash },
      labels: { 'abe.version': old.version, 'abe.hash': old.hash },
    });
    expect(baked).toEqual(['the installed abe\n']);
    // The copy goes once the build is done.
    expect(existsSync(join(s.state.dir, 'base-bin'))).toBe(false);
    const firstBase = docker.images.get('abe-base:latest')?.id;

    expect(docker.builds[1]?.labels['abe.base.id']).toBe(firstBase);
    // The same abe again: nothing built.
    await up(s);
    expect(docker.builds).toHaveLength(2);
    await s.serve.stop();

    // An upgrade: serve started again on the new release; the next up builds both anew.
    const now: AbeRelease = { version: '2.0.0-alpha.0-90ca905c', hash: 'b2'.repeat(32) };
    await using again = await scenario({ state: s.state, box: s.box, boxBase: base(now) });
    const ws = data(WorkspaceData, await up(again));

    expect(docker.builds.slice(2).map((b) => [b.tag, b.labels])).toEqual([
      ['abe-base:latest', { 'abe.version': now.version, 'abe.hash': now.hash }],
      [
        IMAGE,
        {
          'abe.image.tree': 'tree1',
          'abe.base.id': docker.images.get('abe-base:latest')?.id ?? '',
        },
      ],
    ]);
    expect(docker.images.get('abe-base:latest')?.id).not.toBe(firstBase);
    // Nobody in it: the container made again on the new image, the same volume.
    expect(docker.runs.filter((r) => r.name === 'abe-ws-101')).toHaveLength(2);
    expect(ws.imageCurrent).toBe(true);
    rmSync(bin, { recursive: true, force: true });
  });

  test("up says each step as workspace.step, a build's Docker step count as it moves (#142)", async () => {
    const bin = mkdtempSync(join(tmpdir(), 'abe-bin-'));

    writeFileSync(join(bin, 'abe'), 'the installed abe\n');
    const release: AbeRelease = { version: '2.2.0-142', hash: 'c3'.repeat(32) };
    await using s = await scenario({
      box: true,
      boxBase: { dir: '/opt/abe/images/base', bin: join(bin, 'abe'), release },
    });

    s.box.mirrors.trees.set(REPO, 'tree1');
    s.box.docker.buildOutput.set('abe-base:latest', [
      '#1 [internal] load build definition from Dockerfile',
      '#5 [1/27] FROM docker.io/library/ubuntu:24.04',
      '#5 0.4 resolve docker.io/library/ubuntu:24.04',
      '#6 [2/27] RUN apt-get update',
      '#6 12.1 Reading package lists...',
    ]);
    s.box.docker.buildOutput.set(IMAGE, ['#4 [1/2] FROM abe-base:latest', '#5 [2/2] RUN make']);
    expect((await up(s)).exit).toBe(0);
    const steps = (await heldEvents(s.state.socket))
      .filter((e) => e.type === 'workspace.step')
      .map((e) => e.data);

    // Each names its card: a box brings up a workspace per card (ADR 0022).
    expect(steps).toEqual(
      [
        { step: 'mirror', detail: null },
        { step: 'base-image', detail: null },
        { step: 'base-image', detail: 'step 1/27' },
        { step: 'base-image', detail: 'step 2/27' },
        { step: 'image', detail: null },
        { step: 'image', detail: 'step 1/2' },
        { step: 'image', detail: 'step 2/2' },
        { step: 'database', detail: null },
        { step: 'clone', detail: null },
        { step: 'container', detail: null },
      ].map((x) => ({ ...x, card: '101' })),
    );
    rmSync(bin, { recursive: true, force: true });
  });

  test('the release’s VimStorm config goes into the base image as its vimstorm-nvim context (#89)', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'abe-bin-'));
    const nvim = mkdtempSync(join(tmpdir(), 'abe-nvim-'));

    writeFileSync(join(bin, 'abe'), 'abe\n');
    writeFileSync(join(nvim, 'init.lua'), '-- vimstorm\n');
    await using s = await scenario({
      box: true,
      boxBase: {
        dir: '/opt/abe/images/base',
        bin: join(bin, 'abe'),
        nvim,
        release: { version: 'v', hash: 'h' },
      },
    });
    const { docker } = s.box;

    s.box.mirrors.trees.set(REPO, 'tree1');
    expect((await up(s)).exit).toBe(0);
    expect(docker.builds[0]?.contexts).toEqual({
      'abe-bin': join(s.state.dir, 'base-bin'),
      'vimstorm-nvim': nvim,
    });
    rmSync(bin, { recursive: true, force: true });
    rmSync(nvim, { recursive: true, force: true });
  });

  test('a base image that fails to build is build-failed, and no workspace image is built on the old one', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'abe-bin-'));

    writeFileSync(join(bin, 'abe'), 'abe\n');
    await using s = await scenario({
      box: true,
      boxBase: {
        dir: '/opt/abe/images/base',
        bin: join(bin, 'abe'),
        release: { version: 'v', hash: 'h' },
      },
    });
    const { docker } = s.box;
    const build = docker.build;

    s.box.mirrors.trees.set(REPO, 'tree1');
    docker.build = (b) =>
      b.tag === 'abe-base:latest'
        ? Promise.resolve({ exit: 1, stdout: '', stderr: 'npm ERR! network' })
        : build(b);
    expect(errorOf(await up(s))).toBe('build-failed');
    expect(docker.images.has(IMAGE)).toBe(false);
    rmSync(bin, { recursive: true, force: true });
  });

  test("a base image the box's boot built meanwhile is used: its build losing the race to the tag is no failure (#302)", async () => {
    const bin = mkdtempSync(join(tmpdir(), 'abe-bin-'));

    writeFileSync(join(bin, 'abe'), 'abe\n');
    const release: AbeRelease = { version: 'v302', hash: 'd4'.repeat(32) };
    await using s = await scenario({
      box: true,
      boxBase: { dir: '/opt/abe/images/base', bin: join(bin, 'abe'), release },
    });
    const { docker } = s.box;
    const build = docker.build;

    s.box.mirrors.trees.set(REPO, 'tree1');
    // The boot's own build (images/build.sh, outside serve) of the same release exports first.
    docker.build = (b) => {
      if (b.tag !== 'abe-base:latest') return build(b);
      docker.images.set('abe-base:latest', {
        id: 'sha256:boot',
        labels: { 'abe.version': release.version, 'abe.hash': release.hash },
      });

      return Promise.resolve({
        exit: 1,
        stdout: '',
        stderr:
          '#27 ERROR: image "docker.io/library/abe-base:latest": already exists\nERROR: failed to build: failed to solve: image "docker.io/library/abe-base:latest": already exists',
      });
    };
    const ws = data(WorkspaceData, await up(s));

    expect(ws.state).toBe('running');
    // The workspace image is built on the boot's base.
    expect(docker.builds.at(-1)?.labels['abe.base.id']).toBe('sha256:boot');
    rmSync(bin, { recursive: true, force: true });
  });

  test("a base image whose build failed with another release's base there is still build-failed (#302)", async () => {
    const bin = mkdtempSync(join(tmpdir(), 'abe-bin-'));

    writeFileSync(join(bin, 'abe'), 'abe\n');
    await using s = await scenario({
      box: true,
      boxBase: {
        dir: '/opt/abe/images/base',
        bin: join(bin, 'abe'),
        release: { version: 'v', hash: 'h' },
      },
    });
    const { docker } = s.box;
    const build = docker.build;

    s.box.mirrors.trees.set(REPO, 'tree1');
    docker.build = (b) => {
      if (b.tag !== 'abe-base:latest') return build(b);
      docker.images.set('abe-base:latest', {
        id: 'sha256:other',
        labels: { 'abe.version': 'older', 'abe.hash': 'h' },
      });

      return Promise.resolve({ exit: 1, stdout: '', stderr: 'already exists' });
    };
    expect(errorOf(await up(s))).toBe('build-failed');
    expect(docker.images.has(IMAGE)).toBe(false);
    rmSync(bin, { recursive: true, force: true });
  });

  test('a changed .abe/session rebuilds the image and makes the container again on the same volume', async () => {
    await using s = await onBox();
    const { docker, mirrors } = s.box;

    await up(s);
    mirrors.trees.set(REPO, 'tree2');
    await up(s);
    expect(docker.builds).toHaveLength(2);
    const runs = docker.runs.filter((r) => r.name === 'abe-ws-101');

    expect(runs).toHaveLength(2);
    expect(runs[1]?.labels['abe.image.id']).toBe('sha256:built2');
    expect(runs[1]?.mounts[0]).toEqual({
      type: 'volume',
      source: 'abe-ws-101',
      target: '/workspace',
    });
    // A new container gets a new password; the role is told it.
    expect(pgSql(s)).toHaveLength(2);
  });

  test('a second card on the box gets a workspace of its own beside the first: its container, clone, database and socket (ADR 0022)', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s, '101');
    const other = await up(s, '102', 'Stock badge');

    expect(data(WorkspaceData, other)).toMatchObject({
      card: '102',
      branch: 'card/102-stock-badge',
      container: 'abe-ws-102',
      database: 'ws_102',
      state: 'running',
    });
    // One image and one Postgres for the box; the first workspace left as it was.
    expect(docker.builds).toHaveLength(1);
    expect(docker.runs.map((r) => r.name)).toEqual(['abe-pg', 'abe-ws-101', 'abe-ws-102']);
    const a = docker.containersByName.get('abe-ws-101')?.spec;
    const b = docker.containersByName.get('abe-ws-102')?.spec;

    expect(b?.mounts).toContainEqual({
      type: 'volume',
      source: 'abe-ws-102',
      target: '/workspace',
    });
    expect(b?.mounts).toContainEqual({
      type: 'bind',
      source: join(s.state.dir, 'workspaces', '102'),
      target: '/run/abe',
      readOnly: true,
    });
    // Neither is handed the other's database (each role reaches only its own: `sameuser`).
    expect(a?.env.DATABASE_URL).toMatch(/^postgresql:\/\/ws_101:[0-9a-f]{32}@\/ws_101\?/);
    expect(b?.env.DATABASE_URL).toMatch(/^postgresql:\/\/ws_102:[0-9a-f]{32}@\/ws_102\?/);
    expect(pgSql(s).map((e) => e.stdin?.includes('ROLE ws_102') === true)).toEqual([false, true]);
    expect(statSync(join(s.state.dir, 'workspaces', '102', 'serve.sock')).mode & 0o777).toBe(0o666);
    expect(
      data(WorkspaceList, await s.request('workspace', 'status', '--json')).workspaces.map(
        (w) => w.card,
      ),
    ).toEqual(['101', '102']);
  });

  test("a 2.2 box's one workspace (abe-workspace) is still recognised: up keeps it under its old names", async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s, '101');
    // As a 2.2 box made it: the same labels, the fixed names.
    const made = docker.containersByName.get('abe-ws-101');

    if (made === undefined) throw new Error('no workspace');
    docker.containersByName.delete('abe-ws-101');
    docker.containersByName.set('abe-workspace', {
      ...made,
      spec: { ...made.spec, name: 'abe-workspace' },
    });
    const again = data(WorkspaceData, await up(s, '101'));

    expect(again).toMatchObject({ container: 'abe-workspace', database: 'workspace' });
    expect(docker.containersByName.has('abe-ws-101')).toBe(false);
  });

  test("each card's workspace is on its own network: no other card's container is reached on it", async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s, '101');
    await up(s, '102', 'Stock badge');
    expect(docker.containersByName.get('abe-ws-101')?.spec.network).toBe('abe-ws-101');
    expect(docker.containersByName.get('abe-ws-102')?.spec.network).toBe('abe-ws-102');
    // Postgres keeps the box's network, reached by the workspaces over its socket.
    expect(docker.containersByName.get('abe-pg')?.spec.network).toBe('abe-net');
  });

  test('cards that differ only in case would share a database: the second is refused', async () => {
    await using s = await onBox();

    await up(s, 'AB-1');
    expect(errorOf(await up(s, 'ab-1'))).toBe('other-workspace');
  });

  test("a card's workspace holding another repo refuses it", async () => {
    await using s = await onBox();

    s.box.mirrors.trees.set('mkdir-swe/other', 'tree2');
    await up(s, '101');
    const other = await s.request(
      'workspace',
      'up',
      '--repo',
      'mkdir-swe/other',
      '--card',
      '101',
      '--json',
    );

    expect(errorOf(other)).toBe('other-workspace');
  });

  test('a repo with no .abe/session is refused before anything is made', async () => {
    await using s = await onBox();

    s.box.mirrors.trees.clear();
    expect(errorOf(await up(s))).toBe('no-workspace-image');
    expect(s.box.docker.volumes.size).toBe(0);
  });

  test('a first up with GitHub unreachable is clone-failed', async () => {
    await using s = await onBox();

    s.box.mirrors.failing.set(REPO, 'Authentication failed');
    expect(errorOf(await up(s))).toBe('clone-failed');
    expect(s.box.docker.builds).toHaveLength(0);
    expect(s.box.docker.containersByName.has('abe-ws-101')).toBe(false);
  });

  test('a failed clone makes no container', async () => {
    await using s = await onBox();

    s.box.docker.onOnce = () => ({ exit: 128, stdout: '', stderr: 'fatal: not a git repository' });
    expect(errorOf(await up(s))).toBe('clone-failed');
    expect(s.box.docker.containersByName.has('abe-ws-101')).toBe(false);
  });

  test('a repo that is no <owner>/<repo> is a usage error', async () => {
    await using s = await onBox();
    const reply = await s.request('workspace', 'up', '--repo', 'x', '--card', '1', '--json');

    expect(reply.exit).toBe(2);
    expect(errorOf(reply)).toBe('usage');
  });

  test('a serve that is no box refuses workspaces', async () => {
    await using s = await scenario();
    const reply = await s.request('workspace', 'status', '--json');

    expect(reply.exit).toBe(1);
    expect(errorOf(reply)).toBe('not-a-box');
  });
});

describe('abe workspace status', () => {
  test('before any up it lists none', async () => {
    await using s = await onBox();

    expect(data(WorkspaceList, await s.request('workspace', 'status', '--json'))).toEqual({
      workspaces: [],
    });
  });
});

describe('abe workspace up --all', () => {
  test("the box's start brings every workspace back, each as its labels say", async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s, '101');
    await up(s, '102', 'Stock badge');
    docker.boxStop();
    const all = data(WorkspaceList, await s.request('workspace', 'up', '--all', '--json'));

    expect(all.workspaces.map((w) => [w.card, w.state, w.branch])).toEqual([
      ['101', 'running', 'card/101-cart-total-is-wrong'],
      ['102', 'running', 'card/102-stock-badge'],
    ]);
    // Nothing made anew: the same containers on their volumes.
    expect(docker.runs.map((r) => r.name)).toEqual(['abe-pg', 'abe-ws-101', 'abe-ws-102']);
  });

  test('one that fails is said; the rest still come back', async () => {
    const said: string[] = [];
    await using s = await onBox((m) => said.push(m));
    const { docker } = s.box;

    await up(s, '101');
    await up(s, '102', 'Stock badge');
    docker.boxStop();
    const start = docker.start;

    docker.start = (name) =>
      name === 'abe-ws-101' ? Promise.reject(new Error('no space left on device')) : start(name);
    const reply = await s.request('workspace', 'up', '--all', '--json');

    expect(errorOf(reply)).toBe('workspace-failed');
    expect(docker.containersByName.get('abe-ws-102')?.state).toBe('running');
    expect(said.some((m) => m.includes("card 101's workspace did not come back"))).toBe(true);
  });

  test('on a box with none it brings none', async () => {
    await using s = await onBox();

    expect(data(WorkspaceList, await s.request('workspace', 'up', '--all', '--json'))).toEqual({
      workspaces: [],
    });
  });

  test('--all with --card, or neither, is a usage error', async () => {
    await using s = await onBox();

    expect(
      (await s.request('workspace', 'up', '--all', '--repo', REPO, '--card', '1', '--json')).exit,
    ).toBe(2);
    expect((await s.request('workspace', 'up', '--json')).exit).toBe(2);
  });
});

describe('abe workspace rm', () => {
  const rm = (s: ServeScenario, card: string) => s.request('workspace', 'rm', card, '--json');

  test('a pushed workspace goes: its container, clone volume, database and socket folder; the box keeps the others', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s, '101');
    await up(s, '102', 'Stock badge');
    expect(data(WorkspaceRemoved, await rm(s, '101'))).toEqual({ card: '101', removed: true });
    expect(docker.containersByName.has('abe-ws-101')).toBe(false);
    expect(docker.volumes.has('abe-ws-101')).toBe(false);
    expect(
      docker.execs.some(
        (e) =>
          e.name === 'abe-pg' &&
          e.user === 'postgres' &&
          e.stdin === 'DROP DATABASE IF EXISTS ws_101 WITH (FORCE);\nDROP ROLE IF EXISTS ws_101;',
      ),
    ).toBe(true);
    expect(existsSync(join(s.state.dir, 'workspaces', '101'))).toBe(false);
    expect(docker.containersByName.get('abe-ws-102')?.state).toBe('running');
    expect(docker.volumes.has('abe-ws-102')).toBe(true);
  });

  test('one holding unpushed or uncommitted work stays, and says what', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s, '101');
    // Its clone: 2 commits on no remote, 1 file changed.
    const said = (argv: readonly string[]) => {
      if (argv.includes('rev-list')) return '2\n';
      if (argv.includes('status')) return ' M src/cart.ts\n';

      return '';
    };

    docker.onExec = (name, argv) => ({
      exit: 0,
      stdout: name === 'abe-ws-101' ? said(argv) : '',
      stderr: '',
    });
    const reply = await rm(s, '101');

    expect(errorOf(reply)).toBe('unpushed');
    expect(readEnvelope(WorkspaceRemoved, JSON.parse(reply.stdout))).toMatchObject({
      ok: false,
    });
    expect(reply.stdout).toContain('2 unpushed commits and 1 uncommitted file');
    expect(docker.containersByName.has('abe-ws-101')).toBe(true);
    expect(docker.volumes.has('abe-ws-101')).toBe(true);
  });

  test('one someone is in (a session runs) stays', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s, '101');
    docker.onExec = (name, argv) =>
      name === 'abe-ws-101' && argv.join(' ').includes('tmux list-clients')
        ? { exit: 0, stdout: 'p claude\n', stderr: '' }
        : { exit: 0, stdout: '', stderr: '' };
    expect(errorOf(await rm(s, '101'))).toBe('workspace-busy');
    expect(docker.containersByName.has('abe-ws-101')).toBe(true);
  });

  test('a stopped one is started for the look, then goes', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s, '101');
    docker.boxStop();
    expect((await rm(s, '101')).exit).toBe(0);
    expect(docker.containersByName.has('abe-ws-101')).toBe(false);
  });

  test('a workspace left with no container (its up cut off) keeps its clone until it is up again, then goes', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s, '101');
    docker.containersByName.delete('abe-ws-101');
    // Its work cannot be looked at: never dropped unseen.
    expect(errorOf(await rm(s, '101'))).toBe('work-unknown');
    expect(docker.volumes.has('abe-ws-101')).toBe(true);
    await up(s, '101');
    expect(data(WorkspaceRemoved, await rm(s, '101'))).toEqual({ card: '101', removed: true });
    expect(docker.volumes.has('abe-ws-101')).toBe(false);
    expect(docker.networks.has('abe-ws-101')).toBe(false);
    expect(
      docker.execs.some((e) => e.stdin?.startsWith('DROP DATABASE IF EXISTS ws_101') === true),
    ).toBe(true);
  });

  test('a database that cannot be dropped leaves the container, so it is tried again', async () => {
    await using s = await onBox();
    const { docker } = s.box;

    await up(s, '101');
    docker.onExec = (name, _argv, stdin) =>
      name === 'abe-pg' && stdin?.startsWith('DROP') === true
        ? { exit: 1, stdout: '', stderr: 'ERROR: database is being accessed' }
        : { exit: 0, stdout: '', stderr: '' };
    expect(errorOf(await rm(s, '101'))).toBe('database-failed');
    expect(docker.containersByName.has('abe-ws-101')).toBe(true);
    expect(docker.volumes.has('abe-ws-101')).toBe(true);
  });

  test('a card with none is no-workspace; a bad card a usage error', async () => {
    await using s = await onBox();

    expect(errorOf(await rm(s, '7'))).toBe('no-workspace');
    expect((await rm(s, '1;rm')).exit).toBe(2);
  });
});

describe("the workspace's socket", () => {
  test('abe status inside answers for the workspace', async () => {
    await using s = await onBox();

    await up(s);
    expect(data(StatusData, await s.requestInside('status', '--json'))).toMatchObject({
      workspaces: 1,
      workspace: { card: '101', branch: 'card/101-cart-total-is-wrong', state: 'running' },
    });
    // One workspace, one box: the box's own status names it too (`abe box list` reads it, #56).
    expect(data(StatusData, await s.request('status', '--json'))).toMatchObject({
      workspaces: 1,
      workspace: { card: '101', state: 'running' },
    });
  });

  test('a command no session may run is refused there', async () => {
    await using s = await onBox();

    await up(s);
    for (const argv of [
      ['workspace', 'status'],
      ['workspace', 'up', '--repo', REPO, '--card', '9'],
      ['serve', 'stop'],
      ['watch'],
      ['settings', 'get', 'team'],
      ['issue', 'show', 'mkdir-swe/demo-shop#1'],
    ]) {
      const reply = await s.requestInside(...argv, '--json');

      expect(reply.exit).toBe(1);
      expect(errorOf(reply)).toBe('not-in-session');
    }
  });

  test('a serve started again (the box woke) listens on it again', async () => {
    const s = await onBox();

    await up(s);
    await s.serve.stop();
    await using again = await scenario({ state: s.state, box: s.box });

    expect(data(StatusData, await again.requestInside('status', '--json'))).toMatchObject({
      workspace: { card: '101' },
    });
  });
});

describe("the box's load (ADR 0022)", () => {
  const GB = 1024 ** 3;

  /** A box's machine: its memory, CPU and root disk as given; every growth asked kept. */
  const machine = (o: { freeGb: number; totalGb: number; grows?: 'ok' | 'refused' }) => {
    const grown: number[] = [];
    let disk = { freeBytes: o.freeGb * GB, totalBytes: o.totalGb * GB };
    let cpu = { busy: 1000, total: 10_000 };
    const host: BoxHost = {
      shutdown: () => Promise.resolve({ ok: true, data: null }),
      attached: () => Promise.resolve(false),
      load: () => {
        cpu = { busy: cpu.busy + 600, total: cpu.total + 4000 };

        return Promise.resolve({ memAvailableKb: 9_437_184, memTotalKb: 16_777_216, cpu, disk });
      },
      growRoot: (maxGb) => {
        const toGb = Math.min(maxGb, disk.totalBytes / GB + 20);

        grown.push(toGb);
        if (o.grows === 'refused')
          return Promise.resolve({
            ok: false,
            error: { code: 'grow-failed', message: 'UnauthorizedOperation' },
          });
        disk = { freeBytes: disk.freeBytes + (toGb * GB - disk.totalBytes), totalBytes: toGb * GB };

        return Promise.resolve({ ok: true, data: { ...disk, toGb } });
      },
    };

    return { host, grown };
  };

  const status = async (s: ServeScenario) =>
    data(WorkspaceList, await s.request('workspace', 'status', '--json'));

  test("workspace status says what it has left: memory, CPU, its disk and each workspace's share", async () => {
    const box = machine({ freeGb: 31, totalGb: 60 });
    await using s = await scenario({ box: true, boxHost: box.host });

    s.box.mirrors.trees.set(REPO, 'tree1');
    await up(s, '101');
    await up(s, '102', 'Stock badge');
    s.box.docker.volumeBytes.set('abe-ws-101', 4.1 * GB);
    s.box.docker.volumeBytes.set('abe-ws-102', 3.8 * GB);
    const { load } = await status(s);

    expect(load).toMatchObject({
      memory: { availableMb: 9216, totalMb: 16_384 },
      disk: { freeGb: 31, totalGb: 60 },
      workspaces: [
        { card: '101', diskGb: 4.1 },
        { card: '102', diskGb: 3.8 },
      ],
    });
    expect(box.grown).toEqual([]);
    // abe status carries it too, for the Mac's Boxes (its Disk column).
    expect(data(StatusData, await s.request('status', '--json')).load?.disk).toEqual({
      freeGb: 31,
      totalGb: 60,
    });
  });

  test('read at most every so often: asked again soon, the same read', async () => {
    const box = machine({ freeGb: 31, totalGb: 60 });
    await using s = await onBoxWith(box.host);

    const first = (await status(s)).load?.at;

    s.clock.tick(60_000);
    expect((await status(s)).load?.at).toBe(first);
  });

  /** Waits until `ok()` holds (a growth runs behind the read), failing after 2 s. */
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 400 && !ok(); i += 1) await Bun.sleep(5);
    expect(ok()).toBe(true);
  };

  test('under 20 % free the root disk grows by 20 GB behind the read, said in serve.log; the next read has its size', async () => {
    const said: string[] = [];
    const box = machine({ freeGb: 10, totalGb: 60 });
    await using s = await onBoxWith(box.host, (m) => said.push(m));

    // The read answers at once: the growth goes on behind it.
    expect((await status(s)).load?.disk).toEqual({ freeGb: 10, totalGb: 60 });
    await until(() => said.some((m) => m.includes('grew to 80 GB')));
    expect(box.grown).toEqual([80]);
    expect(said.some((m) => m.includes('growing it (at most 200 GB)'))).toBe(true);
    s.clock.tick(60_000);
    expect((await status(s)).load?.disk).toEqual({ freeGb: 30, totalGb: 80 });
    s.clock.tick(3_600_000);
    // 30 of 80 free: no growth (the 6 h between growths is core's table).
    await status(s);
    expect(box.grown).toEqual([80]);
  });

  test('a growth EC2 refuses is said, the disk as it was', async () => {
    const said: string[] = [];
    const box = machine({ freeGb: 10, totalGb: 60, grows: 'refused' });
    await using s = await onBoxWith(box.host, (m) => said.push(m));

    expect((await status(s)).load?.disk).toEqual({ freeGb: 10, totalGb: 60 });
    await until(() => said.some((m) => m.includes('did not grow: UnauthorizedOperation')));
  });

  test('a box with no machine to read says no load', async () => {
    await using s = await onBox();

    expect((await status(s)).load).toBeUndefined();
  });
});

// A workspace has no Docker, and never the box's socket: its docker compose runs on the box, in the
// card's own project from the compose file read in the workspace, the workspace joined to its
// network; refused on a Docker that is not local; down when the card's workspace goes.
describe("a workspace's docker compose runs on the box", () => {
  const COMPOSE_FILE = 'services:\n  db:\n    image: postgres\n';
  const onBoxComposing = async (context = LOCAL_DOCKER, file = COMPOSE_FILE) => {
    const compose = fakeCompose(context);
    const s = await scenario({ box: true, compose });

    s.box.mirrors.trees.set(REPO, 'tree1');
    // the compose file, read in the workspace as its script user: its name, then its text
    s.box.docker.onExec = (name, argv, _stdin, user) =>
      name === 'abe-ws-101' && user === 'abe-run' && argv.join(' ').includes('exec cat')
        ? { exit: 0, stdout: `compose.yaml\n${file}`, stderr: '' }
        : { exit: 0, stdout: '', stderr: '' };
    await up(s, '101');

    return { s, compose };
  };
  const composeIn = (s: ServeScenario, cwd: string, ...args: string[]) =>
    s.requestInsideOf('101', 'compose', '--cwd', cwd, '--json', '--', ...args);
  const code = (reply: Reply) => {
    const doc = readEnvelope(RunData, JSON.parse(reply.stdout));

    return doc.ok ? 'ok' : doc.error.code;
  };

  test("up in the card's project from the workspace's file, joined to its network; down leaves it first; the card's end takes both projects down", async () => {
    const { s, compose } = await onBoxComposing();
    const project = 'abe-demo-shop-101';

    expect(code(await composeIn(s, '/workspace/repo', 'up', '-d'))).toBe('ok');
    expect(compose.runs.map((r) => [r.project, r.args.slice(2), r.stdin])).toEqual([
      [project, ['-f', '-', 'up', '-d'], COMPOSE_FILE],
    ]);
    // the volume not readable on the box host: the clone synced into the project's own folder
    const dir = join(s.state.dir, 'compose', project);
    const sync = s.box.docker.onces.at(-1);

    expect(compose.runs[0]?.args.slice(0, 2)).toEqual(['--project-directory', dir]);
    expect([sync?.mounts, sync?.argv?.at(-1), sync?.network]).toEqual([
      [
        { type: 'volume', source: 'abe-ws-101', target: '/src', readOnly: true },
        { type: 'bind', source: dir, target: '/dst' },
      ],
      '/repo',
      'none',
    ]);
    expect(sync?.argv?.[2]).toContain('--exclude=./.git --exclude=./node_modules');
    // Before's worktree in its own project
    expect(code(await composeIn(s, '/workspace/repo-base', 'up', '-d'))).toBe('ok');
    expect(code(await composeIn(s, '/workspace/repo', 'down'))).toBe('ok');
    expect(compose.networks).toEqual([
      `join ${project}_default abe-ws-101`,
      `join ${project}-base_default abe-ws-101`,
      `leave ${project}_default abe-ws-101`,
    ]);
    await s.request('workspace', 'rm', '101', '--json');
    expect(compose.downs.map((d) => d.project)).toEqual([project, `${project}-base`]);
    await s.close();
  });

  test('the volume readable on the box host: compose runs in the clone itself, nothing synced', async () => {
    const { s, compose } = await onBoxComposing();
    const host = mkdtempSync(join(tmpdir(), 'vol-'));

    mkdirSync(join(host, 'repo', 'infra'), { recursive: true });
    s.box.docker.volumePaths.set('abe-ws-101', host);
    const onces = s.box.docker.onces.length;

    expect(code(await composeIn(s, '/workspace/repo/infra', 'up', '-d'))).toBe('ok');
    expect([compose.runs[0]?.args.slice(0, 2), s.box.docker.onces.length]).toEqual([
      ['--project-directory', join(host, 'repo', 'infra')],
      onces,
    ]);
    rmSync(host, { recursive: true, force: true });
    await s.close();
  });

  test("a host path that is not the clone's: refused by file and line, nothing run", async () => {
    const { s, compose } = await onBoxComposing(
      LOCAL_DOCKER,
      'services:\n  db:\n    volumes:\n      - ./init.sql:/init.sql\n      - /var/run/docker.sock:/var/run/docker.sock\n',
    );
    const reply = await composeIn(s, '/workspace/repo', 'up', '-d');

    expect([code(reply), reply.stdout.includes('compose.yaml:5 /var/run/docker.sock')]).toEqual([
      'compose-path-outside',
      true,
    ]);
    expect(compose.runs).toEqual([]);
    await s.close();
  });

  test.each([
    ['a flag that picks the project', ['-p', 'other', 'up'], '/workspace/repo', 'compose-args'],
    ['a folder up out of the clone', ['up', '-d'], '/workspace/repo/../x', 'compose-outside'],
    ['a folder out of the clone', ['up', '-d'], '/etc', 'compose-outside'],
  ])('refused: %s', async (_, args, cwd, want) => {
    const { s, compose } = await onBoxComposing();

    expect(code(await composeIn(s, cwd, ...args))).toBe(want);
    expect(compose.runs).toEqual([]);
    await s.close();
  });

  test('a docker context on another host: refused compose-not-local, nothing run', async () => {
    const { s, compose } = await onBoxComposing({ name: 'far', host: 'ssh://deploy@10.0.0.5' });

    expect(code(await composeIn(s, '/workspace/repo', 'up', '-d'))).toBe('compose-not-local');
    expect(compose.runs).toEqual([]);
    await s.close();
  });
});
