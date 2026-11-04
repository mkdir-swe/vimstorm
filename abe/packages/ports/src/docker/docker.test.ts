/** The docker CLI adapter against a fake `docker` that records its argv and answers canned output. */
import { describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ContainerSpec } from '@abe/core';
import { tempState, type TempState } from '@abe/testing';
import { dockerCli, runFlags } from './docker';

const FAKE = `#!/bin/sh
for a in "$@"; do printf '%s\\037' "$a"; done >> "$FAKE_LOG"; echo >> "$FAKE_LOG"
case "$1" in
  ps) echo abc123 ;;
  inspect) cat "$FAKE_INSPECT" ;;
  image) echo 'Error: No such image: abe-base:latest' >&2; exit 1 ;;
  run)
    case "$*" in
      *attr/current*)
        [ -e "$FAKE_LOG.unloaded" ] && { echo 'docker: Error response from daemon: AppArmor enabled on system but the abe-workspace profile could not be loaded.' >&2; exit 125; }
        echo 'abe-workspace (enforce)' ;;
    esac
    printf 'DATABASE_URL=%s\n' "$DATABASE_URL" >> "$FAKE_LOG.env" ;;
  exec) cat ;;
  build) printf '#5 [1/2] FROM docker.io/library/ubuntu\n#6 [2/2] RUN apt-get' >&2 ;;
  start) echo "Error response from daemon: No such container: $2" >&2; exit 1 ;;
  system) echo '[{"Name":"abe-ws-101","Size":"4.1GB"},{"Name":"abe-pg-data","Size":"512.3MB"},{"Name":"x","Size":"N/A"}]' ;;
  volume)
    case "$3" in
      abe-ws-gone) echo "Error response from daemon: get abe-ws-gone: no such volume" >&2; exit 1 ;;
      abe-ws-used) echo "Error response from daemon: remove abe-ws-used: volume is in use - [c0ffee]" >&2; exit 1 ;;
    esac ;;
esac
`;

const fake = (state: TempState) => {
  const bin = join(state.dir, 'docker');
  const log = join(state.dir, 'argv.log');
  const inspect = join(state.dir, 'inspect.json');

  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  writeFileSync(log, '');
  const docker = dockerCli({
    bin,
    env: { PATH: '/usr/bin:/bin', FAKE_LOG: log, FAKE_INSPECT: inspect },
  });
  const calls = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.split('\x1f').slice(0, -1));

  return { docker, calls, inspect };
};

describe('the docker CLI adapter', () => {
  test('containers: a label filter, then one inspect read with zod', async () => {
    const state = tempState();
    const { docker, calls, inspect } = fake(state);

    writeFileSync(
      inspect,
      JSON.stringify([
        {
          Name: '/abe-ws1',
          State: { Status: 'exited' },
          Config: { Labels: { 'abe.box': 'abe' } },
        },
        { Name: '/abe-pg', State: { Status: 'running' }, Config: { Labels: null } },
      ]),
    );
    expect(await docker.containers('abe.box', 'abe')).toEqual([
      { name: 'abe-ws1', state: 'exited', labels: { 'abe.box': 'abe' } },
      { name: 'abe-pg', state: 'running', labels: {} },
    ]);
    expect(calls()).toEqual([
      ['ps', '-aq', '--no-trunc', '--filter', 'label=abe.box=abe'],
      ['inspect', '--type', 'container', 'abc123'],
    ]);
    state.remove();
  });

  test("runFlags: the Mac database's loopback port as --publish (#349)", () => {
    expect(
      runFlags({
        image: 'postgres:17-alpine',
        labels: {},
        env: {},
        mounts: [],
        network: 'bridge',
        publish: [{ host: '127.0.0.1', port: 54123, target: 5432 }],
      }),
    ).toEqual(['--network', 'bridge', '--publish', '127.0.0.1:54123:5432']);
  });

  test("run: a workspace's hardening, limits, mounts and network as flags", async () => {
    const state = tempState();
    const { docker, calls } = fake(state);
    const spec: ContainerSpec = {
      name: 'abe-ws1',
      hostname: 'ws1',
      image: 'abe-session-a-b:latest',
      argv: ['bash', '-c', 'sleep infinity'],
      labels: { 'abe.box': 'abe' },
      env: { DATABASE_URL: 'postgres://ws1:pw@abe-pg:5432/ws1' },
      mounts: [
        { type: 'volume', source: 'abe-ws1', target: '/workspace' },
        { type: 'bind', source: '/m/a.git', target: '/src.git', readOnly: true },
      ],
      network: 'abe-net',
      workdir: '/workspace/repo',
      limits: { memory: '3g', pids: 1024, shm: '256m' },
      hardened: true,
      seccomp: '/state/seccomp-chromium.json',
      apparmor: 'abe-workspace',
      systemPaths: 'unconfined',
    };

    await docker.run(spec);
    expect(calls()).toEqual([
      [
        'run',
        '--detach',
        '--name',
        'abe-ws1',
        '--hostname',
        'ws1',
        '--label',
        'abe.box=abe',
        '--env',
        'DATABASE_URL',
        '--mount',
        'type=volume,source=abe-ws1,target=/workspace',
        '--mount',
        'type=bind,source=/m/a.git,target=/src.git,readonly',
        '--network',
        'abe-net',
        '--workdir',
        '/workspace/repo',
        '--memory',
        '3g',
        '--memory-swap',
        '3g',
        '--pids-limit',
        '1024',
        '--shm-size',
        '256m',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--security-opt',
        'seccomp=/state/seccomp-chromium.json',
        '--security-opt',
        'apparmor=abe-workspace',
        // /proc unmasked: bwrap mounts a fresh one in its user namespace, which Docker's masks stop
        '--security-opt',
        'systempaths=unconfined',
        'abe-session-a-b:latest',
        'bash',
        '-c',
        'sleep infinity',
      ],
    ]);
    // The value reaches docker through its environment, never its argv.
    expect(readFileSync(join(state.dir, 'argv.log.env'), 'utf8')).toBe(
      'DATABASE_URL=postgres://ws1:pw@abe-pg:5432/ws1\n',
    );
    state.remove();
  });

  test('confinement: a throwaway hardened container under the profile says what the kernel put it in', async () => {
    const state = tempState();
    const { docker, calls } = fake(state);

    expect(await docker.confinement('abe-ws:latest', 'abe-workspace')).toBe(
      'abe-workspace (enforce)',
    );
    expect(calls()[0]).toEqual([
      'run',
      '--rm',
      '--label',
      'abe.role=apparmor-check',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--security-opt',
      'apparmor=abe-workspace',
      'abe-ws:latest',
      'sh',
      '-c',
      'cat /proc/self/attr/apparmor/current 2>/dev/null || cat /proc/self/attr/current',
    ]);
    state.remove();
  });

  test('confinement: Docker refusing the profile is an error naming it', async () => {
    const state = tempState();
    const { docker } = fake(state);

    // AppArmor on and the profile never loaded: Docker refuses the container.
    writeFileSync(join(state.dir, 'argv.log.unloaded'), '');
    const refused = await docker.confinement('abe-ws:latest', 'abe-workspace').then(
      () => 'answered',
      (err: unknown) => String(err),
    );

    expect(refused).toBe(
      'Error: docker run failed: docker: Error response from daemon: AppArmor enabled on system but the abe-workspace profile could not be loaded.',
    );
    state.remove();
  });

  test("exec writes stdin; a missing image is undefined; Docker's refusal is an error", async () => {
    const state = tempState();
    const { docker, calls } = fake(state);

    expect(await docker.exec('abe-pg', ['psql'], 'SELECT 1;')).toEqual({
      exit: 0,
      stdout: 'SELECT 1;',
      stderr: '',
    });
    expect(calls()[0]).toEqual(['exec', '--interactive', 'abe-pg', 'psql']);
    expect(await docker.image('abe-base:latest')).toBeUndefined();
    expect(docker.start('abe-ws9')).rejects.toThrow(
      'docker start failed: Error response from daemon: No such container: abe-ws9',
    );
    state.remove();
  });

  test("volumeSizes: each volume's bytes from docker system df's words (decimal units)", async () => {
    const state = tempState();
    const { docker, calls } = fake(state);

    expect(await docker.volumeSizes()).toEqual({
      'abe-ws-101': 4_100_000_000,
      'abe-pg-data': 512_300_000,
      x: 0,
    });
    expect(calls()[0]).toEqual(['system', 'df', '-v', '--format', '{{json .Volumes}}']);
    state.remove();
  });

  test("removeVolume: a card's clone volume goes; one gone already is fine, one in use an error", async () => {
    const state = tempState();
    const { docker, calls } = fake(state);

    await docker.removeVolume('abe-ws-101');
    await docker.removeVolume('abe-ws-gone');
    expect(calls()[0]).toEqual(['volume', 'rm', 'abe-ws-101']);
    expect(docker.removeVolume('abe-ws-used')).rejects.toThrow('volume is in use');
    state.remove();
  });

  test("build: the base image's named abe-bin context, its args and labels as flags", async () => {
    const state = tempState();
    const { docker, calls } = fake(state);

    await docker.build({
      tag: 'abe-base:latest',
      context: '/opt/abe/images/base',
      dockerfile: '/opt/abe/images/base/Dockerfile',
      contexts: { 'abe-bin': '/state/base-bin' },
      args: { ABE_VERSION: '2.0.0', ABE_HASH: 'ab12' },
      labels: { 'abe.version': '2.0.0', 'abe.hash': 'ab12' },
    });
    expect(calls()[0]).toEqual([
      'build',
      '--tag',
      'abe-base:latest',
      '--file',
      '/opt/abe/images/base/Dockerfile',
      '--build-context',
      'abe-bin=/state/base-bin',
      '--build-arg',
      'ABE_VERSION=2.0.0',
      '--build-arg',
      'ABE_HASH=ab12',
      '--label',
      'abe.version=2.0.0',
      '--label',
      'abe.hash=ab12',
      '/opt/abe/images/base',
    ]);
    state.remove();
  });

  test("build: its output's lines handed on as they come, the last without a newline too (#142)", async () => {
    const state = tempState();
    const { docker } = fake(state);
    const lines: string[] = [];
    const ran = await docker.build({
      tag: 'abe-ws-demo:latest',
      context: '/ctx',
      dockerfile: '/ctx/Dockerfile',
      args: {},
      labels: {},
      progress: (line) => lines.push(line),
    });

    expect(lines).toEqual(['#5 [1/2] FROM docker.io/library/ubuntu', '#6 [2/2] RUN apt-get']);
    expect(ran.stderr).toBe('#5 [1/2] FROM docker.io/library/ubuntu\n#6 [2/2] RUN apt-get');
    state.remove();
  });
});
