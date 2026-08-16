// @effect-diagnostics nodeBuiltinImport:off - Raw origin-form HTTP client over preview tunnel duplexes; Effect HttpClient cannot drive a custom keep-alive Agent.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import {
  absoluteProxyUrlToOriginPath,
  ignoreBenignPreviewSocketErrors,
  isPreviewLoopbackDestination,
} from "./previewHttp.ts";

/**
 * Plain-http requests to loopback hosts are answered by the preview session's
 * protocol handler instead of Chromium's proxy stack. The handler speaks
 * origin-form HTTP/1.1 ("GET /path") to the destination over the preview
 * tunnel, so the absolute-form request lines an HTTP proxy would produce — and
 * the Next.js 308 loops they trigger — cannot occur, on any platform.
 *
 * Chromium hands the handler a bare fetch Request: no Cookie, Origin, Referer,
 * or Accept-Encoding headers, and it does not decode Content-Encoding on the
 * way back. The helpers here rebuild those pieces so the destination server
 * sees a normal browser request.
 */

const STRIPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
  "host",
]);

// Set-Cookie is excluded because Chromium ignores it on handler responses; the
// interceptor commits cookies straight into the session jar instead.
const STRIPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
]);

const DECODABLE_CONTENT_ENCODINGS: ReadonlySet<string> = new Set([
  "gzip",
  "x-gzip",
  "deflate",
  "br",
]);

export const PREVIEW_LOOPBACK_ACCEPT_ENCODING = "gzip, deflate, br";

export type PreviewLoopbackHttpTarget = {
  readonly host: string;
  readonly port: number;
  /** Raw origin-form path + query, percent-encoding untouched. */
  readonly path: string;
};

export const parsePreviewLoopbackHttpTarget = (
  rawUrl: string,
): PreviewLoopbackHttpTarget | null => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  if (!isPreviewLoopbackDestination(parsed.hostname)) return null;
  const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return {
    host: parsed.hostname,
    port,
    path: absoluteProxyUrlToOriginPath(rawUrl) ?? "/",
  };
};

const httpOriginOf = (rawUrl: string): string | null => {
  try {
    const origin = new URL(rawUrl).origin;
    return origin.startsWith("http") ? origin : null;
  } catch {
    return null;
  }
};

export type PreviewLoopbackRequestHeaderInput = {
  readonly headers: Iterable<readonly [string, string]>;
  /** Value for the Host header, e.g. "localhost:3000". */
  readonly hostHeader: string;
  readonly method: string;
  /** The initiating document URL Chromium reports; may be empty. */
  readonly referrer: string;
  /** "name=a; other=b" from the session cookie jar; empty when none. */
  readonly cookieHeader: string;
  readonly acceptLanguage: string | undefined;
};

/**
 * Rebuilds the header set a direct browser connection would have carried.
 * Referer and Origin are derived from the request's initiating document —
 * Origin-checking backends (Next.js server actions, CSRF guards, CORS
 * allowlists) reject requests without them.
 */
export const buildPreviewLoopbackRequestHeaders = (
  input: PreviewLoopbackRequestHeaderInput,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [name, value] of input.headers) {
    const lower = name.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
    headers[lower] = value;
  }
  headers["host"] = input.hostHeader;
  headers["accept-encoding"] = PREVIEW_LOOPBACK_ACCEPT_ENCODING;
  const referrerOrigin = httpOriginOf(input.referrer);
  if (headers["referer"] === undefined && referrerOrigin !== null) {
    headers["referer"] = input.referrer;
  }
  const method = input.method.toUpperCase();
  const bodylessRead = method === "GET" || method === "HEAD";
  const targetOrigin = `http://${input.hostHeader}`;
  const crossOrigin = referrerOrigin !== null && referrerOrigin !== targetOrigin;
  if (headers["origin"] === undefined && (!bodylessRead || crossOrigin)) {
    headers["origin"] = referrerOrigin ?? targetOrigin;
  }
  if (headers["cookie"] === undefined && input.cookieHeader.length > 0) {
    headers["cookie"] = input.cookieHeader;
  }
  if (headers["accept-language"] === undefined && input.acceptLanguage !== undefined) {
    headers["accept-language"] = input.acceptLanguage;
  }
  return headers;
};

export type PreviewSetCookieSameSite = "unspecified" | "no_restriction" | "lax" | "strict";

export type ParsedPreviewSetCookie = {
  readonly name: string;
  readonly value: string;
  readonly path: string | undefined;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: PreviewSetCookieSameSite;
  /** Epoch seconds; undefined for session cookies. */
  readonly expirationDate: number | undefined;
  /** True when the header is a deletion (Max-Age <= 0 or Expires in the past). */
  readonly expired: boolean;
};

const SAME_SITE_VALUES: Record<string, PreviewSetCookieSameSite> = {
  none: "no_restriction",
  lax: "lax",
  strict: "strict",
};

export const parsePreviewSetCookie = (
  raw: string,
  nowSeconds: number,
): ParsedPreviewSetCookie | null => {
  const [pair, ...attributes] = raw.split(";");
  if (pair === undefined) return null;
  const separator = pair.indexOf("=");
  if (separator <= 0) return null;
  const name = pair.slice(0, separator).trim();
  if (name.length === 0) return null;
  const value = pair.slice(separator + 1).trim();
  let path: string | undefined;
  let secure = false;
  let httpOnly = false;
  let sameSite: PreviewSetCookieSameSite = "unspecified";
  let maxAgeSeconds: number | undefined;
  let expiresSeconds: number | undefined;
  for (const attribute of attributes) {
    const attrSeparator = attribute.indexOf("=");
    const attrName = (attrSeparator === -1 ? attribute : attribute.slice(0, attrSeparator))
      .trim()
      .toLowerCase();
    const attrValue = attrSeparator === -1 ? "" : attribute.slice(attrSeparator + 1).trim();
    if (attrName === "path" && attrValue.length > 0) path = attrValue;
    else if (attrName === "secure") secure = true;
    else if (attrName === "httponly") httpOnly = true;
    else if (attrName === "samesite")
      sameSite = SAME_SITE_VALUES[attrValue.toLowerCase()] ?? "unspecified";
    else if (attrName === "max-age") {
      const parsed = Number.parseInt(attrValue, 10);
      if (Number.isInteger(parsed)) maxAgeSeconds = parsed;
    } else if (attrName === "expires") {
      const parsed = Date.parse(attrValue);
      if (!Number.isNaN(parsed)) expiresSeconds = parsed / 1_000;
    }
  }
  // Max-Age wins over Expires when both are present (RFC 6265 §4.1.2.2).
  const expirationDate = maxAgeSeconds !== undefined ? nowSeconds + maxAgeSeconds : expiresSeconds;
  return {
    name,
    value,
    path,
    secure,
    httpOnly,
    sameSite,
    expirationDate,
    expired: expirationDate !== undefined && expirationDate <= nowSeconds,
  };
};

export type PreviewLoopbackConnect = (
  host: string,
  port: number,
) => Promise<NodeStream.Duplex> | NodeStream.Duplex;

// net.Socket methods http.Agent and ClientRequest call on pooled sockets.
// Tunnel websocket duplexes lack them; keep-alive works fine without the
// underlying TCP knobs, so no-ops are correct.
const AGENT_SOCKET_METHODS = ["ref", "unref", "setKeepAlive", "setNoDelay", "setTimeout"] as const;

export const asAgentSocket = (duplex: NodeStream.Duplex): NodeStream.Duplex => {
  if (duplex instanceof NodeNet.Socket) return duplex;
  const socketLike = duplex as NodeStream.Duplex & Record<string, unknown>;
  for (const method of AGENT_SOCKET_METHODS) {
    if (typeof socketLike[method] !== "function") {
      socketLike[method] = () => socketLike;
    }
  }
  if (typeof socketLike["destroySoon"] !== "function") {
    socketLike["destroySoon"] = () => duplex.end();
  }
  return duplex;
};

/**
 * Keep-alive pool over preview tunnel connections, one pool per host:port.
 * Reusing tunnel circuits matters: each fresh circuit is a websocket handshake
 * to the remote daemon, and a dev page load fetches dozens of assets.
 */
export class PreviewLoopbackAgent extends NodeHttp.Agent {
  private readonly connectDestination: PreviewLoopbackConnect;

  constructor(connectDestination: PreviewLoopbackConnect) {
    super({ keepAlive: true, maxSockets: 6, maxFreeSockets: 4 });
    this.connectDestination = connectDestination;
  }

  override createConnection(
    options: NodeHttp.ClientRequestArgs,
    callback?: (error: Error | null, stream: NodeStream.Duplex) => void,
  ): NodeStream.Duplex | null | undefined {
    const host =
      typeof options.host === "string" && options.host.length > 0 ? options.host : "127.0.0.1";
    const port = Number(options.port ?? 80);
    Promise.resolve(this.connectDestination(host, port)).then(
      (duplex) => {
        const socket = asAgentSocket(duplex);
        ignoreBenignPreviewSocketErrors(socket);
        callback?.(null, socket);
      },
      (cause: unknown) => {
        callback?.(
          cause instanceof Error ? cause : new Error(String(cause)),
          undefined as unknown as NodeStream.Duplex,
        );
      },
    );
    return undefined;
  }
}

export type PreviewLoopbackFetchInput = {
  readonly target: PreviewLoopbackHttpTarget;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: NodeStream.Readable | null;
  readonly signal: AbortSignal | undefined;
  readonly agent: NodeHttp.Agent;
};

export type PreviewLoopbackFetchResult = {
  readonly status: number;
  readonly statusText: string;
  /** Renderer-safe headers: hop-by-hop and Set-Cookie removed, encoding headers removed when the body was decoded. */
  readonly headers: Headers;
  readonly setCookies: ReadonlyArray<string>;
  /** Streaming decoded body; null for HEAD/204/205/304 responses. */
  readonly body: NodeStream.Readable | null;
};

const toRendererHeaders = (
  rawHeaders: ReadonlyArray<string>,
  stripEncodingHeaders: boolean,
): Headers => {
  const headers = new Headers();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] ?? "";
    const lower = name.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
    if (stripEncodingHeaders && (lower === "content-encoding" || lower === "content-length")) {
      continue;
    }
    try {
      headers.append(name, rawHeaders[index + 1] ?? "");
    } catch {
      // A header Node accepted but Headers rejects is dropped, not fatal.
    }
  }
  return headers;
};

const isNullBodyResponse = (method: string, status: number): boolean =>
  method.toUpperCase() === "HEAD" || status === 204 || status === 205 || status === 304;

const finishResponse = (
  method: string,
  res: NodeHttp.IncomingMessage,
): PreviewLoopbackFetchResult => {
  const status = res.statusCode ?? 502;
  const statusText = res.statusMessage ?? "";
  const setCookies = res.headers["set-cookie"] ?? [];
  ignoreBenignPreviewSocketErrors(res);
  if (isNullBodyResponse(method, status)) {
    res.resume();
    return {
      status,
      statusText,
      headers: toRendererHeaders(res.rawHeaders, false),
      setCookies,
      body: null,
    };
  }
  const encoding = (res.headers["content-encoding"] ?? "").trim().toLowerCase();
  if (!DECODABLE_CONTENT_ENCODINGS.has(encoding)) {
    return {
      status,
      statusText,
      headers: toRendererHeaders(res.rawHeaders, false),
      setCookies,
      body: res,
    };
  }
  // Chromium does not decode Content-Encoding on protocol-handler responses,
  // so decode here and drop the encoding headers. The tunnel still carries
  // compressed bytes; only the last hop to the renderer is expanded.
  const inflate =
    encoding === "br"
      ? NodeZlib.createBrotliDecompress()
      : encoding === "deflate"
        ? NodeZlib.createInflate()
        : NodeZlib.createGunzip();
  ignoreBenignPreviewSocketErrors(inflate);
  NodeStream.pipeline(res, inflate, () => {});
  return {
    status,
    statusText,
    headers: toRendererHeaders(res.rawHeaders, true),
    setCookies,
    body: inflate,
  };
};

const requestOnce = (input: PreviewLoopbackFetchInput): Promise<PreviewLoopbackFetchResult> =>
  new Promise((resolve, reject) => {
    const req = NodeHttp.request(
      {
        host: input.target.host,
        port: input.target.port,
        path: input.target.path,
        method: input.method,
        headers: input.headers,
        agent: input.agent,
        setHost: false,
      },
      (res) => resolve(finishResponse(input.method, res)),
    );
    req.on("error", (cause) => {
      reject(Object.assign(cause, { reusedSocket: req.reusedSocket }));
    });
    req.on("socket", (socket) => {
      ignoreBenignPreviewSocketErrors(socket);
    });
    input.signal?.addEventListener(
      "abort",
      () => req.destroy(new Error("Preview request aborted.")),
      {
        once: true,
      },
    );
    if (input.body !== null) input.body.pipe(req);
    else req.end();
  });

/**
 * One origin-form HTTP/1.1 request over the preview tunnel. A request that
 * failed on a reused keep-alive connection — the destination closed it while
 * idle — is retried once on a fresh connection when it carried no body.
 */
export const fetchPreviewLoopback = async (
  input: PreviewLoopbackFetchInput,
): Promise<PreviewLoopbackFetchResult> => {
  try {
    return await requestOnce(input);
  } catch (error) {
    const method = input.method.toUpperCase();
    const message = error instanceof Error ? error.message : String(error);
    const retryable =
      input.body === null &&
      (method === "GET" || method === "HEAD") &&
      input.signal?.aborted !== true &&
      ((error as { reusedSocket?: boolean }).reusedSocket === true ||
        message.includes("websocket is closed"));
    if (!retryable) throw error;
    return await requestOnce(input);
  }
};
