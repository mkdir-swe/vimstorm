/**
 * A request that asked for progress (`Request.progress`): its answer becomes a stream, the
 * journal's `PROGRESS_EVENTS` as `WatchFrame`s while the command runs, then its reply line. The
 * client draws the progress line from them; anything else is answered as before.
 */
import { type Journal, PROGRESS_EVENTS, PROTOCOL, readRequest, type WatchFrame } from '@abe/core';
import { type Answer } from '@abe/ports';

export const withProgress =
  (events: Journal, answer: (line: string) => Promise<Answer>) =>
  async (line: string): Promise<Answer> => {
    const read = readRequest(line);

    if (!read.ok || read.request.progress !== true) return answer(line);

    return {
      stream: (out) => {
        const unwatch = events.watch(undefined, (event) => {
          if (!PROGRESS_EVENTS.has(event.type)) return;
          const frame: WatchFrame = { v: PROTOCOL, event };

          out.send(JSON.stringify(frame));
        });

        answer(line).then(
          (answered) => {
            unwatch();
            if ('stream' in answered) {
              answered.stream(out);

              return;
            }
            const after = answered.after;

            if (after !== undefined) out.onClose(after);
            out.send(answered.line);
            out.end();
          },
          // A throw has no answer to give: close, so the client hears it at once.
          () => {
            unwatch();
            out.end();
          },
        );
      },
    };
  };
