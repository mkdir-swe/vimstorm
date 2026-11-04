/**
 * This build's abe version: what `abe status` says, what a box's `serve` is compared
 * with. A compiled `abe` carries the one `scripts/build.sh` gave it (`--define`, from
 * `scripts/version.sh`: `packages/serve`'s version and the commit, `-dirty` for a tree with
 * changes); from source it is `packages/serve`'s.
 */
import { statSync } from 'node:fs';
import pkg from '../../package.json';

/** Put in by `bun build --define ABE_BUILD_VERSION='"…"'`; not there when run from source. */
declare const ABE_BUILD_VERSION: string | undefined;

const built = typeof ABE_BUILD_VERSION === 'string' ? ABE_BUILD_VERSION : '';

export const VERSION: string = built === '' ? pkg.version : built;

/**
 * The abe installed on this Mac now, its version, as serve reads it while it runs: install.sh
 * replaces the binary serve started from (`process.execPath`), so serve asks that file again
 * (`<it> --version`) each time it changes, the version it had said till then. From source there
 * is no installed binary: none.
 */
export const installedAbe = (): (() => string | undefined) => {
  if (built === '') return () => undefined;
  const path = process.execPath;
  const changed = () => statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  let seen = changed();
  let said: string | undefined = VERSION;

  return () => {
    const now = changed();

    if (now !== seen) {
      seen = now;
      const child = Bun.spawn([path, '--version'], {
        env: {},
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 10_000);

      void Promise.all([new Response(child.stdout).text(), child.exited])
        .then(([out, exit]) => {
          const v = out.trim();

          // a file read mid-write (or broken) is asked again on the next look
          if (exit === 0 && /^[\w.+-]+$/.test(v)) said = v;
          else seen = -1;
        })
        .catch(() => {
          seen = -1;
        })
        .finally(() => {
          clearTimeout(timer);
        });
    }

    return said;
  };
};
