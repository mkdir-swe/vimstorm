/**
 * An in-memory Docker and Mirrors for a box's `serve`. Containers keep their spec and state,
 * volumes appear on first mount, and a test answers what runs inside through `exec` and `once`.
 * `boxStop()` and `boxStart()` stop and start the box. Containers exit, volumes stay, and the
 * ones with a restart policy run again.
 */
import {
  type Compose,
  type Container,
  type ContainerSpec,
  type Docker,
  type DockerEndpoint,
  type Image,
  type Mirrors,
  type Ran,
  WORKSPACE_APPARMOR,
  type WorkspaceRelays,
} from '@abe/core';
import { workspaceRelays } from '@abe/ports';

export type FakeContainer = { spec: ContainerSpec; state: string };

export type FakeDocker = Docker & {
  containersByName: Map<string, FakeContainer>;
  volumes: Set<string>;
  /** Each volume's size in bytes for `volumeSizes`. Defaults to 0. */
  volumeBytes: Map<string, number>;
  /** Each volume's mountpoint on the box host for `volumePath`; none: not host-visible. */
  volumePaths: Map<string, string>;
  networks: Set<string>;
  images: Map<string, Image>;
  /** Every `build`, oldest first. */
  builds: Parameters<Docker['build']>[0][];
  /** The output lines a `build` prints, by its tag. Defaults to none. */
  buildOutput: Map<string, readonly string[]>;
  /** Every `once`, oldest first. */
  onces: ContainerSpec[];
  /** Every `run`, oldest first. */
  runs: ContainerSpec[];
  /** Every `exec`, with the container, its argv and stdin, and the user when one was named. */
  execs: { name: string; argv: readonly string[]; stdin?: string; user?: string }[];
  /**
   * What an `exec` answers. Defaults to exit 0 with nothing printed. `hostExec` runs it for real.
   */
  onExec: (
    name: string,
    argv: readonly string[],
    stdin?: string,
    user?: string,
  ) => Ran | Promise<Ran>;
  /** What a `once` answers. Defaults to exit 0 with nothing printed. */
  onOnce: (spec: ContainerSpec) => Ran;
  /**
   * The AppArmor profiles loaded on the box host, the workspace's by default. A profile missing
   * here is not in force, so `confinement` answers `unconfined`, as Docker does with AppArmor off.
   */
  apparmor: Set<string>;
  /** Every `confinement` asked, oldest first. */
  confinements: { image: string; apparmor: string }[];
  /** Stops the box. Every container exits, and volumes and images stay. */
  boxStop: () => void;
  /** Starts the box. Containers with a restart policy run again. */
  boxStart: () => void;
};

const OK: Ran = { exit: 0, stdout: '', stderr: '' };

const matches = (labels: Readonly<Record<string, string>>, key: string, value: string) =>
  Object.hasOwn(labels, key) && labels[key] === value;

export const fakeDocker = (): FakeDocker => {
  const containersByName = new Map<string, FakeContainer>();
  const volumes = new Set<string>();
  const networks = new Set<string>();
  const images = new Map<string, Image>([['abe-base:latest', { id: 'sha256:base1', labels: {} }]]);
  const mountVolumes = (spec: ContainerSpec) => {
    for (const m of spec.mounts) if (m.type === 'volume') volumes.add(m.source);
  };
  const named = (name: string) => {
    const found = containersByName.get(name);

    if (found === undefined)
      throw new Error(`Error response from daemon: No such container: ${name}`);

    return found;
  };
  let built = 0;

  const docker: FakeDocker = {
    containersByName,
    volumes,
    volumeBytes: new Map(),
    volumePaths: new Map(),
    networks,
    images,
    builds: [],
    buildOutput: new Map(),
    onces: [],
    runs: [],
    execs: [],
    onExec: () => OK,
    onOnce: () => OK,
    apparmor: new Set([WORKSPACE_APPARMOR]),
    confinements: [],
    boxStop: () => {
      for (const c of containersByName.values()) c.state = 'exited';
    },
    boxStart: () => {
      for (const c of containersByName.values())
        if (c.spec.restart === 'unless-stopped') c.state = 'running';
    },
    containers: (key, value) =>
      Promise.resolve(
        [...containersByName.entries()]
          .filter(([, c]) => matches(c.spec.labels, key, value))
          .map(([name, c]): Container => ({ name, state: c.state, labels: c.spec.labels })),
      ),
    image: (ref) => Promise.resolve(images.get(ref)),
    build: (b) => {
      const { progress, ...asked } = b;

      docker.builds.push(asked);
      for (const line of docker.buildOutput.get(b.tag) ?? []) progress?.(line);
      built += 1;
      images.set(b.tag, { id: `sha256:built${built}`, labels: b.labels });

      return Promise.resolve(OK);
    },
    network: (name) => {
      networks.add(name);

      return Promise.resolve();
    },
    removeNetwork: (name) => {
      networks.delete(name);

      return Promise.resolve();
    },
    run: (spec) => {
      const name = spec.name ?? `anon${containersByName.size}`;

      if (containersByName.has(name))
        return Promise.reject(
          new Error(`Conflict. The container name "/${name}" is already in use`),
        );
      if (!images.has(spec.image) && !spec.image.startsWith('postgres:'))
        return Promise.reject(new Error(`Unable to find image '${spec.image}' locally`));
      if (spec.network !== 'none' && !networks.has(spec.network))
        return Promise.reject(new Error(`network ${spec.network} not found`));
      mountVolumes(spec);
      docker.runs.push(spec);
      containersByName.set(name, { spec, state: 'running' });

      return Promise.resolve();
    },
    once: (spec) => {
      docker.onces.push(spec);
      mountVolumes(spec);

      return Promise.resolve(docker.onOnce(spec));
    },
    confinement: (image, apparmor) => {
      docker.confinements.push({ image, apparmor });

      return Promise.resolve(
        docker.apparmor.has(apparmor) ? `${apparmor} (enforce)` : 'unconfined',
      );
    },
    exec: (name, argv, stdin, opts) => {
      if (named(name).state !== 'running')
        return Promise.reject(new Error(`container ${name} is not running`));
      docker.execs.push({
        name,
        argv,
        ...(stdin === undefined ? {} : { stdin }),
        ...(opts?.user === undefined ? {} : { user: opts.user }),
      });

      return Promise.resolve(docker.onExec(name, argv, stdin, opts?.user));
    },
    start: (name) => {
      named(name).state = 'running';

      return Promise.resolve();
    },
    remove: (name) => {
      containersByName.delete(name);

      return Promise.resolve();
    },
    volumeSizes: () =>
      Promise.resolve(
        Object.fromEntries([...volumes].map((v) => [v, docker.volumeBytes.get(v) ?? 0])),
      ),
    volumePath: (name) => Promise.resolve(docker.volumePaths.get(name)),
    removeVolume: (name) => {
      const used = [...containersByName.values()].some((c) =>
        c.spec.mounts.some((m) => m.type === 'volume' && m.source === name),
      );

      if (used) return Promise.reject(new Error(`Error response from daemon: volume is in use`));
      volumes.delete(name);

      return Promise.resolve();
    },
  };

  return docker;
};

export type FakeMirrors = Mirrors & {
  /** Each repo's `.abe/session` tree id. A repo missing here has no workspace image. */
  trees: Map<string, string>;
  synced: string[];
  /** Makes `sync` of this repo fail with this message, as when GitHub is unreachable. */
  failing: Map<string, string>;
  /** Each repo's checkout of its default branch on the box. Defaults to `/box/checkouts/<repo>`. */
  checkouts: Map<string, string>;
};

export const fakeMirrors = (): FakeMirrors => {
  const m: FakeMirrors = {
    trees: new Map(),
    synced: [],
    failing: new Map(),
    checkouts: new Map(),
    sync: (repo) => {
      const why = m.failing.get(repo);

      if (why !== undefined) return Promise.reject(new Error(why));
      m.synced.push(repo);

      return Promise.resolve(`/box/mirrors/${repo}.git`);
    },
    // A repo never fetched has no mirror on the box to read a tree from.
    tree: (repo) => Promise.resolve(m.synced.includes(repo) ? m.trees.get(repo) : undefined),
    snapshot: (repo) => Promise.resolve(`/box/build/${repo}`),
    checkout: (repo) => Promise.resolve(m.checkouts.get(repo) ?? `/box/checkouts/${repo}`),
  };

  return m;
};

export type FakeRelays = WorkspaceRelays & {
  /** Every relay opened, with the container and its port. */
  opened: { container: string; port: number }[];
};

/**
 * A box's relays for real on this machine's 127.0.0.1. Each connection pipes through `cat` in
 * place of `docker exec … abe port pipe`, so what is written comes back.
 */
export const echoRelays = (): FakeRelays => {
  const real = workspaceRelays({ env: process.env, command: () => ['cat'] });
  const opened: FakeRelays['opened'] = [];

  return {
    opened,
    open: (container, port) => {
      opened.push({ container, port });

      return real.open(container, port);
    },
  };
};

/** The local Docker as compose sees it: the context it is on, and each project taken down. */
export type FakeCompose = Compose & {
  /** The context `endpoint` answers, a local socket by default; null: no Docker here. */
  context: DockerEndpoint | null;
  /** Every `down`, oldest first: the project and the `DOCKER_*` it went with. */
  downs: { project: string; docker: Record<string, string> }[];
  /** Every `run`, oldest first: the project, its args, where and what it was handed. */
  runs: { project: string; args: readonly string[]; cwd: string; stdin?: string }[];
  /** Every network join and leave, oldest first: `join <network> <container>`. */
  networks: string[];
};

/** A local socket, as Docker Desktop's default context reaches it. */
export const LOCAL_DOCKER: DockerEndpoint = {
  name: 'default',
  host: 'unix:///var/run/docker.sock',
};

export const fakeCompose = (context: DockerEndpoint | null = LOCAL_DOCKER): FakeCompose => {
  const fake: FakeCompose = {
    context,
    downs: [],
    runs: [],
    networks: [],
    endpoint: () => Promise.resolve(fake.context),
    run: ({ project, args, cwd, stdin }) => {
      fake.runs.push({ project, args, cwd, ...(stdin === undefined ? {} : { stdin }) });

      return Promise.resolve(OK);
    },
    network: ({ network, container, leave = false }) => {
      fake.networks.push(`${leave ? 'leave' : 'join'} ${network} ${container}`);

      return Promise.resolve(OK);
    },
    down: ({ project, env }) => {
      fake.downs.push({
        project,
        docker: Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('DOCKER_'))),
      });

      return Promise.resolve(OK);
    },
  };

  return fake;
};
