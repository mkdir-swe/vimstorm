import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOX_HIDDEN,
  boxJailScript,
  boxSessionEnv,
  boxSessionSettings,
  boxSessionSocket,
  CONTAINER,
  CONTAINER_SECRETS,
  gitAuthor,
  isWorkspaceSessionSocket,
  managedSettings,
  sessionDirAccess,
} from './box-session';
import { HOOK_EVENTS } from '../session/session';

const base = {
  socket: '/run/abe/s/4-a1b2/session.sock',
  inherited: {
    DATABASE_URL: 'postgres://w:p@abe-pg:5432/workspace',
    ABE_WORKSPACE: '4',
    OTHER: 'x',
  },
  claudeLogin: 'fake-claude-login',
};

describe('boxSessionEnv', () => {
  test('the allowlist, the image switches, the container database, Reach and the login only', () => {
    const env = boxSessionEnv({
      ...base,
      reach: { ABE_AWS_READ_TEST: 'abe-read-test', ABE_AWS_WRITE_TEST: 'abe-write-test' },
      granted: ['ABE_AWS_WRITE_TEST'],
    });

    expect(env).toEqual({
      ok: true,
      env: {
        HOME: '/home/abe',
        USER: 'abe',
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        TERM: 'xterm-256color',
        LANG: 'C.UTF-8',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CHROME_PATH: '/usr/bin/chromium',
        DATABASE_URL: 'postgres://w:p@abe-pg:5432/workspace',
        ABE_WORKSPACE: '4',
        ABE_AWS_READ_TEST: 'abe-read-test',
        ABE_AWS_WRITE_TEST: 'abe-write-test',
        CLAUDE_CODE_OAUTH_TOKEN: 'fake-claude-login',
        ABE_SOCKET: '/run/abe/s/4-a1b2/session.sock',
      },
    });
  });

  test.each([
    ['AWS_CONFIG_FILE', '/home/abe/.abe/logins/aws/.aws/config'],
    ['AWS_SHARED_CREDENTIALS_FILE', '/home/abe/.abe/logins/aws/.aws/credentials'],
    ['HOME', '/home/abe/.abe/logins/aws'],
  ])("a session's env never points at your restored aws login: %s", (name, value) => {
    const env = boxSessionEnv({
      ...base,
      inherited: { ...base.inherited, [name]: value },
      reach: {},
      granted: [],
    });

    expect(env.ok && Object.values(env.env).some((v) => v.includes('.abe/logins'))).toBe(false);
  });

  test.each([
    [{ ABE_AWS_WRITE_PROD: 'abe-write-prod' }, 'write-name'],
    [{ AWS_PROFILE: 'admin' }, 'not-reach'],
    // The ABE_ prefix alone is no Reach name: only the four fixed shapes are.
    [{ ABE_SOCKET: '/tmp/other.sock' }, 'not-reach'],
    [{ ABE_AWS_READ_test: 'abe-read-test' }, 'not-reach'],
  ])('%j is refused (%s)', (reach, code) => {
    expect(boxSessionEnv({ ...base, reach, granted: [] })).toMatchObject({ ok: false, code });
  });
});

const jail = boxJailScript();

/** The jail keeps `path` from a command: hidden, a session socket not its own, another /proc. */
const jailHides = (path: string) =>
  BOX_HIDDEN.some((h) => path === h || path.startsWith(`${h}/`)) ||
  path.startsWith('/run/abe/s/') ||
  path.startsWith('/proc/');

describe('managedSettings', () => {
  const m = managedSettings({
    abe: 'abe',
    allowedModels: ['sonnet', 'haiku'],
    allow: ['Bash(abe status:*)'],
    awsRegions: ['eu-west-1', 'eu-north-1', 'eu-west-1'],
  });

  test('only the managed hooks and permission rules count: a settings file the agent writes adds none', () => {
    expect(m.allowManagedHooksOnly).toBe(true);
    expect(m.allowManagedPermissionRulesOnly).toBe(true);
    // So the allow rules a session's own --settings would give are here: the in-session abe
    // commands (`abe run` among them: the pack's scripts leave the sandbox only through serve).
    // and every command without asking: its jail holds it (ADR 0029)
    expect(m.permissions?.allow).toEqual(['Bash(abe status:*)', 'Bash']);
    // Nor do project settings the file tools write; a command writes them, and they add nothing.
    for (const rule of ['Edit(**/.claude/settings.json)', 'Edit(**/.claude/settings.local.json)'])
      expect(m.permissions?.deny).toContain(rule);
  });

  test('the jail: writes open but what decides its reach, read-only by its paths in each tree (no glob on Linux)', () => {
    expect(jail).toContain("for t in '/workspace/repo' '/workspace/repo-base'; do");
    for (const file of [
      'abe.yaml',
      '.abe/settings.local.yaml',
      '.abe/abe.dev.env',
      '.abe/abe.test.env',
      '.abe/abe.prod.env',
    ])
      expect(jail).toContain(`"$t"/'${file}'`);
    // a missing one made by no command: an empty mount point, read-only (`--ro-bind-try` skips it)
    expect(jail).toContain(
      'if [ -e "$f" ]; then set -- "$@" --ro-bind "$f" "$f"; else set -- "$@" --ro-bind /dev/null "$f"; fi',
    );
    expect(jail).not.toContain('--ro-bind-try');
    expect(jail).not.toContain('--ro-bind / /');
    expect(jail).not.toContain('.claude/settings');
  });

  test("the file tools write none of what decides its reach, there or not, by the container's paths", () => {
    const deny = m.permissions?.deny ?? [];

    for (const tree of ['/workspace/repo', '/workspace/repo-base'])
      for (const file of [
        'abe.yaml',
        '.abe/settings.local.yaml',
        '.abe/abe.dev.env',
        '.abe/abe.test.env',
        '.abe/abe.prod.env',
      ])
        for (const tool of ['Edit']) expect(deny).toContain(`${tool}(/${tree}/${file})`);
    // an off environment's files are its launch's (`accessRules`): none read here by default
    expect(deny.join(' ')).not.toContain('Read(//workspace/repo/');
  });

  test("the jail hides an off environment's files given it, after their read-only binds", () => {
    const off = boxJailScript({
      off: ['/workspace/repo/.abe/abe.prod.env', '/workspace/repo/.env.production'],
    });
    const loop = off.split('\n').find((l) => l.startsWith('for p in ')) ?? '';

    expect(loop).toContain("'/workspace/repo/.abe/abe.prod.env' '/workspace/repo/.env.production'");
    expect(off.indexOf('for p in ')).toBeGreaterThan(off.indexOf('for t in '));
    // none given: only the secrets
    expect(jail).not.toContain("'/workspace/repo/.abe/abe.prod.env'");
  });

  test("a box session's own gh merges nothing: gh works there, and a person merges (#196)", () => {
    expect(m.permissions?.deny).toContain('Bash(gh pr merge:*)');
    expect(m.permissions?.deny).toContain('Bash(gh api *pulls/*/merge*)');
  });

  test("the session's variables file (its Claude login, briefly) is denied like the credential files", () => {
    // The file tools the files; commands the whole folder (no glob on Linux).
    expect(m.permissions?.deny).toContain('Read(~/.abe/sessions/*/env)');
    expect(jailHides('/home/abe/.abe/sessions/9-other/env')).toBe(true);
  });

  test("Claude Code's sandbox off: each command in Abe's jail, the network open, no bubblewrap of Claude Code's around it", () => {
    // Claude Code's credential scrub runs each command in a bubblewrap that forbids further user
    // namespaces on Linux: the jail's bubblewrap inside it could not start. The jail unsets the login.
    expect(m.sandbox).toEqual({ enabled: false });
    expect(m.env).toEqual({ CLAUDE_CODE_SHELL_PREFIX: '/etc/claude-code/abe-jail.sh' });
  });

  test('hooks for every event, on the session socket through abe hook', () => {
    expect(Object.keys(m.hooks ?? {})).toEqual([...HOOK_EVENTS]);
    expect(m.hooks?.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'abe hook Stop', timeout: 5 }] },
    ]);
  });

  // ADR 0029: bubblewrap around each command line, the network shared (outbound open; the
  // container publishes no port), secrets and other sockets hidden, its own pid namespace
  test.each<[string, string]>([
    ['the whole command line, again by a shell', 'cmd=$1'],
    ['its own pid namespace and /proc: no other process', '--unshare-pid'],
    ['the root written, as its user may', '--bind / /'],
    ['the session sockets hidden but its own', '--tmpfs \'/run/abe/s\' --bind-try "$own" "$own"'],
    ["Claude Code's login unset, bwrap's own too", 'unset CLAUDE_CODE_OAUTH_TOKEN\nexec bwrap'],
    ['a secret folder under an empty tmpfs', 'if [ -d "$p" ]; then set -- "$@" --tmpfs "$p"'],
  ])('the jail: %s', (_, line) => {
    expect(jail).toContain(line);
  });

  test("the jail: bwrap, pid 1 in it, holds no login either (its /proc/1/environ is the command's to read)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'abe-jail-'));

    try {
      writeFileSync(join(dir, 'jail.sh'), jail, { mode: 0o755 });
      // A stand-in bwrap: its own environment and its argv.
      writeFileSync(
        join(dir, 'bwrap'),
        '#!/bin/sh\nenv > "$JAIL_OUT/env"\nprintf "%s\\n" "$@" > "$JAIL_OUT/argv"\n',
        { mode: 0o755 },
      );
      const ran = Bun.spawnSync(['/bin/sh', join(dir, 'jail.sh'), 'true'], {
        env: {
          PATH: `${dir}:/usr/bin:/bin`,
          JAIL_OUT: dir,
          CLAUDE_CODE_OAUTH_TOKEN: 'canary-not-a-token',
        },
      });

      expect(ran.exitCode).toBe(0);
      expect(readFileSync(join(dir, 'env'), 'utf8')).not.toContain('canary-not-a-token');
      // Still its own pid namespace and /proc: without them, every process's environ is read.
      const argv = readFileSync(join(dir, 'argv'), 'utf8');

      expect(argv.split('\n')).toContain('--unshare-pid');
      expect(argv).toContain('--proc\n/proc\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the jail on real trees: present reach files read-only, missing ones over /dev/null, an off env's hidden, a missing tree left alone", () => {
    const dir = mkdtempSync(join(tmpdir(), 'abe-jail-'));
    const repo = join(dir, 'repo');
    const base = join(dir, 'repo-base');

    try {
      mkdirSync(join(repo, '.abe'), { recursive: true });
      writeFileSync(join(repo, 'abe.yaml'), 'x');
      writeFileSync(join(repo, '.abe', 'abe.prod.env'), 'K=v');
      writeFileSync(join(repo, '.env.production'), 'K=v');
      const script = boxJailScript({
        trees: [repo, base],
        off: [join(repo, '.abe', 'abe.prod.env'), join(repo, '.env.production')],
      });

      writeFileSync(join(dir, 'jail.sh'), script, { mode: 0o755 });
      writeFileSync(join(dir, 'bwrap'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$JAIL_OUT/argv"\n', {
        mode: 0o755,
      });
      const ran = Bun.spawnSync(['/bin/sh', join(dir, 'jail.sh'), 'true'], {
        env: { PATH: `${dir}:/usr/bin:/bin`, JAIL_OUT: dir },
      });

      expect(ran.exitCode).toBe(0);
      const argv = readFileSync(join(dir, 'argv'), 'utf8').split('\n');
      const binds = (src: string, dest: string) =>
        argv.some((a, i) => a === '--ro-bind' && argv[i + 1] === src && argv[i + 2] === dest);
      const at = (f: string) => join(repo, f);

      expect(binds(at('abe.yaml'), at('abe.yaml'))).toBe(true);
      for (const f of ['.abe/settings.local.yaml', '.abe/abe.dev.env', '.abe/abe.test.env'])
        expect([f, binds('/dev/null', at(f))]).toEqual([f, true]);
      // the off one: read-only first, then hidden over it (bwrap mounts in order)
      const prod = at('.abe/abe.prod.env');
      const last = (src: string) =>
        argv.findLastIndex(
          (a, i) => a === '--ro-bind' && argv[i + 1] === src && argv[i + 2] === prod,
        );

      expect(last('/dev/null')).toBeGreaterThan(last(prod));
      expect(binds('/dev/null', at('.env.production'))).toBe(true);
      // Before's worktree not there yet: nothing made in it (git worktree add wants it empty)
      expect(argv.join(' ')).not.toContain(base);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the jail: no network namespace of its own, so every host is reached', () => {
    expect(jail).not.toContain('--unshare-net');
    expect(jail).not.toContain('--unshare-all');
  });

  test("the file tools: the credential files and the sockets denied, gh's login readable", () => {
    const deny = m.permissions?.deny ?? [];

    for (const rule of [
      'Read(~/.claude/.credentials.json)',
      'Read(~/.aws/credentials)',
      'Read(~/.ssh/**)',
      'Read(//run/abe/serve.sock)',
      'Read(//run/abe/s/**)',
      'Read(//proc/*/environ)',
    ])
      expect(deny).toContain(rule);
    expect(deny.join(' ')).not.toContain('gh/hosts.yml');
    expect(m.permissions?.disableBypassPermissionsMode).toBe('disable');
  });

  test("the coordinator's model, lowered; only the allowed ones to pick", () => {
    expect(m.model).toBe('sonnet');
    expect(m.availableModels).toEqual(['sonnet', 'haiku']);
    expect(m.modelPicker?.options.map((o) => o.label)).toEqual(['sonnet', 'haiku']);
  });

  test("a session's own settings open its own socket folder again", () => {
    expect(boxSessionSettings('4-a1b2')).toEqual({
      sandbox: { filesystem: { allowRead: ['/run/abe/s/4-a1b2'] } },
    });
  });
});

/** A rule's path or a sandbox entry as a whole-path pattern: `**` any depth, `*` one segment. */
const escaped = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const pattern = (glob: string) =>
  new RegExp(
    `^${glob
      .split('**')
      .map((part) => part.split('*').map(escaped).join('[^/]*'))
      .join('.*')}$`,
  );
const home = (path: string) => path.replace(/^~(?=\/)/, CONTAINER.home);

/** A file tool's `Read(…)` deny rule reaches `path`: `//abs`, `~/home`, a folder's `/**`. */
const readDenied = (rules: readonly string[], path: string) =>
  rules.some((rule) => {
    const at = /^Read\((.*)\)$/.exec(rule)?.[1];

    return at !== undefined && pattern(home(at.replace(/^\/\//, '/'))).test(path);
  });

describe("every secret in the container is behind a managed deny rule and the jail (the hook's link check races)", () => {
  const m = managedSettings({ abe: 'abe', allowedModels: ['sonnet'], allow: [], awsRegions: [] });
  test.each(CONTAINER_SECRETS.map((s) => [s.path, s.holds]))('%s (%s)', (path) => {
    expect(readDenied(m.permissions?.deny ?? [], path)).toBe(true);
    expect(jailHides(path)).toBe(true);
  });

  test("the matchers are no blanket: the clone and gh's login stay readable", () => {
    for (const path of ['/workspace/repo/src/a.ts', `${CONTAINER.home}/.config/gh/hosts.yml`]) {
      expect(readDenied(m.permissions?.deny ?? [], path)).toBe(false);
      expect(jailHides(path)).toBe(false);
    }
  });
});

describe('isWorkspaceSessionSocket: only a session in the workspace container gets its narrower set', () => {
  const dir = '/var/lib/abe-box/workspace';

  test.each([
    [boxSessionSocket(dir, '4-a1b2'), dir, true],
    [boxSessionSocket(dir, '4-a1b2'), `${dir}/`, true],
    // A Factory run's session the box's serve runs locally (tmux): a local session's socket.
    ['/var/lib/abe-box/sessions/4-a1b2/session.sock', dir, false],
    [`${dir}/serve.sock`, dir, false],
    ['/var/lib/abe-box/workspace-old/s/4-a1b2/session.sock', dir, false],
  ])('%s → %p', (socket, socketDir, inside) => {
    expect(isWorkspaceSessionSocket(socket, socketDir)).toBe(inside);
  });
});

describe("gitAuthor: the person's identity from gh api user", () => {
  test.each([
    [
      { login: 'octocat', id: 583231, name: 'The Octocat' },
      { name: 'The Octocat', email: '583231+octocat@users.noreply.github.com' },
    ],
    [
      { login: 'octocat', id: 583231, name: null },
      { name: 'octocat', email: '583231+octocat@users.noreply.github.com' },
    ],
    [
      { login: 'octocat', id: 583231, name: '  ' },
      { name: 'octocat', email: '583231+octocat@users.noreply.github.com' },
    ],
  ])('%j → %j', (user, author) => {
    expect(gitAuthor(user)).toEqual(author);
  });

  test.each([{}, { login: 'octocat' }, { login: '', id: 1 }, { login: 'a b', id: 1 }, 'nope'])(
    '%j is no user',
    (user) => {
      expect(gitAuthor(user)).toBeUndefined();
    },
  );
});

describe("sessionDirAccess: a workspace session's socket folder, closed to the script user", () => {
  test.each([
    // The stand-in box's serve runs as root: the folder is given to the session's user.
    [0, { mode: 0o700, chown: [1000, 1000] as const }],
    // Any other serve keeps it as its own, closed: a session of another uid then cannot reach
    // its socket and fails at its first hook, never the folder left open to the script user.
    [1000, { mode: 0o700 }],
    [501, { mode: 0o700 }],
  ])('serve as uid %p → %j', (uid, access) => {
    expect(sessionDirAccess(uid)).toEqual(access);
  });
});
