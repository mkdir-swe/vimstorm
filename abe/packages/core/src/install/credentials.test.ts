/** Abe env files (ADR 0028): their paths, and every value in them known to redaction. */
import { describe, expect, test } from 'bun:test';
import {
  abeEnvSecrets,
  awsRegionEnv,
  awsSessionEnv,
  injectedSecrets,
  isAbeEnvFile,
  isEnvExampleName,
} from './credentials';

test.each<[string, boolean]>([
  ['.env.example', true],
  ['backend/.env.sample', true],
  ['.env.sample', true],
  ['.env', false],
  ['.env.local', false],
  ['app.env.template', true],
])('an example env file name: %s', (name, is) => {
  expect(isEnvExampleName(name.split('/').at(-1) ?? name)).toBe(is);
});

test.each<[string, boolean]>([
  ['.abe/abe.dev.env', true],
  ['.abe/abe.test.env', true],
  ['.abe/abe.prod.env', true],
  ['.abe/abe.stage.env', false],
  ['.abe/agents.dev.env', false],
  ['api/.abe/abe.dev.env', false],
])('an Abe env file: %s', (path, is) => {
  expect(isAbeEnvFile(path)).toBe(is);
});

describe("what the app and the checks get, and what's redacted", () => {
  test.each<[string, string, Record<string, string> | null]>([
    [
      'keys and a token',
      '{"Version":1,"AccessKeyId":"id","SecretAccessKey":"sk","SessionToken":"t","Expiration":"x"}',
      { AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'sk', AWS_SESSION_TOKEN: 't' },
    ],
    [
      'no token',
      '{"AccessKeyId":"id","SecretAccessKey":"sk"}',
      { AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'sk' },
    ],
    ['an expired login: none', 'Error when retrieving token from sso: Token has expired', null],
    ['no keys: none', '{"Version":1}', null],
  ])('aws export-credentials: %s', (_, text, env) => {
    expect(awsSessionEnv(text)).toEqual(env);
  });

  // its region beside the keys (ADR 0029: no profile of ~/.aws read), never redacted
  test.each<[string, string, Record<string, string>]>([
    ['a region', 'eu-west-1\n', { AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'eu-west-1' }],
    ['none set', '', {}],
    ['not a region', 'The config profile (x) could not be found', {}],
  ])('aws configure get region: %s', (_, text, env) => {
    expect(awsRegionEnv(text)).toEqual(env);
    expect(injectedSecrets({ ...env, AWS_ACCESS_KEY_ID: 'id' }).map((s) => s.kind)).toEqual([
      'AWS_ACCESS_KEY_ID',
    ]);
  });

  test.each<[string, Parameters<typeof abeEnvSecrets>[0], [string, string][]]>([
    ['none there: nothing', {}, []],
    [
      "each file's values, every environment's",
      {
        dev: '# header\nAPI_URL=http://localhost:4000\nAPI_KEY=dev-key-271\n',
        test: 'API_URL=https://api.test.shop.example\nAPI_KEY=test-key-314\n',
        prod: 'API_URL=https://api.shop.example\n',
      },
      [
        ['API_URL', 'http://localhost:4000'],
        ['API_KEY', 'dev-key-271'],
        ['API_URL', 'https://api.test.shop.example'],
        ['API_KEY', 'test-key-314'],
        ['API_URL', 'https://api.shop.example'],
      ],
    ],
    ['an empty value: not one', { test: 'EMPTY=\nFLAG=  \n' }, []],
  ])('redacted: %s', (_, texts, want) => {
    expect(abeEnvSecrets(texts).map((s) => [s.kind, s.value])).toEqual(want);
  });
});
