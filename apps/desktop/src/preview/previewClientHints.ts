/**
 * Preview sessions strip `Electron/` from the User-Agent string, but Chromium
 * still advertises an Electron brand in Client Hints. Google Identity then
 * treats the guest as an embedded webview and hides the account picker /
 * signup UI.
 */

const ELECTRON_BRAND = /\s*"Electron";v="[^"]*"\s*,?/giu;

const collapseCommas = (value: string): string =>
  value
    .replace(/,\s*,/gu, ",")
    .replace(/^\s*,\s*|\s*,\s*$/gu, "")
    .trim();

export const rewritePreviewSecChUa = (value: string): string => {
  if (!/"Electron"/iu.test(value)) {
    return value;
  }
  const stripped = collapseCommas(value.replace(ELECTRON_BRAND, ""));
  if (/"Google Chrome"/iu.test(stripped)) {
    return stripped;
  }
  const chromium = /"Chromium";v="(\d+)"/iu.exec(stripped)?.[1] ?? "142";
  if (stripped.length === 0) {
    return `"Google Chrome";v="${chromium}", "Chromium";v="${chromium}", "Not A(Brand";v="99"`;
  }
  return `${stripped}, "Google Chrome";v="${chromium}"`;
};
