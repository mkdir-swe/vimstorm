/** #158: the setup a new user gets wrong as Problems, each with its fix: no board, a cloud target AWS can't reach. */
import { describe, expect, test } from 'bun:test';
import { settingsProblems } from './problems';
import { setupProblems, type SetupFacts } from './setup-problems';

const ready: SetupFacts = {
  board: null,
  cloud: { target: 'cloud', profile: 'abe-dev', region: 'eu-north-1' },
};
const codes = (facts: SetupFacts) => setupProblems(facts).map((p) => p.code);

describe('setupProblems', () => {
  test('all set: no problem', () => {
    expect(setupProblems(ready)).toEqual([]);
  });

  test("no board for the repo: said, with the board row in the repo's file", () => {
    expect(setupProblems({ ...ready, board: 'the board setting has no board.project' })).toEqual([
      {
        kind: 'setup',
        code: 'no-board',
        text: 'no board for this repo: the board setting has no board.project',
        where: 'Board & you › Provider · abe.yaml',
        page: 'board-team',
        way: { kind: 'open', page: 'board-team', row: 'board#provider' },
      },
    ]);
  });

  test('serve.target cloud with no AWS profile or region: set them, or run locally', () => {
    expect(
      setupProblems({ ...ready, cloud: { target: 'cloud', profile: null, region: null } }),
    ).toEqual([
      {
        kind: 'setup',
        code: 'no-aws',
        text: "serve.target is cloud but there is no AWS profile and no AWS region, so boxes can't be reached — name the AWS profile of your boxes' account: abe settings set box.profile <profile> (and box.region), then abe serve stop so serve starts on it, or run locally",
        where: 'Boxes & cloud › AWS profile · yours',
        page: 'boxes-cloud',
        way: { kind: 'fix', command: 'abe settings set serve.target local' },
      },
    ]);
    expect(
      codes({ ...ready, cloud: { target: 'cloud', profile: 'abe-dev', region: null } }),
    ).toEqual(['no-aws']);
    expect(codes({ ...ready, cloud: { target: 'local', profile: null, region: null } })).toEqual(
      [],
    );
  });

  test('in Problems after logins and tools, before the checks', () => {
    const all = settingsProblems({
      settings: [],
      scope: { repo: null },
      logins: { secret: null, logins: { github: 'missing', claude: 'ok', az: 'ok' } },
      checks: { repo: 'demo', entries: [] },
      setup: { ...ready, board: 'no board in the settings' },
    });

    expect(all.map((p) => p.kind)).toEqual(['login', 'setup', 'checks']);
  });
});
