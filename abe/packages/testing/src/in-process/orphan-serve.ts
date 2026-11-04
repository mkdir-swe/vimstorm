/**
 * A test file's process that dies without its `close()`. It starts a `serve` through the CLI seam,
 * prints its pid and state folder, and exits failing, as a crashed test run would.
 * `cli-cleanup.test.ts` checks that the `serve` it leaves stops by itself.
 */
import { StatusData } from '@abe/core';
import { cli } from './cli';

const abe = cli();
const status = await abe.json(StatusData, 'status');

if (!status.doc.ok) {
  process.stderr.write(`no serve: ${JSON.stringify(status.doc)}\n`);
  process.exit(2);
}
process.stdout.write(`${JSON.stringify({ pid: status.doc.data.pid, dir: abe.state.dir })}\n`);
process.exit(1);
