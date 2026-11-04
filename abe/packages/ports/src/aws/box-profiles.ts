/**
 * Your boxes across the AWS profiles your checkouts name (`box.profile`, ADR 0025): serve's own
 * profile's and each other one's, made once. A list is every profile's; a box by name goes to the
 * profile it was last listed or made on (a name not seen yet: the first profile that has it); a
 * new box to its spec's `profile`.
 */
import { type Answered, type Box, type BoxLink, type Boxes } from '@abe/core';

/** The boxes on one AWS profile, their link and `session list`'s short list. */
export type ProfileBoxes = { boxes: Boxes; link: BoxLink; scanList?: Boxes['list'] };

export type BoxesByProfile = ProfileBoxes & {
  /** The profile a box by name is on, as last seen; `null`: serve's own. */
  profileOf: (box: string) => string | null;
  /** Each other profile the last list could not read: `<profile>: its boxes not listed: <why>`. */
  unlisted: () => readonly string[];
};

export const boxesByProfile = (o: {
  own: ProfileBoxes;
  /** Serve's own profile (`null`: aws's own), which `own` is on. */
  ownProfile: string | null;
  /** The other profiles your boxes may be on now (your checkouts' `box.profile`s). */
  profiles: () => readonly string[];
  as: (profile: string) => ProfileBoxes;
}): BoxesByProfile => {
  const made = new Map<string, ProfileBoxes>();
  /** Each box's profile as last listed or made (`null`: serve's own). */
  const where = new Map<string, string | null>();
  const others = () => [...new Set(o.profiles())].filter((p) => p !== o.ownProfile);
  const on = (profile: string | null | undefined): ProfileBoxes => {
    if (profile === null || profile === undefined || profile === o.ownProfile) return o.own;
    const was = made.get(profile);

    if (was !== undefined) return was;
    const now = o.as(profile);

    made.set(profile, now);

    return now;
  };
  const ofBox = (name: string) => on(where.get(name));
  let unlisted: readonly string[] = [];
  /**
   * Every profile's boxes: serve's own first, its failure the list's; another's is left out and
   * said (`unlisted`).
   */
  const listAll =
    (pick: (p: ProfileBoxes) => Boxes['list']): Boxes['list'] =>
    async () => {
      const profiles = [null, ...others()];
      const lists = await Promise.all(profiles.map((p) => pick(on(p))()));
      const [first] = lists;

      if (first?.ok !== true) return first ?? { ok: true, data: [] };
      const all: Box[] = [];
      const said: string[] = [];

      lists.forEach((listed, i) => {
        if (!listed.ok) {
          said.push(`${profiles[i] ?? ''}: its boxes not listed: ${listed.error.message}`);

          return;
        }
        for (const box of listed.data) {
          if (all.some((b) => b.name === box.name)) continue;
          where.set(box.name, profiles[i] ?? null);
          all.push(box);
        }
      });

      unlisted = said;

      return { ok: true, data: all };
    };
  const status = async (name: string): Promise<Answered<Box | null>> => {
    if (where.has(name)) return ofBox(name).boxes.status(name);
    const own = await o.own.boxes.status(name);

    if (!own.ok || own.data !== null) return own;
    for (const profile of others()) {
      const found = await on(profile).boxes.status(name);

      if (found.ok && found.data !== null) {
        where.set(name, profile);

        return found;
      }
    }

    return own;
  };
  const boxes: Boxes = {
    list: listAll((p) => p.boxes.list),
    status,
    up: async (spec) => {
      const profile = spec.profile ?? null;
      const up = await on(profile).boxes.up(spec);

      if (up.ok) where.set(spec.name, profile === o.ownProfile ? null : profile);

      return up;
    },
    start: (name) => ofBox(name).boxes.start(name),
    stop: (name) => ofBox(name).boxes.stop(name),
    resize: (name, size) => ofBox(name).boxes.resize(name, size),
    terminate: (name) => ofBox(name).boxes.terminate(name),
  };
  const link: BoxLink = {
    run: (box, argv) => ofBox(box).link.run(box, argv),
    follow: (box, argv, onLine) => ofBox(box).link.follow(box, argv, onLine),
    attach: (box, argv) => ofBox(box).link.attach(box, argv),
    forward: (box, port, local) => ofBox(box).link.forward(box, port, local),
    close: () => {
      o.own.link.close?.();
      for (const p of made.values()) p.link.close?.();
    },
  };

  return {
    boxes,
    link,
    scanList: listAll((p) => p.scanList ?? p.boxes.list),
    profileOf: (box) => where.get(box) ?? null,
    unlisted: () => unlisted,
  };
};
