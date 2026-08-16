import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { configureWebAuthn, showMessageBox, sessionOn, setDevicePermissionHandler } = vi.hoisted(
  () => ({
    configureWebAuthn: vi.fn(),
    showMessageBox: vi.fn(),
    sessionOn: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
  }),
);

vi.mock("electron", () => ({
  app: { configureWebAuthn },
  dialog: { showMessageBox },
  BrowserWindow: { fromWebContents: vi.fn() },
  webContents: { fromFrame: vi.fn() },
}));

import {
  attachPreviewWebAuthn,
  configurePreviewWebAuthnPlatformAuthenticator,
  readPreviewWebAuthnTeamId,
  resetPreviewWebAuthnForTests,
} from "./previewWebAuthnSession.ts";

describe("readPreviewWebAuthnTeamId", () => {
  it("prefers the env team id and falls back to Info.plist", () => {
    expect(readPreviewWebAuthnTeamId({ T3CODE_APPLE_TEAM_ID: "abc1234567" }, () => "", "/x")).toBe(
      "abc1234567",
    );
    expect(
      readPreviewWebAuthnTeamId(
        {},
        () => "<key>ElectronTeamID</key><string>ZYX9876543</string>",
        "/App.app/Contents/MacOS/T3 Code",
      ),
    ).toBe(process.platform === "darwin" ? "ZYX9876543" : undefined);
  });
});

describe("configurePreviewWebAuthnPlatformAuthenticator", () => {
  beforeEach(() => {
    resetPreviewWebAuthnForTests();
    configureWebAuthn.mockReset();
  });

  it("enables Touch ID when a valid team id is available", () => {
    const enabled = configurePreviewWebAuthnPlatformAuthenticator("ABC1234567");
    expect(enabled).toBe(true);
    expect(configureWebAuthn).toHaveBeenCalledWith({
      touchID: {
        keychainAccessGroup: "ABC1234567.com.t3tools.t3code.webauthn",
        promptReason: "sign in to $1",
      },
    });
    expect(configurePreviewWebAuthnPlatformAuthenticator("ABC1234567")).toBe(true);
    expect(configureWebAuthn).toHaveBeenCalledTimes(1);
  });
});

describe("attachPreviewWebAuthn", () => {
  it("listens for passkey account selection and grants HID only to identity origins", () => {
    const session = {
      setDevicePermissionHandler,
      on: sessionOn,
    };
    attachPreviewWebAuthn(session as never);
    attachPreviewWebAuthn(session as never);
    expect(setDevicePermissionHandler).toHaveBeenCalledTimes(1);
    expect(sessionOn).toHaveBeenCalledWith("select-webauthn-account", expect.any(Function));
    const deviceHandler = setDevicePermissionHandler.mock.calls.at(0)?.at(0);
    expect(deviceHandler?.({ deviceType: "hid", origin: "https://accounts.google.com" })).toBe(
      true,
    );
    expect(deviceHandler?.({ deviceType: "hid", origin: "https://example.com" })).toBe(false);
  });
});
