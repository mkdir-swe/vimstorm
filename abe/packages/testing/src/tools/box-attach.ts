/**
 * A fake `abe box attach`, per ADR 0021. `<box> [--shared] -- <argv…>` runs argv here, as if on
 * the box, with the box's clone `root` read as a local folder in every word. A leading
 * `docker exec [-i] [-t] [-u abe] [-w <dir>] [-e <var>]… abe-ws-<card>` into a card's workspace
 * container becomes cd and env here. An old box's `abe-workspace` works too.
 * `<box> --session <id>` prints what it would attach. `<box> --forward <port>` prints the local
 * URL the port would be reached at, as for a prototype's page on a box. It keeps each call's argv
 * as one JSON line.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export type FakeBoxAttach = {
  /** The script that `$ABE_BOX_ATTACH` names. */
  bin: string;
  /** Every call's argv after `abe box attach`, in order. */
  calls: () => string[][];
};

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

export const fakeBoxAttach = (o: { root: string; dir: string }): FakeBoxAttach => {
  const home = mkdtempSync(join(tmpdir(), 'box-attach-'));
  const bin = join(home, 'abe-box-attach');
  const log = join(home, 'calls.jsonl');

  writeFileSync(
    bin,
    [
      '#!/bin/bash',
      // one JSON line per call, with the words as given
      `printf '%s\\0' "$@" | ${quote(process.execPath)} -e 'const t = await Bun.stdin.text(); console.log(JSON.stringify(t.split("\\0").slice(0, -1)))' >> ${quote(log)}`,
      'box="$1"; shift',
      'if [ "$1" = "--session" ]; then echo "attached to session $2 on $box"; exit 0; fi',
      // the port forward for a prototype's page on a box answers with a local URL
      'if [ "$1" = "--forward" ]; then echo "http://127.0.0.1:$2"; exit 0; fi',
      // only the real attach shares a connection. Here every call runs alike.
      'if [ "$1" = "--shared" ]; then shift; fi',
      'if [ "$1" != "--" ]; then echo "usage: abe box attach <box> [--session <id>] [-- <argv>]" >&2; exit 2; fi',
      'shift',
      `root=${quote(o.root)}; dir=${quote(o.dir)}`,
      'args=("${@//$root/$dir}")',
      'if [ "${args[0]}" = docker ] && [ "${args[1]}" = exec ]; then',
      '  args=("${args[@]:2}"); vars=()',
      '  while [ "${#args[@]}" -gt 0 ]; do',
      '    case "${args[0]}" in',
      '      -i|-t) args=("${args[@]:1}") ;;',
      '      -u) [ "${args[1]}" = abe ] || { echo "fake attach: docker exec as ${args[1]}, not abe" >&2; exit 125; }; args=("${args[@]:2}") ;;',
      '      -w) cd "${args[1]}" || exit 126; args=("${args[@]:2}") ;;',
      '      -e) vars+=("${args[1]}"); args=("${args[@]:2}") ;;',
      '      abe-workspace|abe-ws-*) args=("${args[@]:1}"); break ;;',
      '      *) echo "fake attach: unknown docker exec word ${args[0]}" >&2; exit 125 ;;',
      '    esac',
      '  done',
      '  exec env "${vars[@]}" "${args[@]}"',
      'fi',
      'exec "${args[@]}"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  return {
    bin,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
            .map((l) => z.array(z.string()).parse(JSON.parse(l)))
        : [],
  };
};
