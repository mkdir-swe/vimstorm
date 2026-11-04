/**
 * `abe browser list|add|rename|remove|default|open|store` (#103): your browser profiles in your
 * Layer's `browser.profiles` / `browser.default`, the team's read as they merge, and on the Mac
 * the Chrome folders in `<config>/chrome/`, where 1.0's two Chromes become `work` / `work-admin`
 * the first time (links left under the old names, so 1.0 keeps working until #118). `open`
 * starts a profile's Chrome on its folder to sign in; `store` reads its sign-ins through DevTools
 * into your secret `abe/<person>/browser/<name>` (the value on stdin only), which a box restores;
 * a Chrome opened (or found open) is watched and stored on its own when it closes (`profile-watch`).
 */
import { existsSync, lstatSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  agoText,
  BrowserProfile,
  type BrowserListData,
  type Chrome,
  type ChromeFolder,
  isPageUrl,
  runProfile,
  type Clock,
  DEFAULT_PROFILE,
  individualFile,
  type Migration,
  migrationPlan,
  type Outcome,
  profileList,
  ProfileName,
  type ProfileStore,
  putEntry,
  refused,
  type SettingKey,
  sourcedProfiles,
  storeHint,
  type Handlers,
} from '@abe/core';
import { readYamlFile, runOwn, type SettingsPlaces, writeYamlFile } from '@abe/ports';
import { z } from 'zod';
import { loadSettings, type SettingsCtx, type SettingsService } from '../layer/settings';
import { type ProfileWatch, storeSignIns } from './profile-watch';

/** `<config>/chrome`: the Mac's Chrome folders, one per profile (1.0's place). */
export const chromeRoot = (places: SettingsPlaces): string => join(places.configDir, 'chrome');

/** The Chrome folders, or `null` where there are none (a box has no `chrome/`). */
const foldersIn = (root: string): ChromeFolder[] | null => {
  if (!existsSync(root)) return null;

  return readdirSync(root)
    .filter((name) => !name.startsWith('.'))
    .map((name) => ({ name, link: lstatSync(join(root, name)).isSymbolicLink() }))
    .filter((f) => f.link || lstatSync(join(root, f.name)).isDirectory());
};

/** Whether a Chrome runs on this folder now: never rename one under it. */
export type ChromeRunning = (dir: string) => Promise<boolean>;

export const chromeRunning: ChromeRunning = async (dir) => {
  const ps = await runOwn(['ps', '-axo', 'args=']);

  return ps.exit === 0 && ps.stdout.includes(`--user-data-dir=${dir}`);
};

const Profiles = z.array(BrowserProfile);

/** Your Layer's own file and its two browser keys, as written there. */
const yours = (places: SettingsPlaces) => {
  const file = individualFile(places.configDir);
  const read = readYamlFile(file);
  const doc = 'error' in read ? undefined : read.doc;
  const merged = loadSettings(places, undefined, (f) => (f === file ? read : { doc: undefined }));

  return {
    file,
    error: 'error' in read ? read.error : undefined,
    doc,
    profiles: Profiles.parse(
      merged.explain('browser.profiles').layers.find((l) => l.layer === 'individual')?.written ??
        [],
    ),
    default: ProfileName.nullable().parse(
      merged.explain('browser.default').layers.find((l) => l.layer === 'individual')?.written ??
        null,
    ),
  };
};

type Yours = ReturnType<typeof yours>;

/** Your Layer's file with the browser keys given put, everything else kept. */
const write = (own: Yours, put: { profiles?: BrowserProfile[]; default?: string | null }) => {
  let doc: unknown = own.doc;
  const entry = (key: SettingKey, value: unknown) => {
    doc = putEntry(doc, key, { kind: 'plain', value });
  };

  if (put.profiles !== undefined) entry('browser.profiles', put.profiles);
  if (put.default !== undefined) entry('browser.default', put.default);
  writeYamlFile(own.file, doc);
};

/** 1.0's two Chromes, once; skipped while a Chrome runs on either. */
const migrate = async (
  places: SettingsPlaces,
  running: ChromeRunning,
): Promise<Migration['renames']> => {
  const root = chromeRoot(places);
  const folders = foldersIn(root);

  if (folders === null) return [];
  const own = yours(places);

  if (own.error !== undefined) return [];
  const plan = migrationPlan(folders, own);

  if (plan.renames.length === 0) return [];
  const open = await Promise.all(plan.renames.map((r) => running(join(root, r.from))));

  if (open.some(Boolean)) return [];
  for (const r of plan.renames) renameSync(join(root, r.from), join(root, r.to));
  for (const l of plan.links) symlinkSync(l.to, join(root, l.from));
  write(own, {
    ...(plan.profiles.length > 0 ? { profiles: [...own.profiles, ...plan.profiles] } : {}),
    ...(plan.default === null ? {} : { default: plan.default }),
  });

  return plan.renames;
};

/**
 * When each profile's sign-ins were stored; none known when the store cannot be read (`unread`
 * says why: a list shows them as not stored, a write that would move or delete one refuses).
 */
const storedIn = async (
  store: ProfileStore | undefined,
): Promise<{ at: Map<string, string>; unread: string | undefined }> => {
  if (store === undefined) return { at: new Map(), unread: undefined };
  const listed = await store.list();

  return listed.ok
    ? { at: new Map(listed.data.map((p) => [p.name, p.storedAt])), unread: undefined }
    : { at: new Map(), unread: listed.error.message };
};

/** The Mac's Chromes as a list shows them: which are open now, and their stores on their own. */
type Live = {
  chrome: Chrome | undefined;
  watch: ProfileWatch | undefined;
  clock: Clock | undefined;
};

const listOf = async (
  settings: SettingsService,
  cwd: string,
  migrated: Migration['renames'],
  stored: ReadonlyMap<string, string>,
  live: Live = { chrome: undefined, watch: undefined, clock: undefined },
): Promise<BrowserListData> => {
  const { places } = settings;
  const merged = settings.at(resolve(cwd));
  const profiles = sourcedProfiles(merged.explain('browser.profiles').layers);
  const folders = foldersIn(chromeRoot(places));
  const open = new Set<string>();

  // a Chrome open on a profile's folder is watched, so its sign-ins are stored when it closes
  // (one opened before this serve started, too)
  if (live.chrome !== undefined && folders !== null)
    for (const p of profiles) {
      const dir = join(chromeRoot(places), p.name);

      if (!folders.some((f) => f.name === p.name)) continue;
      if ((await live.chrome.running(dir)) === undefined) continue;
      open.add(p.name);
      live.watch?.watch(p.name, dir);
    }
  const { clock } = live;

  return profileList({
    profiles,
    default: merged.values['browser.default'],
    folders,
    stored: (name) => stored.get(name) ?? null,
    migrated,
    ...(live.chrome === undefined || folders === null
      ? {}
      : { open: (name: string) => open.has(name) }),
    ...(live.watch === undefined ? {} : { failed: live.watch.failed }),
    ...(clock === undefined ? {} : { ago: (at: string) => agoText(at, clock.now()) }),
  });
};

/**
 * Settings' Problems' browser facts (#345): the profiles in force in `cwd`, and whether your
 * stored sign-ins were read (none said of them when not).
 */
export const profileFacts = async (
  settings: SettingsService,
  cwd: string,
  store: ProfileStore | undefined,
): Promise<{ list: BrowserListData; stored: boolean }> => {
  const stored = await storedIn(store);

  return {
    list: await listOf(settings, cwd, [], stored.at),
    stored: store !== undefined && stored.unread === undefined,
  };
};

/** What the profile commands reach besides the settings: your stored sign-ins, the Mac's Chrome. */
export type BrowserStoreCtx = SettingsCtx & {
  serve: {
    profileStore: ProfileStore | undefined;
    /** The Mac's Chrome; none on a box. */
    chrome: Chrome | undefined;
    /** The open profiles' Chromes, stored on their own when they close; none on a box. */
    profileWatch?: ProfileWatch | undefined;
    onBox: boolean;
    clock: Clock;
  };
};

const noSettings = () => refused('no-settings', 'this abe serve was started without its settings');

const badName = (name: string): Outcome<never> | undefined => {
  const read = ProfileName.safeParse(name);

  return read.success
    ? undefined
    : refused('bad-profile-name', `${name}: ${read.error.issues[0]?.message}`);
};

const noStore = () =>
  refused('no-profile-store', 'this abe serve reaches no store for your sign-ins (AWS)');

/**
 * The profile a launch names (`--profile`, else `browser.default` in force in `where`, else the
 * built-in empty `default`): one no Layer has is refused, one with nothing stored too, never
 * started empty in its place (#103).
 */
export const launchProfile = async (
  ctx: {
    settings: SettingsCtx['settings'];
    serve: {
      profileStore: ProfileStore | undefined;
    };
  },
  where: string,
  asked: string | undefined,
): Promise<Outcome<string>> => {
  const merged = ctx.settings?.at(where);
  const chosen = runProfile({
    profiles:
      merged === undefined ? [] : sourcedProfiles(merged.explain('browser.profiles').layers),
    fallback: merged?.values['browser.default'] ?? null,
    asked,
  });

  if (!chosen.ok) return refused(chosen.code, chosen.message);
  const { name } = chosen;

  if (name === DEFAULT_PROFILE) return { ok: true, data: name };
  if (ctx.serve.profileStore === undefined) return noStore();
  const listed = await ctx.serve.profileStore.list();

  if (!listed.ok) return refused('profile-unreadable', listed.error.message);
  if (!listed.data.some((p) => p.name === name))
    return refused('profile-not-stored', `${name} has no stored sign-ins: ${storeHint(name)}`);

  return { ok: true, data: name };
};

/** A stored copy moved to its profile's new name: written there, then the old one deleted. */
const moveStored = async (store: ProfileStore, from: string, to: string) => {
  const read = await store.read(from);

  if (!read.ok) return refused('profile-unreadable', read.error.message);
  if (read.data === null) return undefined;
  const written = await store.write(to, read.data.text);

  if (!written.ok) return refused(written.error.code, written.error.message);
  const removed = await store.remove(from);

  return removed.ok ? undefined : refused(removed.error.code, removed.error.message);
};

const liveOf = (ctx: BrowserStoreCtx): Live => ({
  chrome: ctx.serve.onBox ? undefined : ctx.serve.chrome,
  watch: ctx.serve.profileWatch,
  clock: ctx.serve.clock,
});

export const browserProfileHandlers = <Ctx extends BrowserStoreCtx>(
  running: ChromeRunning = chromeRunning,
) => {
  /** Reads your Layer and the list, the migration first; a write then answers the list after. */
  const begin = async (ctx: Ctx) => {
    if (ctx.settings === undefined) return undefined;
    const { places } = ctx.settings;
    const migrated = await migrate(places, running);

    // what reads the settings next sees the profiles moved in
    if (migrated.length > 0) ctx.settings.poll();
    const own = yours(places);
    const read = await storedIn(ctx.serve.profileStore);
    const stored = read.at;

    return {
      places,
      settings: ctx.settings,
      migrated,
      own,
      stored,
      unread: read.unread,
      list: await listOf(ctx.settings, ctx.cwd, migrated, stored, liveOf(ctx)),
    };
  };
  type Begun = NonNullable<Awaited<ReturnType<typeof begin>>>;
  const done = async (b: Begun, ctx: Ctx, text: string) => {
    // what reads the settings next sees this write
    ctx.settings?.poll();

    return {
      ok: true as const,
      data: {
        file: b.own.file,
        done: text,
        list: await listOf(
          b.settings,
          ctx.cwd,
          b.migrated,
          (await storedIn(ctx.serve.profileStore)).at,
          liveOf(ctx),
        ),
      },
    };
  };
  const teamProfile = (b: Begun, name: string) => {
    const row = b.list.profiles.find((p) => p.name === name);

    if (row === undefined || row.layer === 'individual' || row.layer === 'built-in')
      return undefined;

    return refused('team-profile', `${name} is the repo's: propose a change for the repo`);
  };
  /** A profile `open` and `store` act on: any Layer's (the sign-ins are yours), not `default`. */
  const signable = async (
    ctx: Ctx,
    name: string,
  ): Promise<Outcome<{ dir: string; chrome: Chrome }>> => {
    if (ctx.serve.onBox || ctx.serve.chrome === undefined)
      return refused(
        'mac-only',
        'a box restores sign-ins from Secrets Manager: open and store them locally',
      );
    const b = await begin(ctx);

    if (b === undefined) return noSettings();
    const bad = badName(name);

    if (bad !== undefined) return bad;
    if (!b.list.profiles.some((p) => p.name === name))
      return refused('no-profile', `${name} is no profile: abe browser add ${name} --purpose …`);

    return { ok: true, data: { dir: join(chromeRoot(b.places), name), chrome: ctx.serve.chrome } };
  };

  return {
    'browser list': async (_, ctx) => {
      const b = await begin(ctx);

      return b === undefined ? noSettings() : { ok: true, data: b.list };
    },
    'browser add': async (args, ctx) => {
      const b = await begin(ctx);

      if (b === undefined) return noSettings();
      const bad = badName(args.name);

      if (bad !== undefined) return bad;
      const purpose = args.purpose.trim();

      if (purpose === '') return refused('purpose-required', 'a purpose, one line');
      if (b.list.profiles.some((p) => p.name === args.name))
        return refused('profile-exists', `${args.name} is a profile already`);
      write(b.own, { profiles: [...b.own.profiles, { name: args.name, purpose }] });

      return done(b, ctx, `added ${args.name} (${purpose}) to your Layer`);
    },
    'browser rename': async (args, ctx) => {
      const b = await begin(ctx);

      if (b === undefined) return noSettings();
      const bad = badName(args.old) ?? badName(args.new) ?? teamProfile(b, args.old);

      if (bad !== undefined) return bad;
      if (!b.own.profiles.some((p) => p.name === args.old))
        return refused('no-profile', `${args.old} is no profile of yours`);
      if (b.list.profiles.some((p) => p.name === args.new))
        return refused('profile-exists', `${args.new} is a profile already`);
      const root = chromeRoot(b.places);
      const from = join(root, args.old);

      if (existsSync(from) && (await running(from)))
        return refused('chrome-running', `${args.old}'s Chrome is open: close it, then rename`);
      // The stored sign-ins move with it (first, so a failed move renames nothing).
      if (b.stored.has(args.old)) {
        if (ctx.serve.profileStore === undefined) return noStore();
        const moved = await moveStored(ctx.serve.profileStore, args.old, args.new);

        if (moved !== undefined) return moved;
      }
      if (existsSync(from)) renameSync(from, join(root, args.new));
      write(b.own, {
        profiles: b.own.profiles.map((p) => (p.name === args.old ? { ...p, name: args.new } : p)),
        ...(b.own.default === args.old ? { default: args.new } : {}),
      });

      return done(
        b,
        ctx,
        b.unread === undefined
          ? `renamed ${args.old} → ${args.new}`
          : `renamed ${args.old} → ${args.new}; any stored sign-ins of ${args.old} stay under its old name (${b.unread})`,
      );
    },
    'browser remove': async (args, ctx) => {
      const b = await begin(ctx);

      if (b === undefined) return noSettings();
      const bad = badName(args.name) ?? teamProfile(b, args.name);

      if (bad !== undefined) return bad;
      if (!b.own.profiles.some((p) => p.name === args.name))
        return refused('no-profile', `${args.name} is no profile of yours`);
      const dir = join(chromeRoot(b.places), args.name);

      if (args.forget) {
        if (existsSync(dir) && (await running(dir)))
          return refused('chrome-running', `${args.name}'s Chrome is open: close it, then remove`);
        if (b.stored.has(args.name)) {
          if (ctx.serve.profileStore === undefined) return noStore();
          const removed = await ctx.serve.profileStore.remove(args.name);

          if (!removed.ok) return refused(removed.error.code, removed.error.message);
        }
        rmSync(dir, { recursive: true, force: true });
      }
      write(b.own, {
        profiles: b.own.profiles.filter((p) => p.name !== args.name),
        ...(b.own.default === args.name ? { default: null } : {}),
      });

      const forgotten =
        b.unread === undefined
          ? `removed ${args.name}, its Chrome folder and its stored sign-ins`
          : `removed ${args.name} and its Chrome folder; any stored sign-ins stay (${b.unread})`;

      return done(
        b,
        ctx,
        args.forget
          ? forgotten
          : `removed ${args.name} from your Layer (its Chrome folder and stored sign-ins stay)`,
      );
    },
    'browser default': async (args, ctx) => {
      const b = await begin(ctx);

      if (b === undefined) return noSettings();
      const none = args.name === 'none' || args.name === DEFAULT_PROFILE;

      if (!none && !b.list.profiles.some((p) => p.name === args.name))
        return refused('no-profile', `${args.name} is no profile`);
      write(b.own, { default: none ? null : args.name });

      return done(b, ctx, none ? 'default: the built-in empty profile' : `default: ${args.name}`);
    },
    'browser open': async (args, ctx) => {
      const at = await signable(ctx, args.name);

      if (!at.ok) return at;
      const bad = args.urls.find((u) => !isPageUrl(u));

      if (bad !== undefined) return refused('usage', `${bad} is no http, https or file URL`, 2);
      const { chrome, dir } = at.data;
      const front = args.front;
      const endpoint = front && args.urls.length === 0 ? await chrome.running(dir) : undefined;

      // in front: the one open on the folder raised, never a second window
      if (endpoint !== undefined) {
        const raised = await chrome.front({ dir, endpoint });

        if (!raised.ok) return refused(raised.error.code, raised.error.message);
        ctx.serve.profileWatch?.watch(args.name, dir);

        return {
          ok: true,
          data: { name: args.name, folder: dir, endpoint, started: false, fronted: true },
        };
      }
      const opened = await chrome.open({ dir, urls: args.urls, ...(front ? { front } : {}) });

      if (!opened.ok) return refused(opened.error.code, opened.error.message);
      ctx.serve.profileWatch?.watch(args.name, dir);

      return {
        ok: true,
        data: { name: args.name, folder: dir, ...opened.data, fronted: false },
      };
    },
    'browser store': async (args, ctx) => {
      const at = await signable(ctx, args.name);

      if (!at.ok) return at;
      if (ctx.serve.profileStore === undefined) return noStore();
      const endpoint = await at.data.chrome.running(at.data.dir);

      if (endpoint === undefined)
        return refused(
          'chrome-not-running',
          `${args.name}'s Chrome is not open: abe browser open ${args.name}, sign in, then store again`,
        );
      const read = await at.data.chrome.read(endpoint);

      if (!read.ok) return refused(read.error.code, read.error.message);
      const written = await storeSignIns(
        ctx.serve.profileStore,
        args.name,
        read.data,
        ctx.serve.clock.now(),
      );

      if (!written.ok)
        return refused(
          written.error.code,
          written.error.code === 'profile-too-large'
            ? `${args.name}: ${written.error.message}`
            : written.error.message,
        );
      const { state } = written.data;

      return {
        ok: true,
        data: {
          name: args.name,
          secret: written.data.secret,
          storedAt: state.storedAt,
          cookies: state.cookies.length,
          origins: state.origins.map((o) => o.origin),
          bytes: written.data.bytes,
        },
      };
    },
  } satisfies Partial<Handlers<Ctx>>;
};
