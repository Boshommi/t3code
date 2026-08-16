import { buildPreviewLoopbackPacScript } from "@t3tools/shared/previewLoopbackForward";
import type { Session } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewLoopbackForwarder from "./LoopbackForwarder.ts";

export const previewLoopbackPacDataUrl = (proxyPort: number): string =>
  `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(
    buildPreviewLoopbackPacScript(proxyPort),
  ).toString("base64")}`;

export const applyPreviewLoopbackProxy = (session: Session, proxyPort: number) => {
  void session
    .setProxy({
      mode: "pac_script",
      pacScript: previewLoopbackPacDataUrl(proxyPort),
    })
    .catch((error: unknown) => {
      console.warn("Failed to apply the preview loopback PAC", error);
    });
};

export const attachPreviewLoopbackRequestInterceptor = (session: Session, proxyPort: number) => {
  applyPreviewLoopbackProxy(session, proxyPort);
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
