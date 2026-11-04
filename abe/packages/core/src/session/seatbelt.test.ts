/** Rule tables for a local session's jail (ADR 0029): environment access held, the rest open. */
import { describe, expect, test } from 'bun:test';
import {
  HOME_SECRETS,
  homeSecrets,
  jailed,
  jailEnv,
  jailWrapper,
  pathFilters,
  seatbeltProfile,
  sessionBoundary,
  sessionSettings,
  startingMode,
  SUBPROCESS_SCRUB_ENV,
} from '../index';

const spec = {
  denyWrite: ['/s/state', '/r/shop/.abe/settings.local.yaml', '/r/shop/.abe/abe.*.env'],
  denyRead: ['/s/state', '/h/.ssh', '/r/shop/.abe/abe.prod.env'],
  allowRead: ['/s/state/bin', '/s/state/sessions/4'],
  sockets: ['/s/state/sessions/4/session.sock'],
};

describe("a session's Seatbelt profile: what its commands may do", () => {
  const profile = seatbeltProfile(spec).split('\n');
  const at = (line: string) => profile.indexOf(line);

  test.each<[string, string]>([
    ['everything else is allowed: writes, sockets, the network', '(allow default)'],
    [
      'never what decides its reach nor Abe state written, a glob as a regex',
      '(deny file-write* (literal "/s/state") (subpath "/s/state") (literal "/r/shop/.abe/settings.local.yaml") (subpath "/r/shop/.abe/settings.local.yaml") (regex "^/r/shop/\\\\.abe/abe\\\\.[^/]*\\\\.env(/.*)?$"))',
    ],
    [
      'never reads Abe state, a secret, an Abe env file off',
      '(deny file-read* (literal "/s/state") (subpath "/s/state") (literal "/h/.ssh") (subpath "/h/.ssh") (literal "/r/shop/.abe/abe.prod.env") (subpath "/r/shop/.abe/abe.prod.env"))',
    ],
    [
      'but its own folder and abe',
      '(allow file-read* (literal "/s/state/bin") (subpath "/s/state/bin") (literal "/s/state/sessions/4") (subpath "/s/state/sessions/4"))',
    ],
    [
      "no socket under what it never reads: serve's, tmux's, another session's",
      '(deny network-outbound (remote unix-socket (subpath "/s/state")))',
    ],
    [
      'but its own session socket',
      '(allow network-outbound (remote unix-socket (path-literal "/s/state/sessions/4/session.sock")))',
    ],
    [
      'no Keychain',
      '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.SecurityServer") (global-name "com.apple.security.agent") (global-name "com.apple.secd"))',
    ],
  ])('%s', (_, line) => {
    expect(at(line)).toBeGreaterThan(-1);
  });

  test('no write jail and no blanket socket deny: writes and other sockets open', () => {
    expect(profile.filter((l) => l.includes('(subpath "/")'))).toEqual([]);
    expect(profile.filter((l) => l.startsWith('(allow file-write*'))).toEqual([]);
    expect(profile).not.toContain('(deny network-outbound (remote unix-socket))');
  });

  test('later rules win: the allows after the denies they narrow', () => {
    expect(profile.findIndex((l) => l.startsWith('(deny file-read*'))).toBeLessThan(
      profile.findIndex((l) => l.startsWith('(allow file-read*')),
    );
    expect(
      profile.findIndex((l) => l.startsWith('(deny network-outbound (remote unix-socket')),
    ).toBeLessThan(profile.findIndex((l) => l.startsWith('(allow network-outbound')));
  });

  test('no network rule but the sockets: outbound open, raw TCP and ssh too', () => {
    expect(profile.filter((l) => l.includes('network') && !l.includes('unix-socket'))).toEqual([]);
  });

  test.each<[string, string, string[]]>([
    ['a path: itself and under it', '/a b/c', ['(literal "/a b/c")', '(subpath "/a b/c")']],
    ['`*` within a folder', '/a/*/x', ['(regex "^/a/[^/]*/x(/.*)?$")']],
    ['`**` any depth', '/a/**/hooks', ['(regex "^/a/(.*/)?hooks(/.*)?$")']],
  ])('%s', (_, path, want) => {
    expect(pathFilters(path)).toEqual(want);
  });

  test("the wrapper runs Claude Code's whole command line under the profile, in its shell", () => {
    expect(jailWrapper('/s/state/sessions/4/jail.sb').split('\n').at(-2)).toBe(
      'exec /usr/bin/sandbox-exec -f "/s/state/sessions/4/jail.sb" "$shell" -c "$1"',
    );
  });
});

describe("a jailed session's settings: Claude Code's sandbox off, every Bash command allowed, the denies kept", () => {
  const boundary = sessionBoundary({
    state: '/s/state',
    serveSocket: '/s/state/s.sock',
    plugins: '/s/cache/plugins',
    socket: '/s/state/sessions/4/session.sock',
    checkout: '/r/shop',
    home: '/h',
    worktree: '/r/shop-wt/4',
    secrets: homeSecrets('/h', '/h/work-az'),
  });
  const settings = sessionSettings({
    abe: '/s/state/bin/abe',
    models: { coordinator: 'opus', reader: 'haiku', writer: 'sonnet' },
    allowedModels: ['opus', 'sonnet', 'haiku'],
    allow: ['Bash(abe card show:*)'],
    boundary,
    skillsOnTop: false,
    home: '/h',
    mode: 'auto',
  });
  const jail = jailed(settings);

  test('its settings', () => {
    expect(jail?.settings.sandbox).toEqual({ enabled: false });
    expect(jail?.settings.permissions?.allow).toEqual(['Bash(abe card show:*)', 'Bash']);
    expect(jail?.settings.permissions?.deny).toEqual(settings.permissions?.deny);
    expect(jail?.settings.permissions?.defaultMode).toBe('auto');
  });

  test.each<[string, boolean]>([
    ['/h/.ssh', true],
    ['/h/.aws', true],
    ['/h/work-az', true],
    ['/h/.claude.json', true],
    ['/h/Library/Keychains', true],
    ['/s/state', true],
  ])('%s: never read by its commands, nor its file tools', (path, denied) => {
    expect(jail?.profile.includes(`(literal "${path}")`)).toBe(denied);
    expect(
      settings.permissions?.deny?.includes(`Read(/${path})`) === true || path === '/s/state',
    ).toBe(denied);
  });

  test.each<[string, string]>([
    ["the repo's settings", '/r/shop/abe.yaml'],
    ['your own settings, in the checkout', '/r/shop/.abe/settings.local.yaml'],
    ['your own settings, in its worktree', '/r/shop-wt/4/.abe/settings.local.yaml'],
    ['Abe state', '/s/state'],
    ["core's plugin", '/s/cache/plugins'],
  ])('%s: never written by its commands, nor its file tools', (_, path) => {
    const writes = jail?.profile.split('\n').find((l) => l.startsWith('(deny file-write*')) ?? '';

    expect(writes).toContain(`(literal "${path}")`);
  });

  test('every Abe env file never written, in the checkout and its worktree (a glob)', () => {
    expect(jail?.profile).toContain('(regex "^/r/shop/\\\\.abe/abe\\\\.[^/]*\\\\.env(/.*)?$")');
    expect(jail?.profile).toContain(
      '(regex "^/r/shop-wt/4/\\\\.abe/abe\\\\.[^/]*\\\\.env(/.*)?$")',
    );
    expect(settings.permissions?.deny).toContain('Edit(//r/shop/.abe/settings.local.yaml)');
    expect(settings.permissions?.deny).toContain('Edit(//r/shop/.abe/abe.*.env)');
    // the file tools that write a new file too, by name (ADR 0029)
  });

  test('it starts in the mode Abe launches it with, auto: no SUBPROCESS_SCRUB_ENV, which Claude Code starts in default', () => {
    const env = jailEnv({ HOME: '/h', PATH: '/bin' }, '/s/state/sessions/4/jail.sh');

    expect(env).toEqual({
      HOME: '/h',
      PATH: '/bin',
      CLAUDE_CODE_SHELL_PREFIX: '/s/state/sessions/4/jail.sh',
    });
    expect(jail === undefined ? undefined : startingMode(jail.settings, env)).toBe('auto');
    expect(
      jail === undefined
        ? undefined
        : startingMode(jail.settings, { ...env, [SUBPROCESS_SCRUB_ENV]: '1' }),
    ).toBe('default');
  });

  test("its writers' worktrees are working folders: no ask per path in one", () => {
    expect(jail?.settings.permissions?.additionalDirectories).toEqual([
      '/r/shop/.claude/worktrees',
    ]);
  });

  test('every secret of HOME', () => {
    expect(homeSecrets('/h')).toEqual(HOME_SECRETS.map((p) => `/h/${p}`));
  });

  test('a box session, no sandbox of ours: no jail', () => {
    expect(jailed({ permissions: { allow: [] } })).toBeUndefined();
  });
});
