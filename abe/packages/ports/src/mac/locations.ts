/** Where Abe keeps its state on this machine, from the environment it was started in. */
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

export type Locations = {
  /** `$ABE_STATE_DIR`, else `$XDG_STATE_HOME/abe`, else `~/.local/state/abe`. */
  stateDir: string;
  /**
   * The default state folders besides `stateDir` (`$XDG_STATE_HOME/abe`, `~/.local/state/abe`):
   * another serve's, which a session of this one's may not read either.
   */
  defaultStates: string[];
  /** `$ABE_SOCKET`, else `serve.sock` in the state directory. */
  socket: string;
  /** Where a detached `serve` writes its output. */
  log: string;
  /**
   * Where each session's copy of core's plugin is written (`<plugins>/<id>`): `$XDG_CACHE_HOME/abe/plugins`,
   * else beside an own `$ABE_STATE_DIR` (`<it>-cache/plugins`: a serve of its own shares nothing
   * with the default one), else `~/.cache/abe/plugins`. Never in the state, which a session's file
   * tools may not read.
   */
  plugins: string;
};

const set = (value: string | undefined) =>
  value === undefined || value === '' ? undefined : value;

const pluginsDir = (env: Env, home: string): string => {
  const cache = set(env.XDG_CACHE_HOME);
  const state = set(env.ABE_STATE_DIR)?.replace(/\/+$/, '');

  if (cache === undefined && state !== undefined && state !== '')
    return join(`${state}-cache`, 'plugins');

  return join(cache ?? join(home, '.cache'), 'abe', 'plugins');
};

export const locate = (env: Env, home: string): Locations => {
  const xdg = set(env.XDG_STATE_HOME);
  const defaults = [
    ...(xdg === undefined ? [] : [join(xdg, 'abe')]),
    join(home, '.local', 'state', 'abe'),
  ];
  const stateDir = set(env.ABE_STATE_DIR) ?? defaults[0] ?? join(home, '.local', 'state', 'abe');

  return {
    stateDir,
    defaultStates: defaults.filter((d) => d !== stateDir.replace(/\/+$/, '')),
    socket: set(env.ABE_SOCKET) ?? join(stateDir, 'serve.sock'),
    log: join(stateDir, 'serve.log'),
    plugins: pluginsDir(env, home),
  };
};

/** `path` with every link resolved, as far as it exists yet (the rest kept as named). */
export const realPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);

    return parent === path ? path : join(realPath(parent), basename(path));
  }
};
