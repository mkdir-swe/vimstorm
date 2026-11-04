/** Triage's rows of the command table: `abe triage`. */
import { command } from '../command';
import {
  TriageApplyData,
  TriageData,
  TriageLaunchData,
  triageApplyText,
  triageLaunchText,
  triageText,
} from './triage';

export const TRIAGE_COMMANDS = {
  triage: command({
    noun: 'triage',
    summary:
      'a verdict per backlog item (cards not running, the repo’s open issues): ready for agent, needs info, too big, not for agent; writes nothing',
    // A one-shot of the person's: not an agent's to start from its session.
    inSession: false,
    args: {
      team: {
        kind: 'flag',
        type: 'boolean',
        summary: "the team's whole backlog (default: your cards this sprint)",
      },
      repo: {
        kind: 'flag',
        type: 'string',
        summary:
          "<owner/repo> whose open issues to read (default: the checkout's origin on GitHub)",
      },
    },
    result: TriageData,
    text: triageText,
  }),
  'triage apply': command({
    noun: 'triage',
    verb: 'apply',
    summary:
      "ask the last triage's needs-info cards their question: one Azure comment and the needs-info tag each, once",
    inSession: false,
    args: {
      id: {
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary: 'the items: card ids (`4`, `AB#4`)',
      },
    },
    result: TriageApplyData,
    text: triageApplyText,
  }),
  'triage launch': command({
    noun: 'triage',
    verb: 'launch',
    summary:
      "a Factory run for each of the last triage's ready cards named: started, Queued past the team's box limit, or refused",
    inSession: false,
    args: {
      id: {
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary: 'the items: card ids (`4`, `AB#4`)',
      },
    },
    result: TriageLaunchData,
    text: triageLaunchText,
  }),
};
