/**
 * `abe reach`: the Reach in force where the command was typed (the Layers merged by
 * `ctx.settings.at`), checked by core's rules, turned into a session's `ABE_*` variables, AWS
 * profiles and the credentials behind them. Database URLs come through the secrets port, AWS
 * credentials from one AssumeRole as the person (their GitHub login through `Tracking`).
 */
import { isAbsolute, resolve } from 'node:path';
import {
  type Aws,
  type AwsCredentials,
  awsConfigText,
  awsProfiles,
  checkReach,
  type Clock,
  credsPlan,
  type LayerSource,
  type Merged,
  type Outcome,
  type Reach,
  type ReachCredsData,
  type ReachEnvData,
  reachEnv,
  reachOf,
  reachProblemList,
  type ReachTarget,
  reachVars,
  refused,
  type Secrets,
  sessionName,
  type Tracking,
  type Handlers,
} from '@abe/core';
import { findLayerFiles, readYamlFile } from '@abe/ports';
import { type SettingsCtx } from './settings';

/** Credentials already assumed, by role: handed out again while they last. */
export type CredsCache = Map<string, AwsCredentials>;

export type ReachCtx = SettingsCtx & {
  ports: { tracking: Tracking; aws: Aws; secrets: Secrets };
  serve: {
    clock: Clock;
    creds: CredsCache;
    /** Where this `serve` runs: `cloud` on a box, else `local` (no write is given here). */
    where: ReachTarget;
  };
};

/** Credentials closer than this to their end are assumed anew (the AWS SDKs refresh at 15 min). */
const FRESH_MS = 15 * 60_000;

const source = (file: string): LayerSource => ({ place: 'repo', file, ...readYamlFile(file) });

/** The repo's file as merged here: the one a grant may come from (ADR 0030). */
const grantingSources = (merged: Merged): LayerSource[] =>
  merged
    .explain('reach')
    .layers.flatMap((s) => (s.layer === 'repo' && s.file !== null ? [source(s.file)] : []));

export type InForce = { reach: Reach };

/** The Reach in force in `ctx.cwd`, or the refusal: no settings, or a Reach set up wrong. */
export const inForce = (ctx: SettingsCtx): Outcome<InForce> => {
  if (ctx.settings === undefined)
    return refused('no-settings', 'this abe serve was started without its settings');
  const merged = ctx.settings.at(ctx.cwd);
  const problems = checkReach(grantingSources(merged));

  if (problems.length > 0) return refused('bad-reach', reachProblemList(problems));

  return { ok: true, data: { reach: reachOf(merged) } };
};

/**
 * A session's `ABE_*` variables for `target`, each database URL read through the secrets port:
 * what `abe reach env` answers and a session's launch hands on.
 */
export const sessionReach = async (
  ctx: ReachCtx,
  target: ReachTarget,
): Promise<Outcome<ReachEnvData>> => {
  if (target === 'cloud' && ctx.serve.where === 'local')
    return refused(
      'not-cloud',
      'write names are only given in your cloud environment: this abe serve is local',
    );
  const force = inForce(ctx);

  if (!force.ok) return force;
  const vars = reachVars(force.data.reach, target);
  const sources = new Map(
    vars.flatMap((v) => (v.kind === 'secret' ? [[v.source.secret, v.region] as const] : [])),
  );
  const reads = await Promise.all(
    [...sources].map(async ([secret, region]) => ({
      secret,
      read: await ctx.ports.secrets.read({ secret, region }),
    })),
  );
  const failed = reads.flatMap((r) => (r.read.ok ? [] : [r.read.error.message]));

  if (failed.length > 0) return refused('secret-unreadable', failed.join('\n'));
  const values = Object.fromEntries(
    reads.flatMap((r) => (r.read.ok ? [[r.secret, r.read.data]] : [])),
  );
  const env = reachEnv(vars, values);

  if (!env.ok) return refused('secret-unreadable', `not read: ${env.missing.join(', ')}`);

  return { ok: true, data: { target, env: env.env } };
};

const credsOutput = (c: AwsCredentials): ReachCredsData => ({
  Version: 1,
  AccessKeyId: c.accessKeyId,
  SecretAccessKey: c.secretAccessKey,
  SessionToken: c.sessionToken,
  Expiration: c.expiration,
});

export const reachHandlers = <Ctx extends ReachCtx>() =>
  ({
    'reach env': (args, ctx) => sessionReach(ctx, args.target),
    'reach profiles': (args, ctx) => {
      const force = inForce(ctx);

      if (!force.ok) return Promise.resolve(force);
      const profiles = awsProfiles(reachVars(force.data.reach, args.target));

      return Promise.resolve({
        ok: true,
        data: { target: args.target, profiles, config: awsConfigText(profiles) },
      });
    },
    'reach creds': async (args, ctx) => {
      const force = inForce(ctx);

      if (!force.ok) return force;
      const planned = credsPlan(force.data.reach, args.env, args.access, ctx.serve.where);

      if (!planned.ok) return refused(planned.code, planned.message);
      const { plan } = planned;
      const held = ctx.serve.creds.get(plan.roleArn);

      if (held !== undefined && Date.parse(held.expiration) - ctx.serve.clock.now() > FRESH_MS)
        return { ok: true, data: credsOutput(held) };
      const me = await ctx.ports.tracking.me();

      if (!me.ok)
        return refused('no-login', `your GitHub login, for SourceIdentity: ${me.error.message}`);
      const assumed = await ctx.ports.aws.assumeRole({
        roleArn: plan.roleArn,
        sessionName: sessionName(me.data.login),
        sourceIdentity: me.data.login,
        durationSeconds: plan.durationSeconds,
        region: plan.region,
      });

      if (!assumed.ok) return refused(assumed.error.code, assumed.error.message);
      ctx.serve.creds.set(plan.roleArn, assumed.data);

      return { ok: true, data: credsOutput(assumed.data) };
    },
    'reach check': (args, ctx) => {
      const dir = isAbsolute(args.dir) ? args.dir : resolve(ctx.cwd, args.dir);
      const found = findLayerFiles(dir).repo;

      if (found === undefined)
        return Promise.resolve(
          refused('no-layer-files', `${dir} has no abe.yaml: no Reach to check`),
        );
      const sources = [source(found)];
      const problems = checkReach(sources);

      if (problems.length > 0)
        return Promise.resolve(refused('bad-reach', reachProblemList(problems)));

      return Promise.resolve({ ok: true, data: { files: sources.map((s) => s.file) } });
    },
  }) satisfies Partial<Handlers<Ctx>>;
