import { describe, expect, it } from "vite-plus/test";

import {
  formatPreviewWebAuthnAccountLabel,
  isPreviewIdentityOrigin,
  parseMacTeamIdFromInfoPlist,
  PREVIEW_WEB_AUTHN_BUNDLE_ID,
  resolvePreviewWebAuthnAccountSelection,
  resolvePreviewWebAuthnKeychainAccessGroup,
} from "./previewWebAuthn.ts";

describe("resolvePreviewWebAuthnKeychainAccessGroup", () => {
  it("builds the entitlement group Electron documents for Touch ID", () => {
    expect(resolvePreviewWebAuthnKeychainAccessGroup("abc1234567")).toBe(
      `ABC1234567.${PREVIEW_WEB_AUTHN_BUNDLE_ID}.webauthn`,
    );
    expect(resolvePreviewWebAuthnKeychainAccessGroup("not-a-team")).toBeNull();
    expect(resolvePreviewWebAuthnKeychainAccessGroup(undefined)).toBeNull();
  });
});

describe("parseMacTeamIdFromInfoPlist", () => {
  it("reads ElectronTeamID from a packaged Info.plist", () => {
    expect(
      parseMacTeamIdFromInfoPlist(`<key>ElectronTeamID</key>\n    <string>abc1234567</string>`),
    ).toBe("ABC1234567");
  });
});

describe("formatPreviewWebAuthnAccountLabel", () => {
  it("prefers the display name, then the account name", () => {
    expect(
      formatPreviewWebAuthnAccountLabel({
        credentialId: "1",
        displayName: "Ada",
        name: "ada@example.com",
      }),
    ).toBe("Ada");
    expect(formatPreviewWebAuthnAccountLabel({ credentialId: "1", name: "ada@example.com" })).toBe(
      "ada@example.com",
    );
    expect(formatPreviewWebAuthnAccountLabel({ credentialId: "1" })).toBe("Passkey");
  });
});

describe("resolvePreviewWebAuthnAccountSelection", () => {
  it("accepts an in-range choice and treats cancel as no selection", () => {
    expect(resolvePreviewWebAuthnAccountSelection(2, 1)).toBe(1);
    expect(resolvePreviewWebAuthnAccountSelection(2, 2)).toBeNull();
    expect(resolvePreviewWebAuthnAccountSelection(2, -1)).toBeNull();
  });
});

describe("isPreviewIdentityOrigin", () => {
  it("allows Google and other OAuth hosts over https only", () => {
    expect(isPreviewIdentityOrigin("https://accounts.google.com")).toBe(true);
    expect(isPreviewIdentityOrigin("https://passkeys.google.com")).toBe(true);
    expect(isPreviewIdentityOrigin("http://accounts.google.com")).toBe(false);
    expect(isPreviewIdentityOrigin("https://example.com")).toBe(false);
  });
});
