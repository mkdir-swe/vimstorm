/** Sheets' rows of the command table: `abe sheet` and `card show`, a card with its Sheets. */
import { CARD_ID } from '../board';
import { command } from '../command';
import {
  CardShowData,
  SheetAttachData,
  SheetFindData,
  SheetListData,
  SheetOpenData,
  SheetSaveData,
  SheetShowData,
  cardShowText,
  sheetAttachText,
  sheetFindText,
  sheetListText,
  sheetSaveText,
  sheetShowText,
} from './sheets';

const SHEET_REF = {
  kind: 'positional',
  type: 'string',
  required: true,
  summary: 'the Sheet: its id or title, or <card>/<id> for one attached to a card',
} as const;

const SHEET_VERSION = {
  kind: 'flag',
  type: 'number',
  summary: 'the version (default: the newest)',
} as const;

/** What `list` and `find` put first; the box's workspace card when not given. */
const CONTEXT = {
  card: { kind: 'flag', type: 'string', summary: 'the current card: its Sheets first' },
  session: { kind: 'flag', type: 'string', summary: 'the current session: its Sheets first' },
} as const;

export const SHEET_COMMANDS = {
  'card show': command({
    noun: 'card',
    verb: 'show',
    summary:
      'a card: title, state, type, tags, assignee, description, acceptance criteria, comments, Sheets',
    inSession: true,
    inWorkspace: 'session',
    args: { id: CARD_ID },
    result: CardShowData,
    text: cardShowText,
  }),
  'sheet save': command({
    noun: 'sheet',
    verb: 'save',
    summary: 'keep a self-contained HTML page as your Sheet (the same title again: a new version)',
    inSession: true,
    inWorkspace: 'session',
    args: {
      title: { kind: 'flag', type: 'string', required: true, summary: 'the title, one line' },
      card: { kind: 'flag', type: 'string', summary: 'the card it is for: its id (`4`, `AB#4`)' },
      session: { kind: 'flag', type: 'string', summary: 'the session making it' },
      file: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: 'the page, relative to where abe runs; nothing in it may reach outside it',
      },
    },
    result: SheetSaveData,
    text: sheetSaveText,
  }),
  'sheet list': command({
    noun: 'sheet',
    verb: 'list',
    summary: "your Sheets: the current card's and session's first, then newest first",
    inSession: true,
    inWorkspace: 'session',
    args: CONTEXT,
    result: SheetListData,
    text: sheetListText,
  }),
  'sheet find': command({
    noun: 'sheet',
    verb: 'find',
    summary: "your Sheets whose title or id fuzzy-match, the current card's and session's first",
    inSession: true,
    inWorkspace: 'session',
    args: {
      name: {
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary: 'the name, as words (`cart totals`)',
      },
      ...CONTEXT,
    },
    result: SheetFindData,
    text: sheetFindText,
  }),
  'sheet show': command({
    noun: 'sheet',
    verb: 'show',
    summary: 'one of your Sheets: its file, title, card, versions and where it is attached',
    inSession: true,
    inWorkspace: 'session',
    args: { id: SHEET_REF, version: SHEET_VERSION },
    result: SheetShowData,
    text: sheetShowText,
  }),
  'sheet attach': command({
    noun: 'sheet',
    verb: 'attach',
    summary:
      'attach your Sheet to a card: its newest version to the org store, listed by `card show`',
    inSession: true,
    args: {
      id: SHEET_REF,
      card: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: 'the card: its id (`4`, `AB#4`)',
      },
    },
    result: SheetAttachData,
    text: sheetAttachText,
  }),
  'sheet open': command({
    noun: 'sheet',
    verb: 'open',
    summary: 'a local URL serving the Sheet with no network: yours, or one attached to a card',
    inSession: true,
    args: { id: SHEET_REF, version: SHEET_VERSION },
    result: SheetOpenData,
    says: 'url',
  }),
};
