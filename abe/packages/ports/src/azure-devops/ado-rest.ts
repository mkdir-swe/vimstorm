/**
 * Azure DevOps' REST API as the person: a bearer token from `az` (`az.ts`), renewed once on a
 * 401; every answer read with zod. The Board's adapter (`board.ts`) and Azure Pipelines'
 * (`pipelines-azure.ts`) send through it. `base` sends every request to a fake Azure DevOps in
 * place of https://dev.azure.com (`ABE_ADO_BASE_URL`).
 */
import { adoErrorCode, type Boarded, type BoardError } from '@abe/core';
import { z } from 'zod';
import { type Tokens } from './az';

const TIMEOUT_MS = 60_000;
export const ADO_HOST = 'https://dev.azure.com';

/** Where the requests go: Azure DevOps, or a fake standing in for its host. */
export type AdoOptions = { tokens: Tokens; base?: string | undefined };

/** One request: its method, URL (on dev.azure.com), query beside `api-version`, body. */
export type AdoRequest = {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  query?: Record<string, string>;
  body?: unknown;
  contentType?: string;
};

const ErrorBody = z.object({ message: z.string() });

const fail = (code: BoardError['code'], message: string) =>
  ({ ok: false, error: { code, message } }) as const;

/** Why a request got no answer, in words, by its error's code (#201). */
const NO_ANSWER: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'the connection dropped',
  ENOTFOUND: 'its host name is not known',
  ETIMEDOUT: 'no answer in time',
  TimeoutError: `no answer in ${TIMEOUT_MS / 1000} s`,
  ConnectionRefused: 'connection refused',
};

/** A failed fetch's code (`ECONNREFUSED`), else its error's name (`TimeoutError`). */
const codeOf = (err: unknown): string => {
  if (!(err instanceof Error)) return '';

  return 'code' in err && typeof err.code === 'string' ? err.code : err.name;
};

/**
 * Azure DevOps not reached (#201): where, why in words, and what to do; not the raw fetch error.
 */
const unreachable = (url: URL, err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);
  const why = NO_ANSWER[codeOf(err)] ?? raw.split(/[.:]\s/)[0] ?? raw;

  return `Azure DevOps cannot be reached at ${url.host}: ${why} · check the network or VPN and read it again`;
};

/** The most of an error answer read: its message is all Abe says of it. */
const ERROR_MAX = 64 * 1024;

/** A body's bytes up to `max`; undefined once it holds more. */
const bodyUpTo = async (res: Response, max: number): Promise<Uint8Array | undefined> => {
  const body: ReadableStream<Uint8Array> | null = res.body;
  const reader = body?.getReader();

  if (reader === undefined) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();

      return undefined;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;

  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }

  return out;
};

/**
 * `send`: one request with `api` its default `api-version`, its answer read with `schema`;
 * `bytes`: a GET's body as it is (an attachment), at most `max` bytes.
 */
export const adoRest = (o: AdoOptions, api: string) => {
  /** The request's URL: its query with `api-version`, on the fake's host when there is one. */
  const target = (url: string, query: Record<string, string>) => {
    const u = new URL(
      o.base !== undefined && url.startsWith(`${ADO_HOST}/`)
        ? `${o.base.replace(/\/+$/, '')}${url.slice(ADO_HOST.length)}`
        : url,
    );

    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);

    return u;
  };

  const fetchOnce = async (
    method: string,
    url: URL,
    token: string,
    body: unknown,
    contentType: string,
  ): Promise<{ ok: true; status: number; text: string } | { ok: false; error: BoardError }> => {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': contentType }),
        },
        // A file (an attachment, #351) goes as its bytes; anything else as JSON.
        ...(body === undefined
          ? {}
          : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      return { ok: true, status: res.status, text: await res.text() };
    } catch (err) {
      return fail('offline', unreachable(url, err));
    }
  };

  /** One request, sent again once with a renewed token on a 401; its answer read with `schema`. */
  const send = async <T extends z.ZodType>(
    schema: T,
    r: AdoRequest,
  ): Promise<Boarded<z.output<T>>> => {
    const url = target(r.url, { 'api-version': api, ...r.query });
    const contentType = r.contentType ?? 'application/json';
    let token = await o.tokens.get();

    if (!token.ok) return token;
    let res = await fetchOnce(r.method, url, token.token, r.body, contentType);

    if (res.ok && res.status === 401) {
      token = await o.tokens.get(token.token);
      if (!token.ok) return token;
      res = await fetchOnce(r.method, url, token.token, r.body, contentType);
    }
    if (!res.ok) return res;
    const path = decodeURIComponent(url.pathname);

    if (res.status === 401)
      return fail(
        'auth',
        `Azure DevOps refused the token from az, renewed too (${r.method} ${path} → 401): run \`az login --allow-no-subscriptions\` and retry`,
      );
    let json: unknown;

    try {
      json = res.text === '' ? undefined : JSON.parse(res.text);
    } catch {
      json = undefined;
    }
    // 203: Azure DevOps' sign-in page for a token it does not take.
    if (res.status < 200 || res.status > 299 || res.status === 203) {
      const said = ErrorBody.safeParse(json);
      const message = said.success ? said.data.message : res.text.slice(0, 300);

      return fail(
        adoErrorCode(res.status, message),
        `Azure DevOps ${r.method} ${path} → ${res.status}: ${message.slice(0, 300)}`,
      );
    }
    const parsed = schema.safeParse(json);

    return parsed.success
      ? { ok: true, data: parsed.data }
      : fail(
          'ado-failed',
          `Azure DevOps answered ${r.method} ${path} in a shape Abe does not read: ${z.prettifyError(parsed.error)}`,
        );
  };

  /** A GET's body, sent again once with a renewed token on a 401; no redirect followed. */
  const bytes = async (src: string, max: number): Promise<Boarded<Uint8Array>> => {
    const url = target(src, { 'api-version': api });
    const once = async (token: string) => {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        return { ok: true as const, res };
      } catch (err) {
        return fail('offline', unreachable(url, err));
      }
    };
    let token = await o.tokens.get();

    if (!token.ok) return token;
    let got = await once(token.token);

    if (got.ok && got.res.status === 401) {
      await got.res.body?.cancel();
      token = await o.tokens.get(token.token);
      if (!token.ok) return token;
      got = await once(token.token);
    }
    if (!got.ok) return got;
    const res = got.res;
    const path = decodeURIComponent(url.pathname);

    if (res.status === 401)
      return fail(
        'auth',
        `Azure DevOps refused the token from az, renewed too (GET ${path} → 401): run \`az login --allow-no-subscriptions\` and retry`,
      );
    if (res.status < 200 || res.status > 299 || res.status === 203) {
      let text: string;

      try {
        text = new TextDecoder().decode((await bodyUpTo(res, ERROR_MAX)) ?? new Uint8Array());
      } catch (err) {
        return fail('offline', unreachable(url, err));
      }
      let json: unknown;

      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      const said = ErrorBody.safeParse(json);
      const message = said.success ? said.data.message : text.slice(0, 300);

      return fail(
        adoErrorCode(res.status, message),
        `Azure DevOps GET ${path} → ${res.status}: ${message.slice(0, 300)}`,
      );
    }
    let body: Uint8Array | undefined;

    try {
      body = await bodyUpTo(res, max);
    } catch (err) {
      return fail('offline', unreachable(url, err));
    }

    return body === undefined
      ? fail('rejected', `GET ${path} is bigger than ${max / 1024 / 1024} MB`)
      : { ok: true, data: body };
  };

  return { send, bytes };
};
