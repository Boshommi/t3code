import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPreparedConnection = vi.fn();
const ensureLoopbackForward = vi.fn();

vi.mock("~/state/session", () => ({ readPreparedConnection }));
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { ensureLoopbackForward },
}));

describe("resolvePreviewNavigationUrl", () => {
  beforeEach(() => {
    readPreparedConnection.mockReset();
    ensureLoopbackForward.mockReset();
    vi.unstubAllGlobals();
  });

  it("asks desktop to prefer or forward a remote localhost URL", async () => {
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "https://nucboxevo-x2.tail5db3ea.ts.net/",
      httpAuthorization: { _tag: "Bearer", token: "test-token" },
    });
    ensureLoopbackForward.mockResolvedValue({
      navigateUrl: "http://localhost:4000/",
      kind: "prefer-local",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ticket: "ws-ticket" }),
      })),
    );
    const { resolvePreviewNavigationUrl } = await import("./resolvePreviewNavigationUrl");
    await expect(
      resolvePreviewNavigationUrl(EnvironmentId.make("env-1"), "http://localhost:4000"),
    ).resolves.toBe("http://localhost:4000/");
    expect(ensureLoopbackForward).toHaveBeenCalledWith({
      environmentId: "env-1",
      url: "http://localhost:4000/",
      environmentIsLoopback: false,
      tunnelWebsocketUrl:
        "wss://nucboxevo-x2.tail5db3ea.ts.net/preview-tunnel?wsTicket=ws-ticket&port=4000",
    });
  });
});
