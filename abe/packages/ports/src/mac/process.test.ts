/** `runProcess` past its time: it answers once the child is gone, not when the child's children let go. */
import { describe, expect, test } from 'bun:test';
import { gitEnv, runProcess, serveEnv } from './process';

test('a child killed at its time answers at once, though a child of its holds its output (#198)', async () => {
  const began = Date.now();
  // A grandchild (as git's git-remote-https or ssh) keeps stdout open for 5 s after the kill.
  const ran = await runProcess(
    ['/bin/sh', '-c', 'sleep 5 & sleep 30'],
    { PATH: '/usr/bin:/bin' },
    undefined,
    200,
  );

  expect(ran).toEqual({ exit: 137, stdout: '', stderr: 'killed after 0.2 s' });
  expect(Date.now() - began).toBeLessThan(2_000);
});

test('a child that ends in time answers with what it said', async () => {
  expect(
    await runProcess(['/bin/sh', '-c', 'echo out; echo err >&2; exit 3'], {
      PATH: '/usr/bin:/bin',
    }),
  ).toEqual({ exit: 3, stdout: 'out\n', stderr: 'err\n' });
});

test("gitEnv: fsmonitor off and no submodules, after a parent's own env config (#181)", () => {
  const env = gitEnv({
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Kim',
  });

  expect(env).toMatchObject({
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'diff.ignoreSubmodules',
    GIT_CONFIG_VALUE_2: 'all',
    GIT_CONFIG_KEY_3: 'fetch.recurseSubmodules',
    GIT_CONFIG_VALUE_3: 'false',
  });
  expect(gitEnv({ PATH: '/bin' }).GIT_CONFIG_COUNT).toBe('3');
});

describe("serveEnv: what a serve the client starts gets of the client's environment", () => {
  test.each<[string, Record<string, string>, Record<string, string>]>([
    [
      'who and where you are, your locale and your tools',
      { HOME: '/home/kim', USER: 'kim', PATH: '/usr/bin', LANG: 'sv_SE.UTF-8', LC_ALL: 'C' },
      { HOME: '/home/kim', USER: 'kim', PATH: '/usr/bin', LANG: 'sv_SE.UTF-8', LC_ALL: 'C' },
    ],
    [
      "Abe's own, the state folders and the editor's",
      { ABE_STATE_DIR: '/s', XDG_STATE_HOME: '/x', VIMSTORM_NO_INSTANCE: '1' },
      { ABE_STATE_DIR: '/s', XDG_STATE_HOME: '/x', VIMSTORM_NO_INSTANCE: '1' },
    ],
    [
      'which aws profile and az folder, never their keys',
      {
        AWS_PROFILE: 'dev',
        AWS_REGION: 'eu-north-1',
        AWS_ACCESS_KEY_ID: 'AKIAFAKE',
        AWS_SECRET_ACCESS_KEY: 'fake',
        AWS_SESSION_TOKEN: 'fake',
        AZURE_CONFIG_DIR: '/az',
      },
      { AWS_PROFILE: 'dev', AWS_REGION: 'eu-north-1', AZURE_CONFIG_DIR: '/az' },
    ],
    [
      "a checkout's env file loaded into the shell: none of its keys",
      {
        HOME: '/h',
        API_URL: 'https://api.example.com',
        STRIPE_SECRET_KEY: 'sk_live_x',
        NODE_ENV: 'production',
      },
      { HOME: '/h' },
    ],
    [
      'the network: a proxy and its certificates',
      { HTTPS_PROXY: 'http://proxy:8080', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: '/ca.pem' },
      { HTTPS_PROXY: 'http://proxy:8080', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: '/ca.pem' },
    ],
  ])('%s', (_, parent, kept) => {
    expect(serveEnv(parent)).toEqual(kept);
  });
});
