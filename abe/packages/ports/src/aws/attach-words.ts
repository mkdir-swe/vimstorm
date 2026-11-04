/**
 * The words of `abe box attach`'s loop (#91), kept out of the package's exports: what ssh runs on
 * the box, and what the attach says while its box is not up yet.
 */
import { CONTAINER, LABEL, shellWord } from '@abe/core';

export type AttachWhat =
  /** The session's terminal on the box: its `abe session attach <id>` (tmux, kept across drops). */
  | { session: string }
  /** A command on the box; `shared`: on the box's one shared SSH connection when it needs no terminal (#93). */
  | { command: readonly string[]; shared?: boolean }
  /**
   * A login shell in a workspace container (`card`'s, else the first running one); the box's
   * own while none runs there.
   */
  | { shell: true; card?: string };

/** The line a `--` command's box writes on stderr before it runs the command. */
export const BEGAN = 'abe-box-attach:began';

/**
 * What the attach says while its box is not up yet, by the state the refusal names (`box x is
 * starting · …`, `boxReachText`): starting, it waits for it; asleep, `Waking <box>…` (#104
 * Behaviour 5).
 */
export const wakingLine = (box: string, refusal: string): string =>
  /\bis starting\b/.test(refusal) ? `${box} is starting, waiting for it…` : `Waking ${box}…`;

/**
 * A login shell where the work is (#104 Behaviour 5, #244): a workspace container's as its user
 * in the clone, as VimStorm's terminal tabs open it (`attachSpecOf`'s `shell`): `card`'s, else the
 * first one running (a box holds one per card, ADR 0022); while none runs there, the box's own
 * login shell, said so (`-- bash -l` is that one asked for). The words go through the box's shell
 * (ssh joins them). With a command sshd shows no login banner.
 */
const workspaceShell = (card: string | undefined): readonly string[] => [
  'c=$(docker ps',
  '--filter',
  shellWord(`label=${LABEL.role}=workspace`),
  ...(card === undefined ? [] : ['--filter', shellWord(`label=${LABEL.card}=${card}`)]),
  "--format '{{.Names}}' 2>/dev/null | head -n 1);",
  'if [ -n "$c" ]; then exec docker exec -it -u',
  shellWord(CONTAINER.user),
  '-w',
  shellWord(CONTAINER.workdir),
  '"$c" bash -l; fi;',
  `echo ${shellWord(`abe: no workspace container ${card === undefined ? '' : `of card ${card} `}answers on this box: its own shell`)} >&2; exec bash -l`,
];

/**
 * The words ssh runs on the box. A `--` command without a terminal writes the began mark on
 * stderr first (taken out again; it says the command may have run, so a drop is not retried); one
 * with a terminal has none: the pty merges the box's stderr into the screen (#89). A terminal's
 * command is run again on a drop (a shell starts afresh), so a one-shot command given a terminal
 * may run twice.
 */
export const remoteOf = (what: AttachWhat, tty: boolean): readonly string[] => {
  if ('session' in what)
    return ['abe', 'session', 'attach', what.session, '--no-start'].map(shellWord);
  if ('command' in what)
    return tty
      ? what.command.map(shellWord)
      : [`printf '%s\\n' ${BEGAN} >&2;`, ...what.command.map(shellWord)];

  // `abe box attach` refuses a --card that is no card id before it gets here.
  return workspaceShell(what.card);
};
