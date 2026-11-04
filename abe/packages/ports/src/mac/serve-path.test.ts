/**
 * serve's PATH (#145): the person's login shell read once (a fake shell here), the node managers
 * found on disk (a fake home), and the two merged; a shell that hangs or fails leaves the managers'.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from '@abe/testing';
import {
  foundManagers,
  loginShellPath,
  managerBins,
  nodeThatRuns,
  resolveServePath,
} from './serve-path';

const root = mkdtempSync(join(tmpdir(), 'abe-sp-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A shell that runs `body` (sh) and keeps its argv and environment. */
const shell = (name: string, body: string) => {
  const path = join(root, name);

  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${path}.argv\n/usr/bin/env > ${path}.env\n${body}\n`,
  );
  chmodSync(path, 0o755);

  return path;
};

const home = (name: string, dirs: readonly string[], files: Record<string, string> = {}) => {
  const dir = join(root, name);

  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);

  return dir;
};

describe('loginShellPath', () => {
  test("the shell's PATH as a login, interactive shell prints it, from a clean environment", async () => {
    const sh = shell('zsh', 'printf %s "/home/ada/.volta/bin:$PATH" > "$ABE_PATH_OUT"; echo noise');
    const read = await loginShellPath({
      env: { SHELL: sh, HOME: '/home/ada', USER: 'ada', GITHUB_TOKEN: 'x', PATH: '/x' },
      timeoutMs: 5000,
    });

    expect(read).toEqual({ ok: true, path: '/home/ada/.volta/bin:/usr/bin:/bin:/usr/sbin:/sbin' });
    expect(readFileSync(`${sh}.argv`, 'utf8').split('\n')[0]).toBe('-lic');
    const env = readFileSync(`${sh}.env`, 'utf8');

    expect(env).toContain('HOME=/home/ada\n');
    expect(env).toContain('USER=ada\n');
    expect(env).not.toContain('GITHUB_TOKEN');
  });

  test('a shell that hangs is given up on at its time', async () => {
    const sh = shell('hang', 'echo $$ > "$0.pid"; sleep 30 & exec sleep 30');
    const started = performance.now();
    const read = await loginShellPath({ env: { SHELL: sh, HOME: root }, timeoutMs: 300 });

    expect(read).toEqual({ ok: false, why: `${sh} -lic did not answer within 0.3 s` });
    expect(performance.now() - started).toBeLessThan(3000);
    // What it started went with it: nothing is left in its process group (a killed one is gone
    // once the kernel has taken it, a moment after the kill on a busy Mac).
    const group = readFileSync(`${sh}.pid`, 'utf8').trim();
    const left = () =>
      Bun.spawnSync(['/bin/ps', '-o', 'pid=', '-g', group]).stdout.toString().trim();

    await until('its process group gone', () => (left() === '' ? true : undefined), { ms: 2000 });
  });

  test('a shell that fails says how', async () => {
    const sh = shell('broken', 'echo boom >&2; exit 3');

    expect(await loginShellPath({ env: { SHELL: sh, HOME: root }, timeoutMs: 5000 })).toEqual({
      ok: false,
      why: `${sh} -lic printed no PATH (exit 3)`,
    });
  });
});

describe('the node managers on disk', () => {
  test("each found manager's home and its node's folder; nvm's by its default alias", () => {
    const h = home(
      'h1',
      [
        '.volta/bin',
        '.nvm/versions/node/v20.11.0/bin',
        '.nvm/versions/node/v22.3.0/bin',
        '.nvm/alias',
      ],
      { '.nvm/alias/default': '20\n', '.nvm/nvm.sh': '', '.volta/bin/volta': '' },
    );

    // Each with its own command for the fix: Volta's binary, nvm's script.
    expect(foundManagers({}, h)).toEqual([
      { manager: 'Volta', home: join(h, '.volta'), tool: join(h, '.volta/bin/volta') },
      { manager: 'nvm', home: join(h, '.nvm'), tool: join(h, '.nvm/nvm.sh') },
    ]);
    expect(managerBins({}, h)).toEqual([
      join(h, '.volta/bin'),
      join(h, '.nvm/versions/node/v20.11.0/bin'),
    ]);
  });

  test('a manager whose node folder is not there adds no folder', () => {
    const h = home('h2', ['.local/share/mise', '.asdf/shims']);

    expect(foundManagers({}, h).map((m) => m.manager)).toEqual(['asdf', 'mise']);
    expect(managerBins({}, h)).toEqual([join(h, '.asdf/shims')]);
  });
});

describe('nodeThatRuns', () => {
  test('the node whose --version answers; a shim with no node set, or none, is no node', async () => {
    const good = join(root, 'good');
    const shim = join(root, 'shim');

    mkdirSync(good);
    mkdirSync(shim);
    writeFileSync(join(good, 'node'), '#!/bin/sh\necho v22.11.0\n');
    writeFileSync(join(shim, 'node'), '#!/bin/sh\necho "No version is set" >&2; exit 126\n');
    chmodSync(join(good, 'node'), 0o755);
    chmodSync(join(shim, 'node'), 0o755);

    expect(await nodeThatRuns({ PATH: `${good}:/usr/bin:/bin` })).toBe(join(good, 'node'));
    expect(await nodeThatRuns({ PATH: `${shim}:${good}` })).toBeNull();
    expect(await nodeThatRuns({ PATH: '/nowhere' })).toBeNull();
  });
});

describe('resolveServePath', () => {
  test("the login shell's PATH, then serve's own, then the managers' folders", async () => {
    const h = home('h3', ['.volta/bin']);
    const sh = shell('zsh3', 'printf %s "/opt/homebrew/bin:/usr/bin:/bin" > "$ABE_PATH_OUT"');

    expect(
      await resolveServePath({ env: { SHELL: sh, HOME: h, PATH: '/usr/bin:/bin:/mine' }, home: h }),
    ).toEqual({
      path: `/opt/homebrew/bin:/usr/bin:/bin:/mine:${join(h, '.volta/bin')}`,
      said: `PATH from your login shell (${sh}), with Volta's node`,
    });
  });

  test("no shell read: serve's own and the managers', saying why", async () => {
    const h = home('h4', ['.volta/bin']);
    const sh = shell('broken4', 'exit 1');

    expect(
      await resolveServePath({ env: { SHELL: sh, HOME: h, PATH: '/usr/bin:/bin' }, home: h }),
    ).toEqual({
      path: `/usr/bin:/bin:${join(h, '.volta/bin')}`,
      said: `PATH as serve was started (${sh} -lic printed no PATH (exit 1)), with Volta's node`,
    });
  });
});
