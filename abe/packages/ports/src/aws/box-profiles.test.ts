/** Your boxes across the AWS profiles your checkouts name (ADR 0025), each call on its own. */
import { describe, expect, test } from 'bun:test';
import { type Answered, type Box, type BoxLink, type Boxes } from '@abe/core';
import { boxesByProfile, type ProfileBoxes } from './box-profiles';

const boxOf = (name: string): Box => ({
  id: `i-${name}`,
  name,
  owner: 'octocat',
  state: 'running',
  size: 'm8g.large',
  zone: 'eu-west-1a',
  privateIp: '10.0.0.1',
  vpc: null,
  subnet: null,
  repo: 'demo/shop',
  card: null,
});

/** One profile's fake EC2 and link: its boxes, and each call it took as `<call> <box>`. */
const profile = (names: string[], failing = false) => {
  const held = new Set(names);
  const calls: string[] = [];
  const said = (call: string, name: string): Promise<Answered<Box>> => {
    calls.push(`${call} ${name}`);

    return Promise.resolve({ ok: true, data: boxOf(name) });
  };
  const boxes: Boxes = {
    list: () =>
      Promise.resolve(
        failing
          ? { ok: false, error: { code: 'aws-auth', message: 'the SSO login expired' } }
          : { ok: true, data: [...held].map(boxOf) },
      ),
    status: (name) => {
      calls.push(`status ${name}`);

      return Promise.resolve({ ok: true, data: held.has(name) ? boxOf(name) : null });
    },
    up: (spec) => {
      held.add(spec.name);

      return said('up', spec.name);
    },
    start: (name) => said('start', name),
    stop: (name) => said('stop', name),
    resize: (name) => said('resize', name),
    terminate: (name) => said('terminate', name),
  };
  const link: BoxLink = {
    run: (box) => {
      calls.push(`run ${box}`);

      return Promise.resolve({ exit: 0, stdout: '', stderr: '' });
    },
    follow: () => ({ stop: () => undefined, ended: Promise.resolve(0) }),
    attach: (box) => [`attach ${box}`],
    forward: () => Promise.reject(new Error('not in this test')),
  };
  const made: ProfileBoxes = { boxes, link };

  return { made, calls };
};

const world = (o: { work?: string[]; play?: string[]; failing?: boolean } = {}) => {
  const own = profile(['shop', 'twice']);
  const work = profile(o.work ?? ['work-api', 'twice'], o.failing);
  const play = profile(o.play ?? []);
  const asked: string[] = [];
  const routed = boxesByProfile({
    own: own.made,
    ownProfile: 'abe-home',
    // serve's own profile named in a block too: never made again
    profiles: () => ['abe-work', 'abe-home', 'abe-work'],
    as: (p) => {
      asked.push(p);

      return p === 'abe-work' ? work.made : play.made;
    },
  });

  return { routed, own, work, play, asked };
};

describe('boxesByProfile', () => {
  test("a list is every profile's, serve's own first; a box by name goes to its profile's", async () => {
    const w = world();
    const listed = await w.routed.boxes.list();

    expect(listed.ok && listed.data.map((b) => b.name)).toEqual(['shop', 'twice', 'work-api']);
    expect(w.asked).toEqual(['abe-work']);
    const rows: [string, string | null, typeof w.own][] = [
      ['shop', null, w.own],
      ['twice', null, w.own],
      ['work-api', 'abe-work', w.work],
    ];

    for (const [name, on, p] of rows) {
      expect(w.routed.profileOf(name)).toBe(on);
      await w.routed.boxes.stop(name);
      await w.routed.link.run(name, ['status']);
      expect(p.calls.slice(-2)).toEqual([`stop ${name}`, `run ${name}`]);
    }
  });

  test("a new box is made on its spec's profile; serve's own when it names none or its own", async () => {
    const rows: [string, string | null | undefined, 'own' | 'work'][] = [
      ['new-a', 'abe-work', 'work'],
      ['new-b', undefined, 'own'],
      ['new-c', 'abe-home', 'own'],
    ];

    for (const [name, on, made] of rows) {
      const w = world();

      await w.routed.boxes.up({
        name,
        repo: 'demo/shop',
        ...(on === undefined ? {} : { profile: on }),
      });
      expect(w[made].calls).toEqual([`up ${name}`]);
      await w.routed.boxes.start(name);
      expect(w[made].calls.at(-1)).toBe(`start ${name}`);
    }
  });

  test('a name not listed yet: the first profile that has it, remembered', async () => {
    const w = world();
    const found = await w.routed.boxes.status('work-api');

    expect(found.ok && found.data?.name).toBe('work-api');
    expect(w.routed.profileOf('work-api')).toBe('abe-work');
    expect((await w.routed.boxes.status('none')).ok).toBe(true);
    expect(w.routed.profileOf('none')).toBeNull();
  });

  test("another profile's list failing leaves its boxes out, said in one line, not the list", async () => {
    const w = world({ failing: true });
    const listed = await w.routed.boxes.list();

    expect(listed.ok && listed.data.map((b) => b.name)).toEqual(['shop', 'twice']);
    expect(w.routed.unlisted()).toEqual(['abe-work: its boxes not listed: the SSO login expired']);
  });
});
