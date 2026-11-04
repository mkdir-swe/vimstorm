/**
 * A fake `aws` for EC2 boxes as a real process. It runs `ec2 describe-instances`, `run-instances`,
 * `start-instances`, `stop-instances`, `terminate-instances` and `modify-instance-attribute`, and
 * prints and fails as the CLI does. IAM's ABAC on `abe:owner` sits in front (infra/aws's user
 * policy). The caller, an SSO session or an IAM user on its keys (`keys`), acts only on instances
 * tagged `abe:owner` with their own login. They make instances
 * only from the box launch template, with their own box role and at a box size. Only a lead
 * terminates.
 *
 * Its state is `state.json` in the folder of the script that imports it, and `ec2.ts` writes it.
 * Every call is a line of `calls`. A state moves on with time unless the instance is held.
 * `pending` becomes `running` after `bootMs`, and `stopping` becomes `stopped` after `stopMs`.
 * `run-instances` answers after `createMs`.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BOX_SIZES } from '@abe/core';
import { Ec2State, type FakeInstance, lockState, settle, TagSpecs, writeState } from './state';

const dir = dirname(process.argv[1] ?? '.');
const file = join(dir, 'state.json');
const all = process.argv.slice(2);

appendFileSync(join(dir, 'calls'), `${all.join(' ')}\n`);

/** argv without the flags every call may carry. */
const argv: string[] = [];

for (let i = 0; i < all.length; i += 1) {
  const word = all[i] ?? '';

  if (word === '--profile' || word === '--region' || word === '--output') i += 1;
  else argv.push(word);
}

const flag = (name: string) => {
  const i = argv.indexOf(name);

  return i === -1 ? undefined : argv[i + 1];
};

/** Every word after `name` up to the next flag. */
const values = (name: string) => {
  const i = argv.indexOf(name);

  if (i === -1) return [];
  const rest = argv.slice(i + 1);
  const end = rest.findIndex((w) => w.startsWith('--'));

  return end === -1 ? rest : rest.slice(0, end);
};

const fail = (code: string, operation: string, message: string): never => {
  process.stderr.write(
    `\nAn error occurred (${code}) when calling the ${operation} operation: ${message}\n`,
  );
  process.exit(254);
};

// A slow `run-instances` (`createMs`) waits before the lock, so no listing has it meanwhile.
if (argv[0] === 'ec2' && argv[1] === 'run-instances') {
  const slow = Ec2State.parse(JSON.parse(readFileSync(file, 'utf8'))).createMs;

  if (slow > 0) Bun.sleepSync(slow);
}

// The whole call runs under the state's lock. A test's change meanwhile waits and is never lost.
const unlock = lockState(dir);

process.on('exit', unlock);
const state = Ec2State.parse(JSON.parse(readFileSync(file, 'utf8')));
const now = Date.now();
const save = () => {
  writeState(file, state);
};

for (const i of state.instances) settle(i, state, now);

if (state.expired && state.keys)
  fail(
    'InvalidClientTokenId',
    'DescribeInstances',
    'The security token included in the request is invalid.',
  );
if (state.expired)
  fail(
    'UnauthorizedSSOTokenError',
    'aws',
    'Error loading SSO Token: Token for abe-tooling does not exist or has expired',
  );

const caller = state.keys
  ? `arn:aws:iam::111111111111:user/${state.sso}`
  : `arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_Developer_fake/${state.sso}`;
const refuse = (operation: string, action: string, resource: string): never =>
  fail(
    'UnauthorizedOperation',
    operation,
    `You are not authorized to perform this operation. User: ${caller} is not authorized to perform: ec2:${action} on resource: ${resource} because no identity-based policy allows the ec2:${action} action. Encoded authorization failure message: FAKEfakeFAKE`,
  );

const tag = (i: FakeInstance, key: string) => i.Tags.find((t) => t.Key === key)?.Value;

const shown = (i: FakeInstance) => ({
  InstanceId: i.InstanceId,
  InstanceType: i.InstanceType,
  State: { Code: 0, Name: i.State },
  // As the CLI prints it, with an offset and no milliseconds.
  LaunchTime: new Date(i.launchedAt).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
  Placement: { AvailabilityZone: 'eu-west-1a', Tenancy: 'default' },
  PrivateIpAddress: i.State === 'terminated' ? undefined : i.PrivateIpAddress,
  VpcId: 'vpc-0fake',
  SubnetId: 'subnet-0fake',
  Tags: i.Tags,
});

const print = (doc: unknown) => {
  process.stdout.write(`${JSON.stringify(doc, null, 4)}\n`);
};

/** The instance `id` for `operation`, if IAM's ABAC finds it the caller's own. */
const own = (id: string | undefined, operation: string, action: string): FakeInstance => {
  const found = state.instances.find((i) => i.InstanceId === id);

  if (found === undefined)
    return fail('InvalidInstanceID.NotFound', operation, `The instance ID '${id}' does not exist`);
  if (tag(found, 'abe:owner') !== state.owner)
    refuse(operation, action, `arn:aws:ec2:eu-west-1:111111111111:instance/${found.InstanceId}`);

  return found;
};

/** A filter `Name=tag:K,Values=a,b` or `Name=tag-key,Values=K` as a test on an instance. */
const filterOf = (text: string): ((i: FakeInstance) => boolean) => {
  const m = /^Name=([^,]+),Values=(.*)$/.exec(text);

  if (m === null) return fail('InvalidParameterValue', 'DescribeInstances', `bad filter ${text}`);
  const [, name = '', list = ''] = m;
  const wanted = list.split(',');

  if (name === 'tag-key') return (i) => i.Tags.some((t) => wanted.includes(t.Key));
  if (name.startsWith('tag:')) {
    const key = name.slice('tag:'.length);

    return (i) => wanted.includes(tag(i, key) ?? '\u0000');
  }

  return fail('InvalidParameterValue', 'DescribeInstances', `the fake knows no filter ${name}`);
};

if (argv[0] !== 'ec2') fail('InvalidAction', argv[0] ?? 'aws', 'this fake aws only does ec2');

switch (argv[1]) {
  case 'describe-instances': {
    const tests = values('--filters').map(filterOf);
    const found = state.instances
      .filter((i) => i.madeAt === undefined || now - i.madeAt >= state.listLagMs)
      .filter((i) => tests.every((t) => t(i)));

    print({
      Reservations: found.map((i) => ({
        ReservationId: `r-${i.InstanceId}`,
        Instances: [shown(i)],
      })),
    });
    break;
  }
  case 'run-instances': {
    const template = /^LaunchTemplateName=(.+)$/.exec(flag('--launch-template') ?? '')?.[1];
    const resource = 'arn:aws:ec2:eu-west-1:111111111111:instance/*';

    if (template !== state.template) refuse('RunInstances', 'RunInstances', resource);
    const size = flag('--instance-type') ?? BOX_SIZES[0];

    if (!state.sizes.includes(size)) refuse('RunInstances', 'RunInstances', resource);
    const specs = TagSpecs.safeParse(JSON.parse(flag('--tag-specifications') ?? '[]'));

    if (!specs.success) fail('InvalidParameterValue', 'RunInstances', 'bad --tag-specifications');
    const tagsFor = (type: string) =>
      (specs.data?.find((s) => s.ResourceType === type)?.Tags ?? []).map((t) => ({
        Key: t.Key,
        Value: t.Value,
      }));
    const tags = tagsFor('instance');
    const ownerOf = (list: { Key: string; Value: string }[]) =>
      list.find((t) => t.Key === 'abe:owner')?.Value;

    if (
      ownerOf(tags) !== state.owner ||
      ownerOf(tagsFor('volume')) !== state.owner ||
      !tags.some((t) => t.Key === 'abe:box')
    )
      refuse('RunInstances', 'RunInstances', resource);
    const profile = /^Name=(.+)$/.exec(flag('--iam-instance-profile') ?? '')?.[1];

    if (profile !== `abe-box-${state.owner}-boxes`)
      fail(
        'UnauthorizedOperation',
        'RunInstances',
        `You are not authorized to perform this operation. User: ${caller} is not authorized to perform: iam:PassRole on resource: arn:aws:iam::111111111111:role/abe/box/${profile ?? ''}`,
      );
    state.next += 1;
    const made: FakeInstance = {
      InstanceId: `i-${String(state.next).padStart(17, '0')}`,
      InstanceType: size,
      State: 'pending',
      since: now,
      launchedAt: now,
      madeAt: now,
      held: false,
      PrivateIpAddress: `10.40.0.${state.next}`,
      // EC2's own tags for an instance launched from a template.
      Tags: [
        ...tags,
        { Key: 'aws:ec2launchtemplate:id', Value: 'lt-0fake' },
        { Key: 'aws:ec2launchtemplate:version', Value: String(state.templateVersion) },
      ],
      profile: profile ?? '',
    };

    state.instances.push(made);
    save();
    print({ Instances: [shown(made)], ReservationId: `r-${made.InstanceId}` });
    break;
  }
  case 'start-instances': {
    const i = own(flag('--instance-ids'), 'StartInstances', 'StartInstances');
    const before = i.State;

    if (i.State !== 'stopped' && i.State !== 'running' && i.State !== 'pending')
      fail(
        'IncorrectInstanceState',
        'StartInstances',
        `The instance '${i.InstanceId}' is not in a state from which it can be started.`,
      );
    if (i.State === 'stopped') {
      i.State = 'pending';
      i.since = now;
      i.launchedAt = now;
    }
    save();
    print({
      StartingInstances: [
        {
          InstanceId: i.InstanceId,
          CurrentState: { Name: i.State },
          PreviousState: { Name: before },
        },
      ],
    });
    break;
  }
  case 'stop-instances': {
    const i = own(flag('--instance-ids'), 'StopInstances', 'StopInstances');
    const before = i.State;

    if (i.State === 'pending' || i.State === 'running') {
      i.State = 'stopping';
      i.since = now;
    }
    save();
    print({
      StoppingInstances: [
        {
          InstanceId: i.InstanceId,
          CurrentState: { Name: i.State },
          PreviousState: { Name: before },
        },
      ],
    });
    break;
  }
  case 'terminate-instances': {
    const i = own(flag('--instance-ids'), 'TerminateInstances', 'TerminateInstances');

    if (!state.lead)
      refuse(
        'TerminateInstances',
        'TerminateInstances',
        `arn:aws:ec2:eu-west-1:111111111111:instance/${i.InstanceId}`,
      );
    const before = i.State;

    if (i.State !== 'shutting-down' && i.State !== 'terminated') {
      i.State = 'shutting-down';
      i.since = now;
    }
    save();
    print({
      TerminatingInstances: [
        {
          InstanceId: i.InstanceId,
          CurrentState: { Name: i.State },
          PreviousState: { Name: before },
        },
      ],
    });
    break;
  }
  case 'modify-instance-attribute': {
    const i = own(flag('--instance-id'), 'ModifyInstanceAttribute', 'ModifyInstanceAttribute');
    const size = /^Value=(.+)$/.exec(flag('--instance-type') ?? '')?.[1];

    if (size === undefined || !state.sizes.includes(size))
      refuse(
        'ModifyInstanceAttribute',
        'ModifyInstanceAttribute',
        `arn:aws:ec2:eu-west-1:111111111111:instance/${i.InstanceId}`,
      );
    if (i.State !== 'stopped')
      fail(
        'IncorrectInstanceState',
        'ModifyInstanceAttribute',
        `The instance '${i.InstanceId}' is not in the 'stopped' state.`,
      );
    i.InstanceType = size ?? i.InstanceType;
    save();
    break;
  }
  default:
    fail('InvalidAction', `ec2 ${argv[1] ?? ''}`, 'this fake ec2 does not know it');
}
save();
