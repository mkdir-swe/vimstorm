/**
 * The `board.provider` setting's words: Azure DevOps (`azure`), a board On this Mac (`local`), or
 * the repo's GitHub Issues (`github`). The names people and tools use for Azure Boards read as
 * `azure`, `github-issues` and `gh` as `github`; any other provider has no cards.
 */
export const BOARD_SETTING_PROVIDERS = ['azure', 'local', 'github'] as const;
export type BoardSettingProvider = (typeof BOARD_SETTING_PROVIDERS)[number];

/** Other names for Azure DevOps, as typed (case and spaces do not matter). */
const AZURE_ALIASES = [
  'azure-boards',
  'azure-board',
  'azure-devops',
  'azure-devops-boards',
  'azuredevops',
  'azureboards',
  'ado',
];

/** Other names for GitHub Issues, as typed. */
const GITHUB_ALIASES = ['github-issues', 'githubissues', 'gh'];

/** A provider as typed, as the setting names it; `undefined`: no board provider Abe reads. */
export const boardProviderOf = (typed: unknown): BoardSettingProvider | undefined => {
  if (typeof typed !== 'string') return undefined;
  const word = typed
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

  if (word === 'azure' || AZURE_ALIASES.includes(word)) return 'azure';
  if (word === 'github' || GITHUB_ALIASES.includes(word)) return 'github';

  return word === 'local' ? 'local' : undefined;
};

/** Providers settings accept that Abe reads no cards from yet. */
export const NO_CARDS_PROVIDERS = ['github-projects', 'jira'] as const;
export type NoCardsProvider = (typeof NO_CARDS_PROVIDERS)[number];

/** A provider settings accept that has no cards in Abe yet (`github-projects`, `jira`). */
export const noCardsProviderOf = (typed: unknown): NoCardsProvider | undefined => {
  const word = typeof typed === 'string' ? typed.trim().toLowerCase() : '';

  return NO_CARDS_PROVIDERS.find((p) => p === word);
};

/** What is said of a provider that has no cards in Abe yet. */
export const NO_CARDS_YET = (provider: string): string => `${provider} has no cards in Abe yet`;

/** Why a provider is refused, naming the valid ones. */
export const providerRefusal = (typed: unknown): string =>
  `${JSON.stringify(typed)} is no board provider: ${[...BOARD_SETTING_PROVIDERS, ...NO_CARDS_PROVIDERS].join(', ')} (azure-boards, azure-devops and ado read as azure, github-issues and gh as github; only azure, local and github have cards)`;
