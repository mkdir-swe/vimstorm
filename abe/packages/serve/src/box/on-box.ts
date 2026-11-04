/**
 * `abe --on <box> …` in the Mac's `serve` (#56): the command, `--on` taken out, goes to that box's
 * own `serve` over the link, the box woken first, and its answer comes back as its `abe` printed
 * it, exit code included. `watch` streams the box's own events (tagged with it); `session attach`
 * names the command that attaches this terminal there.
 */
import {
  argsSchema,
  COMMANDS,
  textOf,
  EXIT,
  type BoxLink,
  parse,
  PROTOCOL,
  printFailure,
  type Printed,
  toReply,
  type WatchFrame,
} from '@abe/core';
import { type Answer } from '@abe/ports';
import { type BoxFront, eventLineOf } from './boxes';

const replied = (printed: Printed): Answer => ({ line: JSON.stringify(toReply(printed)) });

/**
 * The box's `abe watch --json`, each event a frame of this stream, until the watcher leaves or
 * the box sleeps. A dropped tunnel is followed again with `--since` its last event, so none is
 * lost; only to a box EC2 says still runs.
 */
const watchOn = (
  boxes: BoxFront,
  link: BoxLink,
  box: string,
  argv: readonly string[],
  retryMs: number,
  sleep: (ms: number) => Promise<void>,
): Answer => ({
  stream: (out) => {
    let stop: (() => void) | undefined;
    const watcher = { gone: false };
    // A function, so a check after an `await` reads it anew.
    const left = () => watcher.gone;

    out.onClose(() => {
      watcher.gone = true;
      stop?.();
    });
    void (async () => {
      const woke = await boxes.wake(box);

      if (left()) return;
      if (!woke.ok) {
        out.send(
          JSON.stringify(toReply(printFailure(woke.error, EXIT.failed, argv.includes('--json')))),
        );
        out.end();

        return;
      }
      const asked = argv.filter((a) => a !== '--json');
      let since: number | undefined;

      for (;;) {
        const words = [
          ...asked.filter(
            (a, i) => since === undefined || (a !== '--since' && asked[i - 1] !== '--since'),
          ),
          ...(since === undefined ? [] : ['--since', String(since)]),
          '--json',
        ];
        const stream = link.follow(box, words, (text) => {
          const line = eventLineOf(text);

          if (line === undefined) return;
          since = line.seq;
          const frame: WatchFrame = { v: PROTOCOL, event: { ...line, box } };

          if (!out.send(JSON.stringify(frame))) stop?.();
        });

        stop = stream.stop;
        await stream.ended;
        if (left()) return;
        await sleep(retryMs);
        if (left() || !(await boxes.runs(box))) break;
      }
      out.end();
    })();
  },
});

/** The answer to argv that names `--on <box>` (already taken out: `argv`), from that box. */
export const onBoxAnswer = async (
  boxes: BoxFront,
  link: BoxLink,
  /** `abe box attach` as this `abe` runs it (ADR 0021). */
  boxAttach: readonly string[],
  box: string,
  argv: readonly string[],
  times: { retryMs: number; sleep: (ms: number) => Promise<void> },
): Promise<Answer> => {
  const parsed = parse(argv);
  const json = parsed.global.json;

  if (parsed.ok && !parsed.global.help && parsed.id === 'watch')
    return watchOn(boxes, link, box, argv, times.retryMs, times.sleep);
  if (parsed.ok && !parsed.global.help && parsed.id === 'session attach') {
    const woke = await boxes.wake(box);

    if (!woke.ok) return replied(printFailure(woke.error, EXIT.failed, json));
    const { id } = argsSchema(COMMANDS['session attach'].args).parse(parsed.args);
    const data = { id, argv: [...boxAttach, box, '--session', id] };

    return replied({
      exit: EXIT.ok,
      stdout: json
        ? `${JSON.stringify({ ok: true, data })}\n`
        : textOf(COMMANDS['session attach'], data),
      stderr: '',
    });
  }

  return replied(await boxes.forward(box, argv, json));
};
