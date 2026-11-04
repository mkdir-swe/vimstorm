/**
 * The local session runner: a git worktree beside the checkout, `claude` in a `tmux` session on a
 * `tmux` server of `serve`'s own (its socket in the state directory, no config file read, never
 * the person's own server), started through `env -i` so it gets exactly the environment it is
 * handed. Sessions outlive `serve`: stopping `serve` leaves the `tmux` server running.
 *
 * Claude Code's trust dialog comes before any hook, so nobody would see a session waiting on it:
 * a worktree at Abe's own place for the card's branch (made now or by an earlier launch) is
 * trusted in Claude Code's config before `claude` starts (`claude-trust.ts`). A worktree the
 * person made elsewhere on that branch is not: its dialog shows, and they answer it (attach).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  claudeArgv,
  withRepoMcpOff,
  claudeForSession,
  claudeSessionFile,
  resumedTranscript,
  SETUP_TIMEOUT_MS,
  type Outcome,
  type Ran,
  type SessionRunner,
  type SetupRan,
  setupPassed,
  setupReason,
  shellWord,
  sourceServers,
  sourceServersConfig,
  withSourcesTold,
  withServersAllowed,
  withWorktreeHeld,
  jailed,
  jailEnv,
  jailWrapper,
} from '@abe/core';
import { prepareBaseWorktree, prepareWorktree, repairTeamFiles } from './worktree-setup';
import {
  claudeConfigFile,
  mcpServerNamesIn,
  personalMcpConfig,
  personalServers,
  trustFolder,
} from '../claude-code/claude-trust';
import { type Env, realPath } from './locations';
import { mainCheckout } from './settings';
import { sessionDir, sessionSocket } from './sessions';
import { failed, gitEnv, runProcess as run, said } from './process';
import { gitWorktrees } from '../git/worktrees';
import { claudeVersions } from '../claude-code/tool-probe';

/**
 * What tmux says when its server is gone, or going: it ends with its last session, and a command
 * that meets it exiting hears "server exited unexpectedly".
 */
export const SERVER_GONE = /no server running|error connecting|server exited unexpectedly/;
/** The same for one session: it is gone too when the server has it no more. */
export const sessionGone = (stderr: string): boolean =>
  stderr.includes("can't find session") || SERVER_GONE.test(stderr);

/** How long a paste may take to show in Claude Code's input before it is pasted again. */
const PASTE_SHOWS_MS = 1_000;
/** How often the screen is read meanwhile. */
const PASTE_POLL_MS = 50;
/** Pastes before a message is given up: Enter never goes to an input it did not reach. */
const PASTE_TRIES = 2;
/**
 * Pastes a set buffer into a session's pane and presses Enter only once the paste shows there,
 * pasting it again once when it does not; given up after that, with no Enter. A paste Claude Code
 * missed (a menu or a redraw had the keys) would else have Enter submit what its input held, a
 * suggested prompt (a QA run's lost answer). Both runners' `send`.
 */
export const pasteThenEnter = async (
  tmux: (...args: string[]) => Promise<Ran>,
  target: string,
  buffer: string,
): Promise<Outcome<null>> => {
  const screen = async () => {
    const shown = await tmux('capture-pane', '-p', '-t', target);

    return shown.exit === 0 ? shown.stdout : undefined;
  };
  const before = await screen();
  const shows = async () => {
    for (let waited = 0; waited < PASTE_SHOWS_MS; waited += PASTE_POLL_MS) {
      await Bun.sleep(PASTE_POLL_MS);
      const now = await screen();

      if (before === undefined || now === undefined || now !== before) return true;
    }

    return false;
  };

  for (let tries = 0; tries < PASTE_TRIES; tries++) {
    const pasted = await tmux('paste-buffer', '-p', '-b', buffer, '-t', target);

    if (pasted.exit !== 0) return failed('tmux-failed', said(pasted, 'tmux'));
    if (!(await shows())) continue;
    await tmux('delete-buffer', '-b', buffer);
    const entered = await tmux('send-keys', '-t', target, 'Enter');

    return entered.exit === 0
      ? { ok: true, data: null }
      : failed('tmux-failed', said(entered, 'tmux'));
  }
  await tmux('delete-buffer', '-b', buffer);

  return failed(
    'tmux-failed',
    `the message never showed in Claude Code's input (pasted ${PASTE_TRIES} times): not sent; its screen may hold a menu (Esc closes it)`,
  );
};

/** The size a detached session starts at; an attached terminal resizes it. */
const COLUMNS = '200';
const ROWS = '50';

/**
 * The script `env -i` runs: it reads the session's variables from their file (so no value is on
 * a command line) and removes the file, drops what `sh` adds on its own, and becomes `claude`,
 * whose words come from their own file too: its instructions and prompt make a command longer
 * than tmux takes in one.
 */
export const ENTER =
  'set -a; if . "$1"; then set +a; rm -f -- "$1"; else rm -f -- "$1" "$2"; exit 1; fi; ' +
  'argv=$(cat -- "$2") || exit 1; rm -f -- "$2"; ' +
  'eval "exec /usr/bin/env -u SHLVL -u PWD -u OLDPWD -u _ $argv"';

/** The words `ENTER` runs, each quoted for `sh`. */
export const argvFile = (argv: readonly string[]) => `${argv.map(shellWord).join(' ')}\n`;

export const envFile = (env: Readonly<Record<string, string>>) =>
  Object.entries(env)
    .map(([name, value]) => `${name}=${shellWord(value)}\n`)
    .join('');

export type TmuxRunnerOptions = {
  /** `serve`'s state directory: the `tmux` socket, the sessions' folders, the `abe` for sessions. */
  stateDir: string;
  /** The `tmux` binary; null when there is none (a launch is then refused). */
  tmux: string | null;
  /** `serve`'s environment: where git is found. */
  env: Env;
  /** How this program is run (`selfArgv([])`): the `abe` a session gets. */
  self: readonly string[];
  /** Where each session's plugin goes (`<plugins>/<id>`), outside the state (`Locations.plugins`). */
  plugins: string;
};

export const tmuxRunner = (o: TmuxRunnerOptions): SessionRunner => {
  const socket = join(o.stateDir, 'tmux.sock');
  const tmuxBin = o.tmux ?? 'tmux';
  const bin = join(o.stateDir, 'bin');
  const shim = join(bin, 'abe');
  const home = o.env.HOME ?? '/';
  // The server takes its global environment from the first client: nothing of serve's.
  const tmuxEnv = { HOME: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
  const worktrees = gitWorktrees(o.env);
  const tmux = (...args: string[]) =>
    run([tmuxBin, '-u', '-S', socket, '-f', '/dev/null', ...args], tmuxEnv);
  const target = (id: string) => `=abe-${id}:`;

  // The config Abe generates of a session's source servers (ADR 0027): in the state, which the
  // sandbox never reads, never in the session's own folder, which it does.
  const sourcesFile = (id: string) => join(o.stateDir, 'sources', `${id}.json`);

  const writeShim = () => {
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    writeFileSync(shim, `#!/bin/sh\nexec ${o.self.map(shellWord).join(' ')} "$@"\n`, {
      mode: 0o755,
    });
  };

  return {
    abe: shellWord(shim),
    bin,
    plugins: o.plugins,
    socket: (id) => {
      const path = sessionSocket(o.stateDir, id);

      return { listen: path, session: path, mode: 0o600 };
    },
    baseWorktree: async (repo, branch, recipe) => {
      const made = await worktrees.atMergeBase(repo, branch);

      if (!made.ok || recipe === undefined) return made;
      // the recipe as a card's worktree gets it: files, packages linked, its script
      const tracked = await run(
        ['git', '-C', made.data.path, 'ls-files', '--', 'package.json', '*/package.json'],
        gitEnv(o.env),
      );
      const ran = await prepareBaseWorktree({
        checkout: mainCheckout(repo) ?? repo,
        worktree: made.data.path,
        copy: recipe.copy,
        tracked: tracked.exit === 0 ? tracked.stdout.split('\n').filter((l) => l !== '') : [],
        run: recipe.run,
        card: recipe.card,
        env: Object.fromEntries(
          Object.entries(o.env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as const])),
        ),
      });
      const reason = setupReason(ran);

      return reason === null ? made : failed('worktree-setup-failed', reason);
    },
    sourceServers: ({ repo, sources, home: claudeHome }) => {
      const main = mainCheckout(repo) ?? repo;
      let config: unknown = {};

      try {
        config = JSON.parse(readFileSync(claudeConfigFile(claudeHome), 'utf8'));
      } catch {
        // no config, or not JSON: no servers
      }

      return sourceServers({
        config,
        mains: [...new Set([main, repo, realPath(main), realPath(repo)])],
        sources,
      });
    },
    launch: async (spec) => {
      if (o.tmux === null) return failed('no-tmux', 'tmux is not installed (brew install tmux)');
      // The first claude on its PATH new enough for its settings, never an older one first (#179).
      const picked = claudeForSession(await claudeVersions(spec.env), spec.env.PATH ?? '');

      if (!picked.ok) return failed(picked.code, picked.message);
      const claude = picked.path;
      // An Improve retro chat (#87) runs in a plain folder of its own: no worktree, nothing to set up.
      if (spec.folder !== undefined) mkdirSync(spec.folder, { recursive: true, mode: 0o700 });
      const tree =
        spec.folder === undefined
          ? await worktrees.onBranch(spec.repo, spec.branch, spec.from, spec.reopen === true)
          : { ok: true as const, data: { path: spec.folder, ours: true, setupMark: null } };

      if (!tree.ok) return tree;
      const mark = tree.data.setupMark;
      // a new launch's worktree takes the team's files over its branch's; one started again only
      // what it lacks (its own edits to them stay)
      const fresh = spec.reopen !== true && spec.resume === undefined;
      // A worktree of Abe's not made ready yet (new, or one whose setup failed or was cut short)
      // has none of the repo's packages: linked, or set up, before claude starts.
      const prepare = async (worktree: string, at: string): Promise<SetupRan | null> => {
        const tracked = await run(
          ['git', '-C', worktree, 'ls-files', '--', 'package.json', '*/package.json'],
          gitEnv(o.env),
        );
        const ran = await prepareWorktree({
          checkout: mainCheckout(spec.repo) ?? spec.repo,
          worktree,
          fresh,
          setup: spec.setup,
          env: { ...spec.env },
          copy: spec.copy ?? [],
          tracked: tracked.exit === 0 ? tracked.stdout.split('\n').filter((l) => l !== '') : [],
          timeoutMs: SETUP_TIMEOUT_MS,
          run: spec.worktreeRun ?? null,
          card: spec.card ?? null,
          ...(spec.packages === undefined ? {} : { packages: spec.packages }),
        });

        // nothing to do yet is no mark: a setup or lockfile added later still runs here
        if (ran !== null && setupPassed(ran))
          writeFileSync(at, `${ran.how === 'ran' ? ran.run : ran.how}\n`);

        return ran;
      };
      // A worktree made ready before (a reopen, a resume, a launch again on its branch) still gets
      // the team's files the main checkout has and it lacks, never over the card's own.
      const repair = async (): Promise<SetupRan | null> => {
        const over = (spec.copy ?? []).filter((c) => c.over === true);

        if (!tree.data.ours || over.length === 0) return null;
        const put = await repairTeamFiles(
          mainCheckout(spec.repo) ?? spec.repo,
          tree.data.path,
          over,
        );
        const notCopied =
          Object.keys(put.notCopied).length === 0 ? {} : { notCopied: put.notCopied };

        return put.copied.length === 0 && Object.keys(notCopied).length === 0
          ? null
          : { run: '', exit: 0, output: '', how: 'none', copied: put.copied, ...notCopied };
      };
      const setup =
        mark !== null && !existsSync(mark) ? await prepare(tree.data.path, mark) : await repair();
      // Not trusted (a config that is not Claude Code's JSON): the dialog shows, the person answers.
      const claudeHome = spec.env.HOME ?? home;
      const trusted = tree.data.ours && trustFolder(claudeHome, tree.data.path).ok;
      // A moved session (#88): its transcript, copied as a log, is Claude Code's session file here.
      if (spec.resume !== undefined) {
        const log = join(tree.data.path, spec.resume.transcript);

        if (!existsSync(log))
          return failed('no-transcript', `${log}: the moved session's transcript is not there`);
        const cwd = realPath(tree.data.path);
        const file = claudeSessionFile(spec.env.HOME ?? home, cwd, spec.claudeSession);

        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, resumedTranscript(readFileSync(log, 'utf8'), spec.resume.from, cwd), {
          mode: 0o600,
        });
      }
      writeShim();
      const dir = sessionDir(o.stateDir, spec.id);

      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const settings = join(dir, 'settings.json');
      // Its own browser's chrome-devtools-mcp (#182), its files under this worktree.
      const mcpConfig = spec.mcpConfig ?? spec.mcp?.(tree.data.path);
      // `session.mcp: yours`: the person's own servers, from the config of the HOME claude runs
      // with; the repo's own (its .mcp.json, by name) rejected in its settings (`withRepoMcpOff`).
      const personalMcp = spec.mcpMode === 'yours' ? personalMcpConfig(claudeHome) : undefined;
      // A run's sources (ADR 0027): the servers serve found, in a config Abe generates, never
      // the person's own file, never a repo's .mcp.json. A server of Abe's name stays Abe's.
      const abeNames = mcpConfig === undefined ? [] : mcpServerNamesIn(mcpConfig);
      // the person's own a launch always loads (a prototype's Figma): in `yours` they load anyway
      const own =
        spec.mcpMode === 'abe-only' && spec.ownServers !== undefined
          ? personalServers(claudeHome, spec.ownServers)
          : {};
      const servers = [
        ...Object.entries(spec.sources?.servers ?? {}),
        ...Object.entries(own),
      ].filter(([name]) => !abeNames.includes(name));
      const generated = sourcesFile(spec.id);

      rmSync(generated, { force: true });
      if (spec.mcpMode === 'abe-only' && servers.length > 0) {
        mkdirSync(dirname(generated), { recursive: true, mode: 0o700 });
        writeFileSync(generated, sourceServersConfig(Object.fromEntries(servers)), {
          mode: 0o600,
        });
      }
      const sources =
        spec.mcpMode === 'abe-only' && servers.length > 0
          ? { allowed: [...new Set([...abeNames, ...servers.map(([name]) => name)])] }
          : undefined;
      const sourceMcp = sources === undefined ? [] : [generated];
      const missing = spec.mcpMode === 'abe-only' ? (spec.sources?.missing ?? []) : [];
      const vars = join(dir, 'env');
      const words = join(dir, 'argv');
      // The plugin anew each launch: its agents on this launch's models.
      const plugin = join(o.plugins, spec.id);

      rmSync(plugin, { recursive: true, force: true });
      for (const file of spec.plugin) {
        const path = join(plugin, file.path);

        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.text);
      }

      // Its worktree held by name where it really is (a person's own one too, #181).
      const allowed =
        sourceMcp.length === 0 || sources === undefined
          ? spec.settings
          : withServersAllowed(spec.settings, sources.allowed);
      const held = withWorktreeHeld(
        spec.mcpMode === 'yours'
          ? withRepoMcpOff(allowed, mcpServerNamesIn(join(tree.data.path, '.mcp.json')))
          : allowed,
        realPath(tree.data.path),
      );

      // Its commands in Abe's own jail (ADR 0029): Claude Code's sandbox off, every Bash command
      // under the Seatbelt profile its sandbox lists make, written where no command writes.
      const jail = jailed(held);
      const profile = join(dir, 'jail.sb');
      const wrapper = join(dir, 'jail.sh');
      const env = jail === undefined ? spec.env : jailEnv(spec.env, wrapper);

      if (jail !== undefined) {
        writeFileSync(profile, `${jail.profile}\n`, { mode: 0o600 });
        writeFileSync(wrapper, jailWrapper(profile), { mode: 0o700 });
        chmodSync(wrapper, 0o700);
      }
      writeFileSync(
        settings,
        `${JSON.stringify(jail === undefined ? held : jail.settings, null, 2)}\n`,
        { mode: 0o600 },
      );
      writeFileSync(vars, envFile(env), { mode: 0o600 });
      chmodSync(vars, 0o600);
      writeFileSync(
        words,
        argvFile(
          claudeArgv({
            claude,
            settings,
            pluginDir: plugin,
            skillsOnTop: spec.skillsOnTop,
            mcpMode: spec.mcpMode,
            ...(personalMcp === undefined ? {} : { personalMcp }),
            claudeSession: spec.claudeSession,
            resume: spec.resume !== undefined || spec.reopen === true,
            instructions: withSourcesTold(spec.instructions, spec.sources, missing, 'mac'),
            prompt: spec.prompt,
            ...(mcpConfig === undefined ? {} : { mcpConfig }),
            sourceMcp,
          }),
        ),
        { mode: 0o600 },
      );
      const started = await tmux(
        'new-session',
        '-d',
        '-s',
        `abe-${spec.id}`,
        '-x',
        COLUMNS,
        '-y',
        ROWS,
        '-c',
        tree.data.path,
        '/usr/bin/env',
        '-i',
        '/bin/sh',
        '-c',
        ENTER,
        'sh',
        vars,
        words,
      );

      if (started.exit === 0) {
        // An attached terminal (Chat, #71) shows Claude Code alone: no tmux status line.
        await tmux('set-option', '-t', target(spec.id), 'status', 'off');

        const base = 'base' in tree.data ? tree.data.base : undefined;

        return {
          ok: true,
          data: {
            worktree: tree.data.path,
            setup,
            trusted,
            ...(base === undefined ? {} : { base }),
            ...(missing.length === 0 ? {} : { sourcesMissing: [...missing] }),
          },
        };
      }
      rmSync(vars, { force: true });
      rmSync(words, { force: true });

      return failed('tmux-failed', `tmux new-session: ${said(started, 'tmux')}`);
    },
    send: async (id, text) => {
      const buffer = `abe-${id}`;
      const set = await tmux('set-buffer', '-b', buffer, '--', text);

      if (set.exit !== 0) return failed('tmux-failed', said(set, 'tmux'));
      return pasteThenEnter(tmux, target(id), buffer);
    },
    keys: async (id, keys) => {
      for (const key of keys) {
        const pressed = await tmux('send-keys', '-t', target(id), key);

        if (pressed.exit !== 0) return failed('tmux-failed', said(pressed, 'tmux'));
      }

      return { ok: true, data: null };
    },
    screen: async (id) => {
      const shown = await tmux('capture-pane', '-p', '-t', target(id));

      return shown.exit === 0
        ? { ok: true, data: shown.stdout }
        : failed('tmux-failed', said(shown, 'tmux'));
    },
    attach: (id) => [tmuxBin, '-u', '-S', socket, 'attach-session', '-t', `=abe-${id}`],
    attached: async () => {
      if (o.tmux === null || !existsSync(socket)) return false;
      const listed = await tmux('list-clients', '-F', 'c');

      return listed.exit === 0 && listed.stdout.includes('c');
    },
    stop: async (id) => {
      rmSync(join(sessionDir(o.stateDir, id), 'env'), { force: true });
      rmSync(sourcesFile(id), { force: true });
      const killed = await tmux('kill-session', '-t', `=abe-${id}`);
      // the session's last pane ended (or this kill ended the server's last session): gone already
      const gone = sessionGone(killed.stderr);

      return killed.exit === 0 || gone
        ? { ok: true, data: null }
        : failed('tmux-failed', said(killed, 'tmux'));
    },
    running: async () => {
      if (o.tmux === null || !existsSync(socket)) return { ok: true, data: [] };
      const listed = await tmux('list-sessions', '-F', '#{session_name}');

      if (listed.exit !== 0)
        return SERVER_GONE.test(listed.stderr)
          ? { ok: true, data: [] }
          : failed('tmux-failed', said(listed, 'tmux'));

      return {
        ok: true,
        data: listed.stdout
          .split('\n')
          .filter((name) => name.startsWith('abe-'))
          .map((name) => name.slice('abe-'.length)),
      };
    },
  };
};
