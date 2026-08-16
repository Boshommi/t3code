import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";
import { describe, expect } from "vite-plus/test";

import { connectLoopback } from "./LoopbackTunnel.ts";

describe("preview loopback tunnel", () => {
  effectIt.effect("refuses a loopback port that is not listening", () =>
    Effect.gen(function* () {
      const probe = NodeNet.createServer();
      const port = yield* Effect.callback<number>((resume) => {
        probe.listen({ host: "127.0.0.1", port: 0 }, () => {
          const address = probe.address();
          const bound = typeof address === "object" && address !== null ? address.port : 0;
          probe.close(() => resume(Effect.succeed(bound)));
        });
      });
      const error = yield* connectLoopback(port).pipe(Effect.flip);
      expect(error._tag).toBe("PreviewLoopbackTunnelError");
    }),
  );
});
