import { describe, expect, test } from 'bun:test';
import { AttachSpec, attachSpecOf, attachSpecText, inWorkspace } from './attach';

const BOX_ATTACH = ['/usr/local/bin/abe', 'box', 'attach'];

describe('attach-spec: what the shell runs for a session’s workspace (#74)', () => {
  test('a local session: its worktree as a plain project, argv as on this Mac', () => {
    const spec = attachSpecOf({ where: 'local', root: '/r/shop-wt/4-sign-in', shell: '/bin/zsh' });

    expect(spec).toEqual({
      where: 'local',
      root: '/r/shop-wt/4-sign-in',
      nvim: ['nvim', '--embed'],
      shell: ['/bin/zsh', '-l'],
      exec: [],
      box: null,
      waking: false,
    });
    expect(AttachSpec.parse(spec)).toEqual(spec);
  });

  test("a cloud session: every argv through abe box attach to its own box, into its card's workspace container in the clone", () => {
    const spec = attachSpecOf({
      where: 'cloud',
      root: '/workspace/repo',
      box: 'shop-4',
      region: 'eu-west-1',
      boxAttach: BOX_ATTACH,
      container: 'abe-ws-4',
      waking: false,
    });
    const via = [...BOX_ATTACH, 'shop-4', '--'];
    // #89: `abe box attach <box> -- …` runs on the box's host, where the clone is not: in the
    // workspace container as its user.
    const into = [...via, 'docker', 'exec', '-i'];

    // #93: the tree's listings and git share the box's one SSH connection (a round trip each)
    expect(spec.exec).toEqual([
      ...BOX_ATTACH,
      'shop-4',
      '--shared',
      '--',
      'docker',
      'exec',
      '-i',
      '-u',
      'abe',
      'abe-ws-4',
    ]);
    expect(spec.nvim).toEqual([
      ...into,
      '-u',
      'abe',
      '-w',
      '/workspace/repo',
      '-e',
      'NVIM_APPNAME=vimstorm',
      'abe-ws-4',
      'nvim',
      '--embed',
    ]);
    expect(spec.shell).toEqual([
      ...into,
      '-t',
      '-u',
      'abe',
      '-w',
      '/workspace/repo',
      'abe-ws-4',
      'bash',
      '-l',
    ]);
    expect(spec.box).toEqual({ name: 'shop-4', region: 'eu-west-1' });
    expect(spec.where).toBe('cloud');
  });

  test('a command in the workspace container: stdin kept, a terminal only when asked', () => {
    const via = [...BOX_ATTACH, 'shop-4', '--', 'docker', 'exec', '-i'];

    expect(inWorkspace(BOX_ATTACH, 'shop-4', 'abe-ws-4')).toEqual([
      ...via,
      '-u',
      'abe',
      'abe-ws-4',
    ]);
    expect(
      inWorkspace(BOX_ATTACH, 'shop-4', 'abe-ws-4', {
        tty: true,
        cwd: '/workspace/repo',
        env: ['A=1'],
      }),
    ).toEqual([...via, '-t', '-u', 'abe', '-w', '/workspace/repo', '-e', 'A=1', 'abe-ws-4']);
    expect(inWorkspace(BOX_ATTACH, 'shop-4', 'abe-ws-4', { shared: true })).toEqual([
      ...BOX_ATTACH,
      'shop-4',
      '--shared',
      '--',
      'docker',
      'exec',
      '-i',
      '-u',
      'abe',
      'abe-ws-4',
    ]);
  });

  test('its text: where, the root, and the box', () => {
    expect(
      attachSpecText(
        attachSpecOf({
          where: 'cloud',
          root: '/workspace/repo',
          box: 'shop-4',
          region: null,
          boxAttach: BOX_ATTACH,
          container: 'abe-ws-4',
          waking: true,
        }),
      ),
    ).toBe('cloud  /workspace/repo  on shop-4 (waking)\n');
    expect(attachSpecText(attachSpecOf({ where: 'local', root: '/r/wt', shell: '/bin/sh' }))).toBe(
      'local  /r/wt\n',
    );
  });
});
