/**
 * AWS Signature Version 4, for the two requests abe's own EC2 Instance Connect client makes
 * itself (#91): the `openTunnel` WebSocket URL, signed in its query string, and
 * `SendSSHPublicKey`, signed in its headers. Pure but for hashing; the keys are the person's SSO
 * credentials, handed in, never kept.
 */
import { createHash, createHmac } from 'node:crypto';

export type AwsKeys = {
  accessKeyId: string;
  secretAccessKey: string;
  /** An SSO or role session's token. */
  sessionToken?: string;
};

export type SignScope = { service: string; region: string; keys: AwsKeys; now: Date };

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 as SigV4 wants it: only `A-Z a-z 0-9 - _ . ~` left as they are. */
export const uriEncode = (text: string): string =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** `20130524T000000Z` and `20130524`. */
const stamps = (now: Date) => {
  const long = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

  return { long, short: long.slice(0, 8) };
};

const order = (a: string, b: string) => {
  if (a === b) return 0;

  return a < b ? -1 : 1;
};

const canonicalQuery = (params: readonly (readonly [string, string])[]) =>
  params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    // By code point, as SigV4 sorts (never by locale).
    .sort(([a, x], [b, y]) => order(a, b) || order(x, y))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

/** Each segment encoded once (not S3's raw path; neither request here has a special character). */
const canonicalPath = (path: string) =>
  path === '' ? '/' : path.split('/').map(uriEncode).join('/');

const signature = (scope: SignScope, short: string, toSign: string) => {
  const date = hmac(`AWS4${scope.keys.secretAccessKey}`, short);
  const region = hmac(date, scope.region);
  const service = hmac(region, scope.service);
  const signing = hmac(service, 'aws4_request');

  return createHmac('sha256', signing).update(toSign).digest('hex');
};

const stringToSign = (long: string, credentialScope: string, canonical: string) =>
  ['AWS4-HMAC-SHA256', long, credentialScope, sha256(canonical)].join('\n');

/** sha256 of no body: what botocore's `SigV4QueryAuth` signs as a presigned URL's payload. */
export const EMPTY_PAYLOAD = sha256('');

/** What S3 presigns with in place of a payload's hash (its own exception, not EICE's). */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/**
 * `url` signed in its query string (`X-Amz-*`), valid for `expires` seconds: what a WebSocket
 * handshake carries, since it takes no headers. Signs only `host`; the payload is `payload`, the
 * empty body's hash unless given (EC2 Instance Connect's `openTunnel` refuses `UNSIGNED-PAYLOAD`
 * with a 401).
 */
export const presignUrl = (
  url: URL,
  scope: SignScope,
  expires: number,
  payload: string = EMPTY_PAYLOAD,
): string => {
  const { long, short } = stamps(scope.now);
  const credentialScope = `${short}/${scope.region}/${scope.service}/aws4_request`;
  const params: [string, string][] = [
    ...[...url.searchParams.entries()],
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${scope.keys.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', long],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ];

  if (scope.keys.sessionToken !== undefined)
    params.push(['X-Amz-Security-Token', scope.keys.sessionToken]);
  const query = canonicalQuery(params);
  const canonical = [
    'GET',
    canonicalPath(url.pathname),
    query,
    `host:${url.host}\n`,
    'host',
    payload,
  ].join('\n');
  const sig = signature(scope, short, stringToSign(long, credentialScope, canonical));

  return `${url.protocol}//${url.host}${url.pathname}?${query}&X-Amz-Signature=${sig}`;
};

/**
 * The headers that sign a request: `headers` (lower-case names) with `host`, `x-amz-date`, the
 * session's token and `authorization`, every one of them signed.
 */
export const signedHeaders = (
  request: { method: string; url: URL; headers: Readonly<Record<string, string>>; body: string },
  scope: SignScope,
): Record<string, string> => {
  const { long, short } = stamps(scope.now);
  const credentialScope = `${short}/${scope.region}/${scope.service}/aws4_request`;
  const all: Record<string, string> = {
    ...request.headers,
    host: request.url.host,
    'x-amz-date': long,
    ...(scope.keys.sessionToken === undefined
      ? {}
      : { 'x-amz-security-token': scope.keys.sessionToken }),
  };
  const names = Object.keys(all).sort();
  const canonical = [
    request.method,
    canonicalPath(request.url.pathname),
    canonicalQuery([...request.url.searchParams.entries()]),
    names.map((n) => `${n}:${(all[n] ?? '').trim()}\n`).join(''),
    names.join(';'),
    sha256(request.body),
  ].join('\n');
  const sig = signature(scope, short, stringToSign(long, credentialScope, canonical));

  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${scope.keys.accessKeyId}/${credentialScope}, SignedHeaders=${names.join(';')}, Signature=${sig}`,
  };
};
