/**
 * `abe workspace attach-spec` (#74): what VimStorm runs to open a session's workspace in the
 * Editor. The shell only changes how it spawns, never decides where: Neovim (`nvim`, `--embed`
 * over stdio; the shell adds its own `--cmd` and the files to open), terminal tabs (`shell`) and
 * the tree's listings and git (`exec`, a prefix before the command) come from here.
 *
 * Local: plain argv, the worktree opened as a project as in 1.0. Cloud: each through
 * `abe box attach <box> -- …` to the Workspace's own box (ADR 0021: SSH through its EC2 Instance
 * Connect Endpoint), which runs it on the box's host; the clone and its tools are in the
 * workspace container, so each goes on through `docker exec` as the container's user (#89).
 * `exec` goes with `--shared` (#93): one SSH connection per box carries its calls.
 */
import { z } from 'zod';
import { CONTAINER } from '../box/box-session';

export const AttachSpec = z.object({
  where: z.enum(['local', 'cloud']),
  /** The workspace's folder where its Neovim runs: the worktree, or the box's clone. */
  root: z.string(),
  /** Starts an embedded Neovim on stdio. */
  nvim: z.array(z.string()).min(1),
  /** Starts a terminal tab's shell; a cloud one asks for a terminal (`docker exec -t`): run it in a PTY. */
  shell: z.array(z.string()).min(1),
  /** Put before a command (`git …`, the tree's listing) to run it where the workspace is; [] here. */
  exec: z.array(z.string()),
  /** The Workspace's box and its region (null: aws's own); null for a local session. */
  box: z.object({ name: z.string(), region: z.string().nullable() }).nullable(),
  /** The Mac does not know the box to be running: the attach wakes it first. */
  waking: z.boolean(),
});
export type AttachSpec = z.infer<typeof AttachSpec>;

export type AttachInput =
  | { where: 'local'; root: string; shell: string }
  | {
      where: 'cloud';
      root: string;
      box: string;
      region: string | null;
      /** `abe box attach` as this `abe` runs it. */
      boxAttach: readonly string[];
      /** The session's card's workspace container on the box (`workspaceNames`, ADR 0022). */
      container: string;
      waking: boolean;
    };

/**
 * `argv` prefix that runs a command in `box`'s `container` (a card's workspace on it, ADR 0022):
 * `abe box attach <box> --` (the box's host), then `docker exec` as the session user. stdin is always kept (git, a tar, an
 * embedded Neovim on stdio); `tty` only for a terminal (the attach gives ssh one only when its
 * own stdin is one); `cwd` and `env` as `docker exec`'s `-w` / `-e`. `shared` (#93): over the
 * box's one shared SSH connection (`--shared`), for short commands: a round trip, no handshake.
 */
export const inWorkspace = (
  boxAttach: readonly string[],
  box: string,
  container: string,
  o: { tty?: boolean; cwd?: string; env?: readonly string[]; shared?: boolean } = {},
): string[] => [
  ...boxAttach,
  box,
  ...(o.shared === true ? ['--shared'] : []),
  '--',
  'docker',
  'exec',
  '-i',
  ...(o.tty === true ? ['-t'] : []),
  '-u',
  CONTAINER.user,
  ...(o.cwd === undefined ? [] : ['-w', o.cwd]),
  ...(o.env ?? []).flatMap((e) => ['-e', e]),
  container,
];

export const attachSpecOf = (i: AttachInput): AttachSpec => {
  if (i.where === 'local')
    return {
      where: 'local',
      root: i.root,
      nvim: ['nvim', '--embed'],
      shell: [i.shell, '-l'],
      exec: [],
      box: null,
      waking: false,
    };
  return {
    where: 'cloud',
    root: i.root,
    // The workspace image's VimStorm config, under its own app name as on the Mac.
    nvim: [
      ...inWorkspace(i.boxAttach, i.box, i.container, {
        cwd: i.root,
        env: ['NVIM_APPNAME=vimstorm'],
      }),
      'nvim',
      '--embed',
    ],
    shell: [
      ...inWorkspace(i.boxAttach, i.box, i.container, { tty: true, cwd: i.root }),
      'bash',
      '-l',
    ],
    // The tree's listings and git: many short calls, each a round trip on the shared connection.
    exec: inWorkspace(i.boxAttach, i.box, i.container, { shared: true }),
    box: { name: i.box, region: i.region },
    waking: i.waking,
  };
};

export const attachSpecText = (s: AttachSpec): string =>
  `${s.where}  ${s.root}${s.box === null ? '' : `  on ${s.box.name}`}${s.waking ? ' (waking)' : ''}\n`;
