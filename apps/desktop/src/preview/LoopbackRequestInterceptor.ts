// @effect-diagnostics globalConsole:off globalDate:off - Chromium invokes the protocol handler outside any Effect runtime; cookie expiry needs wall-clock epoch seconds.
import type { Session } from "electron";
import { app } from "electron";
import * as NodeStream from "node:stream";
import type * as NodeStreamWeb from "node:stream/web";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewLoopbackForwarder from "./LoopbackForwarder.ts";
import {
  buildPreviewLoopbackRequestHeaders,
  fetchPreviewLoopback,
  parsePreviewLoopbackHttpTarget,
  parsePreviewSetCookie,
  PreviewLoopbackAgent,
  type PreviewLoopbackConnect,
} from "./previewLoopbackHttp.ts";

/** The slice of the loopback forwarder a preview session needs. */
export type PreviewLoopbackSessionServices = {
  readonly proxyPort: number;
  readonly connect: PreviewLoopbackConnect;
};

export const previewLoopbackProxyRules = (proxyPort: number): string =>
  `socks5://127.0.0.1:${String(proxyPort)}`;

export const applyPreviewLoopbackProxy = (session: Session, proxyPort: number): Promise<void> =>
  session
    .setProxy({
      // The protocol handler below answers plain-http loopback requests, so
      // this proxy only carries what a protocol handler cannot see: websocket
      // upgrades (ws/wss) and https CONNECT tunnels. SOCKS5 is a TCP circuit —
      // Chromium's bytes pass through unmodified, TLS stays end-to-end.
      // <-loopback> is still required or Chromium never asks the proxy about
      // localhost at all.
      mode: "fixed_servers",
      proxyRules: previewLoopbackProxyRules(proxyPort),
      proxyBypassRules: "<-loopback>",
    })
    .catch((error: unknown) => {
      console.warn("Failed to apply the preview loopback proxy", error);
    });

let cachedAcceptLanguage: string | undefined;
const previewAcceptLanguage = (): string | undefined => {
  if (cachedAcceptLanguage === undefined) {
    try {
      const locale = app.getLocale();
      if (locale.length === 0) return undefined;
      const base = locale.split("-")[0];
      cachedAcceptLanguage =
        base !== undefined && base !== locale ? `${locale},${base};q=0.9` : locale;
    } catch {
      return undefined;
    }
  }
  return cachedAcceptLanguage;
};

const readCookieHeader = async (session: Session, url: string): Promise<string> => {
  try {
    const cookies = await session.cookies.get({ url });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch {
    return "";
  }
};

// Chromium ignores Set-Cookie on protocol-handler responses, so the jar is
// written directly. Cookies a real jar would reject (e.g. SameSite=None
// without Secure) fail inside cookies.set and are dropped, matching Chromium.
const commitSetCookies = async (
  session: Session,
  url: string,
  setCookies: ReadonlyArray<string>,
): Promise<void> => {
  const nowSeconds = Date.now() / 1_000;
  for (const raw of setCookies) {
    const parsed = parsePreviewSetCookie(raw, nowSeconds);
    if (parsed === null) continue;
    try {
      if (parsed.expired) {
        await session.cookies.remove(url, parsed.name);
      } else {
        await session.cookies.set({
          url,
          name: parsed.name,
          value: parsed.value,
          secure: parsed.secure,
          httpOnly: parsed.httpOnly,
          sameSite: parsed.sameSite,
          ...(parsed.path === undefined ? {} : { path: parsed.path }),
          ...(parsed.expirationDate === undefined ? {} : { expirationDate: parsed.expirationDate }),
        });
      }
    } catch {
      // Invalid cookies are dropped, as a real cookie jar would.
    }
  }
};

const handlePreviewLoopbackHttp = async (
  session: Session,
  agent: PreviewLoopbackAgent,
  request: Request,
): Promise<Response> => {
  const target = parsePreviewLoopbackHttpTarget(request.url);
  if (target === null) {
    // Non-loopback http (rare in a dev preview) keeps Chromium's own network
    // stack, proxy rules included.
    return session.fetch(request, { bypassCustomProtocolHandlers: true });
  }
  try {
    const cookieHeader = request.headers.has("cookie")
      ? ""
      : await readCookieHeader(session, request.url);
    const headers = buildPreviewLoopbackRequestHeaders({
      headers: request.headers,
      hostHeader: new URL(request.url).host,
      method: request.method,
      referrer: request.referrer,
      cookieHeader,
      acceptLanguage: previewAcceptLanguage(),
    });
    const upstream = await fetchPreviewLoopback({
      target,
      method: request.method,
      headers,
      body:
        request.body === null
          ? null
          : NodeStream.Readable.fromWeb(
              request.body as unknown as NodeStreamWeb.ReadableStream<Uint8Array>,
            ),
      signal: request.signal,
      agent,
    });
    if (upstream.setCookies.length > 0) {
      await commitSetCookies(session, request.url, upstream.setCookies);
    }
    return new Response(
      upstream.body === null
        ? null
        : (NodeStream.Readable.toWeb(upstream.body) as unknown as ReadableStream<Uint8Array>),
      {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      },
    );
  } catch (error) {
    return new Response(
      `T3 Code could not reach ${request.url} over the preview tunnel: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { status: 502, headers: { "content-type": "text/plain" } },
    );
  }
};

const interceptedSessions = new WeakSet<Session>();

export const attachPreviewLoopbackHttpHandler = (
  session: Session,
  connect: PreviewLoopbackConnect,
): void => {
  if (interceptedSessions.has(session)) return;
  interceptedSessions.add(session);
  const agent = new PreviewLoopbackAgent(connect);
  session.protocol.handle("http", (request) => handlePreviewLoopbackHttp(session, agent, request));
};

/**
 * Puts a preview session on the loopback forwarder: the protocol handler
 * answers plain-http loopback requests in origin-form over the tunnel, and the
 * SOCKS proxy carries ws/wss/https. Safe to call repeatedly for the same
 * session. The returned promise resolves when the proxy rules are applied.
 */
export const attachPreviewLoopbackSession = (
  session: Session,
  services: PreviewLoopbackSessionServices,
): Promise<void> => {
  attachPreviewLoopbackHttpHandler(session, services.connect);
  return applyPreviewLoopbackProxy(session, services.proxyPort);
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const browserSession = yield* BrowserSession.BrowserSession;
    const forwarder = yield* PreviewLoopbackForwarder.PreviewLoopbackForwarder;
    yield* browserSession.onSessionCreated((session) => {
      void attachPreviewLoopbackSession(session, forwarder);
    });
  }),
);
