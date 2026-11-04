#!/usr/bin/env bun
/**
 * The `abe` binary: `bun build --compile` starts here. `abe hook` is Claude Code's, run for every
 * hook event, so it loads only the hook client and exits 0 whatever happens; everything else is
 * `app.ts`. `abe box tunnel` is ssh's ProxyCommand for a box (#91), run for every connection: it
 * starts the tunnel client and never loads `app.ts`. `abe port pipe` is the box relay's, run in a
 * workspace for every connection to a dev server there (#16): the same, the pipe alone.
 * `abe --version` prints the build and loads nothing else.
 */
if (process.argv[2] === 'hook') {
  try {
    const { runHook } = await import('@abe/hooks');

    await runHook(process.argv.slice(2), {
      env: process.env,
      stdin: process.stdin,
      cwd: process.cwd(),
      elapsed: () => performance.now(),
      print: (text) => process.stdout.write(text),
    });
  } catch {
    // A fenced tool is refused, never let through unchecked (#181); with no hook client to say
    // so, Claude Code's exit 2 (a blocking error) refuses it.
    try {
      const { crashAnswer } = await import('@abe/hooks');
      const deny = crashAnswer(process.argv.slice(2), process.env);

      if (deny !== undefined) process.stdout.write(deny);
    } catch {
      if (process.argv[3] === 'PreToolUse' && process.env.FENCED_BY_ABE === '1') {
        process.stderr.write(
          "abe hook failed, so this session's fence could not check the tool.\n",
        );
        process.exit(2);
      }
    }
  } finally {
    process.exit(0);
  }
}
// `abe --version`: this binary's build alone, what a running serve asks of the abe installed
if (process.argv[2] === '--version' && process.argv.length === 3) {
  const { VERSION } = await import('./process/version');

  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (process.argv[2] === 'box' && process.argv[3] === 'tunnel') {
  const { tunnelMain } = await import('@abe/ports');

  process.exit(await tunnelMain(process.argv.slice(4), process.env));
}
if (process.argv[2] === 'port' && process.argv[3] === 'pipe') {
  const { pipeMain } = await import('@abe/ports');

  process.exit(await pipeMain(process.argv.slice(4)));
}
await import('./process/app');
