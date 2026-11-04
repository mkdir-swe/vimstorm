/**
 * The session runner inside the box's workspace container (#63): `claude` in a `tmux` session on
 * the container's own tmux server, started through `env -i` from a variables file the pane removes
 * once read (as the local runner does), in the workspace's clone. Everything runs through `exec`
 * (`docker exec` into the container): the managed settings as root, the session's files, `gh`'s
 * login, the folder trusted in Claude Code's config. IO only: what goes in them is core's.
 */
import {
  type Answered,
  boxSessionSocket,
  claudeArgv,
  claudeFolderShell,
  claudeSessionFile,
  resumedTranscript,
  CONTAINER,
  DEFAULT_BRANCH_REFS,
  type Docker,
  MANAGED_SETTINGS,
  mcpServerNames,
  type Ran,
  parseEnvFile,
  type SessionRunner,
  SETUP_TIMEOUT_MS,
  type SetupRan,
  shellWord,
  sourceServers,
  sourceServersConfig,
  SYNC_SOURCE_VALUES,
  withSourceValues,
  withSourcesTold,
  withServersAllowed,
  BOX_JAIL,
  boxJailScript,
  WORKTREE_SCRIPT_TIMEOUT_MS,
} from '@abe/core';
import { z } from 'zod';
import { failed, said } from '../mac/process';
import { containerRunTree } from '../mac/run-tree';
import { argvFile, ENTER, envFile, pasteThenEnter, SERVER_GONE, sessionGone } from '../mac/tmux';

/**
 * Runs `argv` in the container, `stdin` written, as root or another `user` when asked (else the
 * container's own), killed after `timeoutMs`.
 */
export type ContainerExec = (
  argv: readonly string[],
  o?: { stdin?: string; root?: boolean; user?: string; timeoutMs?: number },
) => Promise<Ran>;

export type WorkspaceRunnerOptions = {
  exec: ContainerExec;
  /** The box's socket folder, mounted in the container at `socketMount`. */
  socketDir: string;
  socketMount: string;
  /** The command that runs a terminal into the container (`docker exec -it abe-workspace`). */
  attachVia: readonly string[];
  /**
   * The plain `docker exec` into the container (`docker exec abe-workspace`). With it, an attach
   * whose terminal hangs up (its SSH dropped) ends its tmux client in the container too:
   * `docker exec -it` leaves the process inside running, attached for good, which keeps the box up.
   */
  execVia?: readonly string[];
  /** Where things are inside the container (the base image's; a test's host stands in). */
  paths?: {
    home?: string;
    workdir?: string;
    managedSettings?: string;
    /** The `tmux` command inside, server included. */
    tmux?: readonly string[];
    claude?: string;
    abe?: string;
    user?: string;
    /** Claude Code's conversations on the workspace volume (`CONTAINER.conversations`, #343). */
    conversations?: string;
  };
};

/**
 * An attach through `docker exec -it` that cleans up after a hangup (bash, on the box): `$1` words
 * of the terminal's command, `$n` words of the plain one, the container user's home, then the tmux
 * client's argv. The plain command first makes the mark, a fresh file in that home (0700: no other user
 * there, an `abe-run` script's included, can make, read or swap it); no mark, no attach. The
 * client writes its pid to it; on SIGHUP or SIGTERM (sshd's, when the connection drops) the plain
 * command sends that pid SIGHUP, which ends a tmux client, once `ps` names it an `attach-session`
 * of that same user. A normal end only removes the mark.
 */
const ATTACH_SCRIPT = `n=$1; shift; terminal=("\${@:1:n}"); shift "$n"
n=$1; shift; plain=("\${@:1:n}"); shift "$n"
home=$1; shift
mark=$("\${plain[@]}" mktemp "$home/.abe-attach.XXXXXX" </dev/null) && [ -n "$mark" ] ||
  { echo "abe: no mark for the attach in the container's home" >&2; exit 1; }
end() {
  "\${plain[@]}" sh -c 'p=$(cat "$1" 2>/dev/null); rm -f "$1"
[ "$2" = lost ] && [ -n "$p" ] && [ "$(ps -o uid= -p "$p" | tr -d " ")" = "$(id -u)" ] &&
  ps -o args= -p "$p" | grep -q attach-session && kill -HUP "$p"' sh "$mark" "$1" </dev/null >/dev/null 2>&1
}
trap 'end lost; exit 129' HUP
trap 'end lost; exit 143' TERM
"\${terminal[@]}" sh -c 'echo $$ > "$1" || exit 1; shift; exec "$@"' sh "$mark" "$@"
code=$?
end done
exit "$code"`;

const COLUMNS = '200';
const ROWS = '50';

/**
 * Claude Code's conversations (`$2/.claude/projects`) kept on the workspace volume at `$1` (#343),
 * so a new container (a release's image) finds them: the folder there made the session user's
 * alone (0700: the script user shares the volume's group), what an older container kept in its
 * home moved in once, then the home's `projects` a link to it.
 */
export const CONVERSATIONS = `umask 077
mkdir -p "$1" "$2/.claude" || exit 4
[ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] || { echo "$1 is not a folder of its own" >&2; exit 4; }
p="$2/.claude/projects"
if [ -d "$p" ] && [ ! -L "$p" ]; then cp -a "$p/." "$1/" && rm -rf "$p" || exit 4; fi
chmod 700 "$1" || exit 4
[ -L "$p" ] && [ "$(readlink "$p")" = "$1" ] && exit 0
rm -f "$p" && ln -s "$1" "$p"`;

/** Writes stdin to `$2` in folder `$1` (made when missing), the file's mode `$3`. */
const WRITE = 'umask 077; mkdir -p "$1" && cat > "$2" && chmod "$3" "$2"';

/**
 * The managed settings (run as root): stdin to `$2` in folder `$1`, both readable by everyone and
 * writable by their writer only. The folder must be the writer's own: one a repo's `.abe/session`
 * layer made as the session's user would let the session replace the file, and root in the
 * unprivileged container has no `CAP_CHOWN` to take it back (exit 5). The file goes through a new
 * `$2.new` and a rename, so it is root's and a link left at either name is replaced, never followed.
 */
export const MANAGED_WRITE = `umask 022
mkdir -p -- "$1" || exit 4
me=$(id -u)
[ "$(ls -nd -- "$1" | awk '{print $3}')" = "$me" ] || { echo "$1 is not owned by uid $me" >&2; exit 5; }
chmod 755 "$1" || exit 4
rm -f -- "$2.new"
cat > "$2.new" || exit 4
chmod "\${3:-644}" "$2.new" && mv -f -- "$2.new" "$2"`;

/**
 * Before's worktree `$2` of the clone `$1`, detached at the merge base of the card's branch `$3`
 * and the default branch (the first of `$4…` there is, as a local run takes it): made, or moved
 * back to it with an earlier Before's edits gone. Prints the merge base and the default branch's
 * short name, its files group-writable for the script user that runs the app there (its `.git`
 * link, `.claude` and entries the session user's alone, as the clone's). Exit 3: no default
 * branch; 4: no merge base; 5: `$2` is there and no worktree.
 */
const BASE_WORKTREE = `umask 002
cd "$1" || exit 6
# serve's own git in the agent's clone: none of its hooks or fsmonitor run.
git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
path=$2 branch=$3
shift 3
against=
for ref in "$@"; do
  if found=$(git rev-parse --verify --quiet --symbolic-full-name "$ref") && [ -n "$found" ]; then
    against=$found; break
  fi
done
[ -n "$against" ] || exit 3
base=$(git merge-base "$branch" "$against") || exit 4
if [ -e "$path/.git" ]; then
  git -C "$path" checkout --quiet --force --detach "$base" || exit 6
elif [ -e "$path" ]; then
  exit 5
else
  git worktree add --quiet --detach "$path" "$base" || exit 6
fi
# The script user runs the app here, never git's or Claude Code's own files, nor renames them
# (sticky before .claude is made, so no entry of abe's there is swapped meanwhile).
chmod go-w "$path/.git" && chmod +t "$path" || exit 6
{ ${claudeFolderShell('"$path/.claude"')}; } || exit 6
short=\${against#refs/heads/}
printf '%s\\n%s\\n' "$base" "\${short#refs/remotes/}"`;

const BASE_FAILED: Readonly<Record<number, string>> = {
  3: 'no-default-branch',
  4: 'no-merge-base',
  5: 'worktree-taken',
};

const ClaudeConfig = z.looseObject({ projects: z.record(z.string(), z.unknown()).optional() });

/**
 * The workspace's `gh` logged in as the person (the token on stdin, never in argv) and git told
 * to ask it: what a session, the pr stage's push and `gh`, and the deploy poll use in the
 * container. Run at a launch, at `workspace up` and when a box's serve starts again.
 */
/** Each of gh's two steps at most this long: GitHub not answering holds up no start or `up`. */
const GH_LOGIN_TIMEOUT_MS = 15_000;

export const workspaceGhLogin = async (
  exec: ContainerExec,
  token: string,
): Promise<Answered<never> | undefined> => {
  const login = await exec(['gh', 'auth', 'login', '--hostname', 'github.com', '--with-token'], {
    stdin: `${token}\n`,
    timeoutMs: GH_LOGIN_TIMEOUT_MS,
  });

  if (login.exit !== 0) return failed('login-failed', `gh auth login: ${said(login, 'gh')}`);
  const git = await exec(['gh', 'auth', 'setup-git', '--hostname', 'github.com'], {
    timeoutMs: GH_LOGIN_TIMEOUT_MS,
  });

  return git.exit === 0
    ? undefined
    : failed('login-failed', `gh auth setup-git: ${said(git, 'gh')}`);
};

/** tmux's server gone or going, or the container (or Docker) with it. */
const gone = (stderr: string): boolean =>
  SERVER_GONE.test(stderr) || /No such file|is not running|No such container/.test(stderr);

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

export const workspaceRunner = (o: WorkspaceRunnerOptions): SessionRunner => {
  const home = o.paths?.home ?? CONTAINER.home;
  const workdir = o.paths?.workdir ?? CONTAINER.workdir;
  const managed = o.paths?.managedSettings ?? MANAGED_SETTINGS;
  const tmuxCmd = o.paths?.tmux ?? ['tmux', '-u'];
  const claude = o.paths?.claude ?? 'claude';
  const conversations = o.paths?.conversations ?? CONTAINER.conversations;
  // By its path (the base image's): the managed hooks' command, which a project's `env.PATH` must
  // not turn into another program.
  const abe = o.paths?.abe ?? '/usr/local/bin/abe';
  const tmux = (...args: string[]) => o.exec([...tmuxCmd, ...args]);
  const files = (id: string) => `${home}/.abe/sessions/${id}`;
  const synced = `${home}/${SYNC_SOURCE_VALUES}`;
  const target = (id: string) => `=abe-${id}:`;

  type Step = Promise<Answered<never> | undefined>;

  const write = async (path: string, text: string, mode = '600', root = false): Step => {
    // Root's file is the managed settings: readable by everyone, writable by root only.
    const ran = await o.exec(
      root
        ? ['sh', '-c', MANAGED_WRITE, 'sh', dirOf(path), path, mode === '755' ? '755' : '644']
        : ['sh', '-c', WRITE, 'sh', dirOf(path), path, mode],
      { stdin: text, root },
    );

    return ran.exit === 0 ? undefined : failed('workspace-failed', `${path}: ${said(ran, 'sh')}`);
  };

  /** Claude Code's folder trust for the clone, so its hooks run from the first prompt (#44). */
  /**
   * Claude Code's folder trust for the clone (as given and its real path), so its hooks run from
   * the first prompt (#44): what accepting the dialog writes. A config that is not Claude Code's
   * JSON is left alone (the dialog then shows, and the person answers it on attach).
   */
  const trust = async (): Step => {
    const config = `${home}/.claude.json`;
    const read = await o.exec(['sh', '-c', 'cat "$1" 2>/dev/null || true', 'sh', config]);
    const real = await o.exec(['realpath', workdir]);
    let doc: unknown;

    try {
      doc = read.stdout.trim() === '' ? {} : JSON.parse(read.stdout);
    } catch {
      return undefined;
    }
    const parsed = ClaudeConfig.safeParse(doc);

    if (!parsed.success) return undefined;
    const projects = parsed.data.projects ?? {};
    const paths = [...new Set([workdir, ...(real.exit === 0 ? [real.stdout.trim()] : [])])];
    const next = {
      ...parsed.data,
      hasCompletedOnboarding: true,
      projects: {
        ...projects,
        ...Object.fromEntries(
          paths.map((path) => {
            const project = z.looseObject({}).safeParse(projects[path]);

            return [
              path,
              {
                ...(project.success ? project.data : {}),
                hasTrustDialogAccepted: true,
                hasCompletedProjectOnboarding: true,
              },
            ];
          }),
        ),
      },
    };

    return write(config, `${JSON.stringify(next, null, 2)}\n`);
  };

  /** The MCP server names a config file in the container has; none when it is not there. */
  const serverNames = async (path: string): Promise<string[]> => {
    const read = await o.exec(['sh', '-c', 'cat -- "$1" 2>/dev/null || true', 'sh', path]);

    return mcpServerNames(read.stdout);
  };

  /**
   * A box session's sources (always `--strict-mcp-config`, 3.2.1): the servers serve found in the
   * repo's `sources:` (the Mac's synced `abe.yaml`), whose install check passed on the Mac, in a
   * config Abe generates in the session's folder; never the box's own Claude Code config, never
   * the repo's `.mcp.json`. A server of Abe's name stays Abe's. Their sign-in is the Mac's token
   * the sync put in Claude Code's store (`BOX_SYNC_SCRIPT`), never in this file; each `${VAR}`
   * of theirs filled from your values the sync put in `SYNC_SOURCE_VALUES` (read here, never
   * said), in this file alone (no file tool reads it: `managedSettings`; no command: the jail).
   */
  const sourcesOf = async (
    dir: string,
    servers: Readonly<Record<string, unknown>> | undefined,
    mcpConfig?: string,
  ): Promise<Answered<{ file: string; allowed: string[] } | undefined>> => {
    const generated = `${dir}/sources.json`;
    const abeNames = mcpConfig === undefined ? [] : await serverNames(mcpConfig);
    const kept = Object.entries(servers ?? {}).filter(([name]) => !abeNames.includes(name));

    await o.exec(['rm', '-f', '--', generated]);
    if (kept.length === 0) return { ok: true, data: undefined };
    const values = await o.exec(['sh', '-c', 'cat -- "$1" 2>/dev/null || true', 'sh', synced]);
    const written = await write(
      generated,
      sourceServersConfig(withSourceValues(Object.fromEntries(kept), parseEnvFile(values.stdout))),
    );

    return (
      written ?? {
        ok: true,
        data: { file: generated, allowed: [...new Set([...abeNames, ...kept.map(([n]) => n)])] },
      }
    );
  };

  /** The conversations on the volume (`CONVERSATIONS`), before any `claude` writes one. */
  const onVolume = async (): Step => {
    const ran = await o.exec(['sh', '-c', CONVERSATIONS, 'sh', conversations, home]);

    return ran.exit === 0
      ? undefined
      : failed('workspace-failed', `${conversations}: ${said(ran, 'sh')}`);
  };

  /**
   * A moved session (#88): its transcript, copied into the clone as a log, written as Claude
   * Code's own session file for the clone, so `claude --resume` continues it.
   */
  const resumed = async (
    claudeSession: string,
    from: { transcript: string; from: string },
  ): Step => {
    const log = `${workdir}/${from.transcript}`;
    const read = await o.exec(['cat', '--', log]);

    if (read.exit !== 0)
      return failed('no-transcript', `${log}: the moved session's transcript is not there`);
    const real = await o.exec(['realpath', workdir]);
    const cwd = real.exit === 0 ? real.stdout.trim() : workdir;

    return write(
      claudeSessionFile(home, cwd, claudeSession),
      resumedTranscript(read.stdout, from.from, cwd),
    );
  };

  /**
   * The repo pack's setup (`npm ci`) in the clone, before `claude` (#67): in the container as the
   * script user with the workspace's own environment (never the session's, which holds its Claude
   * login), once per clone and command: a mark beside the clone on the volume says it passed.
   */
  const runSetup = async (run: string): Promise<SetupRan> => {
    const mark = `${workdir}.setup`;
    const was = await o.exec(['sh', '-c', 'cat -- "$1" 2>/dev/null || true', 'sh', mark]);

    if (was.stdout === `${run}\n`) return { run, exit: 0, output: '', how: 'ran', copied: [] };
    const ran = await containerRunTree(o.exec).shell({
      run,
      cwd: workdir,
      timeoutMs: SETUP_TIMEOUT_MS,
    });

    if (ran.exit === 0) await write(mark, `${run}\n`, '644');

    return { run, exit: ran.exit, output: ran.output, how: 'ran', copied: [] };
  };

  /**
   * The repo's worktree recipe's script (`hooks.worktree-setup`, the clone's) run in the clone after the
   * setup, as the setup runs (the script user, the workspace's own environment, outside the
   * session's jail), with `WORKTREE` and `CARD`; `MAIN_CHECKOUT` empty: a box has none, the
   * recipe's files came in with the Mac's sync. Once per clone and script: a mark beside it.
   */
  const runScript = async (
    run: string,
    card: string | null,
  ): Promise<NonNullable<SetupRan['script']>> => {
    const mark = `${workdir}.worktree-run`;
    const was = await o.exec(['sh', '-c', 'cat -- "$1" 2>/dev/null || true', 'sh', mark]);

    if (was.stdout === `${run}\n`) return { run, exit: 0, output: '' };
    const path = `./${run}`;
    const ran = await containerRunTree(o.exec).shell({
      run: [
        `if [ ! -e ${shellWord(path)} ]; then echo ${shellWord(`no ${run} in the clone`)}; exit 127; fi`,
        `if [ ! -x ${shellWord(path)} ]; then echo ${shellWord(`${run} is not executable (git update-index --chmod=+x)`)}; exit 126; fi`,
        `MAIN_CHECKOUT= WORKTREE=${shellWord(workdir)} CARD=${shellWord(card ?? '')} exec ${shellWord(path)}`,
      ].join('\n'),
      cwd: workdir,
      timeoutMs: WORKTREE_SCRIPT_TIMEOUT_MS,
    });

    if (ran.exit === 0) await write(mark, `${run}\n`, '644');

    return { run, exit: ran.exit, output: ran.output };
  };

  return {
    abe,
    bin: abe.includes('/') ? dirOf(abe) : '/usr/local/bin',
    home,
    user: o.paths?.user ?? CONTAINER.user,
    // only the definitions `sources:` has (the Mac's synced abe.yaml): a bare name is a server of
    // the person's Claude Code on their Mac, which this box has not
    sourceServers: ({ sources }) => sourceServers({ config: {}, mains: [], sources }),
    socket: (id) => ({
      listen: boxSessionSocket(o.socketDir, id),
      session: boxSessionSocket(o.socketMount, id),
      mode: 0o666,
    }),
    launch: async (spec) => {
      if (spec.folder !== undefined)
        return failed(
          'no-folder-sessions',
          'an Improve retro chat runs locally, not in a workspace',
        );
      const dir = files(spec.id);
      const resume = spec.resume;
      const settings = `${dir}/settings.json`;
      const vars = `${dir}/env`;
      const words = `${dir}/argv`;
      // Core's plugin anew each launch: its agents on this launch's models.
      const plugin = `${dir}/plugin`;
      // The setup first: its packages' install scripts run before this launch's files (the
      // variables file with its Claude login) are in the container.
      const ranSetup = spec.setup === null ? null : await runSetup(spec.setup);
      // then the recipe's script, once the setup passed (the Mac's sync put its files in)
      const worktreeRun = spec.worktreeRun ?? null;
      const setup: SetupRan | null =
        worktreeRun === null || (ranSetup !== null && ranSetup.exit !== 0)
          ? ranSetup
          : {
              ...(ranSetup ?? { run: '', exit: 0, output: '', how: 'none' as const, copied: [] }),
              script: await runScript(worktreeRun, spec.card ?? null),
            };
      const generated = await sourcesOf(dir, spec.sources?.servers, spec.mcpConfig);

      if (!generated.ok) return generated;
      const sourceMcp = generated.data === undefined ? [] : [generated.data.file];
      const missing = [...(spec.sources?.missing ?? [])];
      const own =
        generated.data === undefined
          ? spec.settings
          : withServersAllowed(spec.settings, generated.data.allowed);
      const steps = [
        async (): Step => {
          const cleared = await o.exec(['rm', '-rf', plugin]);

          return cleared.exit === 0
            ? undefined
            : failed('workspace-failed', `${plugin}: ${said(cleared, 'rm')}`);
        },
        ...spec.plugin.map((f) => () => write(`${plugin}/${f.path}`, f.text, '644')),
        ...(spec.managed === undefined
          ? []
          : [
              () => write(managed, `${JSON.stringify(spec.managed, null, 2)}\n`, '644', true),
              // its commands' jail, root's as the managed settings are (ADR 0029)
              // beside the managed settings (`BOX_JAIL` in a container; a test's own folder)
              () =>
                write(
                  `${dirOf(managed)}/${BOX_JAIL.slice(BOX_JAIL.lastIndexOf('/') + 1)}`,
                  boxJailScript({ off: spec.offFiles ?? [] }),
                  '755',
                  true,
                ),
            ]),
        ...(spec.files ?? []).map((f) => () => write(`${home}/${f.path}`, f.text)),
        trust,
        onVolume,
        ...(resume === undefined ? [] : [() => resumed(spec.claudeSession, resume)]),
        () => write(settings, `${JSON.stringify(own, null, 2)}\n`),
        () => write(vars, envFile(spec.env)),
        () =>
          write(
            words,
            argvFile(
              claudeArgv({
                claude,
                settings,
                pluginDir: plugin,
                skillsOnTop: spec.skillsOnTop,
                // A box's session: Abe's own servers and the repo's sources alone, whatever the setting says.
                mcpMode: 'abe-only',
                claudeSession: spec.claudeSession,
                // a moved session's copied conversation, or a reopened one's own (#343)
                resume: spec.resume !== undefined || spec.reopen === true,
                instructions: withSourcesTold(spec.instructions, spec.sources, missing, 'box'),
                prompt: spec.prompt,
                ...(spec.mcpConfig === undefined ? {} : { mcpConfig: spec.mcpConfig }),
                sourceMcp,
              }),
            ),
          ),
      ];

      for (const step of steps) {
        const refusal = await step();

        if (refusal !== undefined) return refusal;
      }
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
        workdir,
        '/usr/bin/env',
        '-i',
        '/bin/sh',
        '-c',
        // What claude and its commands write in the clone stays writable for the script user,
        // who shares its group (#67).
        `umask 002; ${ENTER}`,
        'sh',
        vars,
        words,
      );

      if (started.exit === 0) {
        // An attached terminal (Chat, #71) shows Claude Code alone: no tmux status line.
        await tmux('set-option', '-t', target(spec.id), 'status', 'off');

        return {
          ok: true,
          data: {
            worktree: workdir,
            setup,
            trusted: true,
            ...(missing.length === 0 ? {} : { sourcesMissing: missing }),
          },
        };
      }
      await o.exec(['rm', '-f', '--', vars, words]);

      return failed('tmux-failed', `tmux new-session: ${said(started, 'tmux')}`);
    },
    // Before's worktree (#47, #67): beside the clone on the workspace's volume.
    baseWorktree: async (_repo, branch) => {
      const path = `${workdir}-base`;
      const made = await o.exec([
        'sh',
        '-c',
        BASE_WORKTREE,
        'sh',
        workdir,
        path,
        branch,
        ...DEFAULT_BRANCH_REFS,
      ]);
      const [base = '', against = ''] = made.stdout.trim().split('\n');

      if (made.exit === 0 && base !== '') return { ok: true, data: { path, base, against } };

      return failed(
        BASE_FAILED[made.exit] ?? 'worktree-failed',
        `Before's worktree ${path}: ${said(made, 'git')}`,
      );
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
    attach: (id) => {
      const client = [...tmuxCmd, 'attach-session', '-t', `=abe-${id}`];

      return o.execVia === undefined
        ? [...o.attachVia, ...client]
        : [
            'bash',
            '-c',
            ATTACH_SCRIPT,
            'bash',
            String(o.attachVia.length),
            ...o.attachVia,
            String(o.execVia.length),
            ...o.execVia,
            home,
            ...client,
          ];
    },
    stop: async (id) => {
      await o.exec(['rm', '-f', '--', `${files(id)}/env`]);
      const killed = await tmux('kill-session', '-t', `=abe-${id}`);
      return killed.exit === 0 || sessionGone(killed.stderr)
        ? { ok: true, data: null }
        : failed('tmux-failed', said(killed, 'tmux'));
    },
    running: async () => {
      const listed = await tmux('list-sessions', '-F', '#{session_name}');

      // A container that stopped took its sessions with it.
      if (listed.exit !== 0)
        return gone(listed.stderr)
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
    attached: async () => {
      const listed = await tmux('list-clients', '-F', 'c');

      return listed.exit === 0 && listed.stdout.includes('c');
    },
  };
};

/** `docker exec` into the workspace container; a refusal of Docker's is its exit 125. */
export const containerExec =
  (docker: Docker, container: string): ContainerExec =>
  async (argv, o) => {
    try {
      const user = o?.root === true ? 'root' : o?.user;

      return await docker.exec(container, argv, o?.stdin, {
        ...(user === undefined ? {} : { user }),
        ...(o?.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
      });
    } catch (err) {
      return { exit: 125, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }
  };
