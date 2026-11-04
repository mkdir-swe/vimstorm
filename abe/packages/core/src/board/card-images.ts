/**
 * A card's images (#238): the story dialog draws an image in a card's text or comments only once
 * `abe card images` read it into a local file, and only an attachment of the board's own Azure
 * DevOps organization is read (with the person's `az` token, sent to dev.azure.com only). Any other
 * image is drawn as a link to it, never fetched. Pure rules: the board port reads, the screen
 * rewrites.
 */
import { z } from 'zod';

/** One image `abe card images` was asked for: its local file once read, else why not. */
export const CardImage = z.object({
  url: z.string(),
  path: z.string().optional(),
  error: z.string().optional(),
});
export type CardImage = z.infer<typeof CardImage>;

/** `abe card images`: each image asked for, in order. */
export const CardImagesData = z.object({ images: z.array(CardImage) });
export type CardImagesData = z.infer<typeof CardImagesData>;

export const cardImagesText = (d: CardImagesData): string =>
  d.images
    .map((i) =>
      i.path === undefined ? `${i.url}: ${i.error ?? 'not read'}\n` : `${i.url} → ${i.path}\n`,
    )
    .join('');

/** `![alt](src "title")` or `![alt](<src with spaces>)`: its alt and its source. */
const IMAGE = /!\[([^\]]*)\]\((?:<([^>\n]*)>|([^)\s]+))(?:\s+"[^"\n]*")?\)/g;

const REMOTE = /^https?:\/\//i;

/**
 * An image `IMAGE` reads, else the start of any other the renderer would still draw (a title in
 * other quotes, a `]` in its alt, reference-style, raw `<img>`).
 */
const ANY_IMAGE = new RegExp(`${IMAGE.source}|!\\[|<img\\b`, 'gi');

const DEV = /^https:\/\/dev\.azure\.com\/([^/?#@]+)\/([^#\s]*)$/i;
const VISUALSTUDIO = /^https:\/\/([^./?#@]+)\.visualstudio\.com\/([^#\s]*)$/i;
/** An attachment's path in the org: an optional project segment, then `_apis/wit/attachments/<id>`. */
const ATTACHMENT = /^(?:([^/?#]+)\/)?_apis\/wit\/attachments\/[A-Za-z0-9-]+(?:\?[^#]*)?$/i;

/** A path segment a URL parser reads as `.` or `..` (`%2e` too), or one it cannot read. */
const dotSegment = (segment: string): boolean => {
  try {
    const plain = decodeURIComponent(segment);

    return plain === '.' || plain === '..' || /[/\\]/.test(plain);
  } catch {
    return true;
  }
};

/**
 * The URL Abe reads an image from when `src` is an attachment of the board's organization
 * (`https://dev.azure.com/<org>`, as `organizationOf` gives it): `https://dev.azure.com/<org>/…/
 * _apis/wit/attachments/<id>…` (the org's `visualstudio.com` name read from dev.azure.com);
 * `undefined` for anything else, so the token goes nowhere else.
 */
export const boardAttachment = (organization: string, src: string): string | undefined => {
  if (src.includes('\\')) return undefined;
  const m = DEV.exec(src) ?? VISUALSTUDIO.exec(src);
  const org = m?.[1];
  const rest = m?.[2];
  const own = /^https:\/\/dev\.azure\.com\/([^/]+)$/i.exec(organization)?.[1];

  if (org === undefined || rest === undefined || own === undefined) return undefined;
  if (org.toLowerCase() !== own.toLowerCase()) return undefined;
  const path = ATTACHMENT.exec(rest);

  if (path === null) return undefined;
  const project = path[1];

  if (project !== undefined && dotSegment(project)) return undefined;

  return `${organization}/${rest}`;
};

/** The http(s) images a card's markdown names, each once, in order. */
export const cardImageSources = (markdown: string): string[] => {
  const seen = new Set<string>();

  for (const m of markdown.matchAll(IMAGE)) {
    const src = m[2] ?? m[3] ?? '';

    if (REMOTE.test(src)) seen.add(src);
  }

  return [...seen];
};

/** A local file as a markdown image's source: `file://`, each path segment escaped. */
const fileSource = (path: string): string =>
  `file://${path
    .split('/')
    .map((p) => encodeURIComponent(p).replaceAll('(', '%28').replaceAll(')', '%29'))
    .join('/')}`;

/**
 * `markdown` with each http(s) image `read` holds a file for drawn from that file, and every other
 * one a link to it (`[alt](src)`, `[image](src)` with no alt): the dialog fetches nothing itself
 * and draws no file a card names (`/etc/…`, `file://…`) but those `card images` kept. An image in
 * any other form stays text (`!\[`, `&lt;img`).
 */
export const withCardImages = (
  markdown: string,
  read: Readonly<Record<string, string | null>>,
): string =>
  markdown.replace(ANY_IMAGE, (whole, alt?: string, angled?: string, bare?: string) => {
    if (alt === undefined) return whole === '![' ? '!\\[' : `&lt;${whole.slice(1)}`;
    const src = angled ?? bare ?? '';
    const file = REMOTE.test(src) ? read[src] : undefined;

    if (src === '') return '!\\[' + whole.slice(2);

    if (typeof file === 'string') return `![${alt}](${fileSource(file)})`;

    return `[${alt === '' ? 'image' : alt}](${angled === undefined ? src : `<${src}>`})`;
  });
