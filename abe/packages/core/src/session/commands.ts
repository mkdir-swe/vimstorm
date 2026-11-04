/** Sessions' rows of the command table: `abe session`, `chat`, `hook` and `workspace attach-spec`. */
import { SHORT_ANSWERS, command } from '../command';
import { EFFORTS } from '../layer';
import { SessionAnswerData, SessionAsksData, sessionAnswerText, sessionAsksText } from './ask';
import { HubData, hubText } from './hub';
import { AttachSpec, attachSpecText } from './attach';
import { SessionMoveData, sessionMoveText } from './move';
import { SessionSkillsData, sessionSkillsText } from './slash-skills';
import {
  HookData,
  SessionAttachData,
  SessionData,
  SessionListData,
  SessionModelData,
  SessionSendData,
  SessionUnqueueData,
  sessionAttachText,
  launchSharedNote,
  sessionListNote,
  sessionListText,
  sessionModelText,
  sessionSendText,
  sessionStopText,
  sessionText,
  sessionUnqueueText,
} from './session';
import {
  SessionRevertData,
  SessionTranscriptData,
  sessionRevertText,
  sessionTranscriptText,
} from './transcript';

/** `--profile <name>`: a browser profile (#103). */
export const PROFILE_FLAG = (summary: string) => ({
  kind: 'flag' as const,
  type: 'string' as const,
  summary,
});

export const SESSION_ID_ARG = {
  kind: 'positional',
  type: 'string',
  required: true,
  summary: 'the session: its id (`4-a1b2`)',
} as const;

export const SESSION_COMMANDS = {
  'workspace attach-spec': command({
    noun: 'workspace',
    verb: 'attach-spec',
    summary:
      "what VimStorm runs to open a session's workspace: Neovim, terminal tabs and a command prefix, plain for a local session, through abe box attach for a cloud one",
    inSession: false,
    args: { session: SESSION_ID_ARG },
    result: AttachSpec,
    text: attachSpecText,
  }),
  'session launch': command({
    noun: 'session',
    verb: 'launch',
    summary:
      "start claude on a card where serve.target says: locally a worktree and tmux, in the cloud the card's box",
    inSession: false,
    args: {
      card: { kind: 'flag', type: 'string', required: true, summary: 'the card (`4`, `AB#4`)' },
      repo: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary:
          'the git checkout to branch from, relative to where abe runs (for the cloud also `owner/repo`)',
      },
      profile: PROFILE_FLAG(
        'the browser profile its verify browser starts in (default: browser.default); one with nothing stored is refused',
      ),
      note: {
        kind: 'flag',
        type: 'string',
        summary:
          "your Launch note: words the agent reads after the card's (at most 2000 characters)",
      },
      noteFile: {
        kind: 'flag',
        type: 'string',
        summary: 'your Launch note from a file, relative to where abe runs (not with --note)',
      },
      short: {
        kind: 'flag',
        type: 'string',
        values: SHORT_ANSWERS,
        summary:
          "a cloud launch onto its repo's box short of memory or disk (refused box-short): resize (to the next size, stopping the box first) or anyway",
      },
    },
    result: SessionData,
    text: sessionText,
    note: launchSharedNote,
  }),
  'session list': command({
    noun: 'session',
    verb: 'list',
    summary: 'every session this abe serve knows and where it stands (inside one: only it)',
    waits: 'EC2 for your boxes (the aws CLI)',
    inSession: true,
    inWorkspace: 'session',
    args: {},
    result: SessionListData,
    text: sessionListText,
    note: sessionListNote,
  }),
  'session show': command({
    noun: 'session',
    verb: 'show',
    summary: "a session: its state and since when, its transcript, claude's last message",
    inSession: true,
    inWorkspace: 'session',
    args: { id: SESSION_ID_ARG },
    result: SessionData,
    text: sessionText,
  }),
  'session send': command({
    noun: 'session',
    verb: 'send',
    summary: "type a message into a session's claude and press Enter",
    // Only a person sends: a typed prompt is the person answering Needs you, never the agent's.
    inSession: false,
    args: {
      id: SESSION_ID_ARG,
      text: {
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary: 'the message, quoted or as words',
      },
      context: {
        kind: 'flag',
        type: 'string',
        summary:
          'its implicit context as JSON: {path, from, to[, lines]} a selection, {path, line} the caret, {card, title} a card',
      },
    },
    result: SessionSendData,
    text: sessionSendText,
  }),
  'session answer': command({
    noun: 'session',
    verb: 'answer',
    summary:
      "answer a session's card: a question or grill round as its next prompt, a held permission as its decision",
    // Only a person answers: the answer is theirs, as `session send` is.
    inSession: false,
    args: {
      id: SESSION_ID_ARG,
      card: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: "the card's id (`session asks`); a grill round's id or any card of it",
      },
      option: {
        kind: 'flag',
        type: 'number',
        repeats: true,
        summary: "the option's number; given once per card for a grill round, in its order",
      },
      text: { kind: 'flag', type: 'string', summary: 'your own words instead of an option' },
      answers: {
        kind: 'flag',
        type: 'string',
        summary: 'a grill round\'s answers as JSON, in its order: [1, "own words", 3]',
      },
      pick: {
        kind: 'flag',
        type: 'string',
        summary:
          'one grill question\'s pick, kept until the round is sent: <n>:<option> or <n>:"own words"',
      },
    },
    result: SessionAnswerData,
    text: sessionAnswerText,
  }),
  'session asks': command({
    noun: 'session',
    verb: 'asks',
    summary: "a session's open cards (questions, grill rounds, held permissions), oldest first",
    inSession: false,
    args: { id: SESSION_ID_ARG },
    result: SessionAsksData,
    text: sessionAsksText,
  }),
  'session unqueue': command({
    noun: 'session',
    verb: 'unqueue',
    summary: 'take back a message queued while the session works',
    // A person's, as the message was.
    inSession: false,
    args: {
      id: SESSION_ID_ARG,
      n: {
        kind: 'positional',
        type: 'number',
        required: true,
        summary: 'the queued message: its number (`abe session show`)',
      },
    },
    result: SessionUnqueueData,
    text: sessionUnqueueText,
  }),
  'session model': command({
    noun: 'session',
    verb: 'model',
    summary: "switch a session's model (Claude Code's /model) and effort (/effort)",
    inSession: false,
    args: {
      id: SESSION_ID_ARG,
      model: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: 'the model, one allowedModels allows',
      },
      effort: { kind: 'flag', type: 'string', values: EFFORTS, summary: 'the effort' },
    },
    result: SessionModelData,
    text: sessionModelText,
  }),
  'session skills': command({
    noun: 'session',
    verb: 'skills',
    summary:
      "the skills a session's Claude Code loads, as Chat's / menu lists them: Abe's (/abe:<name>), the repo's and, when it loads them, yours (/<name>)",
    inSession: false,
    args: { id: SESSION_ID_ARG },
    result: SessionSkillsData,
    text: sessionSkillsText,
  }),
  'session attach': command({
    noun: 'session',
    verb: 'attach',
    summary: "put this terminal in a session's claude (tmux attach; detach with Ctrl-b d)",
    inSession: false,
    // Without --json the client runs the attach in its own terminal.
    only: 'client',
    args: { id: SESSION_ID_ARG },
    result: SessionAttachData,
    text: sessionAttachText,
  }),
  'session stop': command({
    noun: 'session',
    verb: 'stop',
    summary: "stop a session's claude; its worktree and branch stay",
    inSession: true,
    risky: true,
    args: { id: SESSION_ID_ARG },
    result: SessionData,
    text: sessionStopText,
  }),
  'session reopen': command({
    noun: 'session',
    verb: 'reopen',
    summary:
      'go back into an ended session: the same worktree (made again from its branch when it was cleared) and the same Claude Code conversation; a run not over goes on at its stage',
    // A person's: an agent never wakes a session.
    inSession: false,
    args: {
      id: SESSION_ID_ARG,
      message: {
        kind: 'flag',
        type: 'string',
        summary: 'its first prompt (default: none; a run not over is told to go on)',
      },
      short: {
        kind: 'flag',
        type: 'string',
        values: SHORT_ANSWERS,
        summary:
          'onto its box running short of memory or disk (refused box-short): resize (to the next size, stopping the box first) or anyway',
      },
    },
    result: SessionData,
    text: sessionText,
  }),
  'session transcript': command({
    noun: 'session',
    verb: 'transcript',
    summary:
      "a session's transcript as Chat draws it: your messages, the agent's words, its tool calls and their results, each turn's changes",
    inSession: true,
    args: {
      id: SESSION_ID_ARG,
      since: {
        kind: 'flag',
        type: 'number',
        summary: "only the entries from this number on (a `session.transcript` event's `from`)",
      },
    },
    result: SessionTranscriptData,
    text: sessionTranscriptText,
  }),
  'session revert': command({
    noun: 'session',
    verb: 'revert',
    summary:
      "put a turn's files back as they were when it started (refused when one changed since the turn)",
    // A person's: the agent undoes its own work with its own tools.
    inSession: false,
    risky: true,
    args: {
      id: SESSION_ID_ARG,
      turn: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: "the turn: its message's entry id (a `changes` entry's `turn`)",
      },
      file: {
        kind: 'flag',
        type: 'string',
        summary: 'only this file of the turn (relative to the worktree, or its full path)',
      },
    },
    result: SessionRevertData,
    text: sessionRevertText,
  }),
  'session download': command({
    noun: 'session',
    verb: 'download',
    summary:
      "recovery: copy a cloud session's Workspace to this machine (commits, changes, untracked files, .scratch, the transcript) and go on with it here, reads only; its box is stopped",
    inSession: false,
    args: {
      id: SESSION_ID_ARG,
      repo: {
        kind: 'flag',
        type: 'string',
        summary:
          "this machine's checkout of the session's repo, relative to where abe runs (default: here)",
      },
    },
    result: SessionMoveData,
    text: sessionMoveText,
  }),
  'session move-to-cloud': command({
    noun: 'session',
    verb: 'move-to-cloud',
    summary:
      "recovery: copy a local session's worktree into a Workspace on its own box and go on with it there (queued past your box limit); the worktree stays as it is",
    inSession: false,
    args: {
      id: SESSION_ID_ARG,
      short: {
        kind: 'flag',
        type: 'string',
        values: SHORT_ANSWERS,
        summary:
          "onto its repo's box running short of memory or disk (refused box-short, before its claude stops): resize (to the next size, stopping the box first) or anyway",
      },
    },
    result: SessionMoveData,
    text: sessionMoveText,
  }),
  chat: command({
    noun: 'chat',
    summary:
      "the repo's Abe chat (on this machine, unjailed): opened in its main checkout, the conversation running or the last one reopened; --new starts another beside it; words: said to it as your message",
    // The person's, from Chat or the `:` line: never an agent's.
    inSession: false,
    args: {
      words: {
        kind: 'positional',
        type: 'string',
        repeats: true,
        summary: 'what you say to it, as a message',
      },
      new: { kind: 'flag', type: 'boolean', summary: 'a new conversation' },
      shown: {
        kind: 'flag',
        type: 'string',
        summary:
          'only mark this conversation (its session id) the one Chat shows: `abe chat` opens it from then on, nothing opened or said',
      },
      repo: {
        kind: 'flag',
        type: 'string',
        summary:
          'the repo (its main checkout, or a worktree of it), relative to where abe runs (default: here)',
      },
    },
    result: HubData,
    text: hubText,
  }),
  hook: command({
    noun: 'hook',
    summary: "Claude Code's hook: the event's JSON on stdin to the session's socket, always exit 0",
    // Claude Code runs it inside the session; it is answered only on a session's socket.
    inSession: true,
    inWorkspace: 'session',
    only: 'session',
    args: {
      event: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the hook event (`Stop`, `PreToolUse` …)',
      },
      payload: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: "the event's JSON, as the hook read it from stdin (the hook client sets it)",
      },
    },
    result: HookData,
  }),
};
