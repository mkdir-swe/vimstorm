/** Improve's rows of the command table: `abe improve` and `log`. */
import { command } from '../command';
import { SESSION_ID_ARG } from '../session';
import {
  ImproveApplyData,
  ImproveData,
  ImproveSuggestData,
  ImproveUndoData,
  improveApplyText,
  improveSuggestText,
  improveText,
  improveUndoText,
} from './improve';
import { LogListData, LogShipData, logListText, logShipText } from './logs';
import {
  RETRO_SCOPES,
  RetroData,
  RetroMakeData,
  RetroRecord,
  retroMakeText,
  retroText,
} from './retro';

export const IMPROVE_COMMANDS = {
  improve: command({
    noun: 'improve',
    summary:
      "ask an agent to change VimStorm for you: a proposal to your personal Layer (settings, keys, commands, skills; Neovim config for developers), nothing written; a wish that needs VimStorm's code becomes a VimStorm issue",
    // A one-shot of the person's, on their own Layer: not an agent's from its session.
    inSession: false,
    args: {
      wish: {
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary:
          'what you want VimStorm to do differently, in your words (quote it when it starts with apply, undo or suggest)',
      },
      again: {
        kind: 'flag',
        type: 'string',
        summary:
          'a proposal (`imp-1a2b3c`) the wish changes: the agent sees its files and answers one in its place',
      },
    },
    result: ImproveData,
    text: improveText,
  }),
  'improve apply': command({
    noun: 'improve',
    verb: 'apply',
    summary: "write a proposal's files to your personal Layer; abe improve undo takes it back",
    inSession: false,
    args: {
      id: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the proposal (`imp-1a2b3c`)',
      },
    },
    result: ImproveApplyData,
    text: improveApplyText,
  }),
  'improve undo': command({
    noun: 'improve',
    verb: 'undo',
    summary:
      'put your personal Layer back as it was before the last apply; again goes one further back (up to 20)',
    inSession: false,
    args: {
      force: {
        kind: 'flag',
        type: 'boolean',
        summary: 'put it back even over changes made to those files since the apply',
      },
    },
    result: ImproveUndoData,
    text: improveUndoText,
  }),
  'improve suggest': command({
    noun: 'improve',
    verb: 'suggest',
    summary:
      'Improve suggests one change by itself: only with improve.suggest on, at most once in 24 hours',
    inSession: false,
    args: {},
    result: ImproveSuggestData,
    text: improveSuggestText,
  }),
  'improve retro': command({
    noun: 'improve',
    verb: 'retro',
    summary:
      'findings from the session logs since the last retro of the scope, most severe first, each traced to log moments and naming its Layer; applies nothing',
    // A one-shot of the person's over everyone's logs: not an agent's to start from its session.
    inSession: false,
    args: {
      scope: {
        kind: 'positional',
        type: 'string',
        values: RETRO_SCOPES,
        required: true,
        summary: 'whose sessions: me (yours in this repo)',
      },
      since: {
        kind: 'flag',
        type: 'string',
        summary: 'read sessions moved after this time (RFC 3339) instead of the last retro’s',
      },
    },
    result: RetroData,
    text: retroText,
  }),
  'improve retro make': command({
    noun: 'improve',
    verb: 'retro make',
    summary:
      "a finding's fix written into this checkout, uncommitted (--pr: as one pull request instead); a Send to Abe one its issue; a personal one an abe improve proposal",
    // The person's, or the Abe chat's (/abe:retro) once the person said which: never a session's.
    inSession: false,
    args: {
      finding: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: "the finding's number in the retro",
      },
      pr: {
        kind: 'flag',
        type: 'boolean',
        summary: 'a repo fix: open it as one pull request instead of writing it into this checkout',
      },
      file: {
        kind: 'flag',
        type: 'boolean',
        summary:
          'a Send to Abe finding: file its issue; only once the person saw its whole body and said File it (without it, refused not-confirmed)',
      },
      retro: {
        kind: 'flag',
        type: 'string',
        summary: 'the retro (its id); default: the last one',
      },
    },
    result: RetroMakeData,
    text: retroMakeText,
  }),
  'improve retro last': command({
    noun: 'improve',
    verb: 'retro last',
    summary: 'the last retro: its findings, earlier fixes and what was made of them',
    inSession: false,
    args: {},
    result: RetroRecord,
    text: retroText,
  }),
  'log ship': command({
    noun: 'log',
    verb: 'ship',
    summary:
      "ship a session's logs to the log store now, redacted (serve also does every 5 min and at its end)",
    inSession: false,
    args: { id: SESSION_ID_ARG },
    result: LogShipData,
    text: logShipText,
  }),
  'log list': command({
    noun: 'log',
    verb: 'list',
    summary: 'the sessions whose logs are in the log store, by repo and user',
    inSession: false,
    args: {
      repo: { kind: 'flag', type: 'string', summary: "only this repo's (<owner/repo>)" },
      user: { kind: 'flag', type: 'string', summary: "only this GitHub login's" },
    },
    result: LogListData,
    text: logListText,
  }),
};
