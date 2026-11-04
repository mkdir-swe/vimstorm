/** The Abe env files' prefill (ADR 0028): from the session's mapping and the repo's env files. */
import { describe, expect, test } from 'bun:test';
import { type AbeEnv, ABE_ENVS, abeEnvHeader } from './credentials';
import {
  abeEnvPrefill,
  type EnvFileMapped,
  envFileSpec,
  type EnvMappingCi,
  withAbeBlocks,
} from './env-prefill';

/** A mapped file, the session's: `to` its environments, not-used or not-sure. */
const map = (path: string, to: EnvFileMapped['to'], why: string): EnvFileMapped => ({
  path,
  to,
  why,
  by: 'session',
  notSure: to === 'not-sure' ? why : null,
});

/** An Abe env file as the prefill writes it on the header alone: the header, then its blocks. */
const file = (env: AbeEnv, ...blocks: string[][]): string =>
  blocks.length === 0
    ? abeEnvHeader(env)
    : `${abeEnvHeader(env).trimEnd()}\n\n${blocks.map((b) => b.join('\n')).join('\n\n')}\n`;

const ciFile = (env: AbeEnv): string =>
  file(env, [
    '# --- from CI · .github/workflows/deploy.yml:47 environment',
    `# ${env} lives in CI; no env file of the repo feeds it. CI's keys: STAGE, AUTH_DOMAIN`,
    '# --- end CI',
  ]);

// Every value here is fake.
describe('what the prefill writes in each Abe env file, and what it leaves Not sure', () => {
  test.each<{
    name: string;
    /** The repo's env files, by path. */
    repo: Record<string, string>;
    /** The session's mapping, in load order. */
    files: EnvFileMapped[];
    ci?: EnvMappingCi;
    awsCovers?: boolean;
    want: Record<AbeEnv, string>;
    notSure?: { path: string; why: string }[];
    left?: { path: string; why: string }[];
  }>([
    {
      name: 'a dotenv cascade: the base in every stage, each stage overlay on top',
      repo: {
        'backend/.env': 'API_URL=http://localhost:4000\nLOG_LEVEL=info\nDB_NAME=shop\n',
        'backend/.env.dev': 'LOG_LEVEL=debug\nDB_NAME=shop_dev\n',
        'backend/.env.test': 'DB_NAME=shop_test\n',
        'backend/.env.prod': 'DB_NAME=shop_prod\nAPI_URL=https://api.shop.example\n',
      },
      files: [
        map('backend/.env', ['dev', 'test', 'prod'], 'backend/package.json:11 dotenv -e .env -c'),
        map('backend/.env.dev', ['dev'], 'backend/package.json:11 dotenv -c dev'),
        map('backend/.env.test', ['test'], 'backend/package.json:12 dotenv -c test'),
        map('backend/.env.prod', ['prod'], 'backend/package.json:26 dotenv -c prod'),
      ],
      want: {
        dev: file(
          'dev',
          [
            '# --- from backend/.env · backend/package.json:11 dotenv -e .env -c',
            'API_URL=http://localhost:4000',
            '# set again below: LOG_LEVEL, DB_NAME',
            '# --- end backend/.env',
          ],
          [
            '# --- from backend/.env.dev · backend/package.json:11 dotenv -c dev',
            'LOG_LEVEL=debug',
            'DB_NAME=shop_dev',
            '# --- end backend/.env.dev',
          ],
        ),
        test: file(
          'test',
          [
            '# --- from backend/.env · backend/package.json:11 dotenv -e .env -c',
            'API_URL=http://localhost:4000',
            'LOG_LEVEL=info',
            '# set again below: DB_NAME',
            '# --- end backend/.env',
          ],
          [
            '# --- from backend/.env.test · backend/package.json:12 dotenv -c test',
            'DB_NAME=shop_test',
            '# --- end backend/.env.test',
          ],
        ),
        prod: file(
          'prod',
          [
            '# --- from backend/.env · backend/package.json:11 dotenv -e .env -c',
            'LOG_LEVEL=info',
            '# set again below: API_URL, DB_NAME',
            '# --- end backend/.env',
          ],
          [
            '# --- from backend/.env.prod · backend/package.json:26 dotenv -c prod',
            'DB_NAME=shop_prod',
            'API_URL=https://api.shop.example',
            '# --- end backend/.env.prod',
          ],
        ),
      },
    },
    {
      name: 'a mixed-stage file: its _DEV, _TEST and _PROD keys each to their own environment only',
      repo: {
        '.env': 'PORT=4000\nPAY_KEY_DEV=fake-dev\nPAY_KEY_TEST=fake-test\nPAY_KEY_PROD=fake-prod\n',
      },
      files: [map('.env', ['dev'], 'package.json:5 node --env-file=.env')],
      want: {
        dev: file('dev', [
          '# --- from .env · package.json:5 node --env-file=.env',
          'PORT=4000',
          'PAY_KEY_DEV=fake-dev',
          '# --- end .env',
        ]),
        test: file('test', [
          '# --- from .env (its _TEST keys) · package.json:5 node --env-file=.env',
          'PAY_KEY_TEST=fake-test',
          '# --- end .env',
        ]),
        prod: file('prod', [
          '# --- from .env (its _PROD keys) · package.json:5 node --env-file=.env',
          'PAY_KEY_PROD=fake-prod',
          '# --- end .env',
        ]),
      },
    },
    {
      name: 'an old copy: left out, even mapped',
      repo: {
        '.env.dev': 'API_URL=http://localhost:4000\n',
        '.env.dev.old': 'API_URL=http://old\n',
      },
      files: [
        map('.env.dev', ['dev'], 'file name'),
        map('.env.dev.old', ['dev'], 'file name'),
        map('.env.bak', 'not-used', 'a backup'),
      ],
      want: {
        dev: file('dev', [
          '# --- from .env.dev · file name',
          'API_URL=http://localhost:4000',
          '# --- end .env.dev',
        ]),
        test: file('test'),
        prod: file('prod'),
      },
      left: [
        { path: '.env.dev.old', why: 'an old copy' },
        { path: '.env.bak', why: 'a backup' },
      ],
    },
    {
      name: 'an empty file: left out',
      repo: { 'api/.env': '', 'web/.env': '# nothing yet\n', '.env.test': 'DB_NAME=shop_test\n' },
      files: [
        map('api/.env', ['dev'], 'file name'),
        map('web/.env', ['dev'], 'file name'),
        map('.env.test', ['test'], 'package.json:8 dotenv -e .env.test'),
      ],
      want: {
        dev: file('dev'),
        test: file('test', [
          '# --- from .env.test · package.json:8 dotenv -e .env.test',
          'DB_NAME=shop_test',
          '# --- end .env.test',
        ]),
        prod: file('prod'),
      },
      left: [
        { path: 'api/.env', why: 'empty' },
        { path: 'web/.env', why: 'empty' },
      ],
    },
    {
      name: "a CI-only repo: three files, each naming CI's keys",
      repo: {},
      files: [],
      ci: {
        keys: ['STAGE', 'AUTH_DOMAIN'],
        evidence: '.github/workflows/deploy.yml:47 environment',
      },
      want: { dev: ciFile('dev'), test: ciFile('test'), prod: ciFile('prod') },
    },
    {
      name: 'CI naming one environment: only that one is said to live there',
      repo: {},
      files: [],
      ci: { keys: ['TEST_URL'], evidence: '.github/workflows/ci.yml:60 environment: test' },
      want: {
        dev: file('dev'),
        test: file('test', [
          '# --- from CI · .github/workflows/ci.yml:60 environment: test',
          "# test lives in CI; no env file of the repo feeds it. CI's keys: TEST_URL",
          '# --- end CI',
        ]),
        prod: file('prod'),
      },
    },
    {
      name: "a file it can't place: Not sure, in no file",
      repo: { 'web/.env': 'APP_ENV=development\nAPI_URL=http://localhost:4000\n' },
      files: [map('web/.env', 'not-sure', 'dev and test both load it; a flag picks the stage')],
      want: { dev: file('dev'), test: file('test'), prod: file('prod') },
      notSure: [{ path: 'web/.env', why: 'dev and test both load it; a flag picks the stage' }],
    },
    {
      name: 'cloud credential keys an aws profile covers: left out, named',
      repo: {
        '.env':
          'AWS_REGION=eu-north-1\nAWS_ACCESS_KEY_ID=FAKEID\nAWS_SECRET_ACCESS_KEY=fake-secret\n',
      },
      files: [map('.env', ['dev'], 'README.md:12 copy .env')],
      awsCovers: true,
      want: {
        dev: file('dev', [
          '# --- from .env · README.md:12 copy .env',
          'AWS_REGION=eu-north-1',
          '# left out, the aws profile for dev covers them: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY',
          '# --- end .env',
        ]),
        test: file('test'),
        prod: file('prod'),
      },
    },
    {
      name: 'cloud credential keys with no aws profile: kept',
      repo: { '.env': 'AWS_ACCESS_KEY_ID=FAKEID\n' },
      files: [map('.env', ['dev'], 'README.md:12 copy .env')],
      want: {
        dev: file('dev', [
          '# --- from .env · README.md:12 copy .env',
          'AWS_ACCESS_KEY_ID=FAKEID',
          '# --- end .env',
        ]),
        test: file('test'),
        prod: file('prod'),
      },
    },
    {
      name: 'a value with a space or a #: quoted as a loader reads it back',
      repo: { '.env': 'GREETING="hello there"\nCOLOR=\'#fff\'\nSAID="it\'s"\n' },
      files: [map('.env', ['dev'], 'file name')],
      want: {
        dev: file('dev', [
          '# --- from .env · file name',
          "GREETING='hello there'",
          "COLOR='#fff'",
          'SAID="it\'s"',
          '# --- end .env',
        ]),
        test: file('test'),
        prod: file('prod'),
      },
    },
  ])('$name', (row) => {
    const p = abeEnvPrefill({
      files: row.files,
      texts: row.repo,
      ci: row.ci ?? null,
      awsCovers: row.awsCovers ?? false,
    });

    expect(
      Object.fromEntries(ABE_ENVS.map((e) => [e, withAbeBlocks(abeEnvHeader(e), p.blocks[e])])),
    ).toEqual(row.want);
    expect(p.notSure).toEqual(row.notSure ?? []);
    expect(p.left).toEqual(row.left ?? []);
  });
});

describe("written again: Abe's blocks replaced, the person's own lines kept", () => {
  const BLOCK = { source: '.env', head: '.env · file name', lines: ['A=1', 'B=2'] };

  test.each<[string, string, string]>([
    [
      'on the header: the blocks after it',
      '# head\n',
      '# head\n\n# --- from .env · file name\nA=1\nB=2\n# --- end .env\n',
    ],
    [
      'again: the old block out, the new in',
      '# head\n\n# --- from .env · old\nA=0\n# --- end .env\n',
      '# head\n\n# --- from .env · file name\nA=1\nB=2\n# --- end .env\n',
    ],
    [
      'a key the person set outside: theirs, named in the block',
      '# head\nB=mine\n\n# --- from .env · old\nA=0\n# --- end .env\n\nC=3\n',
      '# head\nB=mine\n\nC=3\n\n# --- from .env · file name\nA=1\n# yours above: B\n# --- end .env\n',
    ],
    [
      'its end line taken out: the block ends at a blank line',
      '# head\n\n# --- from .env · old\nA=0\n\nC=3\n',
      '# head\n\nC=3\n\n# --- from .env · file name\nA=1\nB=2\n# --- end .env\n',
    ],
  ])('%s', (_, current, want) => {
    expect(withAbeBlocks(current, [BLOCK])).toBe(want);
    expect(withAbeBlocks(want, [BLOCK])).toBe(want);
  });
});

describe('a --file of abe install env-map', () => {
  test.each<[string, Omit<EnvFileMapped, 'by' | 'notSure'> | string]>([
    [
      'backend/.env -> dev,test,prod: backend/package.json:11 dotenv -c dev',
      {
        path: 'backend/.env',
        to: ['dev', 'test', 'prod'],
        why: 'backend/package.json:11 dotenv -c dev',
      },
    ],
    ['.env.test -> test, dev: name', { path: '.env.test', to: ['dev', 'test'], why: 'name' }],
    [
      '.env.dev.old -> not-used: an old copy',
      { path: '.env.dev.old', to: 'not-used', why: 'an old copy' },
    ],
    [
      'web/.env -> not-sure: a flag picks',
      { path: 'web/.env', to: 'not-sure', why: 'a flag picks' },
    ],
    ['.env -> dev', 'usage'],
    ['.env -> stage: name', 'usage'],
    ['../.env -> dev: up', 'usage'],
    ['/etc/app.env -> dev: abs', 'usage'],
    ['.abe/abe.dev.env -> dev: itself', 'usage'],
  ])('%s', (spec, want) => {
    const r = envFileSpec(spec);

    expect(r.ok ? r.data : r.error.code).toEqual(want);
  });
});
