/**
 * Loaded before every `bun test` run through bunfig.toml. When the run ends, it ends any `serve` a
 * test started and never stopped because it failed or timed out first.
 */
import { afterAll } from 'bun:test';
import { stopLeftServes } from './in-process/cli';

afterAll(stopLeftServes);
// a run stopped with ^C or a kill ends them too
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stopLeftServes();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
