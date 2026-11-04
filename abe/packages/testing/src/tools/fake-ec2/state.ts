/** The fake EC2's state on disk, shared by its `aws` (`aws.ts`) and the test's controls (`ec2.ts`). */
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOX_STATES } from '@abe/core';
import { z } from 'zod';

/** A lock older than this is a killed call's, such as an `aws` that timed out. It gets taken over. */
const STALE_LOCK_MS = 5_000;

/**
 * One change of the state at a time, from a fake `aws` call or a test's control. Each reads,
 * changes and writes the state whole under `dir`'s lock, so none is lost to another. Returns the
 * lock's release.
 */
export const lockState = (dir: string): (() => void) => {
  const lock = join(dir, 'state.lock');

  for (;;) {
    try {
      mkdirSync(lock);

      return () => {
        rmSync(lock, { recursive: true, force: true });
      };
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { recursive: true });
      } catch {
        // Released meanwhile, so try again.
      }
      Bun.sleepSync(2);
    }
  }
};

/** Writes the state whole, so a reader never sees half of it. */
export const writeState = (file: string, state: unknown) => {
  const temp = `${file}.${process.pid}.tmp`;

  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, file);
};

export const FakeInstance = z.object({
  InstanceId: z.string(),
  InstanceType: z.string(),
  State: z.enum(BOX_STATES),
  /** When it reached its state, in epoch ms. */
  since: z.number(),
  /** EC2's LaunchTime in epoch ms, when it was made or last started. */
  launchedAt: z.number(),
  /** A held instance stays in its state, like a box that never comes up. */
  held: z.boolean(),
  PrivateIpAddress: z.string(),
  Tags: z.array(z.object({ Key: z.string(), Value: z.string() })),
  /** The instance profile it was made with. */
  profile: z.string(),
  /** When `run-instances` made it, in epoch ms. None means a test put it there. */
  madeAt: z.number().optional(),
});
export type FakeInstance = z.infer<typeof FakeInstance>;

export const Ec2State = z.object({
  /** The caller's GitHub login. IAM lets them act on that login's boxes. */
  owner: z.string(),
  /** The caller's SSO session name, as IAM says it in a refusal. */
  sso: z.string(),
  template: z.string(),
  /** The launch template version a new box gets, in its `aws:ec2launchtemplate:version` tag. */
  templateVersion: z.number().int().positive(),
  /** The caller may terminate their boxes. A lead's role may, a developer's may not. */
  lead: z.boolean(),
  sizes: z.array(z.string()),
  bootMs: z.number(),
  stopMs: z.number(),
  /**
   * How long `run-instances` takes to answer. A real `aws` call takes a second or two. The new
   * instance is in no `describe-instances` until it answers.
   */
  createMs: z.number().default(0),
  /** EC2's eventual consistency. A new instance is in no `describe-instances` for this long. */
  listLagMs: z.number().default(0),
  /** The SSO login expired, and every call says so. */
  expired: z.boolean(),
  /** The caller is an IAM user on its keys, not an SSO session: expired, its keys are refused. */
  keys: z.boolean().default(false),
  next: z.number(),
  instances: z.array(FakeInstance),
});
export type Ec2State = z.infer<typeof Ec2State>;

/** The instance's state moved on with time, pending to running and stopping to stopped. */
export const settle = (i: FakeInstance, s: Ec2State, now: number): void => {
  if (i.held) return;
  if (i.State === 'pending' && now - i.since >= s.bootMs) {
    i.State = 'running';
    i.since = i.since + s.bootMs;
  } else if (i.State === 'stopping' && now - i.since >= s.stopMs) {
    i.State = 'stopped';
    i.since = i.since + s.stopMs;
  } else if (i.State === 'shutting-down' && now - i.since >= s.stopMs) {
    i.State = 'terminated';
    i.since = i.since + s.stopMs;
  }
};

/** What `--tag-specifications` holds, as JSON. */
export const TagSpecs = z.array(
  z.looseObject({
    ResourceType: z.string(),
    Tags: z.array(z.looseObject({ Key: z.string(), Value: z.string() })),
  }),
);
