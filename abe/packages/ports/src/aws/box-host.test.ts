/**
 * The box's own machine (#92) against a fake `sudo` and a fake `who`: the exact shutdown its
 * `serve` runs once idle, and a login with a terminal (`abe box attach`'s SSH) seen as attached.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FakeTool, fakeTool } from '@abe/testing';
import { boxHost } from './box-host';

const tools: FakeTool[] = [];
const tool = (...args: Parameters<typeof fakeTool>) => {
  const t = fakeTool(...args);

  tools.push(t);

  return t;
};

afterEach(() => {
  for (const t of tools.splice(0)) t.remove();
});

describe('shutdown', () => {
  test('sudo -n shutdown -h now: the instance stops (its disk kept)', async () => {
    const sudo = tool('sudo', { exit: 0 });

    expect(await boxHost({ env: { PATH: sudo.path } }).shutdown()).toEqual({
      ok: true,
      data: null,
    });
    expect(sudo.calls().map((c) => c.argv)).toEqual([['-n', '/usr/sbin/shutdown', '-h', 'now']]);
  });

  test('refused (no sudoers rule): said', async () => {
    const sudo = tool('sudo', { stderr: 'sudo: a password is required', exit: 1 });

    expect(await boxHost({ env: { PATH: sudo.path } }).shutdown()).toEqual({
      ok: false,
      error: { code: 'shutdown-failed', message: 'sudo: a password is required' },
    });
  });
});

describe('attached', () => {
  test.each<[string, string, boolean]>([
    ['nobody logged in', '', false],
    ['an SSH login with a terminal', 'ubuntu   pts/0        2026-10-24 10:00 (10.40.1.9)\n', true],
  ])('%s', async (_, said, attached) => {
    const who = tool('who', { stdout: said, exit: 0 });

    expect(await boxHost({ env: { PATH: who.path } }).attached()).toBe(attached);
  });

  test('who failing is no one attached', async () => {
    const who = tool('who', { stdout: 'x', exit: 1 });

    expect(await boxHost({ env: { PATH: who.path } }).attached()).toBe(false);
  });
});

describe('boot', () => {
  test("the kernel's boot_id, trimmed; none readable is not known", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boot-'));
    const file = join(dir, 'boot_id');

    try {
      writeFileSync(file, '3f2c9e1a-0d4b-4c55-9b1e-7a6f0c2d8e11\n');
      expect(await boxHost({ env: {}, bootFile: file }).boot?.()).toBe(
        '3f2c9e1a-0d4b-4c55-9b1e-7a6f0c2d8e11',
      );
      expect(await boxHost({ env: {}, bootFile: join(dir, 'none') }).boot?.()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('load (ADR 0022: what the box has left)', () => {
  test("memory, the CPU counters and the root disk, from Linux's own files", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abe-proc-'));

    writeFileSync(
      join(dir, 'meminfo'),
      'MemTotal:       16000000 kB\nMemFree:         500000 kB\nMemAvailable:    1433600 kB\n',
    );
    // user nice system idle iowait irq softirq steal: busy is all but idle and iowait.
    writeFileSync(join(dir, 'stat'), 'cpu  100 0 50 800 40 5 5 0 0 0\ncpu0 1 2 3 4\n');
    try {
      const read = await boxHost({
        env: {},
        proc: { meminfo: join(dir, 'meminfo'), stat: join(dir, 'stat'), root: dir },
      }).load?.();

      expect(read).toMatchObject({
        memAvailableKb: 1_433_600,
        memTotalKb: 16_000_000,
        cpu: { busy: 160, total: 1000 },
      });
      expect(read?.disk.totalBytes).toBeGreaterThan(0);
      expect(read?.disk.freeBytes).toBeLessThanOrEqual(read?.disk.totalBytes ?? 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('growRoot (ADR 0022: +20 GB under 20 % free, up to limits.maxBoxDisk)', () => {
  const VOLUMES = [{ id: 'vol-0ab', size: 60, device: '/dev/xvda' }];
  const env = (aws: FakeTool, sudo: FakeTool) => ({
    PATH: `${aws.dir}:${sudo.path}`,
    ABE_INSTANCE_ID: 'i-0123',
    AWS_REGION: 'eu-west-1',
  });

  test("EC2 grows the instance's root volume, then its filesystem takes the room", async () => {
    const aws = tool('aws', { exit: 0 }, [
      ['describe-volumes-modifications', { stdout: 'optimizing\n' }],
      ['describe-volumes', { json: VOLUMES }],
      ['modify-volume', { json: { VolumeModification: { ModificationState: 'modifying' } } }],
    ]);
    const sudo = tool('sudo', { stdout: '85899345920 21474836480\n', exit: 0 });
    const grown = await boxHost({ env: env(aws, sudo), sleep: () => Promise.resolve() }).growRoot?.(
      200,
    );

    // The 60 GB volume (its own size, not its filesystem's) to 80.
    expect(grown).toEqual({
      ok: true,
      data: { totalBytes: 85_899_345_920, freeBytes: 21_474_836_480, toGb: 80 },
    });
    expect(aws.calls().map((c) => c.argv.slice(0, 2).concat(c.argv.slice(2, 4)))).toEqual([
      ['ec2', 'describe-volumes', '--filters', 'Name=attachment.instance-id,Values=i-0123'],
      ['ec2', 'modify-volume', '--volume-id', 'vol-0ab'],
      ['ec2', 'describe-volumes-modifications', '--volume-ids', 'vol-0ab'],
    ]);
    expect(aws.calls()[1]?.argv.slice(-2)).toEqual(['--size', '80']);
    expect(aws.calls()[0]?.env.AWS_REGION).toBe('eu-west-1');
    expect(sudo.calls().map((c) => c.argv)).toEqual([['-n', '/usr/local/sbin/abe-grow-root']]);
  });

  test('EC2 refusing the change (no abe-box-disk policy) is said, the filesystem left alone', async () => {
    const aws = tool('aws', { exit: 0 }, [
      ['describe-volumes', { json: VOLUMES }],
      [
        'modify-volume',
        {
          stderr:
            'An error occurred (UnauthorizedOperation) when calling the ModifyVolume operation',
          exit: 254,
        },
      ],
    ]);
    const sudo = tool('sudo', { exit: 0 });
    const grown = await boxHost({ env: env(aws, sudo) }).growRoot?.(200);

    expect(grown?.ok === false && grown.error.code).toBe('grow-failed');
    expect(grown?.ok === false && grown.error.message).toContain('UnauthorizedOperation');
    expect(sudo.calls()).toEqual([]);
  });

  test('a volume at limits.maxBoxDisk is not changed or waited on; its filesystem still takes what it has', async () => {
    const aws = tool('aws', { exit: 0 }, [
      ['describe-volumes', { json: [{ id: 'vol-0ab', size: 200, device: '/dev/xvda' }] }],
    ]);
    const sudo = tool('sudo', { stdout: '214748364800 32212254720\n', exit: 0 });
    const grown = await boxHost({ env: env(aws, sudo) }).growRoot?.(200);

    expect(grown).toEqual({
      ok: true,
      data: { totalBytes: 214_748_364_800, freeBytes: 32_212_254_720, toGb: null },
    });
    expect(aws.calls().map((c) => c.argv[1])).toEqual(['describe-volumes']);
  });

  test('a box not told its instance grows nothing', async () => {
    const aws = tool('aws', { exit: 0 });
    const grown = await boxHost({ env: { PATH: aws.path } }).growRoot?.(200);

    expect(grown).toEqual({
      ok: false,
      error: {
        code: 'no-instance',
        message: 'this box was not told its instance (ABE_INSTANCE_ID)',
      },
    });
    expect(aws.calls()).toEqual([]);
  });
});
