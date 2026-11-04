/**
 * A config repo's render step (ADR 0026): CI runs `node scripts/render*.js <in> <out>` before the
 * deploy, and the script fills the input file's keys from the environment. Pure: the commands in a
 * text and the key names a script lists, never a value.
 */

/** A render command: the script it runs and the arguments after it. */
export type RenderCommand = { script: string; args: string[] };

const RENDER_COMMAND =
  /\b(?:node|tsx|bun(?:\s+run)?|ts-node)[ \t]+(?:\.\/)?([\w./@-]*render[\w./-]*\.[cm]?[jt]s)((?:[ \t]+[^\s|&;<>"'`]+)*)/g;

/** The render commands in CI files' and package scripts' text, in order, each script once per arguments. */
export const renderCommands = (texts: readonly string[]): RenderCommand[] => {
  const out: RenderCommand[] = [];

  for (const text of texts)
    for (const m of text.matchAll(RENDER_COMMAND)) {
      const command = {
        script: m[1] ?? '',
        args: (m[2] ?? '').split(/[ \t]+/).filter((a) => a !== ''),
      };

      if (
        !out.some((c) => c.script === command.script && c.args.join(' ') === command.args.join(' '))
      )
        out.push(command);
    }

  return out;
};

/** Whether an argument names a file: `config.CI.json`, or `config.${env}.json` for any `config.*.json`. */
export const argNames = (arg: string, file: string): boolean => {
  const re = new RegExp(
    `^(?:\\./)?${arg
      .split(/\$\{[^}]*\}|\$\w+/)
      .map((p) => p.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')}$`,
  );

  return re.test(file);
};

/**
 * The key names a render script fills from the environment: the quoted names in its
 * `environmentMappings` list or object, and `process.env.NAME` / `process.env['NAME']`.
 */
export const renderNames = (text: string): string[] => {
  const names = new Set<string>();

  for (const m of text.matchAll(/process\.env(?:\.|\[\s*['"])([A-Z][A-Z0-9_]*)/g))
    names.add(m[1] ?? '');
  const list = /\benvironmentMappings\b\s*[:=]\s*[[{]/.exec(text);

  if (list !== null) {
    const open = text.charAt(list.index + list[0].length - 1);
    const close = text.indexOf(open === '[' ? ']' : '}', list.index + list[0].length);
    const body = text.slice(list.index + list[0].length, close === -1 ? undefined : close);

    for (const m of body.matchAll(/['"]([A-Z][A-Z0-9_]*)['"]|^\s*([A-Z][A-Z0-9_]*)\s*:/gm))
      names.add(m[1] ?? m[2] ?? '');
  }

  return [...names].sort();
};
