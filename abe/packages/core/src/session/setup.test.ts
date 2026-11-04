import { describe, expect, test } from 'bun:test';
import {
  ciCommand,
  ciNodeOptions,
  installCommand,
  manifestPaths,
  nodeModulesTops,
  type Lockfile,
  type RegistryConfig,
  registryAllows,
  registryHosts,
  SetupRan,
  setupAfterLink,
  setupReason,
  setupText,
} from './setup';

const ran = (o: Partial<SetupRan> & { run: string; exit: number | null }): SetupRan =>
  SetupRan.parse({ output: '', ...o });

describe("setupReason: a new worktree's setup that failed is Needs you with its output", () => {
  test.each<[string, SetupRan, string | null]>([
    ['it passed', ran({ run: 'npm ci', exit: 0, output: 'added 120 packages\n' }), null],
    [
      'it failed: the command, its exit and its output',
      ran({
        run: 'npm ci',
        exit: 1,
        output: 'npm error code EUSAGE\nnpm error lockfile missing\n',
      }),
      "the repo's setup `npm ci` failed (exit 1) in the new worktree:\nnpm error code EUSAGE\nnpm error lockfile missing",
    ],
    [
      'only the end of a long output',
      ran({
        run: 'make deps',
        exit: 2,
        output: `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')}\n`,
      }),
      `the repo's setup \`make deps\` failed (exit 2) in the new worktree:\n${Array.from({ length: 20 }, (_, i) => `line ${i + 11}`).join('\n')}`,
    ],
    ['packages linked: nothing failed', ran({ run: '', exit: 0, how: 'linked', from: '/r' }), null],
    [
      "the main checkout's team files not all put in: which, and why",
      ran({
        run: '',
        exit: 0,
        how: 'linked',
        from: '/r',
        copied: ['.abe/abe.dev.env'],
        notCopied: { 'abe.yaml': 'not put in', '.claude/skills': 'EACCES: permission denied' },
      }),
      "the new worktree did not get the main checkout's abe.yaml (not put in), .claude/skills (EACCES: permission denied): its next start puts them in again, or copy them in by hand",
    ],
  ])('%s', (_, setup, reason) => {
    expect(setupReason(setup)).toBe(reason);
  });
});

describe('the setup line: what was done in the worktree before claude started', () => {
  test.each<[string, SetupRan, string]>([
    [
      'linked from the main checkout, env files copied',
      ran({ run: '', exit: 0, how: 'linked', from: '/r/shop', copied: ['.env.test'] }),
      'packages linked from /r/shop (the same lockfile) · copied .env.test',
    ],
    [
      'linked, then the setup’s other steps',
      ran({ run: 'npm run codegen', exit: 0, how: 'linked', from: '/r/shop' }),
      'packages linked from /r/shop (the same lockfile), then npm run codegen (network: the package registries only): passed',
    ],
    [
      'the lockfile changed: its install, on the registries alone',
      ran({ run: 'npm ci', exit: 0 }),
      'npm ci (network: the package registries only): passed',
    ],
    [
      'it failed',
      ran({ run: 'npm ci', exit: 1, copied: ['.abe'] }),
      'npm ci (network: the package registries only): failed (exit 1) · copied .abe',
    ],
    [
      "a prototype's: cloned from the main checkout",
      ran({ run: '', exit: 0, how: 'cloned', from: '/r/shop' }),
      'packages cloned from /r/shop (copy on write)',
    ],
    [
      "a prototype's whose manifests differ: cloned, then the install",
      ran({ run: 'npm install', exit: 0, how: 'cloned', from: '/r/shop' }),
      'packages cloned from /r/shop (copy on write), then npm install (network: the package registries only): passed',
    ],
    [
      'nothing to install, files copied',
      ran({ run: '', exit: 0, how: 'none', copied: ['web/.env.local'] }),
      'copied web/.env.local',
    ],
    [
      'some not put in: said, never silent',
      ran({
        run: '',
        exit: 0,
        how: 'linked',
        from: '/r/shop',
        copied: ['.abe/abe.dev.env'],
        notCopied: { 'abe.yaml': 'not put in' },
      }),
      'packages linked from /r/shop (the same lockfile) · copied .abe/abe.dev.env · not copied: abe.yaml (not put in)',
    ],
  ])('%s', (_, setup, line) => {
    expect(setupText(setup)).toBe(line);
  });
});

describe("the setup's steps after its packages are linked: all but the install", () => {
  test.each<[string, string, string | null]>([
    ['the install alone', 'npm ci', null],
    ['then codegen', 'npm ci && npm run codegen', 'npm run codegen'],
    [
      'each manager, its flags, a step before',
      'corepack enable; pnpm install --frozen-lockfile && pnpm -r build:types',
      'corepack enable && pnpm -r build:types',
    ],
    ['lines', 'yarn install --immutable\nyarn prisma generate\n', 'yarn prisma generate'],
    ['yarn bare', 'yarn && yarn gen', 'yarn gen'],
    ['bun', 'bun i && bun run gen', 'bun run gen'],
    ['an install with a fallback', 'npm ci || npm install && make gen', 'make gen'],
    ["a quoted '&&' stays in its step", "npm ci && echo 'a && b' > x", "echo 'a && b' > x"],
    ['no install in it: all of it', 'make bootstrap', 'make bootstrap'],
    ['npm run is no install', 'npm run setup', 'npm run setup'],
  ])('%s', (_, setup, after) => {
    expect(setupAfterLink(setup)).toBe(after);
  });
});

describe("a lockfile's own install, as CI runs it", () => {
  test.each<[Lockfile, boolean, string]>([
    ['package-lock.json', false, 'npm ci'],
    ['npm-shrinkwrap.json', false, 'npm ci'],
    ['pnpm-lock.yaml', false, 'pnpm install --frozen-lockfile'],
    ['yarn.lock', false, 'yarn install --frozen-lockfile'],
    ['yarn.lock', true, 'yarn install --immutable'],
    ['bun.lock', false, 'bun install --frozen-lockfile'],
    ['bun.lockb', false, 'bun install --frozen-lockfile'],
  ])('%s (yarn 2+: %p): %s', (lock, berry, command) => {
    expect(ciCommand(lock, berry)).toBe(command);
  });
});

describe("a prototype's install over its cloned packages: the manifests', never frozen", () => {
  test.each<[Lockfile, boolean, string]>([
    ['package-lock.json', false, 'npm install'],
    ['pnpm-lock.yaml', false, 'pnpm install'],
    ['yarn.lock', false, 'yarn install --non-interactive'],
    ['yarn.lock', true, 'yarn install'],
    ['bun.lock', false, 'bun install'],
  ])('%s (yarn 2+: %p): %s', (lock, berry, command) => {
    expect(installCommand(lock, berry)).toBe(command);
  });
});

describe("the node_modules a prototype clones: the main checkout's, none inside another", () => {
  test.each<[string, string[], string[]]>([
    ['the top alone', ['node_modules/', '.env', 'dist/'], ['node_modules']],
    [
      "each workspace's, sorted",
      ['web/apps/shop/node_modules/', 'node_modules/', 'api/node_modules/'],
      ['api/node_modules', 'node_modules', 'web/apps/shop/node_modules'],
    ],
    [
      "a package's own nested one comes with its folder",
      ['node_modules/', 'node_modules/left-pad/node_modules/'],
      ['node_modules'],
    ],
    ['a folder only named like it', ['node_modules_old/', 'my-node_modules/'], []],
    ['none', [''], []],
  ])('%s', (_, ignored, tops) => {
    expect(nodeModulesTops(ignored)).toEqual(tops);
  });

  test("the manifests: each tracked package.json and the lockfiles beside it, never node_modules'", () => {
    expect(
      manifestPaths(['package.json', 'web/package.json', 'node_modules/x/package.json']),
    ).toEqual(
      [
        'package.json',
        'package-lock.json',
        'npm-shrinkwrap.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'bun.lock',
        'bun.lockb',
      ]
        .flatMap((f) => [f, `web/${f}`])
        .sort(),
    );
  });
});

describe('the registries a setup reaches: the public ones and those the configs name', () => {
  const PUBLIC = [
    'registry.npmjs.org',
    'registry.yarnpkg.com',
    'repo.yarnpkg.com',
    'pypi.org',
    'files.pythonhosted.org',
  ];

  test.each<[string, { file: RegistryConfig; text: string }[], string[]]>([
    ['no config: the public ones', [], PUBLIC],
    [
      "npm's registry and a scope's, a token line naming none",
      [
        {
          file: '.npmrc',
          text: 'registry=https://npm.acme.dev/\n@acme:registry=https://pkgs.dev.azure.com/acme/_packaging/feed/npm/registry/\n//npm.acme.dev/:_authToken=${NPM_TOKEN}\n',
        },
      ],
      [...PUBLIC, 'npm.acme.dev', 'pkgs.dev.azure.com'],
    ],
    [
      "yarn 2+'s server and a scope's",
      [
        {
          file: '.yarnrc.yml',
          text: 'npmRegistryServer: "https://yarn.acme.dev"\nnpmScopes:\n  acme:\n    npmRegistryServer: https://npm.pkg.github.com\n',
        },
      ],
      [...PUBLIC, 'yarn.acme.dev', 'npm.pkg.github.com'],
    ],
    [
      "yarn 1's and bun's",
      [
        { file: '.yarnrc', text: 'registry "https://y1.acme.dev/"\n' },
        {
          file: 'bunfig.toml',
          text: '[install]\nregistry = "https://bun.acme.dev/"\n[install.scopes]\nacme = { url = "https://scoped.acme.dev/" }\n',
        },
      ],
      [...PUBLIC, 'y1.acme.dev', 'bun.acme.dev', 'scoped.acme.dev'],
    ],
    [
      'a comment names none',
      [{ file: '.npmrc', text: '# registry=https://old.acme.dev/\n' }],
      PUBLIC,
    ],
  ])('%s', (_, configs, hosts) => {
    expect(registryHosts(configs)).toEqual(hosts);
  });

  test.each<[string, boolean]>([
    ['registry.npmjs.org', true],
    ['REGISTRY.npmjs.org', true],
    ['npm.acme.dev', true],
    ['a.mirror.acme.dev', true],
    ['mirror.acme.dev', false],
    ['github.com', false],
    ['registry.npmjs.org.evil.dev', false],
  ])('%s reached: %p', (host, reached) => {
    expect(registryAllows(['registry.npmjs.org', 'npm.acme.dev', '*.mirror.acme.dev'], host)).toBe(
      reached,
    );
  });
});

describe("the checks' NODE_OPTIONS: the memory the repo's CI gives", () => {
  test.each<[string, { path: string; text: string }[], string | null]>([
    ['no CI', [], null],
    [
      "a workflow's env",
      [
        {
          path: '.github/workflows/ci.yml',
          text: 'jobs:\n  test:\n    env:\n      NODE_OPTIONS: --max-old-space-size=8192\n    steps:\n      - run: npm test\n',
        },
      ],
      '--max-old-space-size=8192',
    ],
    [
      'quoted, with a comment',
      [
        {
          path: '.github/workflows/ci.yaml',
          text: 'env:\n  NODE_OPTIONS: "--max-old-space-size=6144" # vitest\n',
        },
      ],
      '--max-old-space-size=6144',
    ],
    [
      'before a command in a step',
      [
        {
          path: '.github/workflows/test.yml',
          text: '      - run: NODE_OPTIONS=--max-old-space-size=4096 npx vitest run\n',
        },
      ],
      '--max-old-space-size=4096',
    ],
    [
      "Azure's name and value",
      [
        {
          path: 'azure-pipelines.yml',
          text: 'variables:\n  - name: NODE_OPTIONS\n    value: --max_old_space_size=12288\n',
        },
      ],
      '--max_old_space_size=12288',
    ],
    [
      'of several, the most heap',
      [
        {
          path: '.github/workflows/a.yml',
          text: 'env:\n  NODE_OPTIONS: --max-old-space-size=2048\n',
        },
        { path: '.gitlab-ci.yml', text: 'variables:\n  NODE_OPTIONS: --max-old-space-size=7168\n' },
      ],
      '--max-old-space-size=7168',
    ],
    [
      'computed by CI: not read',
      [
        {
          path: '.github/workflows/ci.yml',
          text: 'env:\n  NODE_OPTIONS: ${{ vars.NODE_OPTIONS }}\n',
        },
      ],
      null,
    ],
    [
      'a file that is no CI file',
      [{ path: 'docs/ci.yml', text: 'NODE_OPTIONS: --max-old-space-size=9000\n' }],
      null,
    ],
  ])('%s', (_, files, options) => {
    expect(ciNodeOptions(files)).toBe(options);
  });
});
