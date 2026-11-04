/**
 * The workspace container's AppArmor profile (`images/box/apparmor/abe-workspace`, #67): Docker's
 * docker-default with only the mounts Claude Code's sandbox (bubblewrap) makes, and the box
 * host's script that loads it. Proved against bwrap on a real box (`.scratch/2.0/t67`); here its
 * shape is held: no mount rule but bwrap's places and file system types, docker-default's other
 * denials kept. The loader runs for real against a stand-in `apparmor_parser` and AppArmor's
 * `enabled` switch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROFILE = readFileSync(join(import.meta.dir, 'apparmor/abe-workspace'), 'utf8');
const LOADER = join(import.meta.dir, 'apparmor.sh');

/** The profile's rules, comments and blank lines left out. */
const rules = PROFILE.split('\n')
  .map((line) => line.replace(/#(?!include).*$/, '').trim())
  .filter((line) => line !== '');

/**
 * Every mount, remount and pivot_root the profile allows: exactly bubblewrap's, each found from an
 * AppArmor audit line on the box, each its own kind (a propagation change, a bind, a remount, a new
 * mount with its file system type), so no rule lets a new mount of any type through.
 */
const MOUNTS = [
  'mount options in (rslave, silent) -> /,',
  'mount fstype=tmpfs options in (nosuid, nodev, silent) tmpfs -> /tmp/,',
  'mount options in (bind, rbind) /tmp/newroot/ -> /tmp/newroot/,',
  'pivot_root oldroot=/tmp/oldroot/ /tmp/,',
  'mount options in (bind, rbind) /oldroot/proc/ -> /proc/,',
  'mount options in (bind, rbind) /oldroot/{,**} -> /newroot/{,**},',
  'remount options in (ro, nosuid, nodev, noexec, noatime, nodiratime, relatime, strictatime, bind, silent) /newroot/{,**},',
  'mount fstype=tmpfs options in (nosuid, nodev, silent) tmpfs -> /newroot/{,**},',
  'mount fstype=devpts options in (nosuid, noexec, silent) devpts -> /newroot/dev/pts/,',
  'mount fstype=mqueue options in (nosuid, nodev, noexec, silent) mqueue -> /newroot/dev/mqueue/,',
  'mount fstype=proc options in (nosuid, nodev, noexec, silent) proc -> /newroot/proc/,',
  'mount options in (rprivate, silent) -> /oldroot/,',
  'pivot_root oldroot=/newroot/ /newroot/,',
];

/** docker-default's own rules (moby's profiles/apparmor template), all kept but `deny mount`. */
const DOCKER_DEFAULT = [
  'network,',
  'capability,',
  'file,',
  'umount,',
  'signal (receive) peer=unconfined,',
  'signal (receive) peer=runc,',
  'signal (receive) peer=crun,',
  'signal (receive) peer=dockerd,',
  'signal (send,receive) peer=abe-workspace,',
  'deny @{PROC}/* w,',
  'deny @{PROC}/{[^1-9],[^1-9][^0-9],[^1-9s][^0-9y][^0-9s],[^1-9][^0-9][^0-9][^0-9/]*}/** w,',
  'deny @{PROC}/sys/[^k]** w,',
  'deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,',
  'deny @{PROC}/sysrq-trigger rwklx,',
  'deny @{PROC}/kcore rwklx,',
  'deny /sys/[^f]*/** wklx,',
  'deny /sys/f[^s]*/** wklx,',
  'deny /sys/fs/[^c]*/** wklx,',
  'deny /sys/fs/c[^g]*/** wklx,',
  'deny /sys/fs/cg[^r]*/** wklx,',
  'deny /sys/firmware/** rwklx,',
  'deny /sys/devices/virtual/powercap/** rwklx,',
  'deny /sys/kernel/security/** rwklx,',
  'ptrace (trace,read,tracedby,readby) peer=abe-workspace,',
];

/** docker-default's rules the profile adds to: /proc's kernel symbols, modules and keys not read. */
const OWN_PROC: Record<string, string[]> = {
  'deny @{PROC}/kcore rwklx,': [
    'deny @{PROC}/kcore rwklx,',
    'deny @{PROC}/{kallsyms,modules,keys} r,',
  ],
};

/** An AppArmor path glob (`@{PROC}`, `{a,b}`, `[^x]`, `**`, `*`, `?`) as a RegExp. */
const glob = (pattern: string): RegExp => {
  const re = pattern
    .replace('@{PROC}', '/proc/')
    .replaceAll('//', '/')
    .replace(/\*\*|\*|\?|\{|\}|,|\[\^?|[.+()$|]/g, (t) => {
      switch (t) {
        case '**':
          return '.*';
        case '*':
          return '[^/]*';
        case '?':
          return '[^/]';
        case '{':
          return '(?:';
        case '}':
          return ')';
        case ',':
          return '|';
        case '[':
        case '[^':
          return t;
        default:
          return `\\${t}`;
      }
    });

  return new RegExp(`^${re}$`);
};

describe('the abe-workspace AppArmor profile', () => {
  test('is the profile the container names', () => {
    expect(rules).toContain('profile abe-workspace flags=(attach_disconnected,mediate_deleted) {');
  });

  test("allows exactly bubblewrap's mounts and no other", () => {
    expect(rules.filter((r) => /^(deny )?(mount|remount|umount|pivot_root)\b/.test(r))).toEqual([
      'umount,',
      ...MOUNTS,
    ]);
  });

  test("is docker-default's rules otherwise, in its order, but its own /proc rules", () => {
    const body = rules.slice(rules.indexOf('#include <abstractions/base>') + 1, -1);

    expect(body.filter((r) => !MOUNTS.includes(r))).toEqual(
      DOCKER_DEFAULT.flatMap((r) => OWN_PROC[r] ?? [r]),
    );
  });

  /** Every rule denying `perm` on `path`, each glob as AppArmor matches it. */
  const denies = (path: string, perm: string) =>
    rules.filter((r) => {
      const [, target, perms] = /^deny (\S+) (\w+),$/.exec(r) ?? [];

      return target !== undefined && perms?.includes(perm) === true && glob(target).test(path);
    });

  test.each(['/proc/kallsyms', '/proc/modules', '/proc/keys', '/proc/kcore'])(
    'denies reading %s',
    (path) => {
      expect(denies(path, 'r')).not.toEqual([]);
    },
  );
});

describe("the box host's loader", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apparmor-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The loader with AppArmor's switch saying `enabled` and a parser that exits `parser`. */
  const load = (enabled: string | undefined, parser = 0) => {
    const switchFile = join(dir, 'enabled');
    const calls = join(dir, 'parser.log');

    if (enabled !== undefined) writeFileSync(switchFile, `${enabled}\n`);
    writeFileSync(
      join(dir, 'apparmor_parser'),
      `#!/bin/sh\necho "$*" >> '${calls}'\nexit ${String(parser)}\n`,
    );
    chmodSync(join(dir, 'apparmor_parser'), 0o755);
    const ran = Bun.spawnSync(['bash', LOADER], {
      env: { PATH: `${dir}:/usr/bin:/bin`, ABE_APPARMOR_ENABLED: switchFile },
    });
    const parsed = existsSync(calls) ? readFileSync(calls, 'utf8') : '';

    return { exit: ran.exitCode, stderr: ran.stderr.toString(), parsed };
  };

  test('loads the profile from the images, replacing an older one', () => {
    const ran = load('Y');

    expect(ran.exit).toBe(0);
    expect(ran.parsed).toBe(`-r ${join(import.meta.dir, 'apparmor/abe-workspace')}\n`);
  });

  test.each([
    ['off', 'N'],
    ['missing', undefined],
  ])('fails with AppArmor %s, so the workspace never starts unconfined', (_, enabled) => {
    const ran = load(enabled);

    expect(ran.exit).toBe(1);
    expect(ran.stderr).toContain('AppArmor is not enabled');
    expect(ran.parsed).toBe('');
  });

  test('fails when the parser refuses the profile', () => {
    expect(load('Y', 1).exit).not.toBe(0);
  });
});
