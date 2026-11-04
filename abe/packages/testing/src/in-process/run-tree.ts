/**
 * A `RunTree` that answers as `base` does and keeps what it was asked to read for a session's
 * logs. A test sees where `serve` looked. On a box, those are the workspace container's paths.
 */
import { type LogSources, type RunTree } from '@abe/core';

export type RecordingRunTree = RunTree & { logsAsked: LogSources[] };

export const recordingRunTree = (base: RunTree): RecordingRunTree => {
  const logsAsked: LogSources[] = [];

  return {
    ...base,
    logs: (sources) => {
      logsAsked.push(sources);

      return base.logs(sources);
    },
    logsAsked,
  };
};
