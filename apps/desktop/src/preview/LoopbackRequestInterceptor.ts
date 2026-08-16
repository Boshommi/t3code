import { PREVIEW_LOOPBACK_REQUEST_URL_PATTERNS } from "@t3tools/shared/previewLoopbackForward";
import type { Session } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewLoopbackForwarder from "./LoopbackForwarder.ts";

const attachedSessions = new WeakSet<Session>();

export const attachPreviewLoopbackRequestInterceptor = (
  session: Session,
  ensureRelated: (url: string) => Promise<void>,
) => {
  if (attachedSessions.has(session)) {
    return;
  }
  attachedSessions.add(session);
  session.webRequest.onBeforeRequest(
    { urls: [...PREVIEW_LOOPBACK_REQUEST_URL_PATTERNS] },
    (details, callback) => {
      void ensureRelated(details.url).finally(() => {
        callback({});
      });
    },
  );
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const browserSession = yield* BrowserSession.BrowserSession;
    const forwarder = yield* PreviewLoopbackForwarder.PreviewLoopbackForwarder;
    const context = yield* Effect.context();
    const runPromise = Effect.runPromiseWith(context);
    yield* browserSession.onSessionCreated((session) => {
      attachPreviewLoopbackRequestInterceptor(session, (url) =>
        runPromise(forwarder.ensureRelated(url).pipe(Effect.asVoid, Effect.ignore)),
      );
    });
  }),
);
