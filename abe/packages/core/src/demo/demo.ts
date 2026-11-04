/**
 * `abe demo new`: the bundled demo app (`examples/demo-shop`) as your own private repo on GitHub,
 * its cards as issues. The seed file's shape, the result every client reads and the words of each
 * refusal; the IO is the `DemoShop` port's.
 */
import { z } from 'zod';

/** The repo the demo becomes under your gh login, unless another name is given. */
export const DEMO_REPO_NAME = 'demo-shop';

/** Where it goes unless a folder is named: `<home>/projects/<the repo's name>`. */
export const DEMO_FOLDER = 'projects';

/** A repo name GitHub takes. */
export const isRepoName = (name: string): boolean =>
  /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..';

/** The seed of cards in the bundled demo, made issues in the new repo in this order. */
export const DEMO_SEED_FILE = 'board/seed.json';

/** What the copy leaves out: the seed (its cards become issues) and what a build or run leaves. */
export const DEMO_SKIPPED = ['board', 'node_modules', 'dist', '.scratch', '.git'] as const;

export const DemoCard = z.object({
  title: z.string().min(1),
  body: z.string(),
  labels: z.array(z.string()).default([]),
});
export type DemoCard = z.infer<typeof DemoCard>;

export const DemoSeed = z.object({ cards: z.array(DemoCard) });
export type DemoSeed = z.infer<typeof DemoSeed>;

export const DemoIssue = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
});
export type DemoIssue = z.infer<typeof DemoIssue>;

/** `abe demo new`. */
export const DemoNewData = z.object({
  /** The folder it was copied to, absolute. */
  folder: z.string(),
  /** `<login>/demo-shop`. */
  repo: z.string(),
  url: z.string(),
  private: z.literal(true),
  issues: z.array(DemoIssue),
  /** What to type next, one command a line. */
  next: z.array(z.string()),
});
export type DemoNewData = z.infer<typeof DemoNewData>;

/** `~/…` for a folder under `home`, else the folder as it is. */
export const homeShort = (folder: string, home: string): string =>
  home !== '' && (folder === home || folder.startsWith(`${home}/`))
    ? `~${folder.slice(home.length)}`
    : folder;

const quoted = (path: string) =>
  /^[\w@%+=:,./~-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;

/** The commands after a demo is made: into it, then Abe's install. */
export const demoNext = (folder: string): string[] => [`cd ${quoted(folder)}`, 'abe install'];

export const demoNewText = (d: DemoNewData): string =>
  [
    `Your demo is ${d.folder}, pushed to ${d.url} (private).`,
    `${d.issues.length} cards as issues:`,
    ...d.issues.map((i) => `  #${i.number} ${i.title}`),
    'Next:',
    ...d.next.map((n) => `  ${n}`),
    '',
  ].join('\n');

/** How to start over: the folder removed, the repo deleted (gh needs its delete_repo scope). */
const startOver = (o: { folder?: string; repo?: string }): string => {
  const steps = [
    ...(o.folder === undefined ? [] : [`rm -rf ${quoted(o.folder)}`]),
    ...(o.repo === undefined
      ? []
      : [`gh repo delete ${o.repo} --yes (first gh auth refresh -s delete_repo)`]),
  ];

  return `to start over: ${steps.join(', then ')}, and abe demo new again`;
};

/** Each refusal's code and words, before anything is made or after part of it. */
export const demoRefusal = {
  noDemo: () => ({
    code: 'no-demo',
    message:
      "this abe has no bundled demo (examples/demo-shop in its checkout, or the app bundle's Resources/demo-shop): build it from a full checkout",
  }),
  badName: (name: string) => ({
    code: 'bad-name',
    message: `${name} is no GitHub repo name: letters, digits, '.', '-' and '_'`,
  }),
  folderExists: (folder: string) => ({
    code: 'folder-exists',
    message: `${folder} is there already; name another folder (abe demo new <folder>), or ${startOver({ folder })}`,
  }),
  noLogin: (said: string) => ({
    code: 'no-gh-login',
    message: `gh is not signed in to GitHub (gh auth login, then abe demo new again): ${said}`,
  }),
  repoExists: (repo: string) => ({
    code: 'repo-exists',
    message: `${repo} is on GitHub already; name another repo (abe demo new --name <name>), or ${startOver({ repo })}`,
  }),
  badSeed: (said: string) => ({
    code: 'bad-seed',
    message: `the bundled demo's ${DEMO_SEED_FILE} does not read: ${said}`,
  }),
  copyFailed: (folder: string, said: string) => ({
    code: 'copy-failed',
    message: `the demo could not be made in ${folder}: ${said}; ${startOver({ folder })}`,
  }),
  repoFailed: (repo: string, folder: string, said: string) => ({
    code: 'repo-create-failed',
    message: `${repo} could not be created or pushed: ${said}; ${startOver({ folder, repo })}`,
  }),
  issueFailed: (repo: string, folder: string, made: number, title: string, said: string) => ({
    code: 'issue-create-failed',
    message: `${repo} is made, but its card "${title}" did not become an issue (${made} did): ${said}; ${startOver({ folder, repo })}`,
  }),
} as const;
