/** The demo's row of the command table: `abe demo new`. */
import { command } from '../command';
import { DemoNewData, demoNewText } from './demo';

export const DEMO_COMMANDS = {
  'demo new': command({
    noun: 'demo',
    verb: 'new',
    summary:
      'your own demo repo: the bundled demo app copied to a folder (default ~/projects/demo-shop) with a first commit, pushed to a new private <your gh login>/demo-shop (or --name) on GitHub, its cards made issues there; refused when the folder or the repo is there already',
    inSession: false,
    args: {
      folder: {
        kind: 'positional',
        type: 'string',
        required: false,
        summary: 'where it goes (default ~/projects/<name>); it must not exist yet',
      },
      name: {
        kind: 'flag',
        type: 'string',
        summary: 'the repo under your gh login (default demo-shop); it must not exist yet',
      },
    },
    result: DemoNewData,
    text: demoNewText,
    waits: 'GitHub',
  }),
};
