import { describe, expect, test } from 'bun:test';
import {
  abeSecrets,
  isTranscriptPath,
  logKey,
  logSessions,
  logSourcesOf,
  redactLog,
  redactText,
} from './logs';

// Planted secrets are built from fragments, so no scanner takes this file for a real one.
const X = (n: number) => 'x'.repeat(n);
const AKID = `AKIA${'Q'.repeat(16)}`;
const ASID = `ASIA${'Z'.repeat(16)}`;
const AWS_SECRET = `${'wJalr'.repeat(4)}${'K7MDENG'.repeat(2)}${'bPxRfiCY'.slice(0, 6)}`;
const SESSION_TOKEN = `IQoJb3JpZ2luX2Vj${'A'.repeat(40)}`;
const GH = (prefix: string) => `${prefix}_${X(36)}`;
const PAT = `github_pat_${'1'.repeat(22)}_${X(59)}`;
const CLAUDE = ['sk', 'ant', 'oat01', X(40)].join('-');
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NSJ9', 's'.repeat(43)].join('.');
const PEM = [
  ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
  'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn',
  '/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yP',
  ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
].join('\n');
const DB_PASSWORD = `p4ss${X(6)}`;

const READ_PASS = `r3ad${X(4)}`;
const ABE = abeSecrets({
  ABE_DB_READ_URL_TEST: `postgres://reader:${READ_PASS}@test-db:5432/shop`,
  ABE_AWS_READ_TEST: 'abe-read-test',
});

describe('redactText: one row per kind', () => {
  test.each([
    [
      'an ABE_* value',
      `psql postgres://reader:${READ_PASS}@test-db:5432/shop -c 1`,
      'psql [redacted:ABE_DB_READ_URL_TEST] -c 1',
    ],
    [
      "an ABE_* database URL's password used on its own",
      `PGPASSWORD=${READ_PASS} psql -h test-db`,
      'PGPASSWORD=[redacted:db-password] psql -h test-db',
    ],
    [
      'a value serve minted (an AWS secret key, unlabelled)',
      `export X=${'m'.repeat(40)}`,
      'export X=[redacted:aws-secret-key]',
    ],
    [
      'an ABE_* profile name',
      'aws --profile abe-read-test s3 ls',
      'aws --profile [redacted:ABE_AWS_READ_TEST] s3 ls',
    ],
    ['an AWS access key id', `key ${AKID} here`, 'key [redacted:aws-access-key] here'],
    ['an AWS temporary key id', `"${ASID}"`, '"[redacted:aws-access-key]"'],
    [
      'an AWS secret key',
      `aws_secret_access_key = ${AWS_SECRET}`,
      'aws_secret_access_key = [redacted:aws-secret-key]',
    ],
    [
      'an AWS secret key in JSON text',
      `{"SecretAccessKey": "${AWS_SECRET}"}`,
      '{"SecretAccessKey": "[redacted:aws-secret-key]"}',
    ],
    [
      'an AWS secret key and token unlabelled, on the line of their key id',
      `CREDENTIALS\t${ASID}\t2026-10-23T10:00:00Z\t${AWS_SECRET}\t${SESSION_TOKEN}${'B'.repeat(60)}`,
      'CREDENTIALS\t[redacted:aws-access-key]\t2026-10-23T10:00:00Z\t[redacted:aws-secret-key]\t[redacted:aws-session-token]',
    ],
    [
      'an AWS session token as plain text',
      `aws_session_token = ${SESSION_TOKEN}`,
      'aws_session_token = [redacted:aws-session-token]',
    ],
    [
      'an AWS session token',
      `export AWS_SESSION_TOKEN=${SESSION_TOKEN}`,
      'export AWS_SESSION_TOKEN=[redacted:aws-session-token]',
    ],
    ['a ghp_ token', `token ${GH('ghp')}.`, 'token [redacted:github-token].'],
    ['a gho_ token', GH('gho'), '[redacted:github-token]'],
    ['a ghs_ token', `x-access-token:${GH('ghs')}`, 'x-access-token:[redacted:github-token]'],
    ['a ghu_ token', `(${GH('ghu')})`, '([redacted:github-token])'],
    ['a github_pat_ token', `GH_TOKEN=${PAT}`, 'GH_TOKEN=[redacted:github-token]'],
    ['a Claude token', `ANTHROPIC_API_KEY=${CLAUDE}`, 'ANTHROPIC_API_KEY=[redacted:claude-token]'],
    ['a JWT', `Authorization: Bearer ${JWT}`, 'Authorization: Bearer [redacted:jwt]'],
    ['a PEM private key', `before\n${PEM}\nafter`, 'before\n[redacted:private-key]\nafter'],
    [
      'a PGP private key block',
      [
        ['-----BEGIN PGP', 'PRIVATE', 'KEY BLOCK-----'].join(' '),
        'lQOYBF',
        ['-----END PGP', 'PRIVATE', 'KEY BLOCK-----'].join(' '),
      ].join('\n'),
      '[redacted:private-key]',
    ],
    [
      'a PEM private key cut short',
      PEM.split('\n').slice(0, 2).join('\n'),
      '[redacted:private-key]',
    ],
    [
      'a database URL password',
      `mysql://app:${DB_PASSWORD}@db.internal:3306/x`,
      'mysql://app:[redacted:db-password]@db.internal:3306/x',
    ],
    [
      "a box workspace's socket URL password (no host)",
      `postgresql://workspace:${DB_PASSWORD}@/workspace?host=/run/postgresql`,
      'postgresql://workspace:[redacted:db-password]@/workspace?host=/run/postgresql',
    ],
    [
      'a URL password with no user',
      `redis://:${DB_PASSWORD}@cache:6379`,
      'redis://:[redacted:db-password]@cache:6379',
    ],
  ])('%s', (_, input, expected) => {
    expect(redactText(input, [...ABE, { kind: 'aws-secret-key', value: 'm'.repeat(40) }])).toBe(
      expected,
    );
  });

  test('a clean line is left alone', () => {
    const clean =
      'Ran `bun test` in /workspace/repo: 12 pass, 0 fail. https://github.com/o/r/pull/7 postgres://localhost/db';

    expect(redactText(clean, ABE)).toBe(clean);
  });

  test('an empty or very short ABE_* value redacts nothing', () => {
    expect(redactText('a b c', abeSecrets({ ABE_X: '', ABE_Y: 'b' }))).toBe('a b c');
  });

  test('a long run of dashes or dots is quick (no quadratic URL search)', () => {
    const started = performance.now();

    redactText(`${'a-'.repeat(100_000)} ${'a.'.repeat(100_000)}`, []);
    // Quadratic would take minutes; linear is milliseconds.
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

test("the local workspace's DATABASE_URL a session was given is a secret of its own, its password too", () => {
  const known = abeSecrets({
    DATABASE_URL: `postgres://shop:${DB_PASSWORD}@127.0.0.1:5432/shop`,
    HOME: '/home/kim',
  });

  expect(known.map((k) => k.kind)).toEqual(['DATABASE_URL', 'db-password']);
  expect(redactText(`PGPASSWORD=${DB_PASSWORD} psql`, known)).toBe(
    'PGPASSWORD=[redacted:db-password] psql',
  );
});

describe('redactLog: by the file it is', () => {
  test('a JSON line keeps its structure: every string redacted, the line still JSON', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `here: ${GH('ghp')}` }] },
      n: 3,
      SecretAccessKey: AWS_SECRET,
      [AKID]: true,
    });
    const out = redactLog('transcript.jsonl', `${line}\n`, ABE);

    expect(out.redacted).toBe(3);
    expect(out.text.endsWith('\n')).toBe(true);
    expect(JSON.parse(out.text)).toEqual({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'here: [redacted:github-token]' }] },
      n: 3,
      SecretAccessKey: '[redacted:aws-secret-key]',
      '[redacted:aws-access-key]': true,
    });
  });

  test('a PEM key inside a JSON string (escaped newlines) is redacted whole', () => {
    const line = JSON.stringify({ tool_response: { stdout: `cat id_rsa\n${PEM}\n` } });
    const out = redactLog('hooks.jsonl', line, []);

    expect(JSON.parse(out.text)).toEqual({
      tool_response: { stdout: 'cat id_rsa\n[redacted:private-key]\n' },
    });
  });

  test('clean JSON lines come back byte for byte; a torn last line is redacted as text', () => {
    const clean = '{"a": 1,   "b":"two"}\n{"c":[1.0,2]}\n';
    const torn = `${clean}{"type":"user","text":"${GH('gho')}`;

    expect(redactLog('transcript.jsonl', clean, ABE)).toEqual({ text: clean, redacted: 0 });
    expect(redactLog('transcript.jsonl', torn, ABE).text).toBe(
      `${clean}{"type":"user","text":"[redacted:github-token]`,
    );
  });

  test('a JSON document (meta.json) stays one pretty document', () => {
    const meta = `${JSON.stringify({ id: '4-a1b2', lastAssistantMessage: `used ${JWT}` }, null, 2)}\n`;
    const out = redactLog('meta.json', meta, []);

    expect(out.text).toBe(
      `${JSON.stringify({ id: '4-a1b2', lastAssistantMessage: 'used [redacted:jwt]' }, null, 2)}\n`,
    );
  });

  test('markdown is text: a key across lines is still caught', () => {
    const out = redactLog('checks.md', `# Checks\n\n\`\`\`\n${PEM}\n\`\`\`\n`, []);

    expect(out).toEqual({ text: '# Checks\n\n```\n[redacted:private-key]\n```\n', redacted: 1 });
  });
});

describe('where logs go', () => {
  test("a session's sources: its folder on serve's side; its transcript, the card's checks and reports where it ran", () => {
    expect(
      logSourcesOf({
        sessionDir: '/s/sessions/4-a1b2',
        transcriptPath: '/h/.claude/projects/-r-wt-4/u-1.jsonl',
        home: '/h',
        claudeSession: 'u-1',
        worktree: '/r-wt/4-sign-in',
        card: 4,
      }),
    ).toEqual({
      serve: {
        files: [
          {
            name: 'meta.json',
            path: '/s/sessions/4-a1b2/meta.json',
            within: '/s/sessions/4-a1b2',
          },
          {
            name: 'hooks.jsonl',
            path: '/s/sessions/4-a1b2/hooks.jsonl',
            within: '/s/sessions/4-a1b2',
          },
          { name: 'run.json', path: '/s/sessions/4-a1b2/run.json', within: '/s/sessions/4-a1b2' },
        ],
        dirs: [],
      },
      // On a box these are the workspace container's paths: read there, not on the box's disk.
      session: {
        files: [
          {
            name: 'transcript.jsonl',
            path: '/h/.claude/projects/-r-wt-4/u-1.jsonl',
            within: '/h/.claude/projects',
          },
          {
            name: 'checks.md',
            path: '/r-wt/4-sign-in/.scratch/4/checks.md',
            within: '/r-wt/4-sign-in',
          },
        ],
        dirs: [
          { name: 'review', path: '/r-wt/4-sign-in/.scratch/4/review', within: '/r-wt/4-sign-in' },
          { name: 'verify', path: '/r-wt/4-sign-in/.scratch/4/verify', within: '/r-wt/4-sign-in' },
        ],
      },
    });
    expect(
      logSourcesOf({
        sessionDir: '/s/x',
        transcriptPath: null,
        home: '/h',
        claudeSession: 'u-1',
        worktree: '',
        card: 4,
      }),
    ).toMatchObject({
      serve: { files: [{ name: 'meta.json' }, { name: 'hooks.jsonl' }, { name: 'run.json' }] },
      session: { files: [], dirs: [] },
    });
  });

  test.each([
    ['/h/.claude/projects/-r/u-1.jsonl', true],
    ['/h/.netrc', false],
    ['/h/.claude/projects/-r/other.jsonl', false],
    ['/h/.claude/projects/../../etc/u-1.jsonl', false],
    ['/h/.claude/projects/a/b/u-1.jsonl', false],
    ['/h/.claude/projects/u-1.jsonl', false],
  ])("the hooks' transcript_path %s is the session's own: %p", (path, own) => {
    expect(isTranscriptPath(path, '/h', 'u-1')).toBe(own);
  });

  test.each([
    ['o/shop', 'octocat', '4-a1b2', 'meta.json', 'o_shop/octocat/4-a1b2/meta.json'],
    [
      'o/shop',
      'octocat',
      '4-a1b2',
      'verify/after run.md',
      'o_shop/octocat/4-a1b2/verify/after_run.md',
    ],
    ['o/shop', 'octocat', '4-a1b2', 'review/../x', 'o_shop/octocat/4-a1b2/review/_/x'],
  ])('logKey(%s, %s, %s, %s)', (repo, login, session, name, key) => {
    expect(logKey({ repo, login, session }, name)).toBe(key);
  });

  test('the store listed as sessions: one row per <repo>/<user>/<session>', () => {
    expect(
      logSessions([
        { key: 'o_shop/octocat/4-a1b2/hooks.jsonl', size: 10 },
        { key: 'o_shop/octocat/4-a1b2/meta.json', size: 5 },
        { key: 'o_shop/octocat/4-a1b2/verify/report.md', size: 1 },
        { key: 'o_api/hubot/9-ffff/meta.json', size: 2 },
        { key: 'stray.txt', size: 1 },
      ]),
    ).toEqual([
      { repo: 'o_api', user: 'hubot', session: '9-ffff', files: ['meta.json'], bytes: 2 },
      {
        repo: 'o_shop',
        user: 'octocat',
        session: '4-a1b2',
        files: ['hooks.jsonl', 'meta.json', 'verify/report.md'],
        bytes: 16,
      },
    ]);
  });
});
