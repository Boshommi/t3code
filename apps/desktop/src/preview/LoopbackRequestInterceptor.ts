import type { Session } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewLoopbackForwarder from "./LoopbackForwarder.ts";

export const previewLoopbackProxyRules = (proxyPort: number): string =>
  `socks5://127.0.0.1:${String(proxyPort)}`;

export const applyPreviewLoopbackProxy = (session: Session, proxyPort: number): Promise<void> =>
  session
    .setProxy({
      // SOCKS5 is a TCP circuit: Chromium speaks origin-form HTTP/WS to the
      // target. An HTTP forward proxy sent absolute-form GETs, which Next 308s,
      // and keep-alive/chunked then had to be rewritten. Electron 41 still
      // needs <-loopback> or localhost never reaches any proxy.
      mode: "fixed_servers",
      proxyRules: previewLoopbackProxyRules(proxyPort),
      proxyBypassRules: "<-loopback>",
    })
    .catch((error: unknown) => {
      console.warn("Failed to apply the preview loopback proxy", error);
    });

export const attachPreviewLoopbackRequestInterceptor = (session: Session, proxyPort: number) => {
  void applyPreviewLoopbackProxy(session, proxyPort);
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const browserSession = yield* BrowserSession.BrowserSession;
    const forwarder = yield* PreviewLoopbackForwarder.PreviewLoopbackForwarder;
    yield* browserSession.onSessionCreated((session) => {
      attachPreviewLoopbackRequestInterceptor(session, forwarder.proxyPort);
    });
  }),
);
