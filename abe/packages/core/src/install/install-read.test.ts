/** Factory install's Read: what local files and the Layers say, nothing remote. */
import { describe, expect, test } from 'bun:test';
import { checkoutFiles } from '@abe/testing';
import {
  boardHintWords,
  type BoardSetting,
  ciCommands,
  readCheckout,
  type ReadFindings,
  readFindings,
} from './install-read';

const WORKFLOW = `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: checks
        run: |
          npm run lint
          npm test
      - run: 'npm run build'
`;

describe('ciCommands: each run line and run block', () => {
  test('a workflow', () => {
    expect(ciCommands(WORKFLOW)).toEqual(['npm ci', 'npm run lint', 'npm test', 'npm run build']);
  });
});

const read = (files: Record<string, string>, board?: BoardSetting): ReadFindings =>
  readFindings({ files: new Map(Object.entries(files)), board });

describe('readFindings: the board, the logins, aws, the ports', () => {
  test.each<[string, BoardSetting | undefined, ReadFindings['board']]>([
    ['no Layer names one: Read asks', undefined, null],
    ['core default (empty)', { value: {}, layer: 'core' }, null],
    [
      "the repo's Azure board",
      {
        value: { organization: 'https://dev.azure.com/acme', project: 'Shop', team: 'Web' },
        layer: 'repo',
      },
      { provider: 'azure-boards', name: 'Shop/Web', from: 'repo' },
    ],
    [
      'GitHub Projects named by the repo',
      { value: { provider: 'github-projects', organization: 'acme' }, layer: 'repo' },
      { provider: 'github-projects', name: 'acme', from: 'repo' },
    ],
    [
      'a board On this machine the install wrote: its name, else its words',
      { value: { provider: 'local', project: 'shop' }, layer: 'repo' },
      { provider: 'local', name: 'shop', from: 'repo' },
    ],
    [
      'a board On this machine, unnamed',
      { value: { provider: 'local' }, layer: 'repo' },
      { provider: 'local', name: 'On this machine', from: 'repo' },
    ],
    [
      "the repo's GitHub Issues: origin's unless it names a repo",
      { value: { provider: 'github' }, layer: 'repo' },
      { provider: 'github-issues', name: 'origin', from: 'repo' },
    ],
    [
      'GitHub Issues of a named repo, as typed',
      { value: { provider: 'gh', repo: 'acme/shop' }, layer: 'repo' },
      { provider: 'github-issues', name: 'acme/shop', from: 'repo' },
    ],
    [
      'only your own Layer names it: Read still asks the team question',
      { value: { provider: 'jira', project: 'SHOP' }, layer: 'individual' },
      null,
    ],
  ])('%s', (_, board, want) => {
    expect(read({}, board).board).toEqual(want);
  });

  test.each<[string, Record<string, string>, string[]]>([
    ['no doc names one', { 'README.md': '# Shop\n' }, []],
    [
      'the README links its board',
      { 'README.md': 'Board: https://dev.azure.com/acme/Shop/_boards\n' },
      ['Azure Boards acme/Shop (README.md:1)'],
    ],
    [
      'a CI file names the org',
      { '.github/workflows/ci.yml': 'x: https://dev.azure.com/acme\n' },
      ['Azure Boards acme (.github/workflows/ci.yml:1)'],
    ],
    [
      "the agent file's team board, the README's Jira",
      {
        'README.md': 'Issues: https://acme.atlassian.net/browse/SHOP-1\n',
        'CLAUDE.md': 'Cards: https://dev.azure.com/acme/Shop/_boards/board/t/Web\n',
      },
      ['Azure Boards acme/Shop/Web (CLAUDE.md:1)', 'Jira SHOP (README.md:1)'],
    ],
    [
      'a source file is not read for it',
      { 'src/a.ts': "const u = 'https://dev.azure.com/acme/Shop'" },
      [],
    ],
  ])('the boards the docs, CI and agent files name: %s', (_, files, hints) => {
    expect(read(files).boards.map((b) => `${boardHintWords(b)} (${b.why})`)).toEqual(hints);
  });

  test.each<[string, Record<string, string>, BoardSetting | undefined, string[]]>([
    ['github and claude always', {}, undefined, ['github', 'claude']],
    [
      'az for an Azure board',
      {},
      { value: { organization: 'https://dev.azure.com/a', project: 'P' }, layer: 'repo' },
      ['github', 'claude', 'az'],
    ],
    [
      'no az for a board On this machine',
      {},
      { value: { provider: 'local', project: 'app' }, layer: 'repo' },
      ['github', 'claude'],
    ],
    [
      'az for CI that logs in to Azure, whatever the board',
      { '.github/workflows/d.yml': 'steps:\n  - uses: azure/login@v2\n' },
      { value: { provider: 'local', project: 'app' }, layer: 'repo' },
      ['github', 'claude', 'az'],
    ],
    [
      'aws from CI',
      {
        '.github/workflows/deploy.yml':
          'steps:\n  - uses: aws-actions/configure-aws-credentials@v4\n',
      },
      undefined,
      ['github', 'claude', 'aws'],
    ],
    [
      'aws from the env example',
      { '.env.example': 'AWS_PROFILE=shop-test\n' },
      undefined,
      ['github', 'claude', 'aws'],
    ],
  ])('logins: %s', (_, files, board, logins) => {
    expect(read(files, board).logins).toEqual(logins);
  });

  test.each<[string, Record<string, string>, string[], string[]]>([
    ['none: not needed', { 'package.json': '{"dependencies":{"react":"19"}}' }, [], []],
    [
      'the aws SDK',
      { 'package.json': '{\n  "dependencies": {\n    "@aws-sdk/client-s3": "3"\n  }\n}' },
      [],
      ['package.json:3 @aws-sdk/client-s3'],
    ],
    [
      'the old aws SDK, Serverless',
      { 'package.json': '{"dependencies":{"aws-sdk":"2"},"devDependencies":{"serverless":"4"}}' },
      [],
      ['package.json:1 aws-sdk', 'package.json:1 serverless'],
    ],
    [
      'CDK: cdk.json first, then its main dependency, then a module of it',
      { 'package.json': '{"dependencies":{"@aws-cdk/aws-lambda":"1","aws-cdk-lib":"2"}}' },
      ['cdk.json', 'package.json'],
      ['cdk.json', 'package.json:1 aws-cdk-lib', 'package.json:1 @aws-cdk/aws-lambda'],
    ],
    [
      "CI's credential step before a dependency",
      {
        'package.json': '{"dependencies":{"@aws-sdk/client-s3":"3"}}',
        '.github/workflows/deploy.yml':
          'jobs:\n  d:\n    steps:\n      - uses: aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a # v4\n',
      },
      ['package.json'],
      [
        '.github/workflows/deploy.yml:4 aws-actions/configure-aws-credentials',
        'package.json:1 @aws-sdk/client-s3',
      ],
    ],
    [
      'a Serverless config',
      {},
      ['serverless.yml', 'serverless.ts'],
      ['serverless.yml', 'serverless.ts'],
    ],
    [
      "Terraform's aws provider",
      {
        'main.tf': 'terraform {}\nprovider "aws" {\n  region = "eu-west-1"\n}\n',
        'infra/versions.tf': 'required_providers {\n  aws = { source = "hashicorp/aws" }\n}\n',
        'terraform/gcp.tf': 'provider "google" {}\n',
      },
      [],
      ['main.tf:2 provider "aws"', 'infra/versions.tf:2 hashicorp/aws'],
    ],
    [
      'an aws action or command in CI',
      {
        '.github/workflows/deploy.yml':
          'steps:\n  - uses: aws-actions/configure-aws-credentials@v4\n',
        '.github/workflows/sync.yml': 'steps:\n  - run: aws s3 sync dist s3://shop\n',
      },
      [],
      [
        '.github/workflows/deploy.yml:2 aws-actions/configure-aws-credentials',
        '.github/workflows/sync.yml:2 aws s3',
      ],
    ],
    [
      'AWS_* keys in the env example',
      { '.env.example': 'DATABASE_URL=\nAWS_PROFILE=shop-test\nAWS_REGION=eu-west-1\n' },
      [],
      ['.env.example:2 AWS_PROFILE', '.env.example:3 AWS_REGION'],
    ],
    [
      "the repo Layer's logins:",
      { 'abe.yaml': 'logins:\n  - gh\n  - aws: { profile: shop-test, sso: true }\n' },
      [],
      ['abe.yaml:3 logins: aws'],
    ],
    [
      'a source that is aws',
      { '.mcp.json': '{"mcpServers":{"aws-docs":{"command":"uvx"}}}' },
      [],
      ['.mcp.json:1 mcpServers.aws-docs'],
    ],
  ])('aws: %s', (_, files, names, why) => {
    const f = readFindings({ files: new Map(Object.entries(files)), board: undefined, names });

    expect([f.aws, f.logins.includes('aws')]).toEqual([why, why.length > 0]);
  });

  test('env keys from the first example, never values; an auth callback fixes its port', () => {
    const f = read({
      '.env.example':
        'DATABASE_URL=postgres://localhost/shop\nAUTH_CALLBACK_URL=http://localhost:3000/cb\nPORT=4000\n',
      '.env.sample': 'OTHER=1\n',
      'package.json': '{"scripts":{"dev":"vite","test":"vitest"}}',
      '.github/workflows/ci.yml': WORKFLOW,
    });

    expect(f.envExample).toBe('.env.example');
    expect(f.envKeys).toEqual(['DATABASE_URL', 'AUTH_CALLBACK_URL', 'PORT']);
    expect(f.fixedPorts).toEqual([3000]);
    expect(f.scripts).toEqual({ dev: 'vite', test: 'vitest' });
    expect(f.ci).toEqual([
      {
        file: '.github/workflows/ci.yml',
        commands: ['npm ci', 'npm run lint', 'npm test', 'npm run build'],
      },
    ]);
  });
});

/** A made-up monorepo: a web frontend, a backend on aws with Sentry, end-to-end tests. */
const SHOP: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      workspaces: ['frontend', 'backend', 'e2e', '!**/node_modules/**'],
      scripts: { dev: 'turbo run dev' },
    },
    null,
    2,
  ),
  'frontend/package.json': JSON.stringify(
    {
      scripts: { dev: 'vite', test: 'vitest run' },
      dependencies: { react: '19' },
      devDependencies: { vite: '7', vitest: '3' },
    },
    null,
    2,
  ),
  'frontend/.env.example':
    'VITE_API_URL=http://localhost:4000\nAUTH_CALLBACK_URL=http://localhost:5173/cb\n',
  'backend/package.json': JSON.stringify(
    {
      scripts: {
        dev: 'bash ./scripts/creds.sh dev && tsx watch src/server.ts',
        'dev:test': 'bash ./scripts/creds.sh test && tsx watch src/server.ts',
        test: 'vitest run',
      },
      dependencies: { fastify: '5', '@sentry/aws-serverless': '9', '@aws-sdk/client-s3': '3' },
    },
    null,
    2,
  ),
  'backend/.env.example': 'DATABASE_URL=\nPAYMENTS_KEY=\n',
  'backend/.env': 'DATABASE_URL=postgres://real\n',
  'backend/scripts/creds.sh':
    '#!/bin/bash\nPROFILE=${1:-dev}\naws sso login --profile "$PROFILE"\n',
  'e2e/package.json': JSON.stringify(
    { scripts: { 'test:e2e': 'playwright test' }, devDependencies: { '@playwright/test': '1' } },
    null,
    2,
  ),
  'e2e/.env.example': 'BASE_URL=\nE2E_USER=\n',
  'node_modules/left-pad/package.json': '{}',
};

const shop = (more: Record<string, string> = {}, drop: readonly string[] = []) =>
  readCheckout(
    checkoutFiles(
      Object.fromEntries(
        Object.entries({ ...SHOP, ...more }).filter(([path]) => !drop.includes(path)),
      ),
    ),
    undefined,
  );

const dirs = (f: ReadFindings) => [f.workspacesFrom, f.workspaces.map((w) => w.dir)];

describe("readCheckout: a monorepo's workspaces, bounded", () => {
  test.each<[string, () => Promise<ReadFindings>, (f: ReadFindings) => unknown, unknown]>([
    [
      "by package.json's workspaces",
      () => shop(),
      dirs,
      ['package.json', ['frontend', 'backend', 'e2e']],
    ],
    [
      "by pnpm-workspace.yaml's packages, a glob",
      () =>
        shop(
          {
            'package.json': '{"scripts":{"dev":"pnpm -r dev"}}',
            'pnpm-workspace.yaml': 'packages:\n  - \'apps/*\'\n  - "e2e"\n',
            'apps/web/package.json': '{}',
            'apps/admin/package.json': '{}',
            'apps/notes.md': '# notes',
          },
          ['frontend/package.json', 'backend/package.json'],
        ),
      dirs,
      ['pnpm-workspace.yaml', ['apps/admin', 'apps/web', 'e2e']],
    ],
    [
      'by the folders at the top two levels holding a package.json, never node_modules, dist or build',
      () =>
        shop({
          'package.json': '{"scripts":{"dev":"turbo run dev"}}',
          'services/api/package.json': '{}',
          'dist/package.json': '{}',
          'frontend/build/package.json': '{}',
          'docs/a/b/package.json': '{}',
        }),
      dirs,
      ['folders', ['backend', 'e2e', 'frontend', 'services/api']],
    ],
    [
      'none: a one-package repo',
      () => readCheckout(checkoutFiles({ 'package.json': '{}', 'src/main.ts': '' }), undefined),
      dirs,
      [null, []],
    ],
    [
      "each workspace's scripts, tests, env example keys (never its env file) and stack",
      () => shop(),
      (f) => [
        f.workspaces.map((w) => [
          w.dir,
          Object.keys(w.scripts),
          w.tests,
          w.envExample,
          w.envKeys,
          w.stack,
        ]),
        f.files.filter((p) => p.endsWith('.env')),
        f.fixedPorts,
      ],
      [
        [
          [
            'frontend',
            ['dev', 'test'],
            ['test'],
            'frontend/.env.example',
            ['VITE_API_URL', 'AUTH_CALLBACK_URL'],
            ['react', 'vite', 'vitest'],
          ],
          [
            'backend',
            ['dev', 'dev:test', 'test'],
            ['test'],
            'backend/.env.example',
            ['DATABASE_URL', 'PAYMENTS_KEY'],
            ['fastify'],
          ],
          [
            'e2e',
            ['test:e2e'],
            ['test:e2e'],
            'e2e/.env.example',
            ['BASE_URL', 'E2E_USER'],
            ['@playwright/test'],
          ],
        ],
        [],
        [5173],
      ],
    ],
    [
      "a workspace's Sentry dependency is a source, by its file and line",
      () => shop(),
      (f) => f.sources.map((s) => [s.id, s.why]),
      [['sentry', 'backend/package.json:9 @sentry/aws-serverless']],
    ],
    [
      'the aws profiles a script names, by where; aws needed, no profile picked',
      () => shop(),
      (f) => [f.awsProfiles, f.aws, f.logins],
      [
        [
          {
            name: 'dev',
            seen: [
              'backend/scripts/creds.sh:2 PROFILE=${1:-dev}',
              'backend/package.json:3 creds.sh dev',
            ],
          },
          { name: 'test', seen: ['backend/package.json:4 creds.sh test'] },
        ],
        [
          'backend/package.json:10 @aws-sdk/client-s3',
          'backend/scripts/creds.sh:2 PROFILE=${1:-dev}',
          'backend/package.json:4 creds.sh test',
        ],
        ['github', 'claude', 'aws'],
      ],
    ],
    [
      "a workspace's vite port and its sign-in redirect from the origin, found by searching: that port fixed",
      () =>
        shop({
          'frontend/vite.config.ts':
            "import { defineConfig } from 'vite';\n\nexport default defineConfig({\n  server: {\n    port: 4000,\n    strictPort: true,\n  },\n});\n",
          'frontend/src/auth/provider.tsx':
            'export const Auth = () => (\n  <Auth0Provider\n    authorizationParams={{ redirect_uri: window.location.origin }}\n  />\n);\n',
        }),
      (f) => [f.files.includes('frontend/vite.config.ts'), f.devPorts, f.originAuth, f.fixedPorts],
      [
        true,
        [{ port: 4000, seen: 'frontend/vite.config.ts:4 server.port' }],
        [
          'frontend/src/auth/provider.tsx:3 authorizationParams={{ redirect_uri: window.location.origin }}',
        ],
        [4000, 5173],
      ],
    ],
    [
      'more workspaces than the cap: the first ones read, the cap said',
      () =>
        readCheckout(
          checkoutFiles({
            'package.json': '{"workspaces":["pkgs/*"]}',
            ...Object.fromEntries(
              Array.from({ length: 60 }, (_, n) => [
                `pkgs/p${String(n).padStart(2, '0')}/package.json`,
                '{}',
              ]),
            ),
          }),
          undefined,
        ),
      (f) => [f.workspaces.length, f.workspaces.at(-1)?.dir, f.capped],
      [50, 'pkgs/p49', [{ what: 'workspaces', cap: 50 }]],
    ],
  ])('%s', async (_, run, pick, want) => {
    expect(pick(await run())).toEqual(want);
  });
});

describe("readFindings: the repo's own dev ports, and those its origin-bound sign-in redirect fixes", () => {
  const VITE = 'export default {\n  server: { port: 4000, strictPort: true },\n};\n';
  const REDIRECT = {
    path: 'web/src/auth.ts',
    line: 7,
    text: '  redirectUri: window.location.origin,',
  };

  test.each<{
    name: string;
    files: Record<string, string>;
    found?: { path: string; line: number; text: string }[];
    dev: [number, string][];
    auth: string[];
    fixed: number[];
  }>([
    {
      name: 'none',
      files: { 'package.json': '{"scripts":{"dev":"vite"}}' },
      dev: [],
      auth: [],
      fixed: [],
    },
    {
      name: "vite's server.port alone: a dev port, not fixed",
      files: { 'web/vite.config.ts': VITE },
      dev: [[4000, 'web/vite.config.ts:2 server.port']],
      auth: [],
      fixed: [],
    },
    {
      name: "webpack's devServer.port",
      files: {
        'webpack.config.js':
          'module.exports = {\n  devServer: {\n    hot: true,\n    port: 8080,\n  },\n};\n',
      },
      dev: [[8080, 'webpack.config.js:2 devServer.port']],
      auth: [],
      fixed: [],
    },
    {
      name: "a package script's port: --port, PORT=, next's -p",
      files: {
        'package.json': JSON.stringify(
          {
            scripts: {
              dev: 'next dev -p 3001',
              serve: 'PORT=5000 node server.js',
              ui: 'vite --port=5174',
              build: 'vite build',
            },
          },
          null,
          2,
        ),
      },
      dev: [
        [3001, 'package.json:3 dev'],
        [5000, 'package.json:4 serve'],
        [5174, 'package.json:5 ui'],
      ],
      auth: [],
      fixed: [],
    },
    {
      name: 'the sign-in redirect is the origin: the dev port of its folder fixed',
      files: {
        'web/vite.config.ts': VITE,
        'api/package.json': '{"scripts":{"dev":"tsx watch --port 4001 src"}}',
      },
      found: [REDIRECT],
      dev: [
        [4000, 'web/vite.config.ts:2 server.port'],
        [4001, 'api/package.json:1 dev'],
      ],
      auth: ['web/src/auth.ts:7 redirectUri: window.location.origin,'],
      fixed: [4000],
    },
    {
      name: 'the redirect in no folder with a dev port: every dev port fixed',
      files: { 'web/vite.config.ts': VITE },
      found: [{ ...REDIRECT, path: 'shared/auth.ts' }],
      dev: [[4000, 'web/vite.config.ts:2 server.port']],
      auth: ['shared/auth.ts:7 redirectUri: window.location.origin,'],
      fixed: [4000],
    },
    {
      name: "a dev tool's port (a DB studio, storybook, an inspector) is no dev server of the app: never fixed",
      files: {
        'web/vite.config.ts': VITE,
        'package.json': JSON.stringify({
          scripts: {
            'drizzle:studio': 'drizzle-kit studio --port 5050',
            storybook: 'storybook dev -p 6006 --port 6006',
            debug: 'node --inspect --port 9229 server.js',
          },
        }),
      },
      found: [{ ...REDIRECT, path: 'shared/auth.ts' }],
      dev: [[4000, 'web/vite.config.ts:2 server.port']],
      auth: ['shared/auth.ts:7 redirectUri: window.location.origin,'],
      fixed: [4000],
    },
    {
      name: "an app script that runs a tool first still fixes the app's port",
      files: {
        'package.json': JSON.stringify({
          scripts: {
            dev: 'prisma generate && next dev -p 3000',
          },
        }),
      },
      found: [{ ...REDIRECT, path: 'auth.ts' }],
      dev: [[3000, 'package.json:1 dev']],
      auth: ['auth.ts:7 redirectUri: window.location.origin,'],
      fixed: [3000],
    },
    {
      name: 'a line that sets no redirect from the origin is no sign-in redirect',
      files: { 'web/vite.config.ts': VITE },
      found: [{ ...REDIRECT, text: 'const here = window.location.origin;' }],
      dev: [[4000, 'web/vite.config.ts:2 server.port']],
      auth: [],
      fixed: [],
    },
  ])('$name', ({ files, found, dev, auth, fixed }) => {
    const f = readFindings({
      files: new Map(Object.entries(files)),
      board: undefined,
      ...(found === undefined ? {} : { found }),
    });

    expect([f.devPorts.map((d) => [d.port, d.seen]), f.originAuth, f.fixedPorts]).toEqual([
      dev,
      auth,
      fixed,
    ]);
  });
});

describe('readFindings: the named aws profiles, each where seen', () => {
  test.each<[string, Record<string, string>, [string, string[]][]]>([
    ['none', { 'package.json': '{"scripts":{"deploy":"cdk deploy"}}' }, []],
    [
      '--profile and AWS_PROFILE= in package scripts',
      {
        'package.json':
          '{\n  "scripts": {\n    "deploy": "cdk deploy --profile shop-prod",\n    "seed": "AWS_PROFILE=shop-dev tsx seed.ts"\n  }\n}',
      },
      [
        ['shop-prod', ['package.json:3 --profile shop-prod']],
        ['shop-dev', ['package.json:4 AWS_PROFILE=shop-dev']],
      ],
    ],
    [
      "CI's env and run lines; a secret's or a variable's value is no name",
      {
        '.github/workflows/deploy.yml':
          'env:\n  AWS_PROFILE: shop-ci\njobs:\n  d:\n    steps:\n      - run: aws s3 ls --profile=${{ inputs.profile }}\n      - run: aws s3 ls --profile $P\n',
      },
      [['shop-ci', ['.github/workflows/deploy.yml:2 AWS_PROFILE: shop-ci']]],
    ],
    [
      "a Serverless or CDK config's profile",
      {
        'api/serverless.yml': 'provider:\n  name: aws\n  profile: shop-sls\n',
        'cdk.json': '{\n  "app": "npx tsx bin/app.ts",\n  "profile": "shop-cdk"\n}',
      },
      [
        ['shop-sls', ['api/serverless.yml:3 profile: shop-sls']],
        ['shop-cdk', ['cdk.json:3 "profile": "shop-cdk"']],
      ],
    ],
  ])('%s', (_, files, want) => {
    const f = readFindings({ files: new Map(Object.entries(files)), board: undefined });

    expect(f.awsProfiles.map((p) => [p.name, p.seen])).toEqual(want);
  });
});

describe('readCheckout: the scripts that write real systems, by name or by what they run', () => {
  const PKG = JSON.stringify(
    {
      scripts: {
        dev: 'vite',
        'deploy:platform': 'cdk deploy --all',
        'sync:vars': 'node scripts/syncVariables.js',
        vars: 'gh variable set FOO --body x',
        tenant: 'a0deploy import -c config.json',
        infra: 'terraform apply -auto-approve',
        api: 'gh api -X DELETE repos/acme/shop/environments/dev',
        creds: 'bash ./scripts/creds.sh',
        seed: 'curl -X POST http://localhost:4100/seed',
        notify: 'curl -X POST https://hooks.example.com/x',
        synth: 'npx cdk synth',
        build: 'tsc && npm i aws-cdk-lib',
      },
    },
    null,
    2,
  );

  test('each with where and why', async () => {
    const f = await readCheckout(
      checkoutFiles({
        'package.json': PKG,
        'scripts/creds.sh':
          '#!/bin/sh\n# aws is used\naws configure export-credentials --profile dev\n',
        'exportUsers.js': 'module.exports = 1;\n',
        'server.js': 'module.exports = 2;\n',
      }),
      undefined,
    );

    expect(f.outward.map((o) => [o.name, o.file, o.seen, o.why])).toEqual([
      ['deploy:platform', null, 'package.json:4', 'its name says deploy'],
      ['sync:vars', 'scripts/syncVariables.js', 'package.json:5', 'its name says sync'],
      ['vars', null, 'package.json:6', 'gh variable set'],
      ['tenant', null, 'package.json:7', 'a0deploy'],
      ['infra', null, 'package.json:8', 'terraform apply'],
      ['api', null, 'package.json:9', 'gh api'],
      ['creds', 'scripts/creds.sh', 'package.json:10', 'scripts/creds.sh:3 aws configure'],
      ['notify', null, 'package.json:12', 'curl -X POST'],
      ['synth', null, 'package.json:13', 'npx cdk synth'],
      [null, 'exportUsers.js', 'exportUsers.js', 'its name says export'],
    ]);
  });
});

describe('readCheckout: a script that calls an outside API with a token is outward', () => {
  const call = (
    url: string,
    auth = 'headers: { Authorization: `Bearer ${process.env.API_TOKEN}` }',
  ) => `const res = await fetch(${url}, { ${auth} });\nconsole.log(await res.json());\n`;
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts }, null, 2);

  test.each<[string, Record<string, string>, (string | null)[][]]>([
    [
      'a package script runs a file that reads a vendor API with a token',
      {
        'package.json': pkg({ users: 'node scripts/fetchUsers.js' }),
        'scripts/fetchUsers.js': call('"https://api.sendgrid.com/v3/marketing/contacts"'),
      },
      [
        [
          'users',
          'scripts/fetchUsers.js',
          'package.json:3',
          'scripts/fetchUsers.js:1 calls api.sendgrid.com with a token',
        ],
      ],
    ],
    [
      'a tenant API path on a host from the environment',
      {
        'package.json': pkg({ users: 'node scripts/fetchUsers.js' }),
        'scripts/fetchUsers.js': call('`https://${process.env.TENANT_DOMAIN}/api/v2/users`'),
      },
      [
        [
          'users',
          'scripts/fetchUsers.js',
          'package.json:3',
          'scripts/fetchUsers.js:1 calls an /api/v2 endpoint with a token',
        ],
      ],
    ],
    [
      'a script file no package script runs, in scripts/',
      { 'scripts/pull.js': call('"https://api.github.com/orgs/acme/members"') },
      [
        [
          null,
          'scripts/pull.js',
          'scripts/pull.js',
          'scripts/pull.js:1 calls api.github.com with a token',
        ],
      ],
    ],
    [
      'a call to this machine is nothing outside',
      { 'scripts/local.js': call('"http://localhost:4100/api/v2/users"') },
      [],
    ],
    [
      'an outside call with no credential is not asked',
      { 'scripts/ping.js': call('"https://api.github.com/zen"', '') },
      [],
    ],
    [
      'a vendor link in a message, the credential far from it',
      {
        'scripts/help.js': `console.log("docs: https://api.github.com/docs");\n${'\n'.repeat(20)}const key = process.env.API_KEY;\n`,
      },
      [],
    ],
    [
      'a host named only in a comment',
      {
        'scripts/doc.js':
          '// see https://api.github.com/orgs, send a Bearer token\nmodule.exports = 1;\n',
      },
      [],
    ],
  ])('%s', async (_, files, want) => {
    const f = await readCheckout(checkoutFiles(files), undefined);

    expect(f.outward.map((o) => [o.name, o.file, o.seen, o.why])).toEqual(want);
  });
});

describe('readCheckout: the env files with cloud credentials, by their key names or their names, never a value', () => {
  test('each with why, in the top and the workspaces', async () => {
    const f = await shop({
      'backend/.env.aws.dev': 'AWS_ACCESS_KEY_ID=AKIAFAKEFAKE\nAWS_SECRET_ACCESS_KEY=s3cr3t\n',
      'backend/.env.aws.prod': '',
      '.env.local': 'AWS_SESSION_TOKEN=t0k3n\n',
      'backend/.env.aws.example': 'AWS_ACCESS_KEY_ID=\n',
    });

    expect(f.cloudCredentials).toEqual([
      { path: '.env.local', why: 'it holds AWS_SESSION_TOKEN' },
      {
        path: 'backend/.env.aws.dev',
        why: 'it holds AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY',
      },
      { path: 'backend/.env.aws.prod', why: 'its name says aws' },
    ]);
    for (const value of ['AKIAFAKEFAKE', 's3cr3t', 't0k3n'])
      expect(JSON.stringify(f)).not.toContain(value);
  });
});

describe("readCheckout: an env file whose keys are its example's, or which CI or a script copies the example to", () => {
  const WEB = { 'package.json': '{"workspaces":["web"]}', 'web/package.json': '{}' };
  type Seen = [boolean, 'ci' | 'script' | null];
  const seen = (f: ReadFindings, path: string): Seen => {
    const e = f.envFiles.find((x) => x.path === path);

    return [e?.inExample ?? false, e?.copiedBy ?? null];
  };

  test.each<[string, Record<string, string>, string, Seen]>([
    [
      'every key in the example beside it',
      { ...WEB, 'web/.env.example': 'API_URL=\nPORT=\n', 'web/.env': 'API_URL=http://fake\n' },
      'web/.env',
      [true, null],
    ],
    [
      'the one at the top when none is beside it',
      { ...WEB, '.env.example': 'API_URL=\nPORT=\n', 'web/.env': 'PORT=3000\n' },
      'web/.env',
      [true, null],
    ],
    [
      "one key not in the example's",
      { '.env.example': 'API_URL=\n', '.env': 'API_URL=http://fake\nPAYMENTS_KEY=fake\n' },
      '.env',
      [false, null],
    ],
    [
      'beside it first: the top one is not looked at then',
      {
        ...WEB,
        '.env.example': 'API_URL=\nPAYMENTS_KEY=\n',
        'web/.env.example': 'API_URL=\n',
        'web/.env': 'PAYMENTS_KEY=fake\n',
      },
      'web/.env',
      [false, null],
    ],
    [
      'a workflow copies the example to it',
      {
        '.github/workflows/ci.yml':
          'jobs:\n  test:\n    steps:\n      - run: cp .env.example .env\n      - run: npm test\n',
        '.env.example': 'API_URL=\n',
        '.env': 'API_URL=http://fake\nPAYMENTS_KEY=fake\n',
      },
      '.env',
      [false, 'ci'],
    ],
    [
      "the top's package script, after a cd",
      {
        'package.json':
          '{"workspaces":["web"],"scripts":{"setup":"cd web && cp -n .env.sample .env.local"}}',
        'web/package.json': '{}',
        'web/.env.sample': 'API_URL=\n',
        'web/.env.local': 'API_URL=http://fake\nPAYMENTS_KEY=fake\n',
      },
      'web/.env.local',
      [false, 'script'],
    ],
    [
      "a workspace's own package script, from its folder",
      {
        ...WEB,
        'web/package.json': '{"scripts":{"setup":"cat .env.example > .env"}}',
        'web/.env.example': 'API_URL=\n',
        'web/.env': 'API_URL=http://fake\nPAYMENTS_KEY=fake\n',
      },
      'web/.env',
      [false, 'script'],
    ],
  ])('%s', async (_, files, path, want) => {
    const f = await readCheckout(checkoutFiles(files), undefined);

    expect(seen(f, path)).toEqual(want);
    expect(JSON.stringify(f)).not.toContain('fake');
  });
});
