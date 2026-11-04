/**
 * Verify's report as HTML: a fragment the verify agent writes from a fixed kit of the design
 * system's parts, which serve sanitises and the Run page draws in place in its Verify step. The
 * kit, one `<section>` per mapped feature:
 *
 *     <section class="ab-verify-feature" data-feature="cart" data-verdict="pass|fail|not-driven"
 *              data-env="local|dev|test">                 where the app ran
 *       <h4 class="ab-verify-head">Cart total follows quantity</h4>
 *       <div class="ab-verify-pair">                      before and after: its first a Before
 *                                                         shot (`before…`), else its two shots
 *                                                         are kept apart
 *         <figure class="ab-verify-shot" data-url="http://localhost:5173/cart" data-account="buyer">
 *           <img src="verify/evidence/cart/before.png" alt="…">
 *           <figcaption>Before, on main: …</figcaption></figure>
 *         <figure class="ab-verify-shot" data-url="…" data-account="…">…</figure>
 *       </div>
 *       <figure class="ab-verify-shot" data-url="…" data-account="…">…</figure>   one alone
 *       <figure class="ab-verify-recording" data-url="…" data-account="…">        its play/pause
 *         <video src="verify/evidence/cart/drive.webm" poster="verify/evidence/cart/after.png"></video>
 *         <img src="verify/evidence/cart/drive.gif" alt="…">   optional: played in place
 *         <figcaption>…</figcaption></figure>
 *       <div class="ab-verify-judged">How it was judged, in words.</div>
 *       <p class="ab-verify-not-driven">Why it was not driven.</p>
 *       <figure class="ab-verify-transcript" data-src="verify/evidence/cli/run.txt">
 *         <figcaption>…</figcaption></figure>              a cli's or an api's proof
 *     </section>
 *
 * The section's `data-verdict` is the feature's verdict, drawn in its head; its `data-env` where
 * the app ran. A shot's or recording's `data-url` is the page it shows (`http`/`https`, no sign-in
 * in it) and `data-account` who the browser was signed in as (a role or test user's name, never a
 * secret): plain words, each optional, stripped when it can't stand. Words inside a part may use
 * `p`, `span`, `code`, `strong`, `em`, `b`, `i`, `small`, `br` (drawn as plain words). Every
 * `src` is Evidence: a path from `.scratch/<card>/`, never up out of it, of the kind its part
 * shows, and there (`there`). Anything else is stripped and said in `stripped`: scripts, styles,
 * handlers, any other attribute or class, external or `javascript:` sources, unknown tags with
 * their content. What is kept is the kit's parts, typed (`VerifyHtml`), and written back as the
 * kit's own HTML (`verifyHtmlText`): nothing of the input passes through as it was. Pure.
 */
import { z } from 'zod';

export const KIT_VERDICTS = ['pass', 'fail', 'not-driven'] as const;
export type KitVerdict = (typeof KIT_VERDICTS)[number];

export const KIT_ENVS = ['local', 'dev', 'test'] as const;

/** Where a shot or recording was taken: its page and who was signed in. Absent in older reports. */
const Where = {
  /** The page's URL, `http`/`https`. */
  url: z.string().optional(),
  /** The account it was driven as: a role or test user's name. */
  account: z.string().optional(),
};

/** A shot's or recording's page and account, as kept. */
export type VerifyWhere = { url?: string | undefined; account?: string | undefined };

export const VerifyShot = z.object({
  /** From `.scratch/<card>/`. */
  src: z.string(),
  alt: z.string(),
  caption: z.string(),
  ...Where,
});
export type VerifyShot = z.infer<typeof VerifyShot>;

export const VerifyKitPart = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pair'), before: VerifyShot, after: VerifyShot }),
  z.object({ kind: z.literal('shot'), shot: VerifyShot }),
  z.object({
    kind: z.literal('recording'),
    /** The recording (a video, else its GIF), opened in the local player. */
    src: z.string(),
    /** The same recording as a GIF: played and paused in place. */
    gif: z.string().nullable(),
    /** Its still while paused. */
    poster: z.string().nullable(),
    caption: z.string(),
    ...Where,
  }),
  z.object({ kind: z.literal('judged'), text: z.string() }),
  z.object({ kind: z.literal('not-driven'), text: z.string() }),
  z.object({
    kind: z.literal('transcript'),
    src: z.string(),
    caption: z.string(),
    /** The file's text, as serve read it for the record; empty until read. */
    text: z.string(),
  }),
]);
export type VerifyKitPart = z.infer<typeof VerifyKitPart>;

export const VerifyKitFeature = z.object({
  /** Its file's name in the Feature map (`cart`). */
  feature: z.string(),
  title: z.string(),
  verdict: z.enum(KIT_VERDICTS),
  /** Where the app ran: `local`, `dev` or `test`. Absent in older reports. */
  env: z.enum(KIT_ENVS).optional(),
  parts: z.array(VerifyKitPart),
});
export type VerifyKitFeature = z.infer<typeof VerifyKitFeature>;

/** A sanitised fragment: the kit's parts per feature, and what was stripped, in words. */
export const VerifyHtml = z.object({
  features: z.array(VerifyKitFeature),
  stripped: z.array(z.string()),
});
export type VerifyHtml = z.infer<typeof VerifyHtml>;

/** Where serve keeps a report's sanitised HTML: beside its copy (`3-after.md` → `3-after.html`). */
export const verifyHtmlPath = (report: string): string => `${report.replace(/\.md$/, '')}.html`;

/** Past this the fragment is not read. */
export const VERIFY_HTML_MAX = 512 * 1024;

// ── Reading the HTML ───────────────────────────────────────────────────────────────────────

type El = { tag: string; attrs: [string, string][]; children: HtmlNode[] };
type HtmlNode = El | { text: string };

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
/** Their content is never markup: skipped whole. */
const RAW = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'template',
  'plaintext',
]);

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  times: '×',
  rarr: '→',
  larr: '←',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e: string) => {
    if (e.startsWith('#')) {
      const hex = e[1] === 'x' || e[1] === 'X';
      const n = Number.parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);

      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }

    return NAMED[e.toLowerCase()] ?? all;
  });

const NAME = /[a-zA-Z][a-zA-Z0-9-]*/y;
const ATTR = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

/** A tolerant tree of the fragment: tags, attributes and words; comments and doctypes dropped. */
const parse = (html: string): HtmlNode[] => {
  const root: El = { tag: '#root', attrs: [], children: [] };
  const open: El[] = [root];
  const top = () => open.at(-1) ?? root;
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    const end = lt === -1 ? html.length : lt;

    if (end > i) top().children.push({ text: decode(html.slice(i, end)) });
    if (lt === -1) break;
    i = lt;
    if (html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i + 4);

      i = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const close = html.indexOf('>', i);

      i = close === -1 ? html.length : close + 1;
      continue;
    }
    const closing = html[i + 1] === '/';

    NAME.lastIndex = i + (closing ? 2 : 1);
    const name = NAME.exec(html)?.[0]?.toLowerCase();

    if (name === undefined) {
      top().children.push({ text: '<' });
      i += 1;
      continue;
    }
    if (closing) {
      const close = html.indexOf('>', NAME.lastIndex);
      const at = open.findLastIndex((e) => e.tag === name);

      if (at > 0) open.length = at;
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    // its attributes, up to `>` (a `/` before it closes nothing in HTML)
    let j = NAME.lastIndex;
    const attrs: [string, string][] = [];

    for (;;) {
      while (html[j] === '/' || /\s/.test(html[j] ?? '')) j += 1;
      if (j >= html.length || html[j] === '>') break;
      ATTR.lastIndex = j;
      const a = ATTR.exec(html);

      if (a === null) {
        j += 1;
        continue;
      }
      attrs.push([(a[1] ?? '').toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? '')]);
      j = ATTR.lastIndex;
    }
    i = j + 1;
    const el: El = { tag: name, attrs, children: [] };

    top().children.push(el);
    if (RAW.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      const gt = close === -1 ? -1 : html.indexOf('>', close);

      i = gt === -1 ? html.length : gt + 1;
    } else if (!VOID.has(name)) open.push(el);
  }

  return root.children;
};

// ── The kit ────────────────────────────────────────────────────────────────────────────────

const isEl = (n: HtmlNode): n is El => 'tag' in n;

const attr = (el: El, name: string): string | undefined => el.attrs.find(([k]) => k === name)?.[1];

/** A tag in words (`<img>`). */
const tagWord = (el: El) => `<${el.tag}>`;

/** The one `ab-verify-*` class it has; undefined for none. */
const kitClass = (el: El): string | undefined =>
  (attr(el, 'class') ?? '')
    .split(/\s+/)
    .find((c) => c.startsWith('ab-verify-'))
    ?.slice('ab-verify-'.length);

type Strip = (why: string) => void;

/** Says every attribute but `allowed` (and its kit class) stripped. */
const only = (el: El, allowed: readonly string[], strip: Strip, kit?: string) => {
  for (const [k, v] of el.attrs) {
    if (k === 'class') {
      const extra = v.split(/\s+/).filter((c) => c !== '' && c !== `ab-verify-${kit ?? ''}`);

      if (extra.length > 0) strip(`class "${extra.join(' ')}" on ${tagWord(el)}`);
      continue;
    }
    if (!allowed.includes(k)) strip(`${k} on ${tagWord(el)}`);
  }
};

const INLINE = new Set(['p', 'span', 'code', 'strong', 'em', 'b', 'i', 'small', 'a', 'br']);

/** Its words: text and the inline tags' text; a `br` or a `p` breaks the line. */
const wordsOf = (nodes: readonly HtmlNode[], strip: Strip): string => {
  const out: string[] = [];
  const walk = (list: readonly HtmlNode[]) => {
    for (const n of list) {
      if (!isEl(n)) {
        out.push(n.text);
        continue;
      }
      if (!INLINE.has(n.tag)) {
        strip(tagWord(n));
        continue;
      }
      only(n, [], strip);
      if (n.tag === 'br') out.push('\n');
      else if (n.tag === 'p') {
        out.push('\n');
        walk(n.children);
        out.push('\n');
      } else walk(n.children);
    }
  };

  walk(nodes);

  return out
    .join('')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n');
};

const IMAGE = /\.(?:png|jpe?g|webp|gif)$/i;
const VIDEO = /\.(?:webm|mp4|mov|m4v)$/i;
const GIF = /\.gif$/i;
const TRANSCRIPT = /\.(?:txt|log|cast|json)$/i;

/**
 * An Evidence path as written (`./verify/evidence/a.png` → `verify/evidence/a.png`), or why it is
 * not one: a URL of any scheme, absolute, from home, up out of `.scratch/<card>/`, or not `kind`.
 */
const evidenceOf = (
  raw: string | undefined,
  kind: RegExp,
  there: (path: string) => boolean,
): { ok: true; path: string } | { ok: false; why: string } => {
  const said = (raw ?? '').trim();
  let path: string;

  try {
    path = decodeURIComponent(said);
  } catch {
    return { ok: false, why: 'is no path' };
  }
  path = path.replace(/^(?:\.\/)+/, '');
  if (path === '') return { ok: false, why: 'has no src' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//'))
    return { ok: false, why: "is not the run's Evidence (a URL)" };
  if (path.startsWith('/') || path.startsWith('~') || path.includes('\\'))
    return { ok: false, why: "is not the run's Evidence (outside .scratch/<card>/)" };
  if (path.split('/').some((p) => p === '..' || p === '.'))
    return { ok: false, why: "is not the run's Evidence (up out of .scratch/<card>/)" };
  if (/[?#]/.test(path) || !kind.test(path))
    return { ok: false, why: 'is not a file of the kind its part shows' };
  if (!there(path)) return { ok: false, why: "is not in the run's Evidence" };

  return { ok: true, path };
};

type Ctx = { strip: Strip; there: (path: string) => boolean };

const URL_MAX = 500;
const ACCOUNT_MAX = 80;
/** `http(s)://<host>[:port]` then a path, query or fragment: no spaces, quotes or angle brackets. */
const WEB_URL = /^https?:\/\/([^/?#\s]+)(?:[/?#][^\s<>"`\\]*)?$/i;
const HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** A part's `data-url` and `data-account`, each kept only as plain words that can stand. */
const whereOf = (fig: El, c: Ctx): VerifyWhere => {
  const out: VerifyWhere = {};
  const url = attr(fig, 'data-url')?.trim();
  const account = attr(fig, 'data-account')?.replace(/\s+/g, ' ').trim();

  if (url !== undefined && url !== '') {
    const host = WEB_URL.exec(url)?.[1];

    if (url.length > URL_MAX) c.strip(`data-url on ${tagWord(fig)} longer than ${URL_MAX}`);
    else if (host?.includes('@') === true) c.strip(`data-url on ${tagWord(fig)} holds a sign-in`);
    else if (host === undefined || !HOST.test(host))
      c.strip(`data-url="${url.slice(0, 60)}" on ${tagWord(fig)} is no http(s) URL`);
    else out.url = url;
  }
  if (account !== undefined && account !== '') {
    if (account.length > ACCOUNT_MAX)
      c.strip(`data-account on ${tagWord(fig)} longer than ${ACCOUNT_MAX}`);
    else out.account = account;
  }

  return out;
};

/** A `figure.ab-verify-shot`: its image and caption; undefined when its image can't stand. */
const shotOf = (fig: El, c: Ctx): VerifyShot | undefined => {
  only(fig, ['data-url', 'data-account'], c.strip, 'shot');
  let shot: VerifyShot | undefined;
  let caption = '';
  let img: El | undefined;

  for (const n of fig.children) {
    if (!isEl(n)) continue;
    if (n.tag === 'img' && img === undefined) img = n;
    else if (n.tag === 'figcaption') {
      only(n, [], c.strip);
      caption = wordsOf(n.children, c.strip);
    } else c.strip(`${tagWord(n)} in a shot`);
  }
  if (img === undefined) {
    c.strip('a shot with no <img>');
    return undefined;
  }
  only(img, ['src', 'alt'], c.strip);
  const src = evidenceOf(attr(img, 'src'), IMAGE, c.there);

  if (!src.ok) c.strip(`<img src="${attr(img, 'src') ?? ''}"> ${src.why}`);
  else shot = { src: src.path, alt: (attr(img, 'alt') ?? '').trim(), caption, ...whereOf(fig, c) };

  return shot;
};

const recordingOf = (fig: El, c: Ctx): VerifyKitPart | undefined => {
  only(fig, ['data-url', 'data-account'], c.strip, 'recording');
  let video: string | undefined;
  let poster: string | null = null;
  let gif: string | null = null;
  let caption = '';
  const said = (el: El, raw: string | undefined, kind: RegExp): string | undefined => {
    const got = evidenceOf(raw, kind, c.there);

    if (got.ok) return got.path;
    c.strip(`${tagWord(el).slice(0, -1)} src="${raw ?? ''}"> ${got.why}`);

    return undefined;
  };

  for (const n of fig.children) {
    if (!isEl(n)) continue;
    if (n.tag === 'video' && video === undefined) {
      only(n, ['src', 'poster', 'controls', 'muted', 'loop', 'playsinline'], c.strip);
      const source = n.children.find((s): s is El => isEl(s) && s.tag === 'source');

      if (source !== undefined) only(source, ['src', 'type'], c.strip);
      video = said(
        n,
        attr(n, 'src') ?? (source === undefined ? undefined : attr(source, 'src')),
        VIDEO,
      );
      const p = attr(n, 'poster');

      if (p !== undefined) {
        const got = evidenceOf(p, IMAGE, c.there);

        if (got.ok) poster = got.path;
        else c.strip(`<video poster="${p}"> ${got.why}`);
      }
    } else if (n.tag === 'img' && gif === null) {
      only(n, ['src', 'alt'], c.strip);
      gif = said(n, attr(n, 'src'), GIF) ?? null;
    } else if (n.tag === 'figcaption') {
      only(n, [], c.strip);
      caption = wordsOf(n.children, c.strip);
    } else c.strip(`${tagWord(n)} in a recording`);
  }
  const src = video ?? gif;

  if (src === null) {
    c.strip("a recording with no <video> or GIF in the run's Evidence");
    return undefined;
  }

  return { kind: 'recording', src, gif, poster, caption, ...whereOf(fig, c) };
};

const transcriptOf = (fig: El, c: Ctx): VerifyKitPart | undefined => {
  only(fig, ['data-src'], c.strip, 'transcript');
  let caption = '';
  let raw = attr(fig, 'data-src');

  for (const n of fig.children) {
    if (!isEl(n)) {
      if (n.text.trim() !== '') c.strip('a transcript written inline: give its file as data-src');
      continue;
    }
    if (n.tag === 'figcaption') {
      only(n, [], c.strip);
      caption = wordsOf(n.children, c.strip);
    } else if (n.tag === 'pre') {
      only(n, ['data-src'], c.strip);
      raw ??= attr(n, 'data-src');
      if (wordsOf(n.children, () => undefined) !== '')
        c.strip('a transcript written inline: give its file as data-src');
    } else c.strip(`${tagWord(n)} in a transcript`);
  }
  const src = evidenceOf(raw, TRANSCRIPT, c.there);

  if (!src.ok) {
    c.strip(`<figure data-src="${raw ?? ''}"> ${src.why}`);
    return undefined;
  }

  return { kind: 'transcript', src: src.path, caption, text: '' };
};

/** A Before pass's shot: its file is named `before…`, as verify saves the merge base's Evidence. */
const isBeforeShot = (s: VerifyShot): boolean => /^before/i.test(s.src.split('/').pop() ?? '');

const HEADS = new Set(['h2', 'h3', 'h4', 'h5']);
const FEATURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PARTS_MAX = 24;

const featureOf = (sec: El, c: Ctx): VerifyKitFeature | undefined => {
  only(sec, ['data-feature', 'data-verdict', 'data-env'], c.strip, 'feature');
  const feature = (attr(sec, 'data-feature') ?? '').trim();
  const verdict = KIT_VERDICTS.find((v) => v === (attr(sec, 'data-verdict') ?? '').trim());
  const saidEnv = attr(sec, 'data-env')?.trim().toLowerCase();
  const env = KIT_ENVS.find((e) => e === saidEnv);

  if (!FEATURE_ID.test(feature)) {
    c.strip('a feature with no data-feature (its file in the Feature map)');
    return undefined;
  }
  if (verdict === undefined) {
    c.strip(`${feature} with no data-verdict of pass, fail or not-driven`);
    return undefined;
  }
  let title = '';
  const parts: VerifyKitPart[] = [];
  const add = (p: VerifyKitPart | undefined) => {
    if (p !== undefined && parts.length < PARTS_MAX) parts.push(p);
  };

  for (const n of sec.children) {
    if (!isEl(n)) {
      if (n.text.trim() !== '') c.strip(`words outside the kit's parts in ${feature}`);
      continue;
    }
    const kit = kitClass(n);

    if (HEADS.has(n.tag) && (kit === undefined || kit === 'head') && title === '') {
      only(n, [], c.strip, 'head');
      title = wordsOf(n.children, c.strip).replace(/\n/g, ' ');
    } else if (n.tag === 'div' && kit === 'pair') {
      only(n, [], c.strip, 'pair');
      const shots = n.children
        .filter(isEl)
        .flatMap((f) => {
          if (f.tag === 'figure' && kitClass(f) === 'shot') return [shotOf(f, c)];
          c.strip(`${tagWord(f)} in a pair`);
          return [];
        })
        .filter((s): s is VerifyShot => s !== undefined);
      const [before, after] = shots;

      if (shots.length > 2) c.strip('a pair of more than two shots');
      if (before !== undefined && after !== undefined && !isBeforeShot(before)) {
        // two After shots are no before and after: each drawn alone, never labelled Before
        c.strip('a pair whose first shot is no Before one (before-*): its two shots drawn apart');
        add({ kind: 'shot', shot: before });
        add({ kind: 'shot', shot: after });
      } else if (before !== undefined && after !== undefined) add({ kind: 'pair', before, after });
      else if (before !== undefined) add({ kind: 'shot', shot: before });
    } else if (n.tag === 'figure' && kit === 'shot') {
      const shot = shotOf(n, c);

      add(shot === undefined ? undefined : { kind: 'shot', shot });
    } else if (n.tag === 'figure' && kit === 'recording') add(recordingOf(n, c));
    else if (n.tag === 'figure' && kit === 'transcript') add(transcriptOf(n, c));
    else if ((n.tag === 'div' || n.tag === 'p') && (kit === 'judged' || kit === 'not-driven')) {
      only(n, [], c.strip, kit);
      const text = wordsOf(n.children, c.strip);

      if (text !== '') add({ kind: kit, text });
    } else c.strip(kit === undefined ? tagWord(n) : `${tagWord(n)} of class ab-verify-${kit}`);
  }

  if (saidEnv !== undefined && env === undefined)
    c.strip(`data-env="${saidEnv.slice(0, 20)}" on ${feature}: not local, dev or test`);

  return {
    feature,
    title: title === '' ? feature : title,
    verdict,
    ...(env === undefined ? {} : { env }),
    parts,
  };
};

/**
 * The fragment sanitised: the kit's parts per feature, each image, recording and transcript a
 * file in the run's Evidence (`there`: whether a path from `.scratch/<card>/` is a file; unasked,
 * every path that stays in it is), and what was stripped.
 */
export const verifyHtmlOf = (
  html: string,
  there: (path: string) => boolean = () => true,
): VerifyHtml => {
  const stripped: string[] = [];
  const strip: Strip = (why) => {
    if (!stripped.includes(why)) stripped.push(why);
  };
  const c: Ctx = { strip, there };
  const features: VerifyKitFeature[] = [];

  if (html.length > VERIFY_HTML_MAX) strip(`all past ${VERIFY_HTML_MAX / 1024} KB`);
  for (const n of parse(html.slice(0, VERIFY_HTML_MAX))) {
    if (!isEl(n)) {
      if (n.text.trim() !== '') strip('words outside a feature');
      continue;
    }
    if (n.tag === 'section' && kitClass(n) === 'feature') {
      const f = featureOf(n, c);

      if (f !== undefined) features.push(f);
    } else strip(tagWord(n));
  }

  return { features, stripped };
};

/** Every Evidence path the kept parts name, each once. */
export const verifyHtmlSources = (v: VerifyHtml): string[] => [
  ...new Set(
    v.features.flatMap((f) =>
      f.parts.flatMap((p) => {
        switch (p.kind) {
          case 'pair':
            return [p.before.src, p.after.src];
          case 'shot':
            return [p.shot.src];
          case 'recording':
            return [p.src, p.gif, p.poster].filter((s): s is string => s !== null);
          case 'transcript':
            return [p.src];
          default:
            return [];
        }
      }),
    ),
  ),
];

// ── Writing it back ────────────────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const words = (s: string) => s.split('\n').map(esc).join('<br>');

/** A part's `data-url` and `data-account`, for those it has. */
const whereAttrs = (w: VerifyWhere) =>
  `${w.url === undefined ? '' : ` data-url="${esc(w.url)}"`}${w.account === undefined ? '' : ` data-account="${esc(w.account)}"`}`;

const figure = (s: VerifyShot) =>
  `<figure class="ab-verify-shot"${whereAttrs(s)}><img src="${esc(s.src)}" alt="${esc(s.alt)}">${s.caption === '' ? '' : `<figcaption>${words(s.caption)}</figcaption>`}</figure>`;

const partHtml = (p: VerifyKitPart): string => {
  switch (p.kind) {
    case 'pair':
      return `<div class="ab-verify-pair">${figure(p.before)}${figure(p.after)}</div>`;
    case 'shot':
      return figure(p.shot);
    case 'recording': {
      const video =
        p.src === p.gif
          ? ''
          : `<video src="${esc(p.src)}"${p.poster === null ? '' : ` poster="${esc(p.poster)}"`}></video>`;
      const gif = p.gif === null ? '' : `<img src="${esc(p.gif)}" alt="">`;
      const caption = p.caption === '' ? '' : `<figcaption>${words(p.caption)}</figcaption>`;

      return `<figure class="ab-verify-recording"${whereAttrs(p)}>${video}${gif}${caption}</figure>`;
    }
    case 'judged':
      return `<div class="ab-verify-judged">${words(p.text)}</div>`;
    case 'not-driven':
      return `<p class="ab-verify-not-driven">${words(p.text)}</p>`;
    case 'transcript':
      return `<figure class="ab-verify-transcript" data-src="${esc(p.src)}">${p.caption === '' ? '' : `<figcaption>${words(p.caption)}</figcaption>`}</figure>`;
  }
};

/** The kept parts as the kit's own HTML, one section per feature: what serve keeps. */
export const verifyHtmlText = (v: VerifyHtml): string =>
  v.features
    .map((f) =>
      [
        `<section class="ab-verify-feature" data-feature="${esc(f.feature)}" data-verdict="${f.verdict}"${f.env === undefined ? '' : ` data-env="${f.env}"`}>`,
        `  <h4 class="ab-verify-head">${words(f.title)}</h4>`,
        ...f.parts.map((p) => `  ${partHtml(p)}`),
        '</section>',
      ].join('\n'),
    )
    .join('\n')
    .concat(v.features.length === 0 ? '' : '\n');
