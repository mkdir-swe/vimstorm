/**
 * The person's boxes on EC2 (ADR 0021) through the `aws` CLI on their own profile (Identity
 * Center or an IAM user's keys: any whose credentials resolve): a box is
 * an instance from the box launch template tagged `abe:owner` with their GitHub login. EC2's
 * answers are read with zod; a refusal is said in words (IAM's encoded message left out). IO
 * only: which box and when is serve's and core's.
 */
import {
  type Answered,
  awsProfileKind,
  awsSignIn,
  BOX_LAUNCH_TEMPLATE,
  BOX_STATES,
  type Box,
  type BoxAws,
  type Boxes,
  type BoxSpec,
  boxRoleName,
  byBoxName,
} from '@abe/core';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { type AwsCli, awsRunner } from './aws';
import { type Env } from '../mac/locations';
import { ghTrackingFrom } from '../github/tracking';

export type Ec2BoxesOptions = {
  aws: AwsCli;
  /** The person's GitHub login (`gh`'s): the `abe:owner` of their boxes. Asked once, then kept. */
  owner: () => Promise<Answered<string>>;
  /**
   * The person's profile in their boxes' account, as the sign-in command names it when the login
   * expired (the CLI itself reads it from `AWS_PROFILE`; null: none named).
   */
  profile?: string | null;
  /** The profile signs in with an IAM user's keys (`aws configure`), not Identity Center's. */
  keys?: boolean;
  /** `--region` (null: the CLI's own). */
  region?: string | null;
  /** The launch template's name (default `BOX_LAUNCH_TEMPLATE`). */
  template?: string;
};

const Tag = z.looseObject({ Key: z.string(), Value: z.string() });
const Instance = z.looseObject({
  InstanceId: z.string(),
  InstanceType: z.string(),
  LaunchTime: z.string().nullish(),
  State: z.looseObject({ Name: z.enum(BOX_STATES) }),
  Placement: z.looseObject({ AvailabilityZone: z.string() }),
  PrivateIpAddress: z.string().nullish(),
  VpcId: z.string().nullish(),
  SubnetId: z.string().nullish(),
  Tags: z.array(Tag).nullish(),
});
type Instance = z.infer<typeof Instance>;
const Described = z.looseObject({
  Reservations: z.array(z.looseObject({ Instances: z.array(Instance) })),
});
const Ran = z.looseObject({ Instances: z.array(Instance).min(1) });

const tagOf = (i: Instance, key: string): string | null =>
  i.Tags?.find((t) => t.Key === key)?.Value ?? null;

/** EC2's LaunchTime (`2026-10-24T08:00:00+00:00`) as ISO; null when it says none or no time. */
const launchedOf = (text: string | null | undefined): string | null => {
  const ms = text === null || text === undefined ? Number.NaN : Date.parse(text);

  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/** A whole number above zero from a tag (`'11'`); else null. */
const countOf = (text: string | null): number | null => {
  const n = Number(text ?? '');

  return text !== null && Number.isInteger(n) && n > 0 ? n : null;
};

/** One instance as a box, or `undefined` for one without its owner and name tags. */
const boxOf = (i: Instance): Box | undefined => {
  const name = tagOf(i, 'abe:box');
  const owner = tagOf(i, 'abe:owner');

  if (name === null || owner === null) return undefined;
  const card = Number(tagOf(i, 'abe:card') ?? '');
  const repo = tagOf(i, 'abe:repo');
  const title = tagOf(i, 'abe:title');

  return {
    id: i.InstanceId,
    name,
    owner,
    state: i.State.Name,
    size: i.InstanceType,
    zone: i.Placement.AvailabilityZone,
    privateIp: i.PrivateIpAddress ?? null,
    vpc: i.VpcId ?? null,
    subnet: i.SubnetId ?? null,
    repo: repo === '' ? null : repo,
    card: Number.isInteger(card) && card > 0 ? card : null,
    title: title === '' ? null : title,
    launchedAt: launchedOf(i.LaunchTime),
    release: countOf(tagOf(i, 'aws:ec2launchtemplate:version')),
  };
};

/** What a box's owner is told when IAM keeps terminating to their lead (ABAC). */
export const TERMINATE_REFUSED = 'Terminate refused: only your lead can terminate boxes';

type Failed = { ok: false; error: { code: string; message: string; profile?: string | undefined } };

const failed = (code: string, message: string): Failed => ({ ok: false, error: { code, message } });

/**
 * Not logged in to AWS: the words, and the profile to log in with as the error's own (#135);
 * `keys`: it signs in with an IAM user's keys.
 */
export const awsAuth = (said: string, profile: string | null, keys = false): Failed => ({
  ok: false,
  error: {
    code: 'aws-auth',
    message: `not logged in to AWS (${said}): run \`${awsSignIn(profile, keys)}\``,
    ...(profile === null ? {} : { profile }),
    ...(keys ? { keys } : {}),
  },
});

/** EC2 / IAM / SSO's refusal in words: who refused and why, never IAM's encoded blob. */
export const awsFailure = (message: string, profile: string | null, keys = false): Failed => {
  const said = message
    .replace(/\s*Encoded authorization failure message:.*$/s, '')
    .replace(/^\s*An error occurred /, '')
    .trim();
  if (/UnauthorizedOperation|AccessDenied|not authorized/i.test(message))
    return failed('aws-refused', `AWS refused it (${said}): only your own boxes are yours`);
  if (
    /Token has expired|ExpiredToken|SSO session|sso login|Error loading SSO Token|Unable to locate credentials|InvalidClientTokenId/i.test(
      message,
    )
  )
    // No profile named and none to sign in with: what is missing is the profile (#344).
    return profile === null && /Unable to locate credentials/i.test(message)
      ? failed(
          'aws-profile',
          "no AWS profile reaches your boxes: abe settings set box.profile <profile> (the AWS profile of your boxes' account, as ~/.aws/config names it) and abe serve stop, then sign in to it (aws sso login --profile <profile>, or aws configure --profile <profile> for an IAM user's keys)",
        )
      : awsAuth(said, profile, keys);
  // the CLI's own words name `aws configure`; say which profile lacks one and both fixes (#294)
  if (/You must specify a region/i.test(message))
    return failed(
      'aws-region',
      profile === null
        ? "no AWS region for the default profile: abe settings set box.region <region> (your boxes' region) then abe serve stop, or add region to it in ~/.aws/config"
        : `no AWS region for profile ${profile}: abe settings set box.region <region> (your boxes' region) then abe serve stop, or add region to that profile in ~/.aws/config`,
    );

  return failed('aws-failed', said === '' ? 'aws failed' : said);
};

const readJson = <T extends z.ZodType>(
  schema: T,
  stdout: string,
  what: string,
): Answered<z.output<T>> => {
  try {
    const read = schema.safeParse(JSON.parse(stdout));

    return read.success
      ? { ok: true, data: read.data }
      : failed('aws-failed', `aws ${what} answered a shape Abe does not read`);
  } catch {
    return failed('aws-failed', `aws ${what} answered no JSON`);
  }
};

/** The tags a box and its volume are made with. */
const tagsOf = (spec: BoxSpec, owner: string) => {
  const common = [
    { Key: 'abe:owner', Value: owner },
    { Key: 'abe:box', Value: spec.name },
    { Key: 'project', Value: 'abe' },
  ];

  return [
    {
      ResourceType: 'instance',
      Tags: [
        ...common,
        // The repo's box (ADR 0022): no card or title tag, its workspaces are its serve's.
        { Key: 'abe:repo', Value: spec.repo },
        { Key: 'Name', Value: `abe-box-${owner}-${spec.name}` },
      ],
    },
    {
      ResourceType: 'volume',
      Tags: [...common, { Key: 'Name', Value: `abe-box-${owner}-${spec.name}` }],
    },
  ];
};

export const ec2Boxes = (o: Ec2BoxesOptions): Boxes => {
  const profile = o.profile ?? null;
  const keys = o.keys ?? false;
  const where = o.region === undefined || o.region === null ? [] : ['--region', o.region];
  const template = o.template ?? BOX_LAUNCH_TEMPLATE;
  let owner: Promise<Answered<string>> | undefined;

  const who = (): Promise<Answered<string>> => {
    owner ??= o.owner().then((a) => {
      if (!a.ok) owner = undefined;

      return a;
    });

    return owner;
  };

  const ec2 = async (args: readonly string[]): Promise<Answered<string>> => {
    const ran = await o.aws(['ec2', ...args, ...where, '--output', 'json']);

    return ran.ok ? ran : awsFailure(ran.error.message, profile, keys);
  };

  /** The owner's boxes (every state), by EC2's own tag filter. */
  const mine = async (me: string, name?: string): Promise<Answered<Box[]>> => {
    const read = await ec2([
      'describe-instances',
      '--filters',
      `Name=tag:abe:owner,Values=${me}`,
      ...(name === undefined
        ? ['Name=tag-key,Values=abe:box']
        : [`Name=tag:abe:box,Values=${name}`]),
    ]);

    if (!read.ok) return read;
    const doc = readJson(Described, read.data, 'ec2 describe-instances');

    if (!doc.ok) return doc;
    const boxes = doc.data.Reservations.flatMap((r) => r.Instances)
      .map(boxOf)
      .filter((b): b is Box => b?.owner === me && (name === undefined || b.name === name));

    return { ok: true, data: boxes.sort(byBoxName) };
  };

  /** The owner's box by name: a live one before a terminated one. */
  const find = async (name: string): Promise<Answered<{ me: string; box: Box | null }>> => {
    const me = await who();

    if (!me.ok) return me;
    const listed = await mine(me.data, name);

    if (!listed.ok) return listed;
    const box =
      listed.data.find((b) => b.state !== 'terminated') ??
      listed.data.find((b) => b.state === 'terminated') ??
      null;

    return { ok: true, data: { me: me.data, box } };
  };

  /** The box read again after a call that moved it. */
  const reread = async (name: string, fallback: Box): Promise<Answered<Box>> => {
    const now = await find(name);

    return now.ok ? { ok: true, data: now.data.box ?? fallback } : now;
  };

  const noBox = (name: string) =>
    failed('no-box', `you have no box ${name}: abe box list names yours`);

  const live = async (name: string): Promise<Answered<Box>> => {
    const found = await find(name);

    if (!found.ok) return found;
    const box = found.data.box;

    return box === null || box.state === 'terminated' ? noBox(name) : { ok: true, data: box };
  };

  /** A found box on its way up: started when stopped, as it is when pending or running. */
  const startOf = async (box: Box): Promise<Answered<Box>> => {
    if (box.state === 'pending' || box.state === 'running') return { ok: true, data: box };
    if (box.state !== 'stopped')
      return failed('box-busy', `box ${box.name} is ${box.state}: start it once it is stopped`);
    const started = await ec2(['start-instances', '--instance-ids', box.id]);

    return started.ok ? reread(box.name, { ...box, state: 'pending' }) : started;
  };

  return {
    list: async () => {
      const me = await who();

      if (!me.ok) return me;
      const listed = await mine(me.data);

      return listed.ok
        ? { ok: true, data: listed.data.filter((b) => b.state !== 'terminated') }
        : listed;
    },
    status: async (name) => {
      const found = await find(name);

      if (!found.ok) return found;
      const box = found.data.box;

      return { ok: true, data: box === null || box.state === 'terminated' ? null : box };
    },
    up: async (spec) => {
      const found = await find(spec.name);

      if (!found.ok) return found;
      const box = found.data.box;

      if (box !== null && box.state !== 'terminated') return startOf(box);
      const ran = await ec2([
        'run-instances',
        '--launch-template',
        `LaunchTemplateName=${template}`,
        ...(spec.size === undefined ? [] : ['--instance-type', spec.size]),
        '--iam-instance-profile',
        `Name=${boxRoleName(found.data.me)}`,
        '--tag-specifications',
        JSON.stringify(tagsOf(spec, found.data.me)),
      ]);

      if (!ran.ok) return ran;
      const made = readJson(Ran, ran.data, 'ec2 run-instances');

      if (!made.ok) return made;
      const first = made.data.Instances[0];
      const fresh = first === undefined ? undefined : boxOf(first);

      return fresh === undefined
        ? failed('aws-failed', 'aws ec2 run-instances answered an instance without its tags')
        : { ok: true, data: fresh };
    },
    start: async (name) => {
      const box = await live(name);

      return box.ok ? startOf(box.data) : box;
    },
    stop: async (name) => {
      const box = await live(name);

      if (!box.ok || box.data.state === 'stopped' || box.data.state === 'stopping') return box;
      if (box.data.state === 'shutting-down')
        return failed('box-busy', `box ${name} is shutting-down`);
      const stopped = await ec2(['stop-instances', '--instance-ids', box.data.id]);

      return stopped.ok ? reread(name, { ...box.data, state: 'stopping' }) : stopped;
    },
    resize: async (name, size) => {
      const box = await live(name);

      if (!box.ok) return box;
      if (box.data.state !== 'stopped')
        return failed(
          'box-busy',
          `box ${name} is ${box.data.state}: a box is resized while stopped`,
        );
      if (box.data.size === size) return box;
      const changed = await ec2([
        'modify-instance-attribute',
        '--instance-id',
        box.data.id,
        '--instance-type',
        `Value=${size}`,
      ]);

      return changed.ok ? reread(name, { ...box.data, size }) : changed;
    },
    terminate: async (name) => {
      const box = await live(name);

      if (!box.ok || box.data.state === 'shutting-down') return box;
      const ended = await ec2(['terminate-instances', '--instance-ids', box.data.id]);

      if (ended.ok) return reread(name, { ...box.data, state: 'shutting-down' });

      // Your own box (only yours are found): IAM saying no is the role's, a lead's to do.
      return ended.error.code === 'aws-refused'
        ? failed('terminate-refused', TERMINATE_REFUSED)
        : ended;
    },
  };
};

/**
 * Who you are to your boxes, wherever you are: `$ABE_OWNER` when set (a box's own serve, from its
 * `abe:owner` tag), else your GitHub login as `gh` says it (the Mac). Every box read goes by it.
 */
export const boxOwnerFrom = (env: Env) => async (): Promise<Answered<string>> => {
  const owner = env.ABE_OWNER ?? '';

  if (owner !== '') return { ok: true, data: owner };
  const me = await ghTrackingFrom(env).me();

  return me.ok
    ? { ok: true, data: me.data.login }
    : { ok: false, error: { code: me.error.code, message: ownerUnread(env, me.error) } };
};

/** The folder `gh` keeps its login in: `$GH_CONFIG_DIR`, else `$XDG_CONFIG_HOME/gh`, else `~/.config/gh`. */
const ghConfigDir = (env: Env): string => {
  const set = (v: string | undefined) => (v === undefined || v === '' ? undefined : v);

  return (
    set(env.GH_CONFIG_DIR) ??
    join(set(env.XDG_CONFIG_HOME) ?? join(set(env.HOME) ?? homedir(), '.config'), 'gh')
  );
};

/**
 * Why the owner could not be had, in one line (#242: never gh's own two; short enough for
 * RemoteState's): with no working login (none, or expired), the folder gh read (an
 * `XDG_CONFIG_HOME` pointing elsewhere shows there) and the fix.
 */
const ownerUnread = (env: Env, error: { code: string; message: string }): string =>
  error.code === 'auth'
    ? `gh has no working GitHub login in ${ghConfigDir(env)}, and your boxes are found by it: run gh auth login (or set ABE_OWNER)`
    : `gh could not say your GitHub login, which finds your boxes: ${error.message.trim().split('\n')[0] ?? ''}`;

/** The environment `aws` reaches boxes with: `$ABE_BOX_PROFILE` as its profile when set. */
export const boxAwsEnv = (env: Env): Env => {
  const profile = env.ABE_BOX_PROFILE ?? '';

  return profile === '' ? env : { ...env, AWS_PROFILE: profile };
};

/**
 * `env` reaching boxes on `aws`, the profile and region the Mac's serve reaches them on
 * (`abe status`'s `boxAws`, #338), in place of the caller's own: VimStorm opened from the Dock
 * has none, a terminal maybe another. One serve has none of (null) stays the caller's.
 */
export const boxAwsEnvAs = (env: Env, aws: BoxAws): Env => {
  const out: Record<string, string | undefined> = { ...env };

  if (aws.profile !== null) {
    delete out.ABE_BOX_PROFILE;
    out.AWS_PROFILE = aws.profile;
  }
  if (aws.region !== null) {
    delete out.AWS_DEFAULT_REGION;
    out.AWS_REGION = aws.region;
  }

  return out;
};

/** The profile boxes are reached on (`$ABE_BOX_PROFILE`, else `$AWS_PROFILE`); null: none. */
export const boxProfileOf = (env: Env): string | null => {
  const profile = boxAwsEnv(env).AWS_PROFILE ?? '';

  return profile === '' ? null : profile;
};

/** The AWS config's sections by profile name (`[default]` and `[profile default]` both `default`). */
const awsConfigProfiles = (env: Env, home: string): Map<string, Map<string, string>> => {
  const profiles = new Map<string, Map<string, string>>();
  let text: string;

  try {
    text = readFileSync(env.AWS_CONFIG_FILE ?? join(home, '.aws', 'config'), 'utf8');
  } catch {
    return profiles;
  }
  let at: Map<string, string> | undefined;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const header = /^\[\s*(?:profile\s+)?([^\]\s]+)\s*\]$/.exec(line);

    if (line.startsWith('[')) {
      at = undefined;
      // `[sso-session x]` and `[services x]` are no profiles.
      if (header?.[1] !== undefined && !/^\[\s*(sso-session|services)\s/.test(line)) {
        at = profiles.get(header[1]) ?? new Map<string, string>();
        profiles.set(header[1], at);
      }
    } else {
      const kv = /^([\w-]+)\s*=\s*(\S.*)$/.exec(line);

      if (at !== undefined && kv?.[1] !== undefined && kv[2] !== undefined)
        at.set(kv[1], kv[2].trim());
    }
  }

  return profiles;
};

/**
 * The AWS config's profile names and the regions they name (`$AWS_CONFIG_FILE`, else
 * `~/.aws/config`), as Settings' combos offer them: names only, no aws run.
 */
export const awsConfigNames = (
  env: Env,
  home: string,
): { awsProfiles: string[]; awsRegions: string[] } => {
  const profiles = awsConfigProfiles(env, home);
  const regions = [...profiles.values()].flatMap((p) => {
    const r = p.get('region');

    return r === undefined ? [] : [r];
  });

  return { awsProfiles: [...profiles.keys()], awsRegions: [...new Set(regions)] };
};

/** Whether the AWS config (`$AWS_CONFIG_FILE`, else `~/.aws/config`) has `profile`: no aws run. */
export const awsConfigHas = (env: Env, home: string, profile: string): boolean =>
  awsConfigProfiles(env, home).has(profile);

/**
 * The AWS profile and region boxes are reached on (#158), as `aws` would find them: the profile
 * `$ABE_BOX_PROFILE` / `$AWS_PROFILE` names, else the config's `default` when it has one; the
 * region `$AWS_REGION`, else `$AWS_DEFAULT_REGION`, else that profile's in the AWS config
 * (`$AWS_CONFIG_FILE`, else `~/.aws/config`). `null`: none found.
 */
export const boxAwsReach = (env: Env, home: string): BoxAws => {
  const profiles = awsConfigProfiles(env, home);
  const profile = boxProfileOf(env) ?? (profiles.has('default') ? 'default' : null);
  const named = [env.AWS_REGION, env.AWS_DEFAULT_REGION].find((r) => r !== undefined && r !== '');

  return {
    profile,
    region: named ?? (profile === null ? undefined : profiles.get(profile)?.get('region')) ?? null,
  };
};

/** A file's text, or '' when it can't be read. */
const textOr = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

/**
 * Whether `profile` (null: `default`) signs in with an IAM user's keys, as the aws config and
 * credentials files (`$AWS_CONFIG_FILE`, `$AWS_SHARED_CREDENTIALS_FILE`, else `~/.aws/…`) say:
 * no aws run. A profile neither names is taken for Identity Center's.
 */
export const awsProfileKeys = (env: Env, home: string, profile: string | null): boolean =>
  awsProfileKind(
    textOr(env.AWS_CONFIG_FILE ?? join(home, '.aws', 'config')),
    textOr(env.AWS_SHARED_CREDENTIALS_FILE ?? join(home, '.aws', 'credentials')),
    profile ?? 'default',
  ) === 'keys';

/**
 * Your boxes from the environment (ADR 0021): EC2 on your profile (`boxAwsEnv`), in
 * `$AWS_REGION` (else `$AWS_DEFAULT_REGION`, else the CLI's), yours by `boxOwnerFrom`.
 */
export const ec2BoxesFrom = (env: Env, aws: AwsCli = awsRunner(boxAwsEnv(env))): Boxes =>
  ec2Boxes({
    aws,
    owner: boxOwnerFrom(env),
    profile: boxProfileOf(env),
    keys: awsProfileKeys(env, env.HOME ?? homedir(), boxProfileOf(env)),
    region:
      [env.AWS_REGION, env.AWS_DEFAULT_REGION].find((r) => r !== undefined && r !== '') ?? null,
  });
