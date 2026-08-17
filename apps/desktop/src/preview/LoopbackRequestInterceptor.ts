import type { Session } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewLoopbackForwarder from "./LoopbackForwarder.ts";

export const previewLoopbackProxyRules = (proxyPort: number): string =>
  `http=127.0.0.1:${String(proxyPort)};https=127.0.0.1:${String(proxyPort)}`;

export const applyPreviewLoopbackProxy = (session: Session, proxyPort: number): Promise<void> =>
  session
    .setProxy({
      // Electron 41 sends http://localhost through an HTTP proxy (absolute-form
      // GET) even when proxyRules say socks5. The Node listener accepts both
      // HTTP and SOCKS; HTTP requests are rewritten per keep-alive message so
      // Next never sees absolute-form. <-loopback> is still required or
      // Chromium never asks the proxy about localhost.
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
