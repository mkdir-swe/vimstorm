/** A `Tracking` for scenarios that never reach GitHub. Every call refuses and names itself. */
import { type Tracked, type Tracking } from '@abe/core';

export const refusingTracking = (): Tracking => {
  const refuse = (name: string) => () =>
    Promise.resolve<Tracked<never>>({
      ok: false,
      error: { code: 'gh-failed', message: `${name}: this scenario has no GitHub` },
    });

  return {
    issueShow: refuse('issueShow'),
    issueCreate: refuse('issueCreate'),
    issueComment: refuse('issueComment'),
    prShow: refuse('prShow'),
    prFind: refuse('prFind'),
    prCreate: refuse('prCreate'),
    prUpdate: refuse('prUpdate'),
    prMerge: refuse('prMerge'),
    prReviews: refuse('prReviews'),
    deployStatus: refuse('deployStatus'),
    me: refuse('me'),
    issueList: refuse('issueList'),
    recentPrs: refuse('recentPrs'),
  };
};
