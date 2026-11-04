/** A throwaway state directory and socket, so a test never meets the user's `serve`. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type TempState = {
  dir: string;
  socket: string;
  /**
   * The environment a CLI run in this state gets. It has these, a clean `PATH` serve keeps, and its
   * own `HOME`.
   */
  env: Record<string, string>;
  remove: () => void;
};

/** Short on purpose, since macOS caps a unix socket path at 103 bytes. */
export const tempState = (): TempState => {
  const dir = mkdtempSync(join(tmpdir(), 'abe-'));

  return {
    dir,
    socket: join(dir, 's.sock'),
    env: {
      ABE_STATE_DIR: dir,
      ABE_SOCKET: join(dir, 's.sock'),
      HOME: dir,
      PATH: '/usr/bin:/bin',
      // serve keeps this PATH. No login shell read adds the machine's tools to it.
      ABE_LOGIN_PATH: 'off',
      // No Docker of the machine's, so the Mac database is never this Mac's own in a test.
      ABE_DOCKER: join(dir, 'no-docker'),
      // a serve this state starts stops, with its sessions' tmux, once the test process is gone.
      // A failed, timed-out or killed test never calls close().
      ABE_SERVE_OWNER_PID: String(process.pid),
    },
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
