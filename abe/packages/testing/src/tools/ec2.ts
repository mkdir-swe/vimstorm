/**
 * EC2 boxes for tests, per ADR 0021. A fake `aws` on disk, `fake-ec2/aws.ts`, takes the real
 * `ec2Boxes` port's calls through the real `awsRunner`, IAM's ABAC included. A fake box shell,
 * `box-ssh [-t] <box> -- <command>` set as `ABE_BOX_LINK=exec:<it>`, runs a command as the box's
 * shell would. Its `abe` is this checkout's, and it reaches the `serve` that stands in for that
 * box. As with SSH, a box the fake EC2 does not report as running cannot be reached.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOX_SIZES, BOX_LAUNCH_TEMPLATE, type BoxState } from '@abe/core';
import { Ec2State, type FakeInstance, lockState, settle, writeState } from './fake-ec2/state';

const IMPL = join(import.meta.dir, 'fake-ec2', 'aws.ts');
const RUNNING = join(import.meta.dir, 'fake-ec2', 'running.ts');
const ENTRY = join(import.meta.dir, '..', '..', '..', 'serve', 'src', 'main.ts');

export type { FakeInstance };

export type FakeEc2 = {
  dir: string;
  /** `PATH` with the fake `aws` first and only the system's tools after it. */
  path: string;
  /** The caller's GitHub login. Boxes tagged with it are theirs. */
  owner: string;
  /** Every instance now, each state moved on with time. */
  instances: () => FakeInstance[];
  /** The instance whose `abe:box` is `name`. The caller's wins over anyone else's. */
  instance: (name: string) => FakeInstance | undefined;
  /** Adds an instance as if made earlier, for any owner, and returns its id. */
  put: (b: {
    name: string;
    owner?: string;
    state?: BoxState;
    size?: string;
    repo?: string;
    card?: number;
    title?: string;
    /**
     * Its launch template version, `aws:ec2launchtemplate:version`. Left out, the template did not
     * make it.
     */
    release?: number;
    /** Its LaunchTime in epoch ms. Defaults to now. */
    launchedAt?: number;
  }) => string;
  /** Moves the box to `state` now, as a person in the console or its own idle stop would. */
  set: (name: string, state: BoxState) => void;
  /** A held box stays in its state, like one that never comes up. */
  hold: (name: string, held: boolean) => void;
  /** Expires the SSO login (refuses an IAM user's keys), or brings it back. */
  expire: (expired: boolean) => void;
  /** Makes the caller a lead, whose role may terminate their boxes. Off by default. */
  lead: (lead: boolean) => void;
  /** Each `aws` call so far, as typed. */
  calls: () => string[];
  remove: () => void;
};

const readOr = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

const lines = (text: string) => text.split('\n').filter((l) => l !== '');

export const fakeEc2 = (
  o: {
    owner?: string;
    sso?: string;
    /** The caller is an IAM user on its keys (named `sso`), not an SSO session. */
    keys?: boolean;
    bootMs?: number;
    stopMs?: number;
    /** How long `run-instances` takes to answer. Defaults to at once. */
    createMs?: number;
    /** How long a new instance stays out of `describe-instances`, as EC2 lags. Defaults to none. */
    listLagMs?: number;
    sizes?: string[];
  } = {},
): FakeEc2 => {
  const dir = mkdtempSync(join(tmpdir(), 'ec2-'));
  const file = join(dir, 'state.json');
  const owner = o.owner ?? 'octocat';
  const read = () => Ec2State.parse(JSON.parse(readFileSync(file, 'utf8')));
  const write = (s: Ec2State) => {
    writeState(file, s);
  };
  // Takes the state's lock, as each fake `aws` call does, so neither loses the other's change.
  const change = (fn: (s: Ec2State) => void) => {
    const unlock = lockState(dir);

    try {
      const s = read();
      const now = Date.now();

      for (const i of s.instances) settle(i, s, now);
      fn(s);
      write(s);
    } finally {
      unlock();
    }
  };
  const named = (s: Ec2State, name: string) => {
    const tagged = s.instances.filter((i) =>
      i.Tags.some((t) => t.Key === 'abe:box' && t.Value === name),
    );

    return (
      tagged.find((i) => i.Tags.some((t) => t.Key === 'abe:owner' && t.Value === owner)) ??
      tagged[0]
    );
  };

  write({
    owner,
    sso: o.sso ?? owner,
    template: BOX_LAUNCH_TEMPLATE,
    templateVersion: 11,
    lead: false,
    sizes: o.sizes ?? [...BOX_SIZES],
    bootMs: o.bootMs ?? 50,
    stopMs: o.stopMs ?? 50,
    createMs: o.createMs ?? 0,
    listLagMs: o.listLagMs ?? 0,
    expired: false,
    keys: o.keys ?? false,
    next: 0,
    instances: [],
  });
  writeFileSync(join(dir, 'aws'), `#!${process.execPath}\nimport ${JSON.stringify(IMPL)};\n`, {
    mode: 0o755,
  });

  return {
    dir,
    path: `${dir}:/usr/bin:/bin`,
    owner,
    instances: () => {
      const s = read();
      const now = Date.now();

      for (const i of s.instances) settle(i, s, now);

      return s.instances;
    },
    instance: (name) => {
      const s = read();
      const found = named(s, name);

      if (found !== undefined) settle(found, s, Date.now());

      return found;
    },
    put: (b) => {
      let id = '';

      change((s) => {
        s.next += 1;
        id = `i-${String(s.next).padStart(17, '0')}`;
        const who = b.owner ?? owner;

        s.instances.push({
          InstanceId: id,
          InstanceType: b.size ?? BOX_SIZES[0],
          State: b.state ?? 'running',
          since: Date.now(),
          launchedAt: b.launchedAt ?? Date.now(),
          held: false,
          PrivateIpAddress: `10.40.0.${s.next}`,
          Tags: [
            { Key: 'abe:owner', Value: who },
            { Key: 'abe:box', Value: b.name },
            ...(b.repo === undefined ? [] : [{ Key: 'abe:repo', Value: b.repo }]),
            ...(b.card === undefined ? [] : [{ Key: 'abe:card', Value: String(b.card) }]),
            ...(b.title === undefined ? [] : [{ Key: 'abe:title', Value: b.title }]),
            ...(b.release === undefined
              ? []
              : [{ Key: 'aws:ec2launchtemplate:version', Value: String(b.release) }]),
          ],
          profile: `abe-box-${who}-boxes`,
        });
      });

      return id;
    },
    set: (name, state) => {
      change((s) => {
        const i = named(s, name);

        if (i === undefined) throw new Error(`the fake EC2 has no box ${name}`);
        // A start from stopped, as by a person in the console, gets a new LaunchTime.
        if ((state === 'pending' || state === 'running') && i.State === 'stopped')
          i.launchedAt = Date.now();
        i.State = state;
        i.since = Date.now();
      });
    },
    hold: (name, held) => {
      change((s) => {
        const i = named(s, name);

        if (i === undefined) throw new Error(`the fake EC2 has no box ${name}`);
        i.held = held;
      });
    },
    expire: (expired) => {
      change((s) => {
        s.expired = expired;
      });
    },
    lead: (lead) => {
      change((s) => {
        s.lead = lead;
      });
    },
    calls: () => lines(readOr(join(dir, 'calls'))),
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

export type FakeBoxShell = {
  /** The shell's path, for `ABE_BOX_LINK=exec:<path>`. */
  path: string;
  /** Points box `name` at the socket of the `serve` that stands in for it. */
  box: (name: string, socket: string) => void;
  /** Each call so far, as typed, like `demo-shop-4 -- abe 'status' '--json'`. */
  calls: () => string[];
  /** Ends the box's connections whose command has `what` in it, as a dropped network does. */
  drop: (box: string, what: string) => number;
  /**
   * Makes the box's `abe` an older one that does not know these commands, such as `box keep`.
   * It says so as an older abe does: `unknown command: box keep`, then its help, then exit 2.
   */
  older: (box: string, unknown: readonly string[]) => void;
  remove: () => void;
};

const shell = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * A fake box shell over `ec2`'s boxes. `box-ssh [-t] <box> -- <command>` runs `<command>` as the
 * box's shell would, joining the words and splitting them again. The `abe` on its `PATH` is the
 * box's.
 */
export const fakeBoxShell = (ec2: FakeEc2): FakeBoxShell => {
  const dir = mkdtempSync(join(tmpdir(), 'box-ssh-'));
  const bin = join(dir, 'bin');
  const tunnels = join(dir, 'tunnels');

  for (const d of [bin, join(dir, 'boxes'), tunnels]) mkdirSync(d, { recursive: true });
  // An older box's abe. A command in its file is unknown, and the rest go to this checkout's.
  writeFileSync(
    join(bin, 'abe'),
    [
      '#!/bin/sh',
      'f=$ABE_FAKE_UNKNOWN',
      'if [ -n "$f" ] && [ -f "$f" ] && grep -qxF -- "$1 $2" "$f"; then',
      '  json=; for a in "$@"; do [ "$a" = --json ] && json=1; done',
      '  if [ -n "$json" ]; then',
      '    printf \'{"ok":false,"error":{"code":"unknown-command","message":"unknown command: %s"}}\\n\' "$1 $2"',
      '  else printf \'abe: unknown command: %s\\n\' "$1 $2" >&2; fi',
      "  printf '\\nabe: the command line every Abe client uses (VimStorm, agents, scripts)\\n' >&2",
      '  exit 2',
      'fi',
      `exec ${shell(process.execPath)} ${shell(ENTRY)} "$@" --no-start`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, 'box-ssh'),
    [
      '#!/bin/sh',
      `d=${shell(dir)}`,
      'printf \'%s\\n\' "$*" >> "$d/calls"',
      '[ "$1" = -t ] && shift',
      'box=$1; shift',
      '[ "$1" = -- ] && shift',
      `${shell(process.execPath)} ${shell(RUNNING)} ${shell(ec2.dir)} "$box" || exit 255`,
      '[ -f "$d/boxes/$box" ] || { echo "ssh: no route to box $box" >&2; exit 255; }',
      'printf \'%s %s\\n\' "$box" "$*" > "$d/tunnels/$$"',
      // ssh lands in the box's home, never the caller's folder
      'cd "$d"',
      'exec /usr/bin/env ABE_SOCKET="$(cat "$d/boxes/$box")" ABE_FAKE_UNKNOWN="$d/boxes/$box.unknown" PATH="$d/bin:$PATH" /bin/sh -c "$*"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  return {
    path: join(dir, 'box-ssh'),
    box: (name, socket) => {
      writeFileSync(join(dir, 'boxes', name), socket);
    },
    calls: () => lines(readOr(join(dir, 'calls'))),
    older: (box, unknown) => {
      writeFileSync(join(dir, 'boxes', `${box}.unknown`), unknown.map((c) => `${c}\n`).join(''));
    },
    drop: (box, what) => {
      let ended = 0;

      for (const pid of readdirSync(tunnels)) {
        const said = readOr(join(tunnels, pid));

        if (!said.startsWith(`${box} `) || !said.includes(what)) continue;
        rmSync(join(tunnels, pid), { force: true });
        try {
          process.kill(Number(pid), 'SIGKILL');
          ended += 1;
        } catch {
          // Ended on its own already.
        }
      }

      return ended;
    },
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
