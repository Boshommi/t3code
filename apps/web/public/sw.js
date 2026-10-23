// T3 Code service worker.
//
// It only keeps the app shell available: navigations are network-first with the
// last good index.html as the offline fallback, and hashed /assets/ files are
// cache-first because their names change with their contents. Everything else,
// including every server route below, goes straight to the network untouched.
// The app is useless without its server, so caching API data would only show
// stale state; what this buys is a fast start and a reconnecting UI instead of
// a browser error page when the server or network is briefly unreachable.
//
// Online behavior must stay identical to having no worker, so a navigation only
// falls back to the cache when the network request itself throws.

const SHELL_CACHE = "t3code-shell-v1";
const ASSET_CACHE = "t3code-assets-v1";
const SHELL_KEY = "/";
// Kept in sync with DEV_PROXIED_PATH_PREFIXES in packages/shared/src/devProxy.ts,
// plus the hosted app's channel switch route.
const SERVER_PREFIXES = ["/api", "/oauth", "/.well-known", "/ws", "/mcp", "/__t3code"];

const isServerPath = (pathname) =>
  SERVER_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

const shellAssetPaths = (html) =>
  new Set(Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g), (match) => match[1]));

async function cacheAsset(cache, path) {
  if (await cache.match(path)) return;
  const response = await fetch(path);
  if (response.ok) await cache.put(path, response);
}

// A new shell means a new build, so the previous build's hashed files can go.
// Lazy chunks of the new build are cached again as the app loads them.
async function storeShell(response) {
  const html = await response.clone().text();
  if (!html.includes('id="root"')) return;
  const shells = await caches.open(SHELL_CACHE);
  const previous = await shells.match(SHELL_KEY);
  const assets = await caches.open(ASSET_CACHE);
  const paths = shellAssetPaths(html);
  if (!previous || (await previous.text()) !== html) {
    await shells.put(SHELL_KEY, response);
    for (const request of await assets.keys()) {
      if (!paths.has(new URL(request.url).pathname)) await assets.delete(request);
    }
  }
  await Promise.all(Array.from(paths, (path) => cacheAsset(assets, path)));
}

async function refreshShell() {
  const response = await fetch(SHELL_KEY, { cache: "no-cache" });
  if (response.ok && !response.redirected) await storeShell(response);
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(refreshShell().catch(() => undefined));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      for (const name of await caches.keys()) {
        if (name.startsWith("t3code-") && !keep.has(name)) await caches.delete(name);
      }
      // Starts the navigation request while the worker boots, so it adds no latency.
      await self.registration.navigationPreload?.enable();
      await self.clients.claim();
    })(),
  );
});

async function handleNavigation(event) {
  try {
    const response = (await event.preloadResponse) ?? (await fetch(event.request));
    const type = response.headers.get("Content-Type") ?? "";
    if (response.ok && !response.redirected && type.startsWith("text/html")) {
      event.waitUntil(storeShell(response.clone()).catch(() => undefined));
    }
    return response;
  } catch (error) {
    const shell = await caches.match(SHELL_KEY, { cacheName: SHELL_CACHE });
    if (shell) return shell;
    throw error;
  }
}

async function handleAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isServerPath(url.pathname)) return;
  if (request.mode === "navigate" && request.destination === "document") {
    event.respondWith(handleNavigation(event));
    return;
  }
  // Media elements send Range requests, which a cached full response cannot answer.
  if (url.pathname.startsWith("/assets/") && !request.headers.has("Range")) {
    event.respondWith(handleAsset(request));
  }
});

// The page reports the build files it loaded before this worker controlled it.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (data?.type !== "t3code:cache-assets" || !Array.isArray(data.paths)) return;
  const paths = data.paths.filter(
    (path) => typeof path === "string" && /^\/assets\/[^/?#]+$/.test(path),
  );
  event.waitUntil(
    caches
      .open(ASSET_CACHE)
      .then((cache) => Promise.all(paths.map((path) => cacheAsset(cache, path))))
      .catch(() => undefined),
  );
});

// Notifications shown through the worker report clicks here instead of to the
// page. The page that receives the message runs the click action it registered,
// or navigates to the notification's URL when another tab created it.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = typeof event.notification.data?.url === "string" ? event.notification.data.url : "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client =
        windows.find((candidate) => candidate.focused) ??
        windows.find((candidate) => candidate.visibilityState === "visible") ??
        windows[0];
      if (!client) {
        await self.clients.openWindow(url);
        return;
      }
      await client.focus().catch(() => undefined);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Client.postMessage takes no origin.
      client.postMessage({ type: "t3code:notification-click", tag: event.notification.tag, url });
    })(),
  );
});
