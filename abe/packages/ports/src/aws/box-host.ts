/**
 * The box's own machine (#92): `sudo -n shutdown -h now` once its `serve` finds it idle (`ubuntu`
 * has passwordless sudo for everything, cloud-init's default, besides the box module's sudoers
 * rule for it; EC2 then stops the instance, its disk kept), and
 * `who` for a login with a terminal: `abe box attach`'s SSH (`-tt`) on the box itself, and the
 * kernel's `boot_id` for which boot this is. Its load (ADR 0022): memory, CPU and the root disk,
 * and the root disk grown (EC2's `modify-volume` on its own root volume, then `sudo -n
 * abe-grow-root`, the box boot's script and sudoers rule).
 */
import { readFile, statfs } from 'node:fs/promises';
import { type BoxHost, rootVolumeTarget } from '@abe/core';
import { z } from 'zod';
import { type Env } from '../mac/locations';
import { failed, runProcess, said } from '../mac/process';

export const SHUTDOWN = ['sudo', '-n', '/usr/sbin/shutdown', '-h', 'now'] as const;

/** Where Linux says which boot this is: a fresh id each boot. */
export const BOOT_ID = '/proc/sys/kernel/random/boot_id';

/** The box boot's script that puts the root filesystem over all of its (grown) disk. */
export const GROW_ROOT = ['sudo', '-n', '/usr/local/sbin/abe-grow-root'] as const;

/** `/proc/meminfo`'s line in kB, or 0. */
const meminfo = (text: string, key: string) =>
  Number(new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(text)?.[1] ?? '0');

/** `/proc/stat`'s first line: all jiffies, and those not idle (idle and iowait are not busy). */
const cpuTimes = (text: string) => {
  const fields = (/^cpu\s+(.*)$/m.exec(text)?.[1] ?? '').trim().split(/\s+/).map(Number);
  const total = fields.slice(0, 8).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);

  return { busy: total - idle, total };
};

/** `aws ec2 describe-volumes`' answer, as asked for (the instance's volumes and their devices). */
const Volumes = z.array(
  z.object({ id: z.string(), size: z.number(), device: z.string().nullable() }),
);

const ROOT_DEVICES = ['/dev/xvda', '/dev/sda1', '/dev/nvme0n1'];

/** How long EC2's resize is waited for before the filesystem is grown (it starts in seconds). */
const MODIFY_TRIES = 60;
const MODIFY_WAIT_MS = 5_000;

export const boxHost = (o: {
  env: Env;
  bootFile?: string;
  /** Where Linux says the box's load (tests: files of their own). */
  proc?: { meminfo?: string; stat?: string; root?: string };
  /** Waits between reads of EC2's resize (tests: none). */
  sleep?: (ms: number) => Promise<void>;
}): BoxHost => {
  const env = { PATH: o.env.PATH ?? '/usr/bin:/bin', LANG: 'C' };
  // The box role's own credentials through the instance metadata, in the box's region.
  const awsEnv = {
    ...env,
    ...(o.env.HOME === undefined ? {} : { HOME: o.env.HOME }),
    ...(o.env.AWS_REGION === undefined ? {} : { AWS_REGION: o.env.AWS_REGION }),
    ...(o.env.AWS_DEFAULT_REGION === undefined
      ? {}
      : { AWS_DEFAULT_REGION: o.env.AWS_DEFAULT_REGION }),
    AWS_PAGER: '',
  };
  const aws = (args: readonly string[]) =>
    runProcess(['aws', ...args], awsEnv, undefined, 60_000).catch((err: unknown) => ({
      exit: 127,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }));
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));

  return {
    shutdown: async () => {
      const ran = await runProcess(SHUTDOWN, env).catch((err: unknown) => ({
        exit: 127,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      }));

      return ran.exit === 0
        ? { ok: true, data: null }
        : failed('shutdown-failed', said(ran, 'shutdown'));
    },
    attached: async () => {
      const ran = await runProcess(['who'], env, undefined, 5000).catch(() => undefined);

      return ran?.exit === 0 && ran.stdout.trim() !== '';
    },
    boot: async () => {
      const id = await readFile(o.bootFile ?? BOOT_ID, 'utf8').catch(() => '');

      return id.trim() === '' ? null : id.trim();
    },
    load: async () => {
      const [mem, stat, root] = await Promise.all([
        readFile(o.proc?.meminfo ?? '/proc/meminfo', 'utf8'),
        readFile(o.proc?.stat ?? '/proc/stat', 'utf8'),
        statfs(o.proc?.root ?? '/'),
      ]);

      return {
        memAvailableKb: meminfo(mem, 'MemAvailable'),
        memTotalKb: meminfo(mem, 'MemTotal'),
        cpu: cpuTimes(stat),
        disk: { freeBytes: root.bavail * root.bsize, totalBytes: root.blocks * root.bsize },
      };
    },
    growRoot: async (maxGb) => {
      const instance = o.env.ABE_INSTANCE_ID ?? '';

      if (instance === '')
        return failed('no-instance', 'this box was not told its instance (ABE_INSTANCE_ID)');
      const listed = await aws([
        'ec2',
        'describe-volumes',
        '--filters',
        `Name=attachment.instance-id,Values=${instance}`,
        '--query',
        'Volumes[].{id:VolumeId,size:Size,device:Attachments[0].Device}',
        '--output',
        'json',
      ]);

      if (listed.exit !== 0) return failed('grow-failed', said(listed, 'aws ec2 describe-volumes'));
      let volumes: z.infer<typeof Volumes>;

      try {
        volumes = Volumes.parse(JSON.parse(listed.stdout));
      } catch (err) {
        return failed('grow-failed', `aws ec2 describe-volumes: ${String(err)}`);
      }
      const root =
        volumes.find((v) => v.device !== null && ROOT_DEVICES.includes(v.device)) ??
        (volumes.length === 1 ? volumes[0] : undefined);

      if (root === undefined)
        return failed('grow-failed', `no root volume is attached to ${instance}`);
      // By the volume's own size (its filesystem's is a little less): none past the cap.
      const toGb = rootVolumeTarget(root.size, maxGb) ?? null;

      if (toGb !== null) {
        const modified = await aws([
          'ec2',
          'modify-volume',
          '--volume-id',
          root.id,
          '--size',
          String(toGb),
        ]);

        if (modified.exit !== 0)
          return failed('grow-failed', said(modified, 'aws ec2 modify-volume'));
      }
      // The new size is the disk's once EC2 is optimizing it (or done); none asked, none waited.
      for (let i = 0; toGb !== null; i += 1) {
        const state = await aws([
          'ec2',
          'describe-volumes-modifications',
          '--volume-ids',
          root.id,
          '--query',
          'VolumesModifications[0].ModificationState',
          '--output',
          'text',
        ]);
        const step = state.stdout.trim();

        if (state.exit === 0 && (step === 'optimizing' || step === 'completed')) break;
        if (state.exit === 0 && step === 'failed')
          return failed('grow-failed', `EC2 could not grow ${root.id}`);
        if (i + 1 >= MODIFY_TRIES)
          return failed('grow-failed', `EC2 still grows ${root.id} (${step || 'no answer'})`);
        await sleep(MODIFY_WAIT_MS);
      }
      const grown = await runProcess(GROW_ROOT, env, undefined, 120_000).catch((err: unknown) => ({
        exit: 127,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      }));

      if (grown.exit !== 0) return failed('grow-failed', said(grown, 'abe-grow-root'));
      const [size, avail] = grown.stdout.trim().split(/\s+/).map(Number);

      return size === undefined || avail === undefined || !Number.isFinite(size + avail)
        ? failed('grow-failed', `abe-grow-root said ${grown.stdout.trim()}`)
        : { ok: true, data: { totalBytes: size, freeBytes: avail, toGb } };
    },
  };
};
