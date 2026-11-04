/** Where compose may run, and each card's own project. */
import { describe, expect, test } from 'bun:test';
import {
  baseComposeProject,
  boxComposeArgs,
  composeNotLocal,
  composePathsOutside,
  composeProject,
  fixedHostPorts,
} from './compose';

const SOCKET = { name: 'default', host: 'unix:///var/run/docker.sock' };

describe('composeNotLocal: compose runs locally only', () => {
  test.each<[string, Record<string, string>, typeof SOCKET | null, string | null]>([
    ['the local socket', {}, SOCKET, null],
    ['no Docker to ask', {}, null, null],
    ['DOCKER_HOST a local socket', { DOCKER_HOST: 'unix:///tmp/d.sock' }, null, null],
    [
      'DOCKER_HOST over tcp, its user left out',
      { DOCKER_HOST: 'tcp://me:pw@10.0.0.5:2376' },
      SOCKET,
      'DOCKER_HOST is tcp://10.0.0.5:2376, not a local socket',
    ],
    [
      'a context on another host',
      {},
      { name: 'far', host: 'ssh://deploy@10.0.0.5' },
      'the docker context far reaches ssh://10.0.0.5, not a local socket',
    ],
  ])('%s', (_, env, context, said) => {
    const why = composeNotLocal(env, context);

    expect(
      said === null ? why : why?.slice(why.indexOf(said), why.indexOf(said) + said.length),
    ).toBe(said);
  });
});

test.each<[string, number | string, string]>([
  ['/x/demo-shop', 4, 'abe-demo-shop-4'],
  ['/x/demo-shop/', 5, 'abe-demo-shop-5'],
  ['/x/My Shop', '4-ab12', 'abe-my-shop-4-ab12'],
])('composeProject %s card %s: %s', (repo, card, want) => {
  expect(composeProject(repo, card)).toBe(want);
  expect(baseComposeProject(want)).toBe(`${want}-base`);
});

test('fixedHostPorts: a published host port written as a number, by file and line', () => {
  const text = [
    'services:',
    '  db:',
    '    image: postgres',
    '    ports:',
    '      - "5432:5432" # the repo default',
    '      - "127.0.0.1:${DB_PORT:-6543}:5432"',
    '      - "6379"',
    '  api:',
    '    ports:',
    '      - target: 80',
    '        published: 8080',
    '      - target: 81',
    '        published: ${API_PORT}',
    '  web:',
    '    ports: ["127.0.0.1:3000:3000", "127.0.0.1::9229"]',
    '',
  ].join('\n');

  expect(fixedHostPorts('compose.yaml', text).map((f) => `${f.line} ${f.item}`)).toEqual([
    '5 5432:5432',
    '11 published: 8080',
    '15 127.0.0.1:3000:3000',
  ]);
});

test.each<[string[], string]>([
  [['up', '-d'], 'up starts'],
  [['down', '--volumes'], 'down stops'],
  [['ps'], 'ps'],
  [['-p', 'other', 'up'], 'refused'],
  [['--file=x.yaml', 'up'], 'refused'],
  [['--context', 'far', 'ps'], 'refused'],
  [['-d'], 'refused'],
])("boxComposeArgs %j: the box's own project, file and daemon", (args, want) => {
  const got = boxComposeArgs(args);

  expect(
    got.ok
      ? [got.command, got.starts ? 'starts' : '', got.stops ? 'stops' : '']
          .filter((x) => x !== '')
          .join(' ')
      : 'refused',
  ).toBe(want);
});

test('composePathsOutside: what a box cannot give from the clone, by file and line', () => {
  const text = [
    'services:',
    '  db:',
    '    image: postgres',
    '    volumes:',
    '      - ./init.sql:/docker-entrypoint-initdb.d/init.sql',
    '      - pgdata:/var/lib/postgresql/data',
    '      - /var/run/docker.sock:/var/run/docker.sock',
    '      - /cache',
    '      - ../../secrets:/run/secrets',
    '  api:',
    '    build: ..',
    '    env_file: ../.env',
    '    volumes:',
    '      - type: bind',
    '        source: ~/certs',
    '        target: /certs',
    'volumes:',
    '  pgdata:',
    '',
  ].join('\n');

  expect(composePathsOutside('infra/compose.yaml', text).map((f) => `${f.line} ${f.item}`)).toEqual(
    ['7 /var/run/docker.sock', '9 ../../secrets', '15 ~/certs'],
  );
});
