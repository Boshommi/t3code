// @effect-diagnostics globalConsole:off - WebAuthn setup runs outside Effect; failures must not crash session create.
import { app, BrowserWindow, dialog, webContents, type Session } from "electron";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  formatPreviewWebAuthnAccountLabel,
  isPreviewIdentityOrigin,
  parseMacTeamIdFromInfoPlist,
  resolvePreviewWebAuthnAccountSelection,
  resolvePreviewWebAuthnKeychainAccessGroup,
  type PreviewWebAuthnAccount,
} from "./previewWebAuthn.ts";

const webAuthnSessions = new WeakSet<Session>();
let configuredPlatformAuthenticator = false;

export const resetPreviewWebAuthnForTests = (): void => {
  configuredPlatformAuthenticator = false;
};

export const readPreviewWebAuthnTeamId = (
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => NodeFS.readFileSync(path, "utf8"),
  exePath: string = process.execPath,
): string | undefined => {
  const fromEnv = env.T3CODE_APPLE_TEAM_ID?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (process.platform !== "darwin") return undefined;
  const plistPath = NodePath.join(NodePath.dirname(exePath), "..", "Info.plist");
  try {
    return parseMacTeamIdFromInfoPlist(readFile(plistPath)) ?? undefined;
  } catch {
    return undefined;
  }
};

export const configurePreviewWebAuthnPlatformAuthenticator = (
  teamId: string | undefined = readPreviewWebAuthnTeamId(),
): boolean => {
  if (configuredPlatformAuthenticator) return true;
  if (typeof app.configureWebAuthn !== "function") return false;
  const keychainAccessGroup = resolvePreviewWebAuthnKeychainAccessGroup(teamId);
  if (keychainAccessGroup === null) return false;
  try {
    app.configureWebAuthn({
      touchID: {
        keychainAccessGroup,
        promptReason: "sign in to $1",
      },
    });
    configuredPlatformAuthenticator = true;
    return true;
  } catch (error) {
    console.warn("Failed to configure preview WebAuthn", error);
    return false;
  }
};

const ownerWindowForFrame = (frame: Electron.WebFrameMain | null): BrowserWindow | undefined => {
  if (frame === null) return undefined;
  const contents = webContents.fromFrame(frame);
  if (contents === undefined) return undefined;
  return BrowserWindow.fromWebContents(contents) ?? undefined;
};

export const attachPreviewWebAuthn = (session: Session): void => {
  if (webAuthnSessions.has(session)) return;
  webAuthnSessions.add(session);
  configurePreviewWebAuthnPlatformAuthenticator();

  session.setDevicePermissionHandler((details) => {
    if (details.deviceType !== "hid" && details.deviceType !== "usb") return false;
    return isPreviewIdentityOrigin(details.origin);
  });

  session.on("select-webauthn-account", (event, details, callback) => {
    void pickWebAuthnAccount(details.accounts, details.relyingPartyId, details.frame).then(
      (credentialId) => {
        callback(credentialId);
      },
      () => {
        callback();
      },
    );
  });

  session.on("select-hid-device", (_event, details, callback) => {
    let origin = "";
    try {
      const frameUrl = details.frame?.url;
      origin = frameUrl === undefined || frameUrl.length === 0 ? "" : new URL(frameUrl).origin;
    } catch {
      origin = "";
    }
    if (!isPreviewIdentityOrigin(origin)) {
      callback();
      return;
    }
    callback(details.deviceList[0]?.deviceId);
  });
};

const pickWebAuthnAccount = async (
  accounts: ReadonlyArray<PreviewWebAuthnAccount>,
  relyingPartyId: string,
  frame: Electron.WebFrameMain | null,
): Promise<string | undefined> => {
  if (accounts.length === 0) return undefined;
  if (accounts.length === 1) return accounts[0]?.credentialId;

  const labels = accounts.map(formatPreviewWebAuthnAccountLabel);
  const owner = ownerWindowForFrame(frame);
  const options: Electron.MessageBoxOptions = {
    type: "question",
    title: "Choose a passkey",
    message: `Choose a passkey for ${relyingPartyId}`,
    buttons: [...labels, "Cancel"],
    cancelId: labels.length,
    defaultId: 0,
    noLink: true,
  };
  const result =
    owner === undefined
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(owner, options);
  const index = resolvePreviewWebAuthnAccountSelection(accounts.length, result.response);
  return index === null ? undefined : accounts[index]?.credentialId;
};
