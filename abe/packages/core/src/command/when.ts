/**
 * Times as a person reads them on the CLI and on every screen (`@abe/core/when`):
 * the local clock, never raw UTC, each from its own instant. A text is rendered by the `serve`
 * that answers, at its `now` (`TextAt`), in its own time zone (a box's is UTC, so its times say
 * so). Pure, no imports: `ui` imports it as values.
 */

/** When a command's text is rendered: the answering serve's clock (ms). */
export type TextAt = { now: number };

const MIN_MS = 60_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const two = (n: number) => String(n).padStart(2, '0');
const msOf = (when: string | number) => (typeof when === 'number' ? when : Date.parse(when));

/** The zone's own short name at `d` (`CET`, `CEST`), as the Mac names it now. */
const zoneName = (d: Date): string =>
  new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value ?? '';

/** A DST change this near `now` names a time's zone: further off, the date says enough. */
const CHANGE_NEAR_MS = 24 * 60 * MIN_MS;

/**
 * ` CET` where a DST change lies between `d` and `now`: the hour around a change comes
 * twice, so a time on its other side says which; none further off than a day.
 */
const changed = (d: Date, now: number | string | undefined): string => {
  if (now === undefined) return '';
  const at = msOf(now);

  if (Math.abs(at - d.getTime()) > CHANGE_NEAR_MS) return '';

  return new Date(at).getTimezoneOffset() === d.getTimezoneOffset() ? '' : ` ${zoneName(d)}`;
};

/** ` UTC` where the local clock is UTC's (a box's serve), so the time is never taken as yours. */
const zone = (d: Date, now: number | string | undefined): string =>
  d.getTimezoneOffset() === 0 ? ' UTC' : changed(d, now);

/**
 * `13:09`: an instant on this Mac's clock as a screen shows it (each time from its own instant
 * in the zone now, never a fixed offset); `13:09 CET` when a DST change lies between it
 * and `now`.
 */
export const screenClock = (when: string | number, now?: string | number): string => {
  const d = new Date(msOf(when));

  return `${two(d.getHours())}:${two(d.getMinutes())}${changed(d, now)}`;
};

/**
 * `13:09`: as `screenClock`, for a command's text: `13:09 UTC` on a UTC clock (a box's serve),
 * so its time is never taken as yours.
 */
export const localClock = (when: string | number, now?: string | number): string => {
  const d = new Date(msOf(when));

  return `${two(d.getHours())}:${two(d.getMinutes())}${zone(d, now)}`;
};

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** `23 Oct ` unless `d` is on `now`'s day (none without `now`: always dated). */
const dayOf = (d: Date, now: number | string | undefined): string =>
  now !== undefined && sameDay(d, new Date(msOf(now)))
    ? ''
    : `${d.getDate()} ${MONTHS[d.getMonth()] ?? ''} `;

/**
 * `13:09` today (as of `now`), else `23 Oct 13:09`; without `now`, always with its date. A DST
 * change between it and `now` names its zone, as `screenClock` does.
 */
export const screenWhen = (when: string | number, now?: string | number): string => {
  const d = new Date(msOf(when));

  return `${dayOf(d, now)}${screenClock(d.getTime(), now)}`;
};

/** As `screenWhen`, for a command's text: ` UTC` on a UTC clock, as `localClock`. */
export const localWhen = (when: string | number, now?: string | number): string => {
  const d = new Date(msOf(when));

  return `${dayOf(d, now)}${localClock(d.getTime(), now)}`;
};

/** `45 s`, `12 min`, `1 h 5 min`, `2 h`: how long, for a person. */
export const spanText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));

  if (s < 60) return `${s} s`;
  const m = Math.floor(ms / MIN_MS);
  const h = Math.floor(m / 60);

  if (h === 0) return `${m} min`;

  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
};

/** `0:07`, `4:36`, `1:02:10`: elapsed time on a progress line. */
export const elapsedText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);

  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
};
