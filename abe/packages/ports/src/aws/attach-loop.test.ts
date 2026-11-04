import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boxReachText } from '@abe/core';
import { remoteOf, wakingLine } from './attach-words';

const MARK = "printf '%s\\n' abe-box-attach:began >&2;";

describe('attach loop: what ssh runs on the box', () => {
  test('a command without a terminal writes the began mark first (never run twice)', () => {
    expect(remoteOf({ command: ['git', 'status'] }, false)).toEqual([MARK, "'git'", "'status'"]);
  });

  test('a command with a terminal has no mark: a pty merges its stderr into the screen (#89)', () => {
    expect(remoteOf({ command: ['bash', '-l'] }, true)).toEqual(["'bash'", "'-l'"]);
  });

  test('a session is its abe session attach', () => {
    expect(remoteOf({ session: '4-ab12' }, true)).toEqual([
      "'abe'",
      "'session'",
      "'attach'",
      "'4-ab12'",
      "'--no-start'",
    ]);
  });

  /** The words run by bash on a box whose `docker ps` names `running` (space-separated). */
  const onBox = (what: { shell: true; card?: string }, running: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'abe-shell-'));

    // docker: `ps` prints the running names its filters let through; `exec` says where it went.
    writeFileSync(
      join(dir, 'docker'),
      [
        '#!/bin/bash',
        'if [ "$1" = ps ]; then',
        `  names=${JSON.stringify(running)}`,
        '  for a in "$@"; do case "$a" in label=abe.card=*) want=${a#label=abe.card=};; esac; done',
        '  for n in $names; do [ -z "$want" ] || [ "$n" = "abe-ws-$want" ] && echo "$n"; done',
        '  exit 0',
        'fi',
        'echo "exec into ${@: -3:1}"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    writeFileSync(join(dir, 'bash'), `#!/bin/sh\necho "the box's own shell"\n`, { mode: 0o755 });
    const ran = Bun.spawnSync(['/bin/bash', '-c', remoteOf(what, true).join(' ')], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
    });

    rmSync(dir, { recursive: true, force: true });

    return { stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
  };

  test('no words is a login shell in a workspace (#104 Behaviour 5, #244): the first running, as its user in the clone', () => {
    expect(remoteOf({ shell: true }, true).join(' ')).toContain(
      "exec docker exec -it -u 'abe' -w '/workspace/repo' \"$c\" bash -l",
    );
    expect(onBox({ shell: true }, 'abe-ws-101 abe-ws-102').stdout).toBe('exec into abe-ws-101\n');
  });

  test("--card's workspace: that card's container (ADR 0022: one per card on the box)", () => {
    expect(onBox({ shell: true, card: '102' }, 'abe-ws-101 abe-ws-102').stdout).toBe(
      'exec into abe-ws-102\n',
    );
  });

  test("none running (or not that card's): the box's own shell, said", () => {
    const none = onBox({ shell: true }, '');

    expect(none.stdout).toBe("the box's own shell\n");
    expect(none.stderr).toBe('abe: no workspace container answers on this box: its own shell\n');
    expect(onBox({ shell: true, card: '7' }, 'abe-ws-101').stderr).toBe(
      'abe: no workspace container of card 7 answers on this box: its own shell\n',
    );
  });
});

describe('attach loop: a box not up yet', () => {
  test('asleep: Waking <box>…; starting: it waits for it', () => {
    // The link's refusal is boxReachText's words for EC2's state.
    const asleep = boxReachText('demo-shop-3', { kind: 'asleep', state: 'stopped' }, 0);
    const starting = boxReachText('demo-shop-2', { kind: 'starting', since: null }, 0);

    expect(wakingLine('demo-shop-3', asleep)).toBe('Waking demo-shop-3…');
    expect(wakingLine('demo-shop-2', starting)).toBe('demo-shop-2 is starting, waiting for it…');
  });
});
