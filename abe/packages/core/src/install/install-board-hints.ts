/**
 * The boards a repo names (Read's `boards`, Board's proposal): links to Azure Boards (dev.azure.com,
 * visualstudio.com), GitHub Projects and Jira in its agent files, README, docs and CI, an org and
 * project said in prose about Azure DevOps, and an Azure DevOps origin. Hints only: the person
 * says which board.
 */
import { z } from 'zod';
import { githubRepoOf } from '../board';

/** A board the repo names, and where it was seen. */
export const BoardHint = z.object({
  provider: z.enum(['azure-boards', 'github-issues', 'github-projects', 'jira']),
  /** As `board-where --board` takes it: `Shop/Web` (project/team), `acme/7`, `SHOP`, `acme/shop`. */
  name: z.string(),
  /** Azure DevOps' `https://dev.azure.com/<org>`, Jira's site; null for GitHub Projects. */
  organization: z.string().nullable(),
  project: z.string().nullable(),
  /** An Azure board's team, when the link names it. */
  team: z.string().nullable(),
  /** The link as written; null: said in prose, or origin. */
  url: z.string().nullable(),
  /** Where it was seen: `origin`, or a file and line (`CLAUDE.md:12`). */
  why: z.string(),
});
export type BoardHint = z.infer<typeof BoardHint>;

/** An Azure board as its URL names it: the team null when the link has none (a query, a work item). */
export type AzureBoard = { organization: string; project: string; team: string | null };

/** The team Azure DevOps makes with a project, as it names it: a link with no team takes it. */
export const defaultTeam = (project: string): string => `${project} Team`;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const decoded = (part: string | undefined): string | null => {
  if (part === undefined) return null;
  try {
    const text = decodeURIComponent(part);

    return text === '' || text.startsWith('_') ? null : text;
  } catch {
    return null;
  }
};

const orgUrl = (org: string) => `https://dev.azure.com/${org}`;

/**
 * An Azure DevOps remote's organization and project:
 * `https://[user@]dev.azure.com/<org>/<project>/_git/<repo>`, `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>`,
 * `https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>`. Anything else: none.
 */
export const azureRemoteOf = (
  remote: string,
): { organization: string; project: string | null } | undefined => {
  const web = /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/?#]+)(?:\/([^/?#]+))?/i.exec(remote);
  const ssh = /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com[:/]v3\/([^/]+)\/([^/]+)/i.exec(remote);
  const legacy =
    /^https:\/\/(?:[^@/]+@)?([^./?#@]+)\.visualstudio\.com(?:\/(?:DefaultCollection\/)?([^/?#]+))?/i.exec(
      remote,
    );
  const m = web ?? ssh ?? legacy;
  const org = m?.[1];

  if (org === undefined || !NAME.test(org)) return undefined;

  return { organization: orgUrl(org), project: decoded(m?.[2]) };
};

/** A file that speaks of Azure DevOps: prose in it may name the org. */
const AZURE_WORDS = /azure\s+(?:devops|boards)|\baz\s+(?:boards|devops)\b/i;

/** An org said in prose: `Org: "acme"`, `organization: acme`, `--org acme`, `--organization acme`. */
const ORG_IN_PROSE =
  /(?:--org(?:ani[sz]ation)?[= ]|\borg(?:ani[sz]ation)?\b["'`*]*\s*[:=]\s*)["'`]?(?:https:\/\/dev\.azure\.com\/)?([A-Za-z0-9][A-Za-z0-9-]*)\b/i;

/** A project said in prose: `project: "Web Shop"`, `--project Shop`. */
const PROJECT_IN_PROSE =
  /(?:--project[= ]|\bproject\b["'`*]*\s*[:=]\s*)(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|([A-Za-z0-9][\w.-]*))/i;

/** The org (and project) a file's prose names, when the file speaks of Azure DevOps. */
const azureInProse = (path: string, text: string): BoardHint | undefined => {
  if (!AZURE_WORDS.test(text)) return undefined;
  const lines = text.split('\n');

  for (const [n, line] of lines.entries()) {
    const org = ORG_IN_PROSE.exec(line)?.[1];

    if (org === undefined) continue;
    const near = [line, lines[n + 1] ?? '', lines[n + 2] ?? ''];
    const p = near.map((l) => PROJECT_IN_PROSE.exec(l)).find((m) => m !== null);
    const project = decoded(p?.[1] ?? p?.[2] ?? p?.[3] ?? p?.[4]);

    return {
      provider: 'azure-boards',
      name: project ?? org,
      organization: orgUrl(org),
      project,
      team: null,
      url: null,
      why: `${path}:${n + 1}`,
    };
  }

  return undefined;
};

/** `https://[user@]dev.azure.com/<org>/<rest>`, `https://<org>.visualstudio.com/[DefaultCollection/]<rest>`. */
const AZURE_WEB = /^https:\/\/(?:[^@/\s]+@)?dev\.azure\.com\/([^/?#\s]+)\/?([^?#\s]*)/i;
const AZURE_LEGACY =
  /^https:\/\/(?:[^@/\s]+@)?([^./?#@\s]+)\.visualstudio\.com\/?(?:DefaultCollection(?:\/|$))?([^?#\s]*)/i;

/** The Boards pages whose next part (after `t/`) is the team: `_boards/board/t/Web`, `_backlogs/backlog/Web`. */
const TEAM_PAGES = new Set(['_boards', '_backlogs', '_sprints']);

/** An Azure DevOps link's org (its URL) and the path after it; none for another host. */
const azureLink = (url: string): { organization: string; rest: string[] } | undefined => {
  const m = AZURE_WEB.exec(url) ?? AZURE_LEGACY.exec(url);
  const org = m?.[1];

  if (org === undefined || !NAME.test(org)) return undefined;

  return { organization: orgUrl(org), rest: (m?.[2] ?? '').split('/').filter((p) => p !== '') };
};

/**
 * Any Azure Boards URL's organization, project and team: a team board
 * (`…/<project>/_boards/board/t/<team>/…`), a backlog or sprint (`_backlogs/backlog/<team>`,
 * `_sprints/taskboard/<team>`), an older link with the team in its path
 * (`<org>.visualstudio.com/<project>/<team>/_backlogs/…`), a query or a work item (no team). None
 * for a link with no project, or another host.
 */
export const azureBoardOf = (url: string): AzureBoard | undefined => {
  const link = azureLink(url);
  const [first, second, third, fourth, fifth] = (link?.rest ?? []).map(segment);
  const project = first;

  if (link === undefined || project === undefined || project.startsWith('_')) return undefined;
  const team = (() => {
    if (second === undefined) return null;
    // an older link: the team between the project and the page
    if (!second.startsWith('_')) return third?.startsWith('_') === true ? second : null;
    if (!TEAM_PAGES.has(second.toLowerCase())) return null;
    const named = fourth === 't' ? fifth : fourth;

    return named === undefined || named.startsWith('_') ? null : named;
  })();

  return { organization: link.organization, project, team };
};

/** A path segment decoded; one that is no URL encoding stays as written. */
const segment = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/** A link in a text: up to a space, a quote, a bracket or a backtick. */
const LINK = /https:\/\/[^\s)"'<>`\]]+/g;

const GITHUB_PROJECT = /^https:\/\/github\.com\/(?:orgs|users)\/([\w.-]+)\/projects\/(\d+)/i;
const JIRA_SITE = /^https:\/\/([a-z0-9][a-z0-9-]*)\.atlassian\.net\//i;
const JIRA_KEY =
  /\/browse\/([A-Z][A-Z0-9_]+)-\d+|\/projects\/([A-Z][A-Z0-9_]+)(?:[/?#]|$)|[?&]projectKey=([A-Z][A-Z0-9_]+)/;

/** The board a link names, seen at `why`; none for any other link. */
const hintOfLink = (url: string, why: string): BoardHint | undefined => {
  const board = azureBoardOf(url);

  if (board !== undefined)
    return {
      provider: 'azure-boards',
      name: board.team === null ? board.project : `${board.project}/${board.team}`,
      ...board,
      url,
      why,
    };
  const org = azureLink(url);

  // an organization alone (its API, its root): a hint at the org
  if (org !== undefined)
    return {
      provider: 'azure-boards',
      name: orgName(org.organization),
      organization: org.organization,
      project: null,
      team: null,
      url,
      why,
    };
  const gh = GITHUB_PROJECT.exec(url);

  if (gh?.[1] !== undefined && gh[2] !== undefined)
    return {
      provider: 'github-projects',
      name: `${gh[1]}/${gh[2]}`,
      organization: null,
      project: null,
      team: null,
      url,
      why,
    };
  const site = JIRA_SITE.exec(url)?.[1];
  const key = JIRA_KEY.exec(url);
  const project = key?.[1] ?? key?.[2] ?? key?.[3];

  return site === undefined || project === undefined
    ? undefined
    : {
        provider: 'jira',
        name: project,
        organization: `https://${site.toLowerCase()}.atlassian.net`,
        project,
        team: null,
        url,
        why,
      };
};

const orgName = (url: string) => url.slice(url.lastIndexOf('/') + 1);

/** Which files are read first: the agent files, the README, the docs, then CI. */
const rank = (path: string): number => {
  const p = path.toLowerCase();

  if (p === 'claude.md') return 0;
  if (p === 'agents.md') return 1;
  if (p.startsWith('readme')) return 2;
  if (p.startsWith('docs/')) return 3;

  return 4;
};

/** The same board: one hint for it, the one that says more (a team, then a link) kept in the first one's place. */
const keyOf = (h: BoardHint) => JSON.stringify([h.provider, h.organization, h.project ?? h.name]);
const says = (h: BoardHint) => (h.team === null ? 0 : 2) + (h.url === null ? 0 : 1);

const merged = (hints: readonly BoardHint[]): BoardHint[] => {
  const out: BoardHint[] = [];
  const at = new Map<string, number>();

  for (const h of hints) {
    const was = at.get(keyOf(h));

    if (was === undefined) {
      at.set(keyOf(h), out.length);
      out.push(h);
    } else if (says(h) > says(out[was] ?? h)) out[was] = h;
  }
  // an organization alone, when a hint names one of its projects: that one says it
  const projects = new Set(
    out
      .filter((h) => h.provider === 'azure-boards' && h.project !== null)
      .map((h) => h.organization),
  );

  return out.filter(
    (h) => !(h.provider === 'azure-boards' && h.project === null && projects.has(h.organization)),
  );
};

/**
 * The boards the files name (the agent files, README, docs, CI), each once, the agent files first:
 * every link to Azure Boards, GitHub Projects or Jira, then an org and project said in prose in a
 * file that speaks of Azure DevOps (`Org: "acme", project: "Shop"`, `az boards … --org acme`). A
 * board linked and said in prose is its link.
 */
export const boardHintsIn = (files: ReadonlyMap<string, string>): BoardHint[] => {
  const ordered = [...files].sort(([a], [b]) => rank(a) - rank(b));
  const linked = ordered.flatMap(([path, text]) =>
    text
      .split('\n')
      .flatMap((line, n) =>
        [...line.matchAll(LINK)].flatMap((m) => hintOfLink(m[0], `${path}:${n + 1}`) ?? []),
      ),
  );
  const prose = ordered.flatMap(([path, text]) => azureInProse(path, text) ?? []);

  return merged([...linked, ...prose]);
};

/**
 * The hints with an Azure DevOps origin's org and project first (`why: origin`); a GitHub
 * origin's issues last (`github-issues`, `why: origin`): any board the files name comes first.
 */
export const withOriginHint = (
  hints: readonly BoardHint[],
  origin: string | undefined,
): BoardHint[] => {
  const remote = origin === undefined ? undefined : azureRemoteOf(origin);
  const github = origin === undefined ? undefined : githubRepoOf(origin);

  if (github !== undefined)
    return merged([
      ...hints,
      {
        provider: 'github-issues',
        name: github,
        organization: null,
        project: null,
        team: null,
        url: null,
        why: 'origin',
      },
    ]);

  return remote === undefined
    ? [...hints]
    : merged([
        {
          provider: 'azure-boards',
          name: remote.project ?? orgName(remote.organization),
          organization: remote.organization,
          project: remote.project,
          team: null,
          url: null,
          why: 'origin',
        },
        ...hints,
      ]);
};
