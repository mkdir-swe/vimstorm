import { expect, test } from 'bun:test';
import { locate } from './locations';

// the default state folders besides its own: a session's read deny hides them too
test.each([
  [{}, '/h/.local/state/abe', '/h/.local/state/abe/serve.sock', []],
  [{ XDG_STATE_HOME: '/x' }, '/x/abe', '/x/abe/serve.sock', ['/h/.local/state/abe']],
  [{ ABE_STATE_DIR: '/s' }, '/s', '/s/serve.sock', ['/h/.local/state/abe']],
  [{ ABE_STATE_DIR: '/s', ABE_SOCKET: '/k.sock' }, '/s', '/k.sock', ['/h/.local/state/abe']],
  [
    { ABE_STATE_DIR: '/s', XDG_STATE_HOME: '/x' },
    '/s',
    '/s/serve.sock',
    ['/x/abe', '/h/.local/state/abe'],
  ],
  [
    { ABE_STATE_DIR: '/h/.local/state/abe' },
    '/h/.local/state/abe',
    '/h/.local/state/abe/serve.sock',
    [],
  ],
  [{ ABE_SOCKET: '' }, '/h/.local/state/abe', '/h/.local/state/abe/serve.sock', []],
])('%j: state %s, socket %s, the defaults besides %j', (env, stateDir, socket, defaultStates) => {
  expect(locate(env, '/h')).toMatchObject({
    stateDir,
    socket,
    log: `${stateDir}/serve.log`,
    defaultStates,
  });
});

// beside the state, never in it: a session's file tools may not read the state
test.each([
  ['the cache', {}, '/h/.cache/abe/plugins'],
  ['XDG_CACHE_HOME', { XDG_CACHE_HOME: '/c' }, '/c/abe/plugins'],
  [
    'XDG_CACHE_HOME before ABE_STATE_DIR',
    { XDG_CACHE_HOME: '/c', ABE_STATE_DIR: '/s' },
    '/c/abe/plugins',
  ],
  ['an own ABE_STATE_DIR: its own, beside it', { ABE_STATE_DIR: '/t/s' }, '/t/s-cache/plugins'],
  ['XDG_STATE_HOME alone: the cache', { XDG_STATE_HOME: '/x' }, '/h/.cache/abe/plugins'],
])("sessions' plugins: %s", (_, env, plugins) => {
  expect(locate(env, '/h').plugins).toBe(plugins);
});
