/**
 * Preview WebAuthn helpers. Electron-free so the keychain group, account
 * labels, and identity-origin checks can be unit-tested without importing
 * `electron`.
 *
 * Until `app.configureWebAuthn` runs, Chromium reports that no platform
 * authenticator exists and Google never opens the OS passkey / Touch ID
 * sheet. A `select-webauthn-account` listener is also required: with none
 * registered Electron cancels the request immediately.
 */

export const PREVIEW_WEB_AUTHN_BUNDLE_ID = "com.t3tools.t3code";

const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/u;

const IDENTITY_HOSTS = new Set([
  "accounts.google.com",
  "passkeys.google.com",
  "accounts.youtube.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
  "login.live.com",
  "oauth.telegram.org",
]);

export type PreviewWebAuthnAccount = {
  readonly credentialId: string;
  readonly displayName?: string;
  readonly name?: string;
};

export const resolvePreviewWebAuthnKeychainAccessGroup = (
  teamId: string | undefined,
): string | null => {
  const normalized = teamId?.trim().toUpperCase() ?? "";
  if (!APPLE_TEAM_ID.test(normalized)) return null;
  return `${normalized}.${PREVIEW_WEB_AUTHN_BUNDLE_ID}.webauthn`;
};

export const parseMacTeamIdFromInfoPlist = (plist: string): string | null => {
  const match =
    /<key>(?:ElectronTeamID|com\.apple\.developer\.team-identifier)<\/key>\s*<string>([A-Z0-9]{10})<\/string>/iu.exec(
      plist,
    );
  return match?.[1]?.toUpperCase() ?? null;
};

export const formatPreviewWebAuthnAccountLabel = (account: PreviewWebAuthnAccount): string => {
  const displayName = account.displayName?.trim();
  if (displayName !== undefined && displayName.length > 0) return displayName;
  const name = account.name?.trim();
  if (name !== undefined && name.length > 0) return name;
  return "Passkey";
};

/** `null` means the user cancelled. */
export const resolvePreviewWebAuthnAccountSelection = (
  accountCount: number,
  selectedIndex: number,
): number | null => {
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= accountCount) {
    return null;
  }
  return selectedIndex;
};

export const isPreviewIdentityOrigin = (rawOrigin: string): boolean => {
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.protocol !== "https:") return false;
    return IDENTITY_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};
