/**
 * One-shots through `claude -p` (core's `OneShot`): the argv is core's `oneShotArgv`, the
 * environment exactly the one given (core's `oneShotEnv`), the prompt on stdin, the answer what it
 * printed. Its own process group, killed whole after the timeout.
 */
import { type Answered, type OneShot, oneShotArgv } from '@abe/core';
import { failed } from '../mac/process';

/** The last lines of a failed run's output, enough to say why. */
const tail = (text: string) => text.trim().split('\n').slice(-20).join('\n');

/**
 * `argv` (a `claude -p`) in `cwd` with exactly `env`, `prompt` on stdin: what it printed. Its own
 * process group (its MCP servers too), killed whole after `timeoutMs`.
 */
export const runClaudeOnce = async (
  argv: readonly string[],
  q: { prompt: string; cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number },
): Promise<Answered<{ text: string }>> => {
  const child = Bun.spawn([...argv], {
    cwd: q.cwd,
    env: { ...q.env },
    stdin: new TextEncoder().encode(q.prompt),
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  const late = { killed: false };
  const timer = setTimeout(() => {
    late.killed = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, q.timeoutMs);
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => {
    clearTimeout(timer);
  });

  if (late.killed)
    return failed('one-shot-timeout', `claude -p gave no answer in ${q.timeoutMs / 1000} s`);
  if (exit !== 0)
    return failed(
      'one-shot-failed',
      `claude -p exited ${exit}${tail(`${stdout}\n${stderr}`) === '' ? '' : `: ${tail(`${stdout}\n${stderr}`)}`}`,
    );

  return { ok: true, data: { text: stdout } };
};

export const claudeOneShot = (): OneShot => ({
  ask: async (q) => {
    const claude = Bun.which('claude', { PATH: q.env.PATH ?? '' });

    if (claude === null)
      return failed('no-claude', `claude is not on the one-shot's PATH: ${q.env.PATH ?? ''}`);

    return runClaudeOnce(oneShotArgv({ claude, model: q.model, system: q.system }), q);
  },
});
