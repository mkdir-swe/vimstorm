import { describe, expect, test } from 'bun:test';
import {
  listeningPorts,
  localCandidates,
  LOCAL_TRIES,
  movedNote,
  portsOfProbe,
  PORTS_PROBE_MARK,
} from './box-ports';

const HEAD =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const HEAD6 =
  '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

/** A `/proc/net/tcp` row: its local `addr:port` (hex) and state. */
const row = (local: string, st: string) =>
  `   0: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0`;

const tcp = (...rows: string[]) => [HEAD, ...rows].join('\n');
const tcp6 = (...rows: string[]) => [HEAD6, ...rows].join('\n');

describe('the dev ports listening in /proc/net/tcp and tcp6', () => {
  test.each<[string, string, number[]]>([
    ['nothing at all', '', []],
    ['headers only', `${tcp()}\n${tcp6()}`, []],
    ['one on 127.0.0.1', tcp(row('0100007F:0BB8', '0A')), [3000]],
    ['one on the wildcard', tcp(row('00000000:1F90', '0A')), [8080]],
    ['an established connection is not listening', tcp(row('0100007F:0BB8', '01')), []],
    ['a time-wait one is not either', tcp(row('0100007F:0BB8', '06')), []],
    ['tcp6 too', tcp6(row('00000000000000000000000001000000:1538', '0A')), [5432]],
    [
      'the same port on v4 and v6 once',
      `${tcp(row('0100007F:0BB8', '0A'))}\n${tcp6(row('00000000000000000000000000000000:0BB8', '0A'))}`,
      [3000],
    ],
    [
      'below the dev range (ssh) and above it (an ephemeral listener) left out',
      tcp(row('00000000:0016', '0A'), row('0100007F:9C40', '0A'), row('0100007F:0400', '0A')),
      [1024],
    ],
    [
      'the range ends at 32767',
      tcp(row('0100007F:7FFF', '0A'), row('0100007F:8000', '0A')),
      [32767],
    ],
    [
      'sorted',
      tcp(row('0100007F:1F90', '0A'), row('0100007F:0BB8', '0A'), row('0100007F:1389', '0A')),
      [3000, 5001, 8080],
    ],
  ])('%s', (_, text, want) => {
    expect(listeningPorts(text)).toEqual(want);
  });
});

/** What the probe prints: the sockets, its mark, then the env example's name and text (if any). */
const printed = (net: string, example?: { name: string; text: string }) =>
  `${net}\n${PORTS_PROBE_MARK}\n${example === undefined ? '' : `${example.name}\n${example.text}`}`;

describe("what the probe printed, read: what listens and what the repo's auth callback fixes", () => {
  test.each<[string, string, number[], number[]]>([
    ['nothing listening, no env example', printed(tcp()), [], []],
    ['listening, no env example', printed(tcp(row('0100007F:0BB8', '0A'))), [3000], []],
    [
      'an auth callback to localhost fixes its port',
      printed(tcp(row('0100007F:0BB8', '0A')), {
        name: '.env.example',
        text: 'DATABASE_URL=postgres://x\nAUTH_CALLBACK_URL=http://localhost:3000/cb\nPORT=4000\n',
      }),
      [3000],
      [3000],
    ],
    [
      'any of the example names, 127.0.0.1 too',
      printed(tcp(), {
        name: '.env.sample',
        text: 'OAUTH_REDIRECT_URI=http://127.0.0.1:5173/auth\n',
      }),
      [],
      [5173],
    ],
    [
      'a callback elsewhere fixes nothing',
      printed(tcp(), { name: '.env.example', text: 'AUTH_CALLBACK_URL=https://shop.example/cb\n' }),
      [],
      [],
    ],
    [
      'no mark at all (a probe cut short): its sockets only',
      tcp(row('0100007F:0BB8', '0A')),
      [3000],
      [],
    ],
  ])('%s', (_, out, ports, fixed) => {
    expect(portsOfProbe('101', out)).toEqual({ card: '101', ports, fixed });
  });
});

describe('the local ports a forward tries', () => {
  test.each<[string, number, boolean, number[]]>([
    ['a fixed one: itself only', 3000, true, [3000]],
    [
      "the box's, then the next ones",
      3000,
      false,
      Array.from({ length: LOCAL_TRIES }, (_, i) => 3000 + i),
    ],
    ['never past 65535', 65534, false, [65534, 65535]],
  ])('%s', (_, port, fixed, want) => {
    expect(localCandidates(port, fixed)).toEqual(want);
  });
});

describe("why a forward is not on the box's port", () => {
  test.each<[string, number, number, string | undefined]>([
    ['on its own port: nothing said', 3000, 3000, undefined],
    ["moved: the box's was taken", 3000, 3001, 'localhost:3000 was taken'],
  ])('%s', (_, port, local, want) => {
    expect(movedNote(port, local)).toBe(want);
  });
});
