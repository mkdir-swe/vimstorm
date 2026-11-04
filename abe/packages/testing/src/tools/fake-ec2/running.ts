/** `running.ts <dir> <box>` exits 0 when the fake EC2 in `dir` says the caller's box `box` runs. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ec2State, settle } from './state';

const [dir = '.', box = ''] = process.argv.slice(2);
const state = Ec2State.parse(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')));
const now = Date.now();
const found = state.instances.find(
  (i) =>
    i.Tags.some((t) => t.Key === 'abe:box' && t.Value === box) &&
    i.Tags.some((t) => t.Key === 'abe:owner' && t.Value === state.owner) &&
    i.State !== 'terminated',
);

if (found !== undefined) settle(found, state, now);
if (found?.State !== 'running') {
  process.stderr.write(`ssh: connect to box ${box}: it is ${found?.State ?? 'not there'}\n`);
  process.exit(255);
}
