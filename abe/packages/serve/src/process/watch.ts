/**
 * `abe watch` in `serve`: a request for it keeps its connection and streams the journal's events
 * as `WatchFrame`s; every other command answered is one `command.ran`.
 */
import {
  argsSchema,
  type Caller,
  commandRan,
  COMMANDS,
  EXIT,
  type Journal,
  parse,
  PROTOCOL,
  printFailure,
  toReply,
  usageText,
  type WatchFrame,
} from '@abe/core';
import { type Answer } from '@abe/ports';

const refuse = (message: string, json: boolean): Answer => ({
  line: JSON.stringify(
    toReply(printFailure({ code: 'usage', message }, EXIT.usage, json, usageText('watch'))),
  ),
});

/**
 * The streamed answer to `abe watch`, or `undefined` for any other request and for one `dispatch`
 * answers itself (`--help`, a usage failure, a caller the row refuses). `stopping` says the stream
 * ends because `serve` does, so no `command.ran` follows it.
 */
export const watchAnswer = (
  events: Journal,
  argv: readonly string[],
  stopping: () => boolean,
  caller: Caller = 'user',
): Answer | undefined => {
  const parsed = parse(argv);

  if (!parsed.ok || parsed.id !== 'watch' || parsed.global.help) return undefined;
  if (caller === 'session' && !COMMANDS.watch.inSession) return undefined;
  const { since } = argsSchema(COMMANDS.watch.args).parse(parsed.args);

  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) {
    commandRan(events, argv, EXIT.usage);

    return refuse('--since must be a whole number, 0 or more', parsed.global.json);
  }

  return {
    stream: (out) => {
      const unwatch = events.watch(since, (event) => {
        const frame: WatchFrame = { v: PROTOCOL, event };

        if (!out.send(JSON.stringify(frame))) throw new Error('the watcher is gone');
      });

      out.onClose(() => {
        unwatch();
        // Cut off for falling too far behind is a failure; the watcher leaving is not.
        if (!stopping()) commandRan(events, argv, out.cut() ? EXIT.failed : EXIT.ok);
      });
    },
  };
};
