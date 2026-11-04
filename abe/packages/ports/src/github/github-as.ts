/**
 * Your gh logins on the Mac (`logins.gh`, ADR 0025): the GitHub ports as one of them, each
 * call on its token from gh's keyring (`GH_TOKEN` for that call only, gh's active login never
 * switched), the token for a session's gh, and the logins gh has; the Pipelines as a gh login and
 * in an az folder (`board.azureConfigDir`). Each login's ports made once.
 */
import {
  type GhAccounts,
  type LayerPulls,
  type Pipelines,
  type RetroPulls,
  type ReviewPort,
  type Tracking,
} from '@abe/core';
import { ghAccountsFrom, ghRunner, type GhToken, ghTokens } from './gh';
import { ghLayerPulls } from './layer-pulls';
import { type Env } from '../mac/locations';
import { pipelinesFrom } from './pipelines';
import { ghRetroPulls } from './retro-pulls';
import { reviewPort } from './review';
import { ghTracking } from './tracking';

/** The GitHub ports as one gh login. */
export type GithubAs = {
  tracking: Tracking;
  review?: ReviewPort;
  layerPulls?: LayerPulls;
  retroPulls?: RetroPulls;
};

/** Who the Pipelines read runs as at a checkout: its gh login and az folder (none: serve's own). */
export type PipelinesWho = { account: string | null; azureConfigDir: string | null };

export type GithubLogins = {
  githubAs: (account: string) => GithubAs;
  githubToken: (account: string) => GhToken;
  githubAccounts: () => Promise<GhAccounts>;
  /** GitHub Actions as `account`, Azure Pipelines on the az login in `azureConfigDir`. */
  pipelinesAs?: (who: PipelinesWho) => Pipelines;
};

export const githubLoginsFrom = (env: Env): GithubLogins => {
  const tokenOf = ghTokens(env);
  const made = new Map<string, GithubAs>();
  const runs = new Map<string, Pipelines>();
  const home = env.HOME ?? '/';
  const homed = (dir: string) => {
    if (dir === '~') return home;

    return dir.startsWith('~/') ? `${home}${dir.slice(1)}` : dir;
  };
  const ghAs = (account: string | null) =>
    account === null ? ghRunner(env) : ghRunner(env, undefined, tokenOf(account));

  return {
    githubAs: (account) => {
      const was = made.get(account);

      if (was !== undefined) return was;
      const gh = ghAs(account);
      const ports = {
        tracking: ghTracking(gh),
        review: reviewPort(env, gh),
        layerPulls: ghLayerPulls(gh),
        retroPulls: ghRetroPulls(gh),
      };

      made.set(account, ports);

      return ports;
    },
    githubToken: tokenOf,
    githubAccounts: ghAccountsFrom(env),
    pipelinesAs: (who) => {
      const key = JSON.stringify([who.account, who.azureConfigDir]);
      const was = runs.get(key);

      if (was !== undefined) return was;
      const azEnv =
        who.azureConfigDir === null ? env : { ...env, AZURE_CONFIG_DIR: homed(who.azureConfigDir) };
      const port = pipelinesFrom(env, { env: azEnv }, ghAs(who.account));

      runs.set(key, port);

      return port;
    },
  };
};
