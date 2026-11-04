import { byBytes } from './changes';

/**
 * A 53-bit hash of `text` (cyrb53 over its UTF-16 units) as 14 hex digits: the same on every run
 * and machine, as 1.x wrote it into `marks/<pr>` and `drafts/<pr>`.
 */
export const hash = (text: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);

    h1 = Math.imul(h1 ^ char, 2654435761);
    h2 = Math.imul(h2 ^ char, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
};

/**
 * `value` as JSON with every object's keys in byte order, as serde_json writes a `json!` map: the
 * text a submission's key and a review's marker were hashed from, so a retry finds 1.x's too.
 */
export const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => byBytes(a, b));

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }

  return JSON.stringify(value);
};
