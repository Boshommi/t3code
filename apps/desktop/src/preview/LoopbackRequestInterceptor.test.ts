// @effect-diagnostics nodeBuiltinImport:off - Drives the preview http handler against real Node servers.
import type { Session } from "electron";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  attachPreviewLoopbackSession,
  previewLoopbackProxyBypassRules,
  previewLoopbackProxyRules,
} from "./LoopbackRequestInterceptor.ts";

vi.mock("electron", () => ({
  app: {
    getLocale: () => "en-US",
  },
}));

type PreviewHandler = (request: Request) => Promise<Response>;

const makeSessionMock = (cookies: Array<{ name: string; value: string }> = []) => {
  const handle = vi.fn<(scheme: string, handler: PreviewHandler) => void>();
  const setProxy = vi.fn(async () => undefined);
  const fetch = vi.fn(async () => new Response("passthrough"));
  const cookiesSet = vi.fn(async () => undefined);
  const cookiesRemove = vi.fn(async () => undefined);
  const onBeforeSendHeaders = vi.fn();
  const session = {
    setProxy,
    fetch,
    protocol: { handle },
    webRequest: { onBeforeSendHeaders },
    cookies: {
      get: vi.fn(async () => cookies),
      set: cookiesSet,
      remove: cookiesRemove,
    },
  };
  return {
    session: session as unknown as Session,
    handle,
    setProxy,
    fetch,
    cookiesSet,
    cookiesRemove,
    onBeforeSendHeaders,
  };
};

const services = { proxyPort: 43_210, connect: vi.fn() };

const listenHttp = (handler: NodeHttp.RequestListener) =>
  new Promise<{ server: NodeHttp.Server; port: number }>((resolve) => {
    const server = NodeHttp.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address !== null ? address.port : 0 });
    });
  });

describe("attachPreviewLoopbackSession", () => {
  it("applies the SOCKS proxy for ws/wss/https and handles http itself", () => {
    const { session, handle, setProxy } = makeSessionMock();
    void attachPreviewLoopbackSession(session, services);
    expect(setProxy).toHaveBeenCalledTimes(1);
    expect(setProxy.mock.calls.at(0)?.at(0)).toEqual({
      mode: "fixed_servers",
      proxyRules: previewLoopbackProxyRules(43_210),
      proxyBypassRules: previewLoopbackProxyBypassRules(),
    });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls.at(0)?.at(0)).toBe("http");
  });

  it("keeps Google Identity off the loopback SOCKS hop", () => {
    const rules = previewLoopbackProxyBypassRules();
    expect(rules.startsWith("<-loopback>,")).toBe(true);
    expect(rules).toContain("*.google.com");
    expect(rules).toContain("*.gstatic.com");
  });

  it("strips the Electron Client Hint brand on the way to Google", () => {
    const mock = makeSessionMock();
    void attachPreviewLoopbackSession(mock.session, services);
    expect(mock.onBeforeSendHeaders).toHaveBeenCalledTimes(1);
    const listener = mock.onBeforeSendHeaders.mock.calls.at(0)?.at(0);
    if (typeof listener !== "function") throw new Error("client-hint listener was not registered");
    let rewritten: Record<string, string> | undefined;
    listener(
      {
        requestHeaders: {
          "Sec-CH-UA": `"Chromium";v="142", "Electron";v="41"`,
        },
      },
      (result: { requestHeaders: Record<string, string> }) => {
        rewritten = result.requestHeaders;
      },
    );
    expect(rewritten?.["Sec-CH-UA"]).toBe(`"Chromium";v="142", "Google Chrome";v="142"`);
  });

  it("registers the http handler once per session, re-applying only the proxy", () => {
    const { session, handle, setProxy, onBeforeSendHeaders } = makeSessionMock();
    void attachPreviewLoopbackSession(session, services);
    void attachPreviewLoopbackSession(session, services);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(setProxy).toHaveBeenCalledTimes(2);
    expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1);
  });

  // An http= rule makes Chromium write absolute-form request lines, which Next
  // answers with a 308 back to the same URL. SOCKS5 keeps it origin-form.
  it("asks Chromium for a SOCKS5 circuit, not an HTTP forward proxy", () => {
    expect(previewLoopbackProxyRules(43_210)).toBe("socks5://127.0.0.1:43210");
  });
});

describe("preview loopback http handler", () => {
  const registeredHandler = (mock: ReturnType<typeof makeSessionMock>): PreviewHandler => {
    void attachPreviewLoopbackSession(mock.session, {
      proxyPort: 1,
      connect: (_host, port) =>
        new Promise((resolve, reject) => {
          const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
          socket.once("connect", () => resolve(socket));
          socket.once("error", reject);
        }),
    });
    const handler = mock.handle.mock.calls.at(0)?.at(1);
    if (typeof handler !== "function") throw new Error("handler was not registered");
    return handler;
  };

  it("passes non-loopback requests through the session's own fetch", async () => {
    const mock = makeSessionMock();
    const handler = registeredHandler(mock);
    const request = new Request("http://example.com/page");
    const response = await handler(request);
    expect(await response.text()).toBe("passthrough");
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    expect(mock.fetch.mock.calls.at(0)).toEqual([request, { bypassCustomProtocolHandlers: true }]);
  });

  it("answers loopback requests in origin-form with jar cookies and commits Set-Cookie", async () => {
    const seen: Array<{ url: string; cookie: string | undefined; origin: string | undefined }> = [];
    const { server, port } = await listenHttp((req, res) => {
      seen.push({
        url: req.url ?? "",
        cookie: req.headers.cookie,
        origin: req.headers.origin,
      });
      res.setHeader("Set-Cookie", ["fresh=1; Path=/; HttpOnly", "gone=0; Max-Age=0"]);
      res.setHeader("Content-Type", "text/plain");
      res.end("UPSTREAM-OK");
    });
    try {
      const mock = makeSessionMock([{ name: "jar", value: "alpha" }]);
      const handler = registeredHandler(mock);
      const response = await handler(
        new Request(`http://localhost:${port}/enc/%5Bx%5D.js?q=%20`, {
          method: "POST",
          body: "payload",
          referrer: `http://localhost:${port}/app`,
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("UPSTREAM-OK");
      expect(seen).toEqual([
        {
          url: "/enc/%5Bx%5D.js?q=%20",
          cookie: "jar=alpha",
          origin: `http://localhost:${port}`,
        },
      ]);
      expect(mock.cookiesSet).toHaveBeenCalledTimes(1);
      expect(mock.cookiesSet.mock.calls.at(0)?.at(0)).toMatchObject({
        name: "fresh",
        value: "1",
        path: "/",
        httpOnly: true,
      });
      expect(mock.cookiesRemove).toHaveBeenCalledTimes(1);
      expect(mock.cookiesRemove.mock.calls.at(0)).toEqual([
        `http://localhost:${port}/enc/%5Bx%5D.js?q=%20`,
        "gone",
      ]);
    } finally {
      server.close();
    }
  });

  it("serves the live Click auth iframe so Google Identity can boot", async () => {
    const mock = makeSessionMock();
    const handler = registeredHandler(mock);
    const response = await handler(new Request("http://127.0.0.1:5173/iframe"));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Click Auth Surface");
    expect(html).toContain("https://accounts.google.com");
  });

  it("returns a 502 with detail when the destination is unreachable", async () => {
    const mock = makeSessionMock();
    void attachPreviewLoopbackSession(mock.session, {
      proxyPort: 1,
      connect: () => Promise.reject(new Error("tunnel is down")),
    });
    const handler = mock.handle.mock.calls.at(0)?.at(1);
    if (typeof handler !== "function") throw new Error("handler was not registered");
    const response = await handler(new Request("http://localhost:3000/"));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("tunnel is down");
  });
});
