/**
 * Every Layer's workflows and skill folders (#15): the repo's `abe/workflows/<id>.yaml` (ADR
 * 0033), yours `.abe/workflows/<id>.local.yaml` in its main checkout (never committed), each
 * Layer's skills (yours in your config folder, the repo's `.claude/skills/`), plus core's built-in
 * ones; each one's YAML parsed with its lines, for core's load check (`loadWorkflows`).
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type AbeFolder,
  type AbeUpdate,
  BUILT_IN_SKILL_FILES,
  BUILT_IN_SKILLS,
  BUILT_IN_WORKFLOWS,
  copyInto,
  isInstalled,
  REPO_ABE_DIR,
  SHIPPED_FILES,
  type SkillFront,
  type SkillSource,
  type WorkflowLayer,
  type WorkflowSource,
  type YamlPath,
  updatesOf,
} from '@abe/core';
import { isNode, LineCounter, parse, parseDocument } from 'yaml';
import { type Env } from './locations';
import { gitEnv, runProcess } from './process';

/**
 * A Layer's folder: the one holding its `skills/`, and its workflow files (`<dir>/workflows/` when
 * `workflows` is absent). `workflows.local`: only the `<id>.local.yaml` files there (yours, beside
 * the repo's), else all but those; `workflows` null: none.
 */
export type WorkflowDir = {
  layer: WorkflowLayer;
  dir: string;
  workflows?: { dir: string; local: boolean } | null;
  /**
   * Its skills' folders, the first's winning a name; none: `<dir>/skills`. The repo's are
   * `.claude/skills` (ADR 0031) then `abe/skills` (ADR 0033).
   */
  skills?: string | readonly string[];
};

/** Yours beside the repo's: `<id>.local.yaml`. */
const LOCAL_YAML = /\.local\.ya?ml$/;

/** A workflow file's id: its name without `.yaml` (and yours without `.local`). */
export const workflowIdOf = (name: string): string => name.replace(/(\.local)?\.ya?ml$/, '');

/** One workflow file's text as a source: its YAML, or where it does not read; its lines. */
export const workflowSource = (
  layer: WorkflowLayer,
  file: string,
  id: string,
  text: string,
): WorkflowSource => {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  const [first] = doc.errors;

  if (first !== undefined) {
    const at = first.linePos?.[0].line ?? null;

    return {
      layer,
      file,
      id,
      read: {
        error: (first.message.split('\n')[0] ?? first.message).replace(
          / at line \d+, column \d+:?$/,
          '',
        ),
        line: at,
      },
    };
  }
  const lineOf = (path: YamlPath): number | null => {
    for (let n = path.length; n >= 0; n -= 1) {
      const node: unknown = n === 0 ? doc.contents : doc.getIn(path.slice(0, n), true);

      if (isNode(node) && node.range !== undefined && node.range !== null)
        return lines.linePos(node.range[0]).line;
    }

    return null;
  };

  return { layer, file, id, read: { doc: doc.toJS() ?? undefined }, lineOf };
};

const isYaml = (name: string) => /\.ya?ml$/.test(name);

const listed = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The most files a skill folder lists. */
export const SKILL_FILES_MAX = 100;

/** A folder's files, relative to it, sorted, recursive; dot files and folders skipped. */
const filesIn = (root: string): string[] => {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of listed(join(root, rel))) {
      if (out.length >= SKILL_FILES_MAX) return;
      if (name.startsWith('.')) continue;
      const path = rel === '' ? name : `${rel}/${name}`;

      if (isDir(join(root, path))) walk(path);
      else out.push(path);
    }
  };

  walk('');

  return out.sort();
};

/** A `SKILL.md`'s frontmatter `description:`; '' when it has none. */
export const skillDescription = (text: string): string => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);

  if (m?.[1] === undefined) return '';
  try {
    const meta: unknown = parse(m[1]);

    return typeof meta === 'object' &&
      meta !== null &&
      'description' in meta &&
      typeof meta.description === 'string'
      ? meta.description.trim()
      : '';
  } catch {
    return '';
  }
};

/**
 * A `SKILL.md`'s frontmatter as Claude Code lists the skill (`dir`: its folder's name): `name`,
 * `description`, and `user-invocable: false` (hidden from its `/` menu).
 */
export const skillFront = (dir: string, text: string): SkillFront => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const meta = ((): unknown => {
    try {
      return m?.[1] === undefined ? null : parse(m[1]);
    } catch {
      return null;
    }
  })();
  const front = typeof meta === 'object' && meta !== null ? meta : {};
  const name = 'name' in front ? front.name : undefined;
  const description = 'description' in front ? front.description : undefined;
  const invocable = 'user-invocable' in front ? front['user-invocable'] : undefined;

  return {
    dir,
    ...(typeof name === 'string' && name.trim() !== '' ? { name: name.trim() } : {}),
    description: typeof description === 'string' ? description.trim() : '',
    ...(invocable === false ? { hidden: true } : {}),
  };
};

/** Each `<dir>/<name>/SKILL.md` of a skills folder (`.claude/skills`), by its folder's name; none without it. */
export const skillFrontsIn = (dir: string): SkillFront[] =>
  listed(dir).flatMap((name) => {
    const text = readText(join(dir, name, 'SKILL.md'));

    return text === '' ? [] : [skillFront(name, text)];
  });

const readText = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

/** A Layer's skill folder as a source: its folder, description and files. */
const skillSource = (layer: WorkflowLayer, dir: string, name: string): SkillSource => ({
  name,
  layer,
  dir,
  description: skillDescription(readText(join(dir, 'SKILL.md'))),
  files: filesIn(dir),
});

/** Core's built-in skills as sources, their files from core's text. */
export const builtInSkillSources = (): SkillSource[] =>
  BUILT_IN_SKILLS.map((name) => {
    const prefix = `skills/${name}/`;
    const own = BUILT_IN_SKILL_FILES.filter((f) => f.path.startsWith(prefix));

    return {
      name,
      layer: 'built-in' as const,
      dir: `built-in/skills/${name}`,
      description: skillDescription(own.find((f) => f.path === `${prefix}SKILL.md`)?.text ?? ''),
      files: own.map((f) => f.path.slice(prefix.length)).sort(),
    };
  });

/**
 * Writes `text` at `path` read-only (0444), its folders made; an older text there is replaced.
 * The Editor opens a built-in file from there.
 */
export const writeReadOnly = (path: string, text: string): void => {
  const there = statSync(path, { throwIfNoEntry: false }) !== undefined;

  if (!there || readText(path) !== text) {
    mkdirSync(dirname(path), { recursive: true });
    if (there) chmodSync(path, 0o644);
    writeFileSync(path, text);
  }
  chmodSync(path, 0o444);
};

/** Core's built-in workflows as sources. */
export const builtInWorkflowSources = (): WorkflowSource[] =>
  BUILT_IN_WORKFLOWS.map((w) =>
    workflowSource('built-in', `built-in/workflows/${w.id}.yaml`, w.id, w.text),
  );

/**
 * Each Layer's workflow files and skill folders, then Abe's own in force (`abe`: the shipped
 * files' `abeInForce`, all of them by default, as before an install); `builtIn` names Abe's skills
 * in force, for the load check.
 */
export const readWorkflowLayers = (
  dirs: readonly WorkflowDir[],
  abe: readonly { path: string }[] = SHIPPED_FILES,
): {
  sources: WorkflowSource[];
  skills: SkillSource[];
  builtIn: string[];
} => {
  const has = new Set(abe.map((f) => f.path));
  const builtIn = BUILT_IN_SKILLS.filter((name) => has.has(`skills/${name}/SKILL.md`));

  return {
    sources: [
      ...dirs.flatMap(({ layer, dir, workflows }) => {
        if (workflows === null) return [];
        const at = workflows?.dir ?? join(dir, 'workflows');
        const local = workflows?.local ?? false;

        return listed(at)
          .filter((name) => isYaml(name) && LOCAL_YAML.test(name) === local)
          .flatMap((name) => {
            const file = join(at, name);

            try {
              return [workflowSource(layer, file, workflowIdOf(name), readFileSync(file, 'utf8'))];
            } catch {
              return [];
            }
          });
      }),
      ...builtInWorkflowSources().filter((w) => has.has(`workflows/${w.id}.yaml`)),
    ],
    skills: [
      ...dirs.flatMap(({ layer, dir, skills = join(dir, 'skills') }) =>
        (typeof skills === 'string' ? [skills] : skills).flatMap((at) =>
          listed(at)
            .filter((name) => isDir(join(at, name)))
            .map((name) => skillSource(layer, join(at, name), name)),
        ),
      ),
      ...builtInSkillSources().filter((k) => builtIn.includes(k.name)),
    ],
    builtIn,
  };
};

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** A path's committed texts, newest first, from git's history of it in `repo`. */
const committedTexts = async (repo: string, path: string, env: Env): Promise<string[]> => {
  const git = (args: readonly string[]) =>
    runProcess(['git', '-C', repo, ...args], { ...gitEnv(env), GIT_TERMINAL_PROMPT: '0' });
  const log = await git(['log', '--format=%H', '--', path]);

  if (log.exit !== 0) return [];
  const texts: string[] = [];

  for (const commit of log.stdout.split('\n').filter((c) => c !== '')) {
    const shown = await git(['show', `${commit}:${path}`]);

    if (shown.exit === 0) texts.push(shown.stdout);
  }

  return texts;
};

/**
 * The repo's `abe/` folder as the shipped files' port: its files on disk, their history from git
 * (where an edited copy's base is found).
 */
export const abeFolder = (repo: string, env: Env = process.env): AbeFolder => {
  const top = join(repo, REPO_ABE_DIR);

  return {
    read: (path) => {
      try {
        return readFileSync(join(top, path), 'utf8');
      } catch {
        return null;
      }
    },
    write: (path, text) => {
      mkdirSync(dirname(join(top, path)), { recursive: true });
      writeFileSync(join(top, path), text);
    },
    files: () =>
      ['skills', 'workflows'].flatMap((dir) => filesIn(join(top, dir)).map((f) => `${dir}/${f}`)),
    hash: sha,
    history: (path) => committedTexts(repo, `${REPO_ABE_DIR}/${path}`, env),
  };
};

/** Whether Abe's workflows and skills are in the repo's `abe/` (a teammate's install, or this one's). */
export const abeFilesIn = (repo: string): boolean => isInstalled(abeFolder(repo));

/**
 * Abe's workflows and skills copied into the repo's `abe/` folder (ADR 0033): nothing when the
 * repo has them already (a teammate's).
 */
export const copyAbeFiles = (
  repo: string,
  version: string,
): { copied: boolean; workflows: number; skills: number } => copyInto(abeFolder(repo), version);

/** What Abe changed since each of the repo's copies' base. */
export const abeUpdatesIn = (repo: string): AbeUpdate[] => updatesOf(abeFolder(repo));
