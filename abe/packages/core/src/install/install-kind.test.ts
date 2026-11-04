/** Factory install's Read of a repo's kind and of what a merge deploys (ADR 0026), on made-up repos. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  CDK_REPO,
  checkoutFiles,
  LIBRARY_REPO,
  MONOREPO,
  NEVER_READ_MARK,
  TENANT_REPO,
  WEB_REPO,
} from '@abe/testing';
import { deployWorkflowsOf, mergeDeploysOf, mergeDeploysWords } from './install-deploys';
import { readCheckout } from './install-read';
import { kindWords, nothingToRun, RepoKindSaid } from './install-kind';

type Want = {
  kind: string;
  parts: [string, string, string[]][];
  deploys: string | null;
  nothing: string | null;
  tools: string[];
  systems: string[];
  ports: number[];
  checks: string[];
  neverRead: string[];
};

describe('Read: the kind from evidence, what runs, what a merge deploys', () => {
  test.each<[string, Readonly<Record<string, string>>, Want]>([
    [
      'a tenant config deployed by CI on every push: nothing to run, a merge deploys prod',
      TENANT_REPO,
      {
        kind: 'config as code',
        parts: [
          [
            '.',
            'config',
            [
              'src/tenant.yaml a tenant config',
              '.github/workflows/deploy.yml:29 a0deploy deploys it',
              'Dockerfile:2 a0deploy installed by its Dockerfile',
              'src/tenant.yaml a template: 3 placeholders',
            ],
          ],
        ],
        deploys: 'a merge here deploys dev, test, prod',
        nothing: 'nothing to run here: config as code, deployed by a0deploy',
        tools: ['.github/workflows/deploy.yml:29 a0deploy'],
        systems: ['.github/workflows/deploy.yml:21 Auth0', 'config.template.json:6 SendGrid'],
        ports: [3021],
        checks: ['syntax', 'json', 'yaml', 'placeholders'],
        neverRead: ['.env', 'config.generated.json'],
      },
    ],
    [
      'a web app: it runs, its release is by hand',
      WEB_REPO,
      {
        kind: 'web app',
        parts: [['.', 'web-app', ['package.json:4 react-dom in its dependencies']]],
        deploys: null,
        nothing: null,
        tools: [],
        systems: ['package.json:4 Sentry'],
        ports: [5173],
        checks: [],
        neverRead: [],
      },
    ],
    [
      'a library: nothing to run, a push to main only tests',
      LIBRARY_REPO,
      {
        kind: 'library',
        parts: [['.', 'library', ['package.json:3 main: what it exports']]],
        deploys: null,
        nothing: 'nothing to run here: library',
        tools: [],
        systems: [],
        ports: [],
        checks: [],
        neverRead: [],
      },
    ],
    [
      'CDK infrastructure: its bin and a Dockerfile installing a0deploy are no CLI and no tenant',
      CDK_REPO,
      {
        kind: 'infrastructure as code',
        parts: [['.', 'iac', ['cdk.json CDK']]],
        deploys: 'a merge here deploys dev, test, prod',
        nothing: 'nothing to run here: infrastructure as code, deployed by cdk',
        tools: ['.github/workflows/deploy.yml:18 cdk'],
        systems: [],
        ports: [],
        checks: ['yaml', 'types', 'tests'],
        neverRead: ['cdk.context.json', 'cdk.out'],
      },
    ],
    [
      'a monorepo: a kind per workspace, Terraform at the top; it runs; a merge deploys staging',
      MONOREPO,
      {
        kind: 'monorepo: infra (infrastructure as code), apps/web (web app), packages/ui (library), services/api (service / API), services/mail (service / API), services/network (infrastructure as code)',
        parts: [
          ['infra', 'iac', ['infra/main.tf Terraform']],
          ['apps/web', 'web-app', ['apps/web/package.json:4 next in its dependencies']],
          ['packages/ui', 'library', ['packages/ui/package.json:3 exports: what it exports']],
          ['services/api', 'service', ['services/api/Dockerfile:3 EXPOSE 8080']],
          [
            'services/mail',
            'service',
            [
              'services/mail/src code that runs: handlers, a server, a function',
              'services/mail/cdk.json CDK',
            ],
          ],
          ['services/network', 'iac', ['services/network/cdk.json CDK']],
        ],
        deploys: 'a merge here deploys staging',
        nothing: null,
        tools: ['infra/main.tf terraform', 'services/mail/package.json:4 cdk'],
        systems: [],
        ports: [8080],
        checks: [],
        neverRead: ['infra/prod.tfvars'],
      },
    ],
    [
      'Bun apps: a server Bun.serve starts, a script bun runs with bun in its dependencies; a library on Bun stays one',
      {
        'package.json':
          '{\n  "name": "shop",\n  "private": true,\n  "workspaces": ["apps/*", "packages/*"],\n  "scripts": { "dev": "bun run --filter \'*\' dev" }\n}\n',
        'apps/api/package.json':
          '{\n  "name": "api",\n  "scripts": { "dev": "bun --watch src/server.ts" },\n  "devDependencies": { "@types/bun": "1.4.4" }\n}\n',
        'apps/api/src/server.ts':
          'const port = Number(process.env.PORT);\n\nBun.serve({ port, fetch: () => new Response("ok") });\n',
        'apps/jobs/package.json':
          '{\n  "name": "jobs",\n  "scripts": { "start": "bun run src/main.ts" },\n  "dependencies": { "bun": "1.4.4" }\n}\n',
        'apps/jobs/src/main.ts': 'setInterval(() => {}, 1000);\n',
        'packages/kit/package.json':
          '{\n  "name": "kit",\n  "exports": "./src/index.ts",\n  "scripts": { "test": "bun test" },\n  "devDependencies": { "@types/bun": "1.4.4" }\n}\n',
      },
      {
        kind: 'monorepo: apps/api (service / API), apps/jobs (service / API), packages/kit (library)',
        parts: [
          [
            'apps/api',
            'service',
            [
              'apps/api/src/server.ts:3 Bun.serve: a server',
              'apps/api/package.json:3 bun --watch src/server.ts: code bun runs',
              'apps/api/package.json:4 @types/bun in its dependencies',
            ],
          ],
          [
            'apps/jobs',
            'service',
            [
              'apps/jobs/package.json:3 bun run src/main.ts: code bun runs',
              'apps/jobs/package.json:4 bun in its dependencies',
            ],
          ],
          ['packages/kit', 'library', ['packages/kit/package.json:3 exports: what it exports']],
        ],
        deploys: null,
        nothing: null,
        tools: [],
        systems: [],
        ports: [],
        checks: [],
        neverRead: [],
      },
    ],
    [
      'Terraform CI only validates, a script deploys: terraform is no deploy tool by CI',
      {
        'package.json': '{\n  "name": "shop",\n  "dependencies": { "fastify": "5" }\n}\n',
        '.github/workflows/ci.yml':
          'on:\n  push:\n    branches: [main]\njobs:\n  terraform:\n    steps:\n      - run: terraform init -backend=false\n      - run: terraform validate\n  deploy-test:\n    environment: test\n    steps:\n      - run: infra/test/deploy.sh\n',
      },
      {
        kind: 'service / API',
        parts: [['.', 'service', ['package.json:3 fastify in its dependencies']]],
        deploys: 'a merge here deploys test',
        nothing: null,
        tools: [],
        systems: [],
        ports: [],
        checks: [],
        neverRead: [],
      },
    ],
  ])('%s', async (_, repo, want) => {
    const read = await readCheckout(checkoutFiles(repo), undefined);
    const s = read.kind;

    if (s === null) throw new Error('no kind read');
    const at = (e: { at: string; says: string }) => `${e.at} ${e.says}`;

    expect({
      kind: kindWords(s),
      parts: s.parts.map((p) => [p.dir, p.kind, p.evidence.map(at)]),
      deploys: mergeDeploysWords(read.deploys),
      nothing: nothingToRun(s),
      tools: s.deployTools.map(at),
      systems: s.systems.map(at),
      ports: s.ports.map((p) => p.port),
      checks: s.checks.map((c) => c.name),
      neverRead: s.neverRead,
    }).toEqual(want);
    // a rendered config, an env file, a tool's state: never read, never said
    expect(JSON.stringify(read)).not.toContain(NEVER_READ_MARK);
  });

  test('the person says it is a web app: the repo is that, the files’ evidence kept after it', async () => {
    const read = await readCheckout(checkoutFiles(TENANT_REPO), undefined, 'web-app');

    expect([
      read.kind?.kind,
      read.kind?.runs,
      read.kind?.parts[0]?.evidence.slice(0, 2).map((e) => `${e.at} ${e.says}`),
      read.kind?.checks,
      nothingToRun(read.kind),
    ]).toEqual([
      'web-app',
      true,
      ['you said it is web app', 'src/tenant.yaml a tenant config'],
      [],
      null,
    ]);
  });

  test("a monorepo's kind said per part: that part takes it, one Read did not find is added, the rest stay the files'", async () => {
    // `web`, the kind's name before, reads as web-app
    const said = RepoKindSaid.parse({ 'packages/ui': 'web', tools: 'cli' });
    const read = await readCheckout(checkoutFiles(MONOREPO), undefined, said);
    const parts = Object.fromEntries((read.kind?.parts ?? []).map((p) => [p.dir, p.kind]));

    expect([parts['packages/ui'], parts['apps/web'], parts.tools, read.kind?.kind]).toEqual([
      'web-app',
      'web-app',
      'cli',
      'monorepo',
    ]);
  });

  test("each environment's mapping file maps every placeholder; one that misses one says which", async () => {
    const stale = {
      ...TENANT_REPO,
      'config.prod.json': '{ "AUTH0_KEYWORD_REPLACE_MAPPINGS": { "ENVIRONMENT": "prod" } }\n',
    };
    const read = await readCheckout(checkoutFiles(stale), undefined);

    expect(read.kind?.mappings.map((m) => [m.file, m.env, m.missing])).toEqual([
      ['config.dev.json', 'dev', []],
      ['config.prod.json', 'prod', ['SENDGRID_API_KEY', 'SHOP_DOMAIN']],
      ['config.template.json', 'template', []],
      ['config.test.json', 'test', []],
    ]);
  });

  test('the static checks: offline commands, a JSON template not JSON yet left out', async () => {
    const marked = { ...TENANT_REPO, 'config.CI.json': '{ "ENVIRONMENT": ENV_SED }\n' };
    const read = await readCheckout(checkoutFiles(marked), undefined);
    const run = Object.fromEntries((read.kind?.checks ?? []).map((c) => [c.name, c.run]));

    expect(run.syntax).toBe(
      "git ls-files -z -- '*.js' '*.cjs' '*.mjs' | xargs -0 -n1 node --check",
    );
    // JSON and YAML parsed by Abe itself: no ruby, python or yaml package of the repo's
    expect(run.json).toBe(
      "git ls-files -z -- '*.json' ':!config.CI.json' | xargs -0 abe check json",
    );
    // a YAML template holds placeholders and is not YAML until rendered: left out
    expect(run.yaml).toBe(
      "git ls-files -z -- '*.yml' '*.yaml' ':!src/tenant.yaml' | xargs -0 abe check yaml",
    );
    expect(run.placeholders).toEndWith(
      ' src/tenant.yaml -- config.CI.json config.dev.json config.prod.json config.template.json config.test.json',
    );
    // nothing in them needs a secret, the network or the deploy tool
    expect(Object.values(run).join('\n')).not.toMatch(
      /a0deploy|curl|\.env|generated|npm (ci|install)/,
    );
  });
});

describe('Read: a template, and what fills it before the deploy', () => {
  const RENDER = `const environmentMappings = [
  'SHOP_DOMAIN',
  'SENDGRID_API_KEY',
];
const secret = process.env.AUTH0_CLIENT_SECRET;
`;
  const withCi = (render: string, extra: Record<string, string> = {}): Record<string, string> => {
    const base = Object.fromEntries(
      Object.entries(TENANT_REPO).filter(([f]) => !/^config\.(dev|test|prod)\.json$/.test(f)),
    );

    return {
      ...base,
      'src/tenant.yaml':
        'tenant:\n  name: "@@ENVIRONMENT@@"\n  url: https://##SHOP_DOMAIN##/\n  key: ##SENDGRID_API_KEY##\n',
      'config.CI.json': '{ "AUTH0_KEYWORD_REPLACE_MAPPINGS": { "ENVIRONMENT": "ci" } }\n',
      '.github/workflows/deploy.yml': (
        TENANT_REPO['.github/workflows/deploy.yml'] ?? ''
      ).replaceAll(/node scripts\/render-config\.js \S+/g, render),
      ...extra,
    };
  };

  test.each<
    [
      string,
      Record<string, string>,
      { placeholders: string[]; mappings: (string | string[] | undefined)[][]; yaml: string },
    ]
  >([
    [
      '@@KEY@@ counts like ##KEY##; a script CI renders the mapping with maps the names it lists',
      withCi('node scripts/render-ci.js config.CI.json', {
        'scripts/render-ci.js': RENDER,
      }),
      {
        placeholders: ['ENVIRONMENT', 'SHOP_DOMAIN', 'SENDGRID_API_KEY'],
        mappings: [
          ['config.CI.json', [], 'scripts/render-ci.js'],
          ['config.template.json', [], undefined],
        ],
        yaml: "git ls-files -z -- '*.yml' '*.yaml' ':!src/tenant.yaml' | xargs -0 abe check yaml",
      },
    ],
    [
      'no render script read: the mapping file misses what it misses',
      withCi('node scripts/render-ci.js config.CI.json'),
      {
        placeholders: ['ENVIRONMENT', 'SHOP_DOMAIN', 'SENDGRID_API_KEY'],
        mappings: [
          ['config.CI.json', ['SENDGRID_API_KEY', 'SHOP_DOMAIN'], undefined],
          ['config.template.json', [], undefined],
        ],
        yaml: "git ls-files -z -- '*.yml' '*.yaml' ':!src/tenant.yaml' | xargs -0 abe check yaml",
      },
    ],
  ])('%s', async (_, repo, want) => {
    const read = await readCheckout(checkoutFiles(repo), undefined);
    const check = read.kind?.checks.find((c) => c.name === 'yaml')?.run ?? '';

    expect({
      placeholders: read.kind?.templates.find((t) => t.file === 'src/tenant.yaml')?.placeholders,
      mappings: read.kind?.mappings.map((m) => [m.file, m.missing, m.renderedBy]),
      yaml: check,
    }).toEqual(want);
  });

  test.each<[string, string, number]>([
    ['every placeholder mapped, by the file or by the render script', RENDER, 0],
    ['one the script does not list', "const environmentMappings = ['SHOP_DOMAIN'];\n", 1],
  ])('the placeholders check run: %s', async (_, render, code) => {
    const repo = withCi('node scripts/render-ci.js config.CI.json', {
      'scripts/render-ci.js': render,
    });
    const read = await readCheckout(checkoutFiles(repo), undefined);
    const run = read.kind?.checks.find((c) => c.name === 'placeholders')?.run ?? '';
    const dir = await mkdtemp(join(tmpdir(), 'abe-placeholders-'));

    try {
      for (const [file, text] of Object.entries(repo)) {
        await mkdir(dirname(join(dir, file)), { recursive: true });
        await writeFile(join(dir, file), text);
      }
      const done = Bun.spawn(['sh', '-c', run], { cwd: dir, stdout: 'ignore', stderr: 'ignore' });

      expect(await done.exited).toBe(code);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Read runs each static check that runs no repo code once on a clean tree, dropping the failing', () => {
  const GAP = 'config.template.json: no SKIP_CONFIRMATION';

  test.each<
    [
      string,
      Readonly<Record<string, string>>,
      Readonly<Record<string, string>> | null,
      { asked: string[]; checks: string[]; failing: string[][] },
    ]
  >([
    [
      'all pass: all kept',
      TENANT_REPO,
      {},
      {
        asked: ['syntax', 'json', 'yaml', 'placeholders'],
        checks: ['syntax', 'json', 'yaml', 'placeholders'],
        failing: [],
      },
    ],
    [
      'one fails on main: dropped, with what it said',
      TENANT_REPO,
      { placeholders: GAP },
      {
        asked: ['syntax', 'json', 'yaml', 'placeholders'],
        checks: ['syntax', 'json', 'yaml'],
        failing: [['placeholders', GAP]],
      },
    ],
    [
      'types and tests run the repo’s code: not run at Read, left to the session’s sandbox',
      CDK_REPO,
      { yaml: 'a.yml: bad', types: 'x', tests: 'y' },
      { asked: ['yaml'], checks: ['types', 'tests'], failing: [['yaml', 'a.yml: bad']] },
    ],
    [
      'no clean tree to run in: nothing dropped',
      TENANT_REPO,
      null,
      {
        asked: ['syntax', 'json', 'yaml', 'placeholders'],
        checks: ['syntax', 'json', 'yaml', 'placeholders'],
        failing: [],
      },
    ],
  ])('%s', async (_, repo, fail, want) => {
    const names = new Map(
      ((await readCheckout(checkoutFiles(repo), undefined)).kind?.checks ?? []).map((c) => [
        c.run,
        c.name,
      ]),
    );
    const asked: string[] = [];
    const read = await readCheckout(
      {
        ...checkoutFiles(repo),
        runChecks: (commands) => {
          const named = commands.map((c) => names.get(c) ?? c);

          asked.push(...named);

          return Promise.resolve(
            fail === null
              ? undefined
              : named.map((n) => ({ ok: fail[n] === undefined, says: fail[n] ?? '' })),
          );
        },
      },
      undefined,
    );

    expect({
      asked,
      checks: read.kind?.checks.map((c) => c.name),
      failing: read.kind?.failing.map((f) => [f.name, f.says]),
    }).toEqual(want);
  });

  test('no runner: every check stays offered', async () => {
    const read = await readCheckout(checkoutFiles(TENANT_REPO), undefined);

    expect([read.kind?.checks.length, read.kind?.failing]).toEqual([4, []]);
  });
});

describe('mergeDeploysOf: the jobs a push to the default branch deploys', () => {
  const wf = (on: string, jobs: string) =>
    new Map([['.github/workflows/d.yml', `${on}\njobs:\n${jobs}`]]);
  const DEPLOY = '  ship:\n    environment: production\n    steps:\n      - run: npm run deploy\n';

  test.each<[string, string, string, string[]]>([
    ['on: push, any branch', 'on: push', DEPLOY, ['production prod']],
    ['on: [push, pull_request]', 'on: [push, pull_request]', DEPLOY, ['production prod']],
    ['push to main', 'on:\n  push:\n    branches: [main]', DEPLOY, ['production prod']],
    [
      'push to master, a list',
      'on:\n  push:\n    branches:\n      - master',
      DEPLOY,
      ['production prod'],
    ],
    ['push to release/* only', 'on:\n  push:\n    branches: [release/*]', DEPLOY, []],
    ['main ignored', 'on:\n  push:\n    branches-ignore: [main]', DEPLOY, []],
    ['tags only', "on:\n  push:\n    tags: ['v*']", DEPLOY, []],
    ['by hand only', 'on: workflow_dispatch', DEPLOY, []],
    [
      'a job with an environment that only lints is no deploy',
      'on: push',
      '  lint:\n    environment: dev\n    steps:\n      - run: npm run lint\n',
      [],
    ],
    [
      'a step that only says deploy is no deploy',
      'on: push',
      '  say:\n    steps:\n      - run: echo "deploy done"\n',
      [],
    ],
    [
      "no environment: the job's name says it",
      'on: push',
      '  deploy-staging:\n    steps:\n      - run: npx cdk deploy --all\n',
      ['staging test'],
    ],
    [
      'an environment by name, a deploy action',
      'on: push',
      '  web:\n    environment:\n      name: prod-eu\n    steps:\n      - uses: azure/webapps-deploy@v3\n',
      ['prod-eu prod'],
    ],
  ])('%s', (_, on, jobs, want) => {
    expect(
      mergeDeploysOf(wf(on, jobs), ['.github/workflows/d.yml']).map(
        (d) => `${d.env} ${d.prod ? 'prod' : 'test'}`,
      ),
    ).toEqual(want);
  });

  test('Azure Pipelines: a deployment job when main triggers it', () => {
    const yml =
      'trigger:\n  branches:\n    include: [main]\nstages:\n  - stage: ship\n    jobs:\n      - deployment: ship_prod\n        environment: prod\n';

    expect(
      mergeDeploysOf(new Map([['azure-pipelines.yml', yml]]), ['azure-pipelines.yml']).map((d) => [
        d.job,
        d.env,
        d.prod,
      ]),
    ).toEqual([['ship_prod', 'prod', true]]);
  });
});

describe("deployWorkflowsOf: the workflows the Pipelines overview's Deploys shows", () => {
  const yml = (on: string, jobs: string) => `${on}\njobs:\n${jobs}`;
  const SHIP = '    steps:\n      - run: npm run deploy\n';

  test.each<[string, string, string | null, string | null]>([
    [
      'by hand, its environment',
      'Ship it',
      yml('on: workflow_dispatch', `  go:\n    environment: production\n${SHIP}`),
      'production · any branch',
    ],
    [
      'on a push to main, its job says staging',
      'CD',
      yml('on:\n  push:\n    branches: [main]', `  deploy-staging:\n${SHIP}`),
      'staging · main',
    ],
    [
      'CI that also deploys: its runs on the default branch',
      'CI',
      yml(
        'on: [push, pull_request]',
        `  test:\n    steps:\n      - run: npm test\n  ship:\n    environment: dev\n${SHIP}`,
      ),
      'dev · main',
    ],
    [
      'an environment by name, no deploy command',
      'Smoke',
      yml(
        'on: push',
        '  check:\n    environment:\n      name: test\n    steps:\n      - run: npm run smoke\n',
      ),
      'test · main',
    ],
    [
      'an expression is no environment: its name says it',
      'Deploy Dev/Test',
      yml(
        'on:\n  workflow_dispatch:\n    inputs:\n      env:\n        type: choice',
        `  go:\n    environment: \${{ inputs.env }}\n${SHIP}`,
      ),
      'dev, test · any branch',
    ],
    [
      'jobs to dev, test and prod, in that order',
      'Release',
      yml(
        'on: push',
        `  prod:\n    environment: prod\n${SHIP}  dev:\n    environment: dev\n${SHIP}  test:\n    environment: test\n${SHIP}`,
      ),
      'dev, test, prod · main',
    ],
    [
      'its name alone: deploy and an environment',
      'Deploy Prod',
      yml('on: workflow_dispatch', '  go:\n    steps:\n      - run: ./go.sh\n'),
      'prod · any branch',
    ],
    [
      'a name saying release and no environment is no deploy',
      'Release Drafter',
      yml(
        'on: [push, pull_request]',
        '  draft:\n    steps:\n      - uses: release-drafter/release-drafter@v6\n',
      ),
      null,
    ],
    [
      'pull request checks are no deploy',
      'PR checks',
      yml('on: [pull_request]', '  build:\n    steps:\n      - run: npm test\n'),
      null,
    ],
    [
      'a preview deployed for pull requests only is none',
      'Deploy preview',
      yml('on: pull_request', `  preview:\n    environment: preview\n${SHIP}`),
      null,
    ],
    [
      'a workflow only called by others is none',
      'Deploy reusable',
      yml('on: workflow_call', `  go:\n    environment: prod\n${SHIP}`),
      null,
    ],
    ['not read (Azure): its name alone', 'Deploy Test', null, 'test · any branch'],
    ['not read, no environment named: none', 'Deploy', null, null],
  ])('%s', (_, name, text, want) => {
    const got = deployWorkflowsOf([{ name, file: 'x.yml', text }]).map(
      (d) => `${d.environment ?? '—'} · ${d.defaultBranch ? 'main' : 'any branch'}`,
    );

    expect(got).toEqual(want === null ? [] : [want]);
  });

  test('in order dev → test → prod, others between', () => {
    const named = (name: string) => ({ name, file: '', text: null });

    expect(
      deployWorkflowsOf(
        ['Deploy Prod', 'Deploy Live EU', 'Deploy Staging', 'Deploy Test', 'Deploy Dev'].map(named),
      ).map((d) => d.workflow),
    ).toEqual(['Deploy Dev', 'Deploy Test', 'Deploy Staging', 'Deploy Live EU', 'Deploy Prod']);
  });
});
