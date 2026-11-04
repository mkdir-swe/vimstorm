/**
 * The ports a command gets at a checkout, composed in one place: the request's checkout routes
 * GitHub through your gh login there and Pipelines through your gh login and az folder (ADR
 * 0025), AWS through your box profile (ADR 0030), a card's GitHub through its own workspace on a
 * box (ADR 0022), and every write through Local mode's held decorators where the checkout is in
 * local mode or its board is read-only.
 */
import {
  type Aws,
  type Board,
  type GhAccounts,
  type BoxAws,
  type ByCard,
  type Git,
  type LayerPulls,
  type Pipelines,
  type RetroPulls,
  type ReviewPort,
  type Run,
  type Secrets,
  type Tracking,
} from '@abe/core';
import {
  type GithubAs,
  mainCheckout,
  type PipelinesWho,
  type ProfileBoxes,
  routedPipelines,
} from '@abe/ports';
import { type CardCheckout, cardRoutedBoard, type LocalMode } from '../local-mode';
import type { SettingsService } from '../settings';

/** Your AWS on one profile: Reach's AWS and secrets, where boxes are reached, your boxes there. */
export type AwsAs = {
  aws: Aws;
  secrets: Secrets;
  reach: () => BoxAws;
  /** Your boxes on it, their link and short list; none on a serve without boxes. */
  cloud?: ProfileBoxes;
};

/** serve's own ports and how it reaches them as you elsewhere. */
export type RoutingOptions = {
  settings: SettingsService | undefined;
  localMode: LocalMode;
  tracking: Tracking;
  /** On a box: GitHub through each card's own workspace. */
  trackingOf?: ByCard<Tracking> | undefined;
  /** GitHub as one of your gh logins; none: gh's own everywhere. */
  githubAs?: ((account: string) => GithubAs) | undefined;
  githubAccounts?: (() => Promise<GhAccounts>) | undefined;
  review?: ReviewPort | undefined;
  board: Board;
  pipelines?: Pipelines | undefined;
  /** Pipelines as your gh login and az folder; none: `pipelines` everywhere. */
  pipelinesAs?: ((who: PipelinesWho) => Pipelines) | undefined;
  layerPulls?: LayerPulls | undefined;
  retroPulls?: RetroPulls | undefined;
  aws: Aws;
  secrets: Secrets;
  awsReach?: (() => BoxAws) | undefined;
  /** Your AWS on another profile; none: serve's own everywhere. */
  awsAs?: ((profile: string) => AwsAs) | undefined;
  /** The profile serve started on and whether its environment pinned it. */
  boxProfile?: { own: string | null; pinned: boolean } | undefined;
  /** The profile your box `name` was last found on; null: serve's own. None: no boxes. */
  boxProfileOf?: ((name: string) => string | null) | undefined;
  /** Each card's git; none: this serve runs no sessions. */
  gitOf?: ByCard<Git> | undefined;
  /** The runs serve keeps: a card's run is found by its checkout and card, never the number alone. */
  runs: () => readonly RunAt[];
};

/** A run as routing finds it: its card, the checkout it runs in, whether it is over. */
export type RunAt = Pick<Run, 'card' | 'repo' | 'outcome'>;

/** What a request names beyond its checkout. */
export type RequestAt = {
  /** The request's checkout (a session's own, else where it was typed); none: inside a workspace. */
  here: string | undefined;
  /** The card whose workspace asks, or whose session does. */
  card: string | undefined;
  /** The checkout a review names (`--path`); none: `here`. */
  reviewAt: string | undefined;
};

/** The ports one request gets. */
export type PortsAt = {
  tracking: Tracking;
  review: ReviewPort | undefined;
  board: Board;
  boardAt: (dir: string) => Board;
  pipelines: Pipelines | undefined;
  pipelinesAt: (dir: string) => Pipelines | undefined;
  github: {
    at: (dir: string) => Tracking;
    as: (account: string) => Tracking | undefined;
    accounts?: () => Promise<GhAccounts>;
  };
  git: ByCard<Git> | undefined;
  layerPulls: LayerPulls | undefined;
  retroPulls: RetroPulls | undefined;
  aws: Aws;
  secrets: Secrets;
  profileAt: (dir: string) => string | null;
  awsReach: (() => BoxAws) | undefined;
  /** The AWS profile and region box `name` is reached on, as last found (ADR 0025). */
  boxAwsOf: (name: string) => BoxAws | undefined;
};

export type Routing = {
  /** The ports a request at its checkout gets. */
  at: (request: RequestAt) => PortsAt;
  /** GitHub for a card (its workspace's on a box), else as your gh login at `dir`; never held. */
  trackingFor: (card: string | undefined, dir?: string) => Tracking;
  /** A run's GitHub, git and board, held where the run's own checkout is in local mode. */
  run: {
    tracking: (run: Pick<Run, 'card' | 'repo'>) => Tracking;
    git: (run: Pick<Run, 'card' | 'repo'>) => Git;
    board: (run: Pick<Run, 'card' | 'repo'>) => Board;
  };
  /** The GitHub ports as your gh login at `dir`; none where it names none. */
  githubAt: (dir: string | undefined) => GithubAs | undefined;
  /** Your gh login at `dir`; null: gh's active one. */
  accountAt: (dir: string | undefined) => string | null;
  /** Pipelines as your gh login and az folder at `dir`, never held. */
  pipelinesFor: (dir: string | undefined) => Pipelines | undefined;
  /** The box profile at `dir` where it is not serve's own; null: serve's own. */
  profileAt: (dir: string | null | undefined) => string | null;
  /** Your AWS on `profile`, made once. */
  awsOf: (profile: string) => AwsAs | undefined;
  /** Your AWS on the box profile at `dir`; none: serve's own. */
  awsAt: (dir: string | undefined) => AwsAs | undefined;
  /** The box profiles the checkouts looked up so far name, serve's own left out. */
  profiles: () => string[];
};

export const openRouting = (o: RoutingOptions): Routing => {
  const { settings, localMode } = o;
  const made = new Map<string, AwsAs>();
  const awsOf = (profile: string): AwsAs | undefined => {
    const was = made.get(profile);

    if (was !== undefined || o.awsAs === undefined) return was;
    const aws = o.awsAs(profile);

    made.set(profile, aws);

    return aws;
  };
  /** Whether a checkout's `box.profile` may move your AWS off serve's own (not pinned). */
  const byProfile = o.awsAs !== undefined && o.boxProfile !== undefined && !o.boxProfile.pinned;
  const accountAt = (dir: string | undefined): string | null =>
    dir === undefined || settings === undefined || o.githubAs === undefined
      ? null
      : settings.facts(dir).githubAccount;
  const azFolderAt = (dir: string | undefined): string | null => {
    const at = dir === undefined ? undefined : settings?.facts(dir).azFolder;

    return at?.from === 'checkout' ? at.dir : null;
  };
  const profileAt = (dir: string | null | undefined): string | null => {
    if (!byProfile || dir === null || dir === undefined || settings === undefined) return null;
    const named = settings.facts(dir).boxProfile;

    return named === null || named === o.boxProfile?.own ? null : named;
  };
  const awsAt = (dir: string | undefined): AwsAs | undefined => {
    const profile = profileAt(dir);

    return profile === null ? undefined : awsOf(profile);
  };
  const pipelinesFor = (dir: string | undefined): Pipelines | undefined => {
    const own = o.pipelines;
    const as = o.pipelinesAs;

    if (own === undefined || as === undefined) return own;

    return routedPipelines(() => {
      const who = { account: accountAt(dir), azureConfigDir: azFolderAt(dir) };

      return who.account === null && who.azureConfigDir === null ? own : as(who);
    });
  };
  const githubAt = (dir: string | undefined): GithubAs | undefined => {
    const account = accountAt(dir);

    return account === null ? undefined : o.githubAs?.(account);
  };
  const trackingFor = (card: string | undefined, dir?: string): Tracking =>
    card !== undefined && o.trackingOf !== undefined
      ? o.trackingOf(card)
      : (githubAt(dir)?.tracking ?? o.tracking);
  const gitOf = o.gitOf;
  /** A folder's checkout (a card worktree's: the one it was added from); no repo: as named. */
  const checkoutOf = (dir: string) => mainCheckout(dir) ?? dir;
  /**
   * The checkout of `card`'s run a request at `here` means, the open run first: the run in
   * here's own checkout, never another's of the same number (a number is only its board's, and
   * two checkouts may share a board); none there, none (here's own). Outside any checkout (a
   * Terminal elsewhere, inside a workspace): the card's runs' one checkout, or `several`.
   */
  const runCheckoutOf = (card: number, here: string | undefined): CardCheckout => {
    const runs = o.runs().filter((r) => r.card === card);
    const at = here === undefined ? undefined : mainCheckout(here);
    const pick = (of: readonly RunAt[]) => (of.find((r) => r.outcome === null) ?? of[0])?.repo;

    if (at !== undefined) return pick(runs.filter((r) => checkoutOf(r.repo) === at));
    const checkouts = [...new Set(runs.map((r) => checkoutOf(r.repo)))];

    return checkouts.length > 1 ? { several: checkouts } : pick(runs);
  };

  return {
    at: ({ here, card, reviewAt }) => {
      const github = githubAt(here);
      const aws = awsAt(here);
      const reviewDir = reviewAt ?? here;

      return {
        tracking: localMode.tracking(localMode.localNumbers(trackingFor(card, here)), here),
        review: localMode.review(githubAt(reviewDir)?.review ?? o.review, reviewDir),
        // typed outside any checkout: the card's own run's (a person's `factory end`)
        board: cardRoutedBoard(
          o.board,
          localMode,
          (id) => runCheckoutOf(id, here),
          localMode.board(o.board, here),
        ),
        boardAt: (dir) => localMode.board(o.board, dir),
        pipelines: localMode.pipelines(pipelinesFor(here), here),
        pipelinesAt: (dir) => localMode.pipelines(pipelinesFor(dir), dir),
        github: {
          at: (dir) => trackingFor(undefined, dir),
          as: (account) => o.githubAs?.(account).tracking,
          ...(o.githubAccounts === undefined ? {} : { accounts: o.githubAccounts }),
        },
        git: gitOf === undefined ? undefined : (c) => localMode.git(gitOf(c), here),
        layerPulls: localMode.layerPulls(github?.layerPulls ?? o.layerPulls, here),
        retroPulls: github?.retroPulls ?? o.retroPulls,
        aws: aws?.aws ?? o.aws,
        secrets: aws?.secrets ?? o.secrets,
        profileAt: (dir) => profileAt(dir),
        awsReach:
          o.awsReach === undefined
            ? undefined
            : () => aws?.reach() ?? o.awsReach?.() ?? { profile: null, region: null },
        boxAwsOf: (name) => {
          const profile = o.boxProfileOf?.(name) ?? null;

          return profile === null ? o.awsReach?.() : awsOf(profile)?.reach();
        },
      };
    },
    trackingFor,
    run: {
      tracking: (run) => localMode.tracking(trackingFor(String(run.card), run.repo), run.repo),
      git: (run) => {
        if (gitOf === undefined) throw new Error('this abe serve runs no sessions');

        return localMode.git(gitOf(run.card), run.repo);
      },
      board: (run) => localMode.board(o.board, run.repo),
    },
    githubAt,
    accountAt,
    pipelinesFor,
    profileAt,
    awsOf,
    awsAt,
    profiles: () => [
      ...new Set(
        (byProfile ? (settings?.seen() ?? []) : [])
          .map((f) => f.boxProfile)
          .filter((p): p is string => p !== null && p !== o.boxProfile?.own),
      ),
    ],
  };
};
