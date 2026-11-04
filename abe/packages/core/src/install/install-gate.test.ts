/** Factory install's gate: each env value's class, and when the gate passes. */
import { describe, expect, test } from 'bun:test';
import {
  type CloudCredentials,
  classifyValue,
  cloudCredentialsWhy,
  credentialsLoaded,
  codeImports,
  gate,
  loadedValues,
  parseEnvFile,
  publicEnvOnly,
  runEntries,
  viteEnvPrefixes,
  sandboxWorkarounds,
  type StartLoad,
  startLoads,
  type TargetClass,
} from './install-gate';

describe('classifyValue: where an env value points the app', () => {
  test.each<[string, string, TargetClass, string]>([
    ['DATABASE_URL', 'postgres://u:secret@localhost:5432/shop', 'local', 'localhost'],
    ['DATABASE_URL', 'postgres://u:p@127.0.0.1/shop', 'local', '127.0.0.1'],
    ['REDIS_URL', 'redis://redis:6379', 'local', 'redis'],
    ['DATABASE_URL', 'sqlite:./dev.db', 'local', 'sqlite file'],
    ['DATABASE_URL', 'file:///tmp/dev.db', 'local', 'file file'],
    ['PROD_DATABASE_URL', 'postgres://localhost/shop_prod', 'local', 'localhost'],
    ['DATABASE_URL', 'postgres://u:p@db.test.example.com/shop', 'test', 'db.test.example.com'],
    ['API_URL', 'https://api-staging.example.com', 'test', 'api-staging.example.com'],
    ['DATABASE_URL', 'postgres://u:p@db.example.com/shop_test', 'test', 'db.example.com'],
    ['PAYPAL_URL', 'https://api.sandbox.paypal.com', 'sandbox', 'api.sandbox.paypal.com'],
    ['STRIPE_SECRET_KEY', 'sk_test_abc123', 'sandbox', 'stripe test key'],
    ['STRIPE_SECRET_KEY', 'sk_live_abc123', 'prod', 'stripe live key'],
    ['DATABASE_URL', 'postgres://u:p@db.prod.example.com/shop', 'prod', 'db.prod.example.com'],
    ['DATABASE_URL', 'postgres://u:p@db.example.com/shop_production', 'prod', 'db.example.com'],
    ['PROD_API_URL', 'https://api.example.com', 'prod', 'api.example.com'],
    ['LIVE_RELOAD_URL', 'https://reload.dev.example.com', 'test', 'reload.dev.example.com'],
    ['API_URL', 'https://api.example.com', 'unknown', 'api.example.com'],
    ['DB_HOST', 'db.staging.example.com', 'test', 'db.staging.example.com'],
    ['DB_HOST', '', 'missing', ''],
    ['LOG_LEVEL', 'debug', 'none', ''],
    ['PORT', '3000', 'none', ''],
  ])('%s=%s is %s (%s)', (key, value, cls, target) => {
    const c = classifyValue(key, value);

    expect({ class: c.class, target: c.target }).toEqual({ class: cls, target });
  });

  test.each<
    [string, { prod?: string[]; testHosts?: string[]; readOnlyHosts?: string[] }, TargetClass]
  >([
    ['https://api.example.com', { testHosts: ['api.example.com'] }, 'test'],
    ['https://api.acme-eu.example.com', { prod: ['acme'] }, 'prod'],
    ['https://api.prod.example.com', { testHosts: ['api.prod.example.com'] }, 'test'],
    ['https://api.prod.example.com', { testHosts: ['other.example.com'] }, 'prod'],
    [
      'https://invoices.prod.example.com',
      { readOnlyHosts: ['invoices.prod.example.com'] },
      'read-only',
    ],
  ])('%s with %j is %s', (value, o, cls) => {
    expect(classifyValue('API_URL', value, o).class).toBe(cls);
  });
});

describe('publicEnvOnly: an env file of public keys alone stays readable', () => {
  test.each<[string, string[], boolean, string[]?]>([
    ['each key a bundler shows anyone', ['VITE_API_URL', 'NEXT_PUBLIC_X', 'REACT_APP_Y'], true],
    ['Expo and SvelteKit', ['EXPO_PUBLIC_A', 'PUBLIC_B'], true],
    ['one key without a public prefix', ['VITE_API_URL', 'API_TOKEN'], false],
    ['a prefix inside the name is no prefix', ['MY_VITE_KEY'], false],
    ['no keys: nothing secret', [], true],
    ["the repo's own vite envPrefix", ['SHOP_API_URL', 'APP_X'], true, ['SHOP_', 'APP_']],
    ["one key outside the repo's prefixes", ['SHOP_API_URL', 'API_TOKEN'], false, ['SHOP_']],
  ])('%s', (_, keys, readable, prefixes = []) => {
    expect(publicEnvOnly(keys, prefixes)).toBe(readable);
  });
});

describe('viteEnvPrefixes: the envPrefix a vite config declares, read as text, never run', () => {
  test.each<[string, string, string[]]>([
    ['one string', "export default defineConfig({ envPrefix: 'SHOP_' });\n", ['SHOP_']],
    [
      'an array, quoted either way',
      'export default { envPrefix: ["SHOP_", \'APP_\'], server: { port: 4000 } };\n',
      ['SHOP_', 'APP_'],
    ],
    ['a quoted key', "export default { 'envPrefix': `PUBLIC_` };\n", ['PUBLIC_']],
    ['none declared: vite has its own', 'export default { plugins: [react()] };\n', []],
    ['computed: not read', 'export default { envPrefix: prefixes() };\n', []],
    ['an empty prefix (vite refuses it): none', "export default { envPrefix: '' };\n", []],
    ['a comment that names one: none', "// envPrefix: 'SECRET_'\nexport default {};\n", []],
  ])('%s', (_, text, prefixes) => {
    expect(viteEnvPrefixes(text)).toEqual(prefixes);
  });
});

describe('parseEnvFile', () => {
  test('keys and values: export, quotes, comments', () => {
    expect([
      ...parseEnvFile(
        '# c\nexport A=1\nB="two words"\nC=\'x\'\nD=v # note\nE=\n  bad line\nF=a=b\n',
      ),
    ]).toEqual([
      ['A', '1'],
      ['B', 'two words'],
      ['C', 'x'],
      ['D', 'v'],
      ['E', ''],
      ['F', 'a=b'],
    ]);
  });
});

const example = (text: string) => ({
  path: '.env.example',
  example: true,
  ignored: false,
  values: parseEnvFile(text),
});
const mine = (text: string, ignored = true) => ({
  path: '.env.local',
  example: false,
  ignored,
  values: parseEnvFile(text),
});

describe('gate: passes only on localhost, answered, with no prod, unknown or missing backend', () => {
  test.each<[string, Parameters<typeof gate>[0], string[]]>([
    [
      'local and test backends: passes',
      {
        url: 'http://localhost:4100',
        answered: true,
        files: [
          example('DATABASE_URL=\nAPI_URL=\n'),
          mine('DATABASE_URL=postgres://localhost/s\nAPI_URL=https://api.test.example.com\n'),
        ],
      },
      [],
    ],
    [
      'the app on another host',
      { url: 'https://shop.example.com', answered: true, files: [] },
      ['the app must answer on localhost, not shop.example.com'],
    ],
    [
      'no URL',
      { url: 'started', answered: false, files: [] },
      ["started is no http(s) URL: .claude/skills/run-app/scripts/start must print the app's URL"],
    ],
    [
      'the app did not answer',
      { url: 'http://127.0.0.1:4100', answered: false, files: [] },
      ['http://127.0.0.1:4100 did not answer'],
    ],
    [
      'a missing value',
      { url: 'http://localhost:4100', answered: true, files: [example('STRIPE_SECRET_KEY=\n')] },
      ['STRIPE_SECRET_KEY has no value'],
    ],
    [
      "a value filled only in the checks' environment's Abe env file: passes",
      {
        url: 'http://localhost:4100',
        answered: true,
        files: [example('STRIPE_SECRET_KEY=\n')],
        abe: { path: '.abe/abe.dev.env', values: new Map([['STRIPE_SECRET_KEY', 'sk_test_x']]) },
      },
      [],
    ],
    [
      'a key only the Abe env file has is judged too',
      {
        url: 'http://localhost:4100',
        answered: true,
        files: [],
        abe: {
          path: '.abe/abe.dev.env',
          values: new Map([['DATABASE_URL', 'postgres://db.prod.example.com/s']]),
        },
      },
      ['DATABASE_URL points at prod (db.prod.example.com): "prod" names prod'],
    ],
    [
      'a prod target',
      {
        url: 'http://localhost:4100',
        answered: true,
        files: [
          example('DATABASE_URL=\n'),
          mine('DATABASE_URL=postgres://db.prod.example.com/s\n'),
        ],
      },
      ['DATABASE_URL points at prod (db.prod.example.com): "prod" names prod'],
    ],
    [
      'an unknown target',
      {
        url: 'http://localhost:4100',
        answered: true,
        files: [mine('API_URL=https://api.example.com\n')],
      },
      ['API_URL points at api.example.com: nothing says whether it is test or prod'],
    ],
    [
      'an unknown target the person said is test',
      {
        url: 'http://localhost:4100',
        answered: true,
        files: [mine('API_URL=https://api.example.com\n')],
        testHosts: ['api.example.com'],
      },
      [],
    ],
    [
      'a prod target the person said the app only reads from',
      {
        url: 'http://localhost:4100',
        answered: true,
        files: [mine('INVOICE_URL=https://invoices.prod.example.com\n')],
        readOnlyHosts: ['invoices.prod.example.com'],
      },
      [],
    ],
    [
      'your env file not gitignored',
      {
        url: 'http://localhost:4100',
        answered: true,
        files: [mine('A=1\n', false)],
      },
      ['.env.local is not gitignored: your env file must never be committed'],
    ],
    [
      'a tracked env file (a test fixture): the repo commits it, so no gitignore reason',
      {
        url: 'http://localhost:4100',
        answered: true,
        files: [{ ...mine('A=1\n', false), tracked: true }],
      },
      [],
    ],
    [
      'before the run: no URL yet, what start loads judged as ever',
      { answered: false, files: [mine('API_URL=https://api.example.com\n')] },
      ['API_URL points at api.example.com: nothing says whether it is test or prod'],
    ],
    [
      'before another pack script runs: judged by its own name',
      {
        answered: false,
        script: '.claude/skills/run-app/scripts/seed',
        start: 'export SEED_URL=https://seed.example.com\nnode seed.js\n',
        files: [],
      },
      [
        ".claude/skills/run-app/scripts/seed talks to seed.example.com (SEED_URL): the gate can't prove it local",
      ],
    ],
    [
      'before the run, backends on this machine: passes',
      { answered: false, files: [mine('DATABASE_URL=postgres://localhost/s\n')] },
      [],
    ],
  ])('%s', (_, input, reasons) => {
    // vite at the top: it loads the top's env files
    const g = gate({ start: 'exec vite\n', ...input });

    expect(g.reasons).toEqual(reasons);
    expect(g.passed).toBe(reasons.length === 0);
  });

  test('a value never leaves the gate: only keys, hosts and classes', () => {
    const g = gate({
      start: 'exec vite\n',
      url: 'http://localhost:4100',
      answered: true,
      files: [
        mine(
          'DATABASE_URL=postgres://admin:hunter2@db.test.example.com/shop\nSTRIPE_SECRET_KEY=sk_test_s3cr3t\n',
        ),
      ],
    });

    expect(JSON.stringify(g)).not.toContain('hunter2');
    expect(JSON.stringify(g)).not.toContain('s3cr3t');
    expect(g.backends.map((b) => [b.key, b.target, b.class, b.from])).toEqual([
      ['DATABASE_URL', 'db.test.example.com', 'test', '.env.local'],
      ['STRIPE_SECRET_KEY', 'stripe test key', 'sandbox', '.env.local'],
    ]);
  });
});

const envFile = (path: string, text: string, ignored = true) => ({
  path,
  example: false,
  ignored,
  values: parseEnvFile(text),
});
const DEV = envFile('backend/.env.dev', 'DATABASE_URL=postgres://localhost/shop\n');
const PROD = envFile(
  'backend/.env.prod',
  'DATABASE_URL=postgres://u:hunter2@db.example.com/shop\n',
);
const OPAQUE =
  'backend/.env.prod points at prod (its name says prod) and what .claude/skills/run-app/scripts/start runs in backend names no env file: nothing proves it does not load it';

describe('gate: only what the start script runs loads, an env file pointing at prod beside a run it cannot see into refused', () => {
  test.each<[string, Parameters<typeof gate>[0]['files'], string, string[], string[]]>([
    [
      'a prod one beside a run that names no env file',
      [DEV, PROD],
      'cd backend && node server.js',
      [OPAQUE],
      ['backend/.env.dev', 'backend/.env.prod'],
    ],
    [
      'start loads its own by name, not the prod one',
      [DEV, PROD],
      'cd backend && dotenv -e .env.dev -- tsx server.ts',
      [],
      ['backend/.env.prod'],
    ],
    [
      "dotenv's cascade loads its own",
      [DEV, PROD],
      'cd backend && dotenv -c dev -- tsx server.ts',
      [],
      ['backend/.env.prod'],
    ],
    [
      'start loads the prod one',
      [DEV, envFile('backend/.env.prod.real', 'A=1\n')],
      'dotenv -e backend/.env.prod.real -- node server.js',
      ['the run loads backend/.env.prod.real, which points at prod (its name says prod)'],
      ['backend/.env.dev'],
    ],
    [
      '*.production* beside a run at the top: prod by its name',
      [envFile('.env.production', 'A=1\n')],
      'node server.js',
      [
        '.env.production points at prod (its name says prod) and what .claude/skills/run-app/scripts/start runs in the top names no env file: nothing proves it does not load it',
      ],
      ['.env.production'],
    ],
    [
      'prod by its values: only their keys said',
      [envFile('frontend/.env.staging', 'API_URL=https://api.prod.example.com\nLOG=1\n')],
      'cd frontend && node s.js',
      [
        'frontend/.env.staging points at prod (API_URL points at prod) and what .claude/skills/run-app/scripts/start runs in frontend names no env file: nothing proves it does not load it',
      ],
      ['frontend/.env.staging'],
    ],
    [
      "a framework loads its folder's .env: its prod value refused",
      [DEV, envFile('frontend/.env', 'VITE_API_URL=https://api.prod.example.com\n')],
      'dotenv -e backend/.env.dev -- node api.js &\ncd frontend && exec vite\n',
      ['VITE_API_URL points at prod (api.prod.example.com): "prod" names prod'],
      [],
    ],
    [
      'a package script it runs is followed: its dotenv cascade',
      [DEV, PROD],
      'npm --prefix backend run dev\n',
      [],
      ['backend/.env.prod'],
    ],
    [
      'a stray .env nothing loads: not judged',
      [envFile('.env', 'UNLEASH_URL=https://gitlab.com/x\n')],
      'node server.js',
      [],
      ['.env'],
    ],
    [
      'a prod one not gitignored',
      [DEV, { ...PROD, ignored: false }],
      'dotenv -e backend/.env.dev -- node x.js',
      ['backend/.env.prod is not gitignored: your env file must never be committed'],
      ['backend/.env.prod'],
    ],
  ])('%s', (_, files, start, reasons, unloaded) => {
    const g = gate({
      url: 'http://localhost:4100',
      answered: true,
      files,
      start,
      scripts: [{ dir: 'backend', scripts: { dev: 'dotenv -c dev -- tsx watch server.ts' } }],
    });

    expect([g.reasons, g.unloaded]).toEqual([reasons, unloaded]);
    expect(g.passed).toBe(reasons.length === 0);
    expect(JSON.stringify(g)).not.toContain('hunter2');
  });

  test('no start script: refused, it judges what start loads', () => {
    expect(gate({ url: 'http://localhost:4100', answered: true, files: [DEV] }).reasons).toEqual([
      'no .claude/skills/run-app/scripts/start: the gate judges what it loads',
    ]);
  });
});

describe('gate: dotenv the app loads in code, from the entry files start runs', () => {
  const run = (code: string, path = 'backend/server.js') =>
    gate({
      url: 'http://localhost:4100',
      answered: true,
      files: [DEV, PROD, envFile('backend/.env', 'DB_HOST=db.prod.example.com\n')],
      start: 'cd backend && exec node server.js\n',
      code: [{ dir: 'backend', path, text: code }],
    });

  test.each<[string, string, string | undefined, string[], string[]]>([
    [
      'the file it names',
      "require('dotenv').config({ path: '.env.dev' });\n",
      undefined,
      [],
      ['backend/.env.prod', 'backend/.env'],
    ],
    [
      "import 'dotenv/config': its folder's .env",
      "import 'dotenv/config';\n",
      undefined,
      ['DB_HOST points at prod (db.prod.example.com): "prod" names prod'],
      ['backend/.env.dev', 'backend/.env.prod'],
    ],
    [
      "a path from the code's own folder",
      "dotenv.config({ path: path.resolve(__dirname, '../.env.prod') });\n",
      'backend/src/server.ts',
      ['the run loads backend/.env.prod, which points at prod (its name says prod)'],
      ['backend/.env.dev', 'backend/.env'],
    ],
    [
      'no dotenv: what it loads unseen, the prod one beside it refused',
      "console.log('hi');\n",
      undefined,
      [
        'backend/.env.prod points at prod (its name says prod) and what .claude/skills/run-app/scripts/start runs in backend names no env file: nothing proves it does not load it',
        'backend/.env points at prod (DB_HOST points at prod) and what .claude/skills/run-app/scripts/start runs in backend names no env file: nothing proves it does not load it',
      ],
      ['backend/.env.dev', 'backend/.env.prod', 'backend/.env'],
    ],
  ])('%s', (_, code, path, reasons, unloaded) => {
    const g = run(code, path);

    expect([g.reasons, g.unloaded]).toEqual([reasons, unloaded]);
  });

  test('the entry files start runs, its package scripts followed, and their relative imports', () => {
    expect([
      runEntries({
        start: 'cd backend && exec npm run dev\nnode ./tools/serve.mjs &\n',
        scripts: [{ dir: 'backend', scripts: { dev: 'tsx watch ./fastify/server.ts' } }],
      }),
      codeImports(
        "import { a } from './config';\nconst b = require('../lib/env.js');\nimport x from 'zod';\n",
      ),
    ]).toEqual([
      [
        { dir: 'backend', path: 'backend/fastify/server.ts' },
        { dir: 'backend', path: 'backend/tools/serve.mjs' },
      ],
      ['./config', '../lib/env.js'],
    ]);
  });
});

describe("gate's Needs you: not used by the app, a test backend only if true, change it", () => {
  const URL = 'http://localhost:4100';
  const unknown = envFile(
    '.env',
    'UNLEASH_URL=https://gitlab.com/x\nDATABASE_URL=postgres://u:p@db.example.com/s\n',
  );

  test.each<[string, Parameters<typeof gate>[0], string[], string[]]>([
    [
      'an unknown host the run loads',
      { url: URL, answered: true, files: [unknown], start: 'exec vite\n' },
      [
        'UNLEASH_URL points at gitlab.com: nothing says whether it is test or prod',
        'DATABASE_URL points at db.example.com: nothing says whether it is test or prod',
      ],
      [
        `Not used by the app: abe install gate --url ${URL} --not-used "UNLEASH_URL: <how you know the app never reads it>"`,
        `A test backend, only if it truly is one: abe install gate --url ${URL} --test-host gitlab.com (written to abe.yaml's gate.testHosts, for every run of the repo)`,
        'Change it: point UNLEASH_URL at a backend on this machine or a test one',
        `Not used by the app: abe install gate --url ${URL} --not-used "DATABASE_URL: <how you know the app never reads it>"`,
        `A test backend, only if it truly is one: abe install gate --url ${URL} --test-host db.example.com (written to abe.yaml's gate.testHosts, for every run of the repo)`,
        'Change it: point DATABASE_URL at a backend on this machine or a test one',
      ],
    ],
    [
      'said not used, with how: not judged; what Abe gives wins over the file',
      {
        url: URL,
        answered: true,
        files: [unknown],
        start: 'exec vite\n',
        notUsed: [{ key: 'UNLEASH_URL', why: 'server.js reads no flag service' }],
        given: ['DATABASE_URL'],
      },
      [],
      [],
    ],
    [
      'before the run: each way out names --before-run',
      {
        answered: false,
        files: [envFile('.env', 'UNLEASH_URL=https://gitlab.com/x\n')],
        start: 'exec vite\n',
      },
      ['UNLEASH_URL points at gitlab.com: nothing says whether it is test or prod'],
      [
        'Not used by the app: abe install gate --before-run --not-used "UNLEASH_URL: <how you know the app never reads it>"',
        "A test backend, only if it truly is one: abe install gate --before-run --test-host gitlab.com (written to abe.yaml's gate.testHosts, for every run of the repo)",
        'Change it: point UNLEASH_URL at a backend on this machine or a test one',
      ],
    ],
    [
      'Connected, an env file not gitignored: add it to .gitignore',
      {
        url: URL,
        answered: true,
        files: [envFile('.env.local', 'A=1\n', false)],
        start: 'exec vite\n',
      },
      ['.env.local is not gitignored: your env file must never be committed'],
      ['Add .env.local to .gitignore'],
    ],
    [
      'Local only, an env file not gitignored: kept out of git on this machine, never a .gitignore change',
      {
        url: URL,
        answered: true,
        local: true,
        files: [envFile('.env.local', 'A=1\n', false)],
        start: 'exec vite\n',
      },
      ['.env.local is not gitignored: your env file must never be committed'],
      ['Keep it out of git on this machine: add .env.local to .git/info/exclude'],
    ],
  ])('%s', (_, input, reasons, options) => {
    const g = gate(input);

    expect([g.reasons, g.options]).toEqual([reasons, options]);
  });
});

describe('startLoads: what a start script loads besides the env files it names', () => {
  test.each<[string, string, { paths: string[]; dirs: string[] }]>([
    [
      'sourced value files and named configs, never a tool of its own',
      'set -a; . ./.env; source "$HOME/.nvm/nvm.sh"\nnode render.js > config.generated.json\ncd backend && a0deploy -c config.yaml && npm run dev --prefix . package.json\n',
      { paths: ['./.env', 'config.generated.json', 'config.yaml'], dirs: ['backend'] },
    ],
    ['nothing', 'exec vite --port "$ABE_PORT_BASE"\n', { paths: [], dirs: [] }],
  ])('%s', (_, start, loads) => {
    expect(startLoads(start)).toEqual(loads);
  });

  test("a config JSON's string leaves by upper-cased key, a YAML's lines, else KEY=value", () => {
    expect([
      ...loadedValues('c.json', '{"auth0":{"domain":"t.eu.auth0.com","retries":3,"ids":["a"]}}'),
      ...loadedValues('c.yaml', 'api:\n  base_url: "https://api.test.example.com" # x\n'),
      ...loadedValues('env.sh', 'export API_HOST=api.example.com\n'),
    ]).toEqual([
      ['AUTH0_DOMAIN', 't.eu.auth0.com'],
      ['AUTH0_IDS_0', 'a'],
      ['BASE_URL', 'https://api.test.example.com'],
      ['API_HOST', 'api.example.com'],
    ]);
  });
});

const TENANT =
  "config.generated.json talks to dev-shop.eu.auth0.com (AUTH0_DOMAIN): the gate can't prove it local";
const generated = (json: string): StartLoad => ({
  path: 'config.generated.json',
  values: loadedValues('config.generated.json', json),
});

describe('gate: what the start script sets and loads, only a host on this Mac or one you said is test passing', () => {
  test.each<[string, string, StartLoad[], string[], string[]]>([
    ["the app's own URL", 'echo "http://localhost:$ABE_PORT_BASE"\n', [], [], []],
    [
      'a tenant host it sets, though its name says dev',
      'export API_URL=https://dev-shop.eu.auth0.com\n',
      [],
      [],
      [
        ".claude/skills/run-app/scripts/start talks to dev-shop.eu.auth0.com (API_URL): the gate can't prove it local",
      ],
    ],
    [
      'a config it writes, with a tenant and a secret',
      'node render.js > config.generated.json\n',
      [generated('{"auth0":{"domain":"dev-shop.eu.auth0.com","clientSecret":"s3cr3t"}}')],
      [],
      [TENANT],
    ],
    [
      'one you said is a test backend',
      'node render.js > config.generated.json\n',
      [generated('{"auth0":{"domain":"dev-shop.eu.auth0.com"}}')],
      ['dev-shop.eu.auth0.com'],
      [],
    ],
    [
      'a prod host in a config it names',
      'a0deploy -c config.json\n',
      [
        {
          path: 'config.json',
          values: loadedValues('config.json', '{"api_url":"https://api.prod.example.com"}'),
        },
      ],
      [],
      ['config.json points at prod (api.prod.example.com, API_URL): "prod" names prod'],
    ],
    [
      "a file it sources the gate can't read",
      'source "$HOME/secrets.env"\n',
      [{ path: '"$HOME/secrets.env"', values: null }],
      [],
      [
        '.claude/skills/run-app/scripts/start loads "$HOME/secrets.env", which the gate can\'t read: nothing proves what it points at',
      ],
    ],
  ])('%s', (_, start, loaded, testHosts, reasons) => {
    const g = gate({
      url: 'http://localhost:4100',
      answered: true,
      files: [],
      start,
      loaded,
      testHosts,
    });

    expect(g.reasons).toEqual(reasons);
    expect(JSON.stringify(g)).not.toContain('s3cr3t');
  });
});

describe("sandboxWorkarounds: a written check with a flag only Abe's sandbox needs, CI's command never", () => {
  const TESTS = { name: 'tests', run: 'npm test -- --env-mode=loose' };

  test.each<[string, { name: string; run: string }[], string[], string[]]>([
    [
      "turbo's loose env mode",
      [TESTS],
      ['npm ci', 'npm test'],
      [
        "tests (npm test -- --env-mode=loose) has --env-mode=loose, which CI's command has not: turbo's loose env mode, a way past the sandbox's temp folder",
      ],
    ],
    ['CI runs it so too', [TESTS], ['npm test -- --env-mode=loose'], []],
    [
      'a temp folder of its own',
      [{ name: 'types', run: 'TMP=/tmp/x npx tsc --noEmit' }],
      [],
      [
        "types (TMP=/tmp/x npx tsc --noEmit) has TMP=, which CI's command has not: a temp folder of its own, a way past the sandbox's",
      ],
    ],
    ["CI's own command", [{ name: 'tests', run: 'npm test' }], ['npm test'], []],
  ])('%s', (_, checks, ci, said) => {
    expect(sandboxWorkarounds(checks, ci)).toEqual(said);
  });
});

describe('cloudCredentialsWhy: an env file holds cloud credentials by its key names or its name, never a value', () => {
  const KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

  test.each<[string, string, string[], string | undefined]>([
    [
      'exported session credentials',
      'backend/.env.aws.dev',
      KEYS,
      'it holds AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN',
    ],
    ['aws in its name', 'backend/.env.aws.prod-readonly', [], 'its name says aws'],
    ['one key, any name', 'config/dev.env', ['AWS_ACCESS_KEY_ID'], 'it holds AWS_ACCESS_KEY_ID'],
    ["aws's region alone: no credential", '.env', ['DATABASE_URL', 'AWS_REGION'], undefined],
    ['an example', '.env.aws.example', KEYS, undefined],
    ['no env file', 'src/aws-exports.js', [], undefined],
  ])('%s', (_, path, keys, why) => {
    expect(cloudCredentialsWhy(path, keys)).toBe(why);
  });
});

describe('credentialsLoaded: the cloud credentials a script loads, its package scripts followed', () => {
  const DEV: CloudCredentials = { path: 'backend/.env.aws.dev', why: 'it holds AWS_ACCESS_KEY_ID' };
  const TOP: CloudCredentials = { path: '.env', why: 'it holds AWS_SESSION_TOKEN' };
  const CREDS = [DEV, TOP];

  test.each<
    [
      string,
      string,
      { dir: string; scripts: Record<string, string> }[],
      { dir: string; text: string }[],
      string[],
    ]
  >([
    [
      'dotenv -e, in the folder it changes into',
      'cd backend && npx dotenv -e .env.aws.dev -- tsx watch src/server.ts',
      [],
      [],
      ['backend/.env.aws.dev'],
    ],
    [
      'sourced',
      'set -a; . backend/.env.aws.dev; set +a; node x.js',
      [],
      [],
      ['backend/.env.aws.dev'],
    ],
    ["node's --env-file", 'node --env-file=.env server.js', [], [], ['.env']],
    [
      'a package script followed',
      'npm --prefix backend run dev',
      [{ dir: 'backend', scripts: { dev: 'dotenv -e .env.aws.dev -- node s.js' } }],
      [],
      ['backend/.env.aws.dev'],
    ],
    ["bare dotenv: the folder's .env", 'dotenv -- node s.js', [], [], ['.env']],
    ['another env file', 'dotenv -e .env.local -- node s.js', [], [], []],
    [
      "docker compose's env_file",
      'docker compose up api',
      [],
      [{ dir: '.', text: 'services:\n  api:\n    env_file:\n      - backend/.env.aws.dev\n' }],
      ['backend/.env.aws.dev'],
    ],
    [
      'env_file as one value',
      'docker-compose up',
      [],
      [{ dir: '.', text: 'services:\n  api:\n    env_file: .env\n' }],
      ['.env'],
    ],
    [
      'a comment that names them: no load',
      '# reads no backend/.env.aws.dev\ncd backend && node s.js # nor .env.aws.dev\n',
      [],
      [],
      [],
    ],
    ['said, never loaded', 'echo "skips backend/.env.aws.dev" && node s.js', [], [], []],
    [
      'a compose file nothing runs',
      'node s.js',
      [],
      [{ dir: '.', text: 'services:\n  api:\n    env_file: .env\n' }],
      [],
    ],
  ])('%s', (_, text, scripts, compose, loaded) => {
    expect(
      credentialsLoaded({ text, scripts, compose, credentials: CREDS }).map((c) => c.path),
    ).toEqual(loaded);
  });
});

describe('gate: a run that loads cloud credentials warned on Connected, refused on Just this Mac', () => {
  const files = [
    {
      path: 'backend/.env.aws.dev',
      example: false,
      ignored: true,
      values: new Map([['AWS_ACCESS_KEY_ID', 'AKIAFAKE']]),
    },
    envFile('backend/.env', 'API_URL=https://api.example.com\n'),
  ];
  const credentials = [{ path: 'backend/.env.aws.dev', why: 'it holds AWS_ACCESS_KEY_ID' }];
  const LOADS = '#!/bin/sh\ncd backend && npx dotenv -e .env.aws.dev -- node server.js\n';
  const WARNING =
    '.claude/skills/run-app/scripts/start loads backend/.env.aws.dev (it holds AWS_ACCESS_KEY_ID): the app reaches a real cloud account with those keys';
  const UNKNOWN = 'API_URL points at api.example.com: nothing says whether it is test or prod';

  test.each<[string, string, boolean, { passed: boolean; reasons: string[]; warnings: string[] }]>([
    [
      'Connected, start loads them',
      LOADS,
      false,
      { passed: true, reasons: [], warnings: [WARNING] },
    ],
    [
      'Local only, start loads them: it fails, the warning first',
      '#!/bin/sh\ncd backend && npx dotenv -e .env.aws.dev -e .env -- node server.js\n',
      true,
      {
        passed: false,
        reasons: [
          `${WARNING}, and a Local only install's gate passes no run against a real cloud account`,
          UNKNOWN,
        ],
        warnings: [WARNING],
      },
    ],
    [
      'start loads none',
      '#!/bin/sh\nnode server.js\n',
      true,
      { passed: true, reasons: [], warnings: [] },
    ],
    [
      'only a comment names them',
      '#!/bin/sh\n# skips backend/.env.aws.dev and setAwsCredentials.sh\nnode server.js\n',
      true,
      { passed: true, reasons: [], warnings: [] },
    ],
  ])('%s', (_, start, local, want) => {
    const g = gate({
      url: 'http://localhost:4100',
      answered: true,
      files,
      start,
      credentials,
      local,
      testHosts: local ? [] : ['api.example.com'],
    });

    expect({ passed: g.passed, reasons: g.reasons, warnings: g.warnings }).toEqual(want);
    expect(JSON.stringify(g)).not.toContain('AKIAFAKE');
  });
});
