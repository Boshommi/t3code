/**
 * webPreferences override applied to every preview `<webview>` element via
 * its `webpreferences="..."` attribute. Single source of truth so all guest
 * surfaces inherit the same security posture.
 *
 * Lives in its own electron-free module so the value is unit-testable
 * without importing `Manager.ts` (which transitively imports
 * `electron` and blows up under vitest).
 *
 * - `contextIsolation=false`: the picker preload needs to share `globalThis`
 *   with the page so react-grab/bippy can read the React DevTools hook
 *   (`__REACT_DEVTOOLS_GLOBAL_HOOK__`) and resolve component names. Without
 *   this every pick comes back with `componentName: null` even on dev React
 *   apps.
 * - `sandbox=true`: keeps the OS-level renderer sandbox enabled. Critical
 *   when paired with `contextIsolation=false` — without sandbox, the preload
 *   has full Node access (`require`, `fs`, `child_process`, ...) and that
 *   `require` would land on the page's shared `globalThis`, giving any
 *   third-party page in the preview full Node + IPC access to the host.
 *   In sandboxed mode Electron still synthesizes the `electron` module for
 *   the preload's `import { ipcRenderer }` line, but no Node globals leak.
 * - `nodeIntegration=false`: pinned for clarity (the page itself never gets
 *   Node access).
 *
 * Format notes (locked down by `WebviewPreferences.test.ts`):
 * - Whitespace-free. Electron's webpreferences parser splits on `,` and
 *   does not trim, so a leading space would turn a key into an unknown one
 *   and silently drop it.
 * - Values are JS-boolean strings (`true`/`false`) — `yes`/`no` are not
 *   special-cased by the parser; `value="no"` becomes the truthy STRING
 *   `"no"` when assigned to a boolean webPreferences key. Most critically,
 *   `contextIsolation="no"` is truthy → contextIsolation stays ENABLED →
 *   react-grab can't see the React DevTools hook.
 *
 * Defense in depth: `DesktopWindow` also runs a `will-attach-webview`
 * handler (`applyPreviewWebviewAttach`) that force-sets `sandbox: true`,
 * `nodeIntegration*: false`, and `allowpopups` on the guest, gated on the
 * preview partition, so even if this string is ever wrong, the
 * security-critical flags can't regress on preview tabs.
 */
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=false,sandbox=true,nodeIntegration=false";

/** Slice of Electron `webPreferences` the attach hook is allowed to pin. */
export type PreviewWebviewAttachPreferences = {
  sandbox?: boolean;
  nodeIntegration?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  contextIsolation?: boolean;
};

/**
 * Pins guest security flags and enables `window.open` before Chromium
 * creates the `<webview>` guest.
 *
 * Google Identity (and other OAuth) call `window.open` from an iframe.
 * Electron discards those popups — and never calls `setWindowOpenHandler`
 * — unless `allowpopups` is set at attach time. The renderer ref that
 * sets the attribute can run after this hook, which is too late.
 */
export const applyPreviewWebviewAttach = (
  webPreferences: PreviewWebviewAttachPreferences,
  params: Record<string, string>,
): void => {
  webPreferences.sandbox = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = false;
  params.allowpopups = "true";
};
