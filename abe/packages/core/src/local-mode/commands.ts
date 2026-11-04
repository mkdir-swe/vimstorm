/** Local mode's rows of the command table: `abe local` and `board read-only` / `board discard`. */
import { command } from '../command';
import {
  BoardDiscardData,
  BoardReadOnlyData,
  LocalModeView,
  LocalPrData,
  LocalSetData,
  boardDiscardText,
  boardReadOnlyText,
  localPrText,
  localSetText,
  localStatusText,
} from './local-mode';

export const LOCAL_MODE_COMMANDS = {
  'local status': command({
    noun: 'local',
    verb: 'status',
    summary:
      "local mode where abe runs: on or off, the writes held on this machine (newest first), the local pull requests and the cards' local states",
    inSession: true,
    args: {},
    result: LocalModeView,
    text: localStatusText,
  }),
  'local on': command({
    noun: 'local',
    verb: 'on',
    summary:
      'local mode on for this checkout (your Layer): reads as usual, every write held on this machine, agents here only',
    inSession: false,
    args: {},
    result: LocalSetData,
    text: localSetText,
  }),
  'local off': command({
    noun: 'local',
    verb: 'off',
    summary:
      'local mode off for this checkout: writes go out from now on; the held ones stay a record, never sent',
    inSession: false,
    args: {},
    result: LocalSetData,
    text: localSetText,
  }),
  'local merge': command({
    noun: 'local',
    verb: 'merge',
    summary:
      'merge a local pull request into the local base, a squash commit on this machine (a person merges: not from inside a session)',
    inSession: false,
    risky: true,
    args: {
      pr: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the local pull request: L<n>',
      },
    },
    result: LocalPrData,
    text: localPrText,
  }),
  'local discard': command({
    noun: 'local',
    verb: 'discard',
    summary: 'discard a local pull request: closed unmerged, its branch kept',
    inSession: false,
    args: {
      pr: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the local pull request: L<n>',
      },
    },
    result: LocalPrData,
    text: localPrText,
  }),
  'board read-only': command({
    noun: 'board',
    verb: 'read-only',
    summary:
      'the board read-only for this checkout (your Layer), on or off: Abe reads the real board, and every change stays on this machine, drawn over its cards, never sent (local mode makes it read-only too); a session only turns it on',
    inSession: true,
    args: {
      state: {
        kind: 'positional',
        type: 'string',
        required: true,
        values: ['on', 'off'],
        summary: 'on or off',
      },
    },
    result: BoardReadOnlyData,
    text: boardReadOnlyText,
  }),
  'board discard': command({
    noun: 'board',
    verb: 'discard',
    summary:
      'Discard local changes: the board changes held on this machine for this checkout dropped (moves, comments, edits, tags, cards made here); the board shows as it is. Nothing is sent',
    inSession: false,
    risky: true,
    args: {},
    result: BoardDiscardData,
    text: boardDiscardText,
  }),
};
