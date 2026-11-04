/**
 * Your browser profiles' sign-ins as secrets (#103 S3), IO only: one Secrets Manager secret per
 * profile beside your logins (`abe/<person>/browser/<name>`), through the `aws` CLI on your SSO
 * (the Mac) or the box's role; or a folder standing in for them (`$ABE_LOGINS_STORE=file://…`).
 * A first write makes the secret as Terraform makes the logins: encrypted with the logins' key,
 * tagged with their owner and team, and fenced with their resource policy before any value goes
 * in. A value goes in on stdin and out on stdout only: never on argv, in a message or a log.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Answered,
  browserSecret,
  browserSecretPrefix,
  personOfLogins,
  type ProfileStore,
  regionOfSecret,
  type StoredProfile,
} from '@abe/core';
import { z } from 'zod';
import { awsEnv } from './aws';
import { boxAwsEnv, boxOwnerFrom } from './boxes';
import { type Env } from '../mac/locations';

const fail = (code: string, message: string) => ({ ok: false, error: { code, message } }) as const;

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

const TIMEOUT_MS = 30_000;
const KMS_KEY = 'alias/abe-logins';
const RECOVERY_DAYS = 7;

type Ran = { exit: number; stdout: string; stderr: string };

/** `aws <args>` with `env`, `stdin` its only way in for a value, killed after the timeout. */
const awsRun = async (
  env: Record<string, string>,
  args: readonly string[],
  stdin = '',
): Promise<Ran> => {
  const bin = Bun.which('aws', { PATH: env.PATH ?? '' });

  if (bin === null) return { exit: 127, stdout: '', stderr: 'aws is not installed (not on PATH)' };
  const child = Bun.spawn([bin, ...args], {
    env,
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, TIMEOUT_MS);
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => {
    clearTimeout(timer);
  });

  return { exit, stdout, stderr };
};

const said = (ran: Ran) => ran.stderr.trim() || `aws exited ${String(ran.exit)}`;

const notFound = (ran: Ran) => ran.stderr.includes('ResourceNotFoundException');

/** A secret scheduled for deletion: Secrets Manager refuses its value as it would a missing one. */
const markedDeleted = (ran: Ran) => ran.stderr.includes('marked for deletion');

const parsed = <T>(schema: z.ZodType<T>, text: string): T | undefined => {
  try {
    const r = schema.safeParse(JSON.parse(text));

    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
};

const Tags = z.array(z.object({ Key: z.string(), Value: z.string() })).nullish();

const Listed = z.object({
  SecretList: z.array(
    z.object({
      ARN: z.string(),
      Name: z.string(),
      Tags,
      LastChangedDate: z.string().nullish(),
      CreatedDate: z.string().nullish(),
    }),
  ),
});

const Described = z.object({ ARN: z.string(), Tags, DeletedDate: z.string().nullish() });
const Policy = z.object({ ResourcePolicy: z.string().nullish() });
const Value = z.object({ text: z.string().nullish(), createdAt: z.string().nullish() });

const tag = (tags: z.infer<typeof Tags>, key: string) =>
  tags?.find((t) => t.Key === key)?.Value ?? undefined;

/** An AWS date (RFC 3339, `+00:00` and microseconds) as `toISOString`; as given when unreadable. */
const iso = (at: string | null | undefined) => {
  if (at === null || at === undefined || at === '') return '';
  const ms = Date.parse(at);

  return Number.isNaN(ms) ? at : new Date(ms).toISOString();
};

type Person = { person: string; logins: string };

/**
 * Whose logins secret: `$ABE_LOGINS_SECRET` (a box: the one it was given), else the one
 * `abe/<person>/logins` tagged `abe:owner` = `owner()`, found through `aws` on `env` (the Mac's
 * SSO). Browser profiles go beside it; `abe login az` on the Mac goes in it (#237).
 */
export const loginsSecretOf = async (o: {
  env: Env;
  owner: () => Promise<Answered<string>>;
}): Promise<Answered<Person>> => {
  const given = o.env.ABE_LOGINS_SECRET ?? '';

  if (given !== '') {
    const person = personOfLogins(given);

    return person === undefined
      ? fail('no-person', `$ABE_LOGINS_SECRET (${given}) is no abe/<person>/logins secret`)
      : { ok: true, data: { person, logins: given } };
  }
  const owner = await o.owner();

  if (!owner.ok) return owner;
  const region =
    [o.env.AWS_REGION, o.env.AWS_DEFAULT_REGION].find((r) => r !== undefined && r !== '') ?? null;
  const ran = await awsRun(awsEnv(o.env), [
    'secretsmanager',
    'list-secrets',
    '--filters',
    'Key=tag-key,Values=abe:owner',
    `Key=tag-value,Values=${owner.data}`,
    '--output',
    'json',
    ...(region === null ? [] : ['--region', region]),
  ]);

  if (ran.exit !== 0)
    return fail('profile-unreadable', `your logins secret could not be listed: ${said(ran)}`);
  const list = parsed(Listed, ran.stdout);

  if (list === undefined) return fail('profile-unreadable', 'aws answered no secret list');
  const mine = list.SecretList.filter(
    (s) => personOfLogins(s.Name) !== undefined && tag(s.Tags, 'abe:owner') === owner.data,
  );
  const [one, more] = mine;

  if (one === undefined)
    return fail(
      'no-person',
      `no logins secret is tagged abe:owner=${owner.data}: infra/aws makes it with owner = ${owner.data}`,
    );
  if (more !== undefined)
    return fail(
      'no-person',
      `more than one logins secret is tagged abe:owner=${owner.data}: ${mine.map((s) => s.Name).join(', ')}`,
    );

  return { ok: true, data: { person: personOfLogins(one.Name) ?? '', logins: one.ARN } };
};

/**
 * Secrets Manager through `aws`. Whose: `$ABE_LOGINS_SECRET` (a box: the logins secret it was
 * given), else the one `abe/<person>/logins` tagged `abe:owner` = `owner()` (the Mac).
 */
export const awsProfileStore = (o: {
  env: Env;
  owner: () => Promise<Answered<string>>;
}): ProfileStore => {
  const env = awsEnv(o.env);
  const envRegion =
    [o.env.AWS_REGION, o.env.AWS_DEFAULT_REGION].find((r) => r !== undefined && r !== '') ?? null;
  let known: Person | undefined;

  const regionOf = (logins: string | undefined) => {
    const r = (logins === undefined ? null : regionOfSecret(logins)) ?? envRegion;

    return r === null ? [] : ['--region', r];
  };
  const aws = (args: readonly string[], stdin = '') =>
    awsRun(env, [...args, ...regionOf(known?.logins)], stdin);

  const whose = async (): Promise<Answered<Person>> => {
    if (known !== undefined) return { ok: true, data: known };
    const found = await loginsSecretOf({ env: o.env, owner: o.owner });

    if (found.ok) known = found.data;

    return found;
  };

  /** Puts `text` in `secret`: on stdin only. */
  const put = async (secret: string, text: string): Promise<Answered<{ secret: string }>> => {
    const ran = await aws(
      [
        'secretsmanager',
        'put-secret-value',
        '--secret-id',
        secret,
        '--secret-string',
        'file:///dev/stdin',
        '--query',
        'VersionId',
        '--output',
        'text',
      ],
      text,
    );

    return ran.exit === 0
      ? { ok: true, data: { secret } }
      : fail('profile-unwritable', `${secret}: ${said(ran)}`);
  };

  /** Makes `secret` with no value, as the logins are made, fenced with their policy. */
  const create = async (
    me: Person,
    name: string,
    secret: string,
  ): Promise<Answered<{ secret: string }>> => {
    const policy = await aws([
      'secretsmanager',
      'get-resource-policy',
      '--secret-id',
      me.logins,
      '--output',
      'json',
    ]);

    if (policy.exit !== 0)
      return fail('no-fence', `${me.logins}'s resource policy could not be read: ${said(policy)}`);
    const fence = parsed(Policy, policy.stdout)?.ResourcePolicy ?? '';

    if (fence === '')
      return fail(
        'no-fence',
        `${me.logins} has no resource policy to fence ${secret} with: nothing was made`,
      );
    const described = await aws([
      'secretsmanager',
      'describe-secret',
      '--secret-id',
      me.logins,
      '--output',
      'json',
    ]);
    const logins = described.exit === 0 ? parsed(Described, described.stdout) : undefined;
    const owner = tag(logins?.Tags, 'abe:owner');
    const team = tag(logins?.Tags, 'abe:team');

    if (owner === undefined || team === undefined)
      return fail(
        'no-fence',
        described.exit !== 0
          ? `${me.logins} could not be read: ${said(described)}`
          : `${me.logins} has no abe:owner and abe:team tags to copy: nothing was made`,
      );
    const made = await aws([
      'secretsmanager',
      'create-secret',
      '--name',
      secret,
      '--kms-key-id',
      KMS_KEY,
      '--description',
      `abe browser profile ${name} of ${me.person}: its sign-ins (abe browser store)`,
      '--tags',
      `Key=abe:owner,Value=${owner}`,
      `Key=abe:team,Value=${team}`,
      'Key=project,Value=abe',
      '--output',
      'json',
    ]);

    if (made.exit !== 0) return fail('profile-unwritable', `${secret}: ${said(made)}`);
    const fenced = await aws([
      'secretsmanager',
      'put-resource-policy',
      '--secret-id',
      secret,
      '--resource-policy',
      fence,
      '--block-public-policy',
      '--output',
      'json',
    ]);

    if (fenced.exit !== 0) {
      // Never left unfenced: a later write would put a value in it (and refuses one unfenced).
      const gone = await aws([
        'secretsmanager',
        'delete-secret',
        '--secret-id',
        secret,
        '--force-delete-without-recovery',
      ]);

      if (gone.exit !== 0)
        return fail(
          'no-fence',
          `${secret} could not be fenced (${said(fenced)}) nor removed (${said(gone)}): delete it before storing again`,
        );

      return fail('no-fence', `${secret} could not be fenced, so it was removed: ${said(fenced)}`);
    }

    return { ok: true, data: { secret } };
  };

  return {
    list: async (): Promise<Answered<StoredProfile[]>> => {
      const me = await whose();

      if (!me.ok) return me;
      const prefix = browserSecretPrefix(me.data.person);
      const ran = await aws([
        'secretsmanager',
        'list-secrets',
        '--filters',
        `Key=name,Values=${prefix}`,
        '--output',
        'json',
      ]);

      if (ran.exit !== 0) return fail('profile-unreadable', `${prefix}*: ${said(ran)}`);
      const list = parsed(Listed, ran.stdout);

      if (list === undefined) return fail('profile-unreadable', 'aws answered no secret list');

      return {
        ok: true,
        data: list.SecretList.filter(
          (s) => s.Name.startsWith(prefix) && /^[^/]+$/.test(s.Name.slice(prefix.length)),
        )
          .map((s) => ({
            name: s.Name.slice(prefix.length),
            secret: s.Name,
            storedAt: iso(s.LastChangedDate ?? s.CreatedDate),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    read: async (name) => {
      const me = await whose();

      if (!me.ok) return me;
      const secret = browserSecret(me.data.person, name);
      const ran = await aws([
        'secretsmanager',
        'get-secret-value',
        '--secret-id',
        secret,
        '--query',
        '{text:SecretString,createdAt:CreatedDate}',
        '--output',
        'json',
      ]);

      if (ran.exit !== 0)
        return notFound(ran) || markedDeleted(ran)
          ? { ok: true, data: null }
          : fail('profile-unreadable', `${secret}: ${said(ran)}`);
      const doc = parsed(Value, ran.stdout);

      if (doc?.text === null || doc?.text === undefined)
        return fail('profile-unreadable', `${secret}: aws answered no text value`);

      return { ok: true, data: { secret, text: doc.text, storedAt: iso(doc.createdAt) } };
    },
    write: async (name, text) => {
      const me = await whose();

      if (!me.ok) return me;
      const secret = browserSecret(me.data.person, name);
      const ran = await aws([
        'secretsmanager',
        'describe-secret',
        '--secret-id',
        secret,
        '--output',
        'json',
      ]);

      if (ran.exit !== 0) {
        if (!notFound(ran)) return fail('profile-unwritable', `${secret}: ${said(ran)}`);
        const made = await create(me.data, name, secret);

        if (!made.ok) return made;
      } else if ((parsed(Described, ran.stdout)?.DeletedDate ?? '') !== '') {
        // Removed within its recovery window: brought back, fence and tags as they were.
        const back = await aws(['secretsmanager', 'restore-secret', '--secret-id', secret]);

        if (back.exit !== 0) return fail('profile-unwritable', `${secret}: ${said(back)}`);
      }
      // A value goes only into a fenced secret: one an earlier failed write left bare is refused.
      if (ran.exit === 0) {
        const own = await aws([
          'secretsmanager',
          'get-resource-policy',
          '--secret-id',
          secret,
          '--output',
          'json',
        ]);

        if (own.exit !== 0 || (parsed(Policy, own.stdout)?.ResourcePolicy ?? '') === '')
          return fail(
            'no-fence',
            `${secret} has no resource policy: nothing was written (delete it, then store again)`,
          );
      }

      return put(secret, text);
    },
    remove: async (name) => {
      const me = await whose();

      if (!me.ok) return me;
      const secret = browserSecret(me.data.person, name);
      const ran = await aws([
        'secretsmanager',
        'delete-secret',
        '--secret-id',
        secret,
        '--recovery-window-in-days',
        String(RECOVERY_DAYS),
      ]);

      return ran.exit === 0 || notFound(ran) || markedDeleted(ran)
        ? { ok: true, data: null }
        : fail('profile-unwritable', `${secret}: ${said(ran)}`);
    },
  };
};

/** Writes `text` whole (a rename), readable by this user only, its folders too. */
const writePrivate = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.abe-${String(process.pid)}`;

  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

/** A folder standing in for Secrets Manager: each secret a file at its name, its mtime when stored. */
export const fileProfileStore = (dir: string, person: string): ProfileStore => {
  const at = (secret: string) => join(dir, ...secret.split('/').filter((p) => p !== '..'));
  const done = <T>(data: T): Promise<Answered<T>> => Promise.resolve({ ok: true, data });
  const refused = (code: string, secret: string, err: unknown) =>
    Promise.resolve(fail(code, `${secret}: ${why(err)}`));
  const storedAt = (path: string) => new Date(statSync(path).mtimeMs).toISOString();

  return {
    list: () => {
      const prefix = browserSecretPrefix(person);
      const folder = at(prefix);

      if (!existsSync(folder)) return done([]);
      try {
        return done(
          readdirSync(folder, { withFileTypes: true })
            .filter((e) => e.isFile() && !e.name.includes('.abe-'))
            .map((e) => ({
              name: e.name,
              secret: `${prefix}${e.name}`,
              storedAt: storedAt(join(folder, e.name)),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      } catch (err) {
        return refused('profile-unreadable', `${prefix}*`, err);
      }
    },
    read: (name) => {
      const secret = browserSecret(person, name);
      const path = at(secret);

      if (!existsSync(path)) return done(null);
      try {
        return done({ secret, text: readFileSync(path, 'utf8'), storedAt: storedAt(path) });
      } catch (err) {
        return refused('profile-unreadable', secret, err);
      }
    },
    write: (name, text) => {
      const secret = browserSecret(person, name);

      try {
        writePrivate(at(secret), text);

        return done({ secret });
      } catch (err) {
        return refused('profile-unwritable', secret, err);
      }
    },
    remove: (name) => {
      const secret = browserSecret(person, name);

      try {
        rmSync(at(secret), { force: true });

        return done(null);
      } catch (err) {
        return refused('profile-unwritable', secret, err);
      }
    },
  };
};

/**
 * `$ABE_LOGINS_STORE=file://<dir>` (tests, a Mac trying it out): the folder, for the person of
 * `$ABE_LOGINS_SECRET`, else `$ABE_OWNER`, else `me`. Otherwise Secrets Manager on your SSO
 * profile (`boxAwsEnv`; the box's role on a box), yours by `boxOwnerFrom`.
 */
export const profileStoreFrom = (env: Env): ProfileStore => {
  const named = env.ABE_LOGINS_STORE ?? '';

  if (named.startsWith('file://')) {
    const owner = env.ABE_OWNER ?? '';
    const person =
      personOfLogins(env.ABE_LOGINS_SECRET ?? '') ?? (owner === '' ? undefined : owner) ?? 'me';

    return fileProfileStore(fileURLToPath(named), person);
  }

  return awsProfileStore({ env: boxAwsEnv(env), owner: boxOwnerFrom(env) });
};
