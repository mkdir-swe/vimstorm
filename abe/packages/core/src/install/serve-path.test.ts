/** serve's PATH and the node managers (#145): the login shell's PATH first, managers named, their fixes. */
import { describe, expect, test } from 'bun:test';
import {
  managerOf,
  nodeAtLaunch,
  nodeFix,
  nodeNeeded,
  nodePlaces,
  type NodeManager,
  nvmBin,
  servePath,
} from './serve-path';

const HOME = '/home/ada';

describe('servePath', () => {
  test("the login shell's PATH first, then serve's own, then the managers' folders, each once", () => {
    expect(
      servePath({
        login: '/home/ada/.volta/bin:/opt/homebrew/bin:/usr/bin:/bin',
        inherited: '/home/ada/.local/bin:/opt/homebrew/bin:/usr/bin:/bin',
        managers: ['/home/ada/.volta/bin', '/home/ada/.local/share/mise/shims'],
      }),
    ).toBe(
      '/home/ada/.volta/bin:/opt/homebrew/bin:/usr/bin:/bin:/home/ada/.local/bin:/home/ada/.local/share/mise/shims',
    );
  });

  test("no login PATH read: serve's own, then the managers' folders; empty parts dropped", () => {
    expect(
      servePath({
        login: null,
        inherited: '/usr/bin::/bin:',
        managers: ['/home/ada/.volta/bin'],
      }),
    ).toBe('/usr/bin:/bin:/home/ada/.volta/bin');
  });
});

describe('nodePlaces', () => {
  test("each manager's own variable, else its default folders", () => {
    expect(nodePlaces({}, HOME)).toEqual([
      { manager: 'Volta', homes: ['/home/ada/.volta'], bin: 'bin' },
      { manager: 'nvm', homes: ['/home/ada/.nvm'], bin: null },
      {
        manager: 'fnm',
        homes: [
          '/home/ada/.local/share/fnm',
          '/home/ada/Library/Application Support/fnm',
          '/home/ada/.fnm',
        ],
        bin: 'aliases/default/bin',
      },
      { manager: 'asdf', homes: ['/home/ada/.asdf'], bin: 'shims' },
      { manager: 'mise', homes: ['/home/ada/.local/share/mise'], bin: 'shims' },
    ]);
    expect(
      nodePlaces({ VOLTA_HOME: '/opt/volta', NVM_DIR: '/n', MISE_DATA_DIR: '' }, HOME)
        .filter((p) => p.manager !== 'fnm' && p.manager !== 'asdf')
        .map((p) => p.homes),
    ).toEqual([['/opt/volta'], ['/n'], ['/home/ada/.local/share/mise']]);
  });
});

describe('nvmBin', () => {
  const versions = ['v18.20.4', 'v20.11.0', 'v22.3.0', 'v22.12.0'];

  test("the default alias's newest match, else the newest installed", () => {
    expect(nvmBin('/n', '20\n', versions)).toBe('/n/versions/node/v20.11.0/bin');
    expect(nvmBin('/n', 'v22.3.0', versions)).toBe('/n/versions/node/v22.3.0/bin');
    expect(nvmBin('/n', '22', versions)).toBe('/n/versions/node/v22.12.0/bin');
    expect(nvmBin('/n', 'lts/*', versions)).toBe('/n/versions/node/v22.12.0/bin');
    expect(nvmBin('/n', null, versions)).toBe('/n/versions/node/v22.12.0/bin');
    expect(nvmBin('/n', '16', versions)).toBe('/n/versions/node/v22.12.0/bin');
    expect(nvmBin('/n', null, [])).toBeNull();
  });
});

describe('managerOf', () => {
  const found = [
    { manager: 'Volta' as const, home: '/home/ada/.volta' },
    { manager: 'nvm' as const, home: '/home/ada/.nvm' },
  ];

  test('the manager whose folder a node is in; Homebrew by its prefix; else none', () => {
    expect(managerOf('/home/ada/.volta/bin/node', found)).toBe('Volta');
    expect(managerOf('/home/ada/.nvm/versions/node/v22.3.0/bin/node', found)).toBe('nvm');
    expect(managerOf('/opt/homebrew/bin/node', found)).toBe('Homebrew');
    expect(managerOf('/usr/local/bin/node', found)).toBeNull();
    expect(managerOf('/home/ada/.voltage/bin/node', found)).toBeNull();
  });
});

describe('nodeFix', () => {
  test("the first manager found installs node, by its own command when found; none: Homebrew's", () => {
    const at = (manager: NodeManager, tool?: string) => ({
      manager,
      home: `${HOME}/.x`,
      ...(tool === undefined ? {} : { tool }),
    });

    // A login shell that read no .zshrc may have no `volta` or `nvm`: their own files run.
    expect(nodeFix([at('Volta', `${HOME}/.volta/bin/volta`), at('nvm')])).toBe(
      '/home/ada/.volta/bin/volta install node',
    );
    // Homebrew's Volta: no binary in its home, called by name.
    expect(nodeFix([at('Volta')])).toBe('volta install node');
    expect(nodeFix([at('Volta', '/home/a b/.volta/bin/volta')])).toBe(
      "'/home/a b/.volta/bin/volta' install node",
    );
    expect(nodeFix([at('nvm', '/opt/homebrew/opt/nvm/nvm.sh')])).toBe(
      '. /opt/homebrew/opt/nvm/nvm.sh && nvm install --lts',
    );
    expect(nodeFix([at('nvm')])).toBe('nvm install --lts');
    expect(nodeFix([at('fnm')])).toBe('fnm install --lts && fnm default lts-latest');
    expect(nodeFix([at('asdf')])).toBe(
      'asdf plugin add nodejs; asdf install nodejs latest && asdf set -u nodejs latest',
    );
    expect(nodeFix([at('mise')])).toBe('mise use -g node@lts');
    expect(nodeFix([])).toBe('brew install node');
  });
});

describe('nodeNeeded', () => {
  test('a repo with a package.json, or a setup that runs a node tool', () => {
    const repo = { packageJson: false, bunLock: false };

    expect(nodeNeeded({ ...repo, packageJson: true, setup: null })).toBe(true);
    expect(nodeNeeded({ ...repo, setup: 'npm ci' })).toBe(true);
    expect(nodeNeeded({ ...repo, setup: 'make deps && pnpm i' })).toBe(true);
    expect(nodeNeeded({ ...repo, setup: 'pip install -r requirements.txt' })).toBe(false);
    expect(nodeNeeded({ ...repo, setup: null })).toBe(false);
    // A Bun repo's package.json is Bun's, unless its setup runs a node tool.
    expect(nodeNeeded({ packageJson: true, bunLock: true, setup: 'bun install' })).toBe(false);
    expect(nodeNeeded({ packageJson: true, bunLock: true, setup: 'npm ci' })).toBe(true);
  });
});

describe('nodeAtLaunch', () => {
  test('node missing where the repo needs it: refused before anything starts, with the fix', () => {
    expect(
      nodeAtLaunch({
        packageJson: true,
        bunLock: false,
        setup: 'npm ci',
        node: null,
        managers: [{ manager: 'Volta', home: `${HOME}/.volta`, tool: `${HOME}/.volta/bin/volta` }],
        path: '/s/bin:/usr/bin:/bin',
      }),
    ).toEqual({
      code: 'no-node',
      message:
        "no node runs on the session's PATH (/s/bin:/usr/bin:/bin), and this repo needs it (package.json, setup `npm ci`): its setup and checks would fail. Volta is installed but has no node: /home/ada/.volta/bin/volta install node, then launch again (abe tools check shows what serve finds)",
    });
    expect(
      nodeAtLaunch({
        packageJson: true,
        bunLock: false,
        setup: null,
        node: null,
        managers: [],
        path: '/usr/bin',
      }),
    ).toMatchObject({
      message:
        "no node runs on the session's PATH (/usr/bin), and this repo needs it (package.json): its setup and checks would fail. brew install node, then launch again (abe tools check shows what serve finds)",
    });
  });

  test('node found, or a repo that needs none: nothing to say', () => {
    const base = { setup: 'npm ci', bunLock: false, managers: [], path: '/usr/bin' };

    expect(nodeAtLaunch({ ...base, packageJson: true, node: '/usr/bin/node' })).toBeNull();
    expect(nodeAtLaunch({ ...base, packageJson: false, setup: null, node: null })).toBeNull();
  });
});
