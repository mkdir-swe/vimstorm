/**
 * Azure Boards' text fields and comments as markdown (ported from old TS Abe's
 * `systems/azure/text.ts`): its html through turndown, and its markdown as Azure Boards keeps it.
 */
import TurndownService from 'turndown';

/** A table cell on one row: its line breaks as spaces, its pipes escaped. */
const cellText = (content: string): string =>
  content
    .replace(/\s*\n\s*/g, ' ')
    .replaceAll('|', '\\|')
    .trim();

/** A node's name, read without the DOM lib. */
const nameOf = (node: unknown): string => {
  const name: unknown =
    typeof node === 'object' && node !== null ? Reflect.get(node, 'nodeName') : '';

  return typeof name === 'string' ? name : '';
};

/** A node's attribute through its own `getAttribute`, read without the DOM lib. */
const attributeOf = (node: unknown, attribute: string): string | undefined => {
  if (typeof node !== 'object' || node === null) return undefined;
  const get: unknown = Reflect.get(node, 'getAttribute');

  if (typeof get !== 'function') return undefined;
  const value: unknown = Reflect.apply(get, node, [attribute]);

  return typeof value === 'string' ? value : undefined;
};

const STRUCK = new Set(['DEL', 'S', 'STRIKE']);

/**
 * Atx headings, `-` bullets, fenced code, `~~` strike-through, a mention as its `@Name`, a line
 * break as a paragraph break, and tables whose first row is the header (Azure Boards' seldom have
 * one).
 */
const converter = (): TurndownService => {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  });
  const escape = service.escape.bind(service);

  // Backticks in Azure Boards text mostly mean code; an underscore inside a word means nothing.
  service.escape = (text) =>
    escape(text)
      .replaceAll('\\`', '`')
      .replace(/(\w)\\_(?=\w)/g, '$1_');
  service.addRule('strike', {
    filter: (node: unknown) =>
      STRUCK.has(nameOf(node)) ||
      (nameOf(node) === 'SPAN' && (attributeOf(node, 'style') ?? '').includes('line-through')),
    replacement: (content) => (content.trim() === '' ? content : `~~${content}~~`),
  });
  // Trailing spaces, markdown's line break, would not survive an editor's save.
  service.addRule('lineBreak', { filter: 'br', replacement: () => '\n\n' });
  service.addRule('mention', {
    filter: (node: unknown) =>
      nameOf(node) === 'A' && attributeOf(node, 'data-vss-mention') !== undefined,
    replacement: (content) => content,
  });
  service.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: (content) => content,
  });
  service.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content) => ` ${cellText(content)} |`,
  });
  service.addRule('tableRow', { filter: 'tr', replacement: (content) => `\n|${content}` });
  service.addRule('table', {
    filter: 'table',
    replacement: (content) => {
      const rows = content.split('\n').filter((row) => row.trim() !== '');
      // Each cell ends ` |`; a pipe inside one is escaped.
      const columns = (rows[0]?.match(/ \|/g) ?? []).length;

      if (rows.length === 0 || columns === 0) return '';

      return `\n\n${[rows[0], `|${' --- |'.repeat(columns)}`, ...rows.slice(1)].join('\n')}\n\n`;
    },
  });

  return service;
};

let shared: TurndownService | undefined;

/** Azure Boards html as markdown. */
export const htmlToMarkdown = (html: string): string => {
  shared ??= converter();

  return (
    shared
      .turndown(html)
      .replaceAll(' ', ' ')
      // Turndown pads list markers to four columns; one space reads better and nests the same.
      .replace(/^(\s*)([-*+]|\d+\.) {2,}/gm, '$1$2 ')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
};

/**
 * Markdown as Azure Boards takes it: `<` and `>` as entities, since raw ones get cut off (as
 * Microsoft's own Azure DevOps MCP server sends them).
 */
export const encodeMarkdown = (text: string): string =>
  text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** A markdown field as Azure Boards gives it back, its entities as the characters typed. */
export const decodeMarkdown = (text: string): string =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .trim();
