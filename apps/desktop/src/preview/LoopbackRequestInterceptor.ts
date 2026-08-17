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
      // SOCKS5 is a TCP circuit, so Chromium writes ordinary origin-form
      // requests ("GET /_next/... HTTP/1.1") into it — byte-identical to the
      // direct connection the preview used before this proxy existed. An HTTP
      // forward proxy instead makes Chromium write absolute-form ("GET
      // http://localhost:3000/_next/..."), which Next answers with a 308 back
      // to the same URL, so anything we failed to rewrite became a redirect
      // loop. Origin-form removes that failure mode instead of patching it.
      // <-loopback> is still required or Chromium never asks the proxy about
      // localhost at all.
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
