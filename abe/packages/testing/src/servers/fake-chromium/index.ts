import { join } from 'node:path';

/** The argv that runs the fake Chromium (`main.ts`) under this Bun, before Chromium's flags. */
export const fakeChromiumArgv = (): string[] => [
  process.execPath,
  join(import.meta.dir, 'main.ts'),
];
