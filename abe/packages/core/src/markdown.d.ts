/** A markdown file imported as text (`import x from './x.md' with { type: 'text' }`, Bun's). */
declare module '*.md' {
  const text: string;
  export default text;
}

/** A YAML file imported as text (core's built-in workflows, #15): parsed by the ports. */
declare module '*.yaml' {
  const text: string;
  export default text;
}

/** A shell file imported as text (the install's start and stop helpers): shipped in its plugin. */
declare module '*.sh' {
  const text: string;
  export default text;
}
