import { useSyncExternalStore } from "react";

import { isElectron } from "./env";

/** Chromium-only, so it is missing from the DOM lib. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type AppInstallState = "installed" | "promptable" | "manual";

let installPrompt: BeforeInstallPromptEvent | null = null;
let installedThisSession = false;
const installListeners = new Set<() => void>();
const notificationClickHandlers = new Map<string, () => void>();

function emitInstallChange() {
  for (const listener of installListeners) listener();
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function getInstallState(): AppInstallState {
  if (installedThisSession || isStandalone()) return "installed";
  return installPrompt ? "promptable" : "manual";
}

function subscribeInstallState(listener: () => void) {
  installListeners.add(listener);
  return () => {
    installListeners.delete(listener);
  };
}

export function useAppInstallState(): AppInstallState {
  return useSyncExternalStore(subscribeInstallState, getInstallState);
}

export async function promptAppInstall(): Promise<void> {
  const prompt = installPrompt;
  if (!prompt) return;
  // The event can only prompt once; Chromium fires a fresh one if it stays installable.
  installPrompt = null;
  emitInstallChange();
  await prompt.prompt();
}

/** Runs `onClick` when the user clicks a notification shown with this tag through the worker. */
export function setNotificationClickHandler(tag: string, onClick: () => void) {
  notificationClickHandlers.set(tag, onClick);
}

/** The active worker registration, or null when this page is not controlled by one. */
export async function controllingServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return null;
  return navigator.serviceWorker.ready;
}

export function installPwa(navigate: (href: string) => void) {
  // Electron serves the app from its own shell and has native install, badges, and notifications.
  if (isElectron) return;

  // Chromium fires this early and once, so it has to be captured before React mounts.
  window.addEventListener("beforeinstallprompt", (event) => {
    installPrompt = event as BeforeInstallPromptEvent;
    emitInstallChange();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    installedThisSession = true;
    emitInstallChange();
  });

  if (!("serviceWorker" in navigator)) return;
  const serviceWorker = navigator.serviceWorker;

  // A worker caching dev modules would fight HMR, and one left over from a
  // production build on the same origin would serve stale assets to dev.
  if (import.meta.env.DEV) {
    void serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(registrations.map((registration) => registration.unregister())),
      )
      .catch(() => undefined);
    return;
  }

  serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; tag?: unknown; url?: unknown } | null;
    if (data?.type !== "t3code:notification-click") return;
    const handler = typeof data.tag === "string" ? notificationClickHandlers.get(data.tag) : null;
    if (handler) handler();
    else if (typeof data.url === "string") navigate(data.url);
  });

  const register = () => {
    void serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then(() => serviceWorker.ready)
      .then((registration) => {
        const paths = performance
          .getEntriesByType("resource")
          .map((entry) => new URL(entry.name))
          .filter((url) => url.origin === location.origin && url.pathname.startsWith("/assets/"))
          .map((url) => url.pathname);
        registration.active?.postMessage({ type: "t3code:cache-assets", paths });
      })
      .catch(() => undefined);
  };
  // Registration fetches and caches the shell, which should not compete with startup.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
