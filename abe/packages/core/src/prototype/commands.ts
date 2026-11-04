/** Prototypes' rows of the command table: `abe prototype`. */
import { command } from '../command';
import { DiscardData, discardText } from './code-prototype';
import { MakeCardData, makeCardText } from './make-card';
import {
  PrototypeData,
  PrototypeListData,
  PrototypeShowData,
  ScreenshotData,
  prototypeListText,
  prototypeShowText,
  prototypeText,
  screenshotAddText,
} from './prototype';

const PROTOTYPE_FLAG = {
  kind: 'flag',
  type: 'string',
  summary: 'the prototype (`proto-1a2b3c`); default: the one that runs',
} as const;

export const PROTOTYPE_COMMANDS = {
  'prototype start': command({
    noun: 'prototype',
    verb: 'start',
    summary:
      "a prototype session (`/abe:prototype` in the Abe chat): real code in a throwaway worktree proto/<card or id>-<slug> (no upstream, every push refused) by a Claude Code session with the prototype skill, jailed as a card's, and the app run from it behind the prototype proxy (its url the preview link, once live); where cards run (serve.target); the one open already for the card when there is one",
    // The person's (the Abe chat's requests are theirs): never a session's.
    inSession: false,
    args: {
      words: {
        kind: 'positional',
        type: 'string',
        repeats: true,
        summary: "what to try, in your words: the session's first message",
      },
      repo: {
        kind: 'flag',
        type: 'string',
        summary:
          'the git checkout whose app it is, relative to where abe runs (default: the one abe runs in)',
      },
      card: { kind: 'flag', type: 'string', summary: 'the card it is for (`4`, `AB#4`)' },
    },
    result: PrototypeData,
    text: prototypeText,
  }),

  'prototype screenshot add': command({
    noun: 'prototype',
    verb: 'screenshot add',
    summary: 'keep a PNG screenshot of the prototype with what it shows: make-card uploads it',
    inSession: true,
    args: {
      file: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: 'the PNG, relative to where abe runs',
      },
      what: { kind: 'flag', type: 'string', required: true, summary: 'what it shows, one line' },
      id: PROTOTYPE_FLAG,
    },
    result: ScreenshotData,
    text: screenshotAddText,
  }),

  'prototype make-card': command({
    noun: 'prototype',
    verb: 'make-card',
    summary:
      "make a card of a prototype: a new card (New, tagged prototype) with your title and description, its `## Prototype` section linking the prototype; its diff and screenshots uploaded to the org store as the card's reference, which the card's runs read. From the prototype's own session, or by you",
    inSession: true,
    args: {
      id: PROTOTYPE_FLAG,
      title: { kind: 'flag', type: 'string', required: true, summary: "the card's title" },
      description: {
        kind: 'flag',
        type: 'string',
        summary: 'its description (markdown: why, what, acceptance criteria), in place of a file',
      },
      descriptionFile: {
        kind: 'flag',
        type: 'string',
        summary: 'a file holding its description (markdown)',
      },
    },
    result: MakeCardData,
    text: makeCardText,
  }),
  'prototype discard': command({
    noun: 'prototype',
    verb: 'discard',
    summary:
      'throw a prototype away: its session and app stopped, its worktree and proto/ branch removed, uncommitted work too',
    inSession: false,
    risky: true,
    args: {
      id: {
        kind: 'positional',
        type: 'string',
        summary: 'the prototype (`proto-1a2b3c`); default: the one that runs',
      },
    },
    result: DiscardData,
    text: discardText,
  }),
  'prototype stop': command({
    noun: 'prototype',
    verb: 'stop',
    summary:
      "stop a prototype's app and proxy; its worktree and session stay (discard throws them away)",
    inSession: true,
    args: { id: PROTOTYPE_FLAG },
    result: PrototypeData,
    text: prototypeText,
  }),
  'prototype restart': command({
    noun: 'prototype',
    verb: 'restart',
    summary:
      "start a prototype's app again (stopped first while it runs): a stopped or failed one's too; on a box its session starts it",
    inSession: true,
    args: { id: PROTOTYPE_FLAG },
    result: PrototypeData,
    text: prototypeText,
  }),
  'prototype show': command({
    noun: 'prototype',
    verb: 'show',
    summary:
      "a prototype's diff by file, its screenshots, its app's output and what its proxy refused (its tile's Code and Logs pages)",
    inSession: true,
    args: { id: PROTOTYPE_FLAG },
    result: PrototypeShowData,
    text: prototypeShowText,
  }),
  'prototype list': command({
    noun: 'prototype',
    verb: 'list',
    summary:
      'your prototypes: where each stands, its preview url while live, its session and worktree',
    inSession: true,
    args: {},
    result: PrototypeListData,
    text: prototypeListText,
  }),
};
