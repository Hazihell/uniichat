const CACHE = "unii-shell-{build}";
const SHELL = ["/", "/app.js", "/style.css", "/favicon.svg", "/mark.svg", "/manifest.webmanifest", "/icon-192.png"];
const PAGES = ["/", "/settings", "/account", "/tree"];

// Safari takes a subscription back from a site whose pushes show nothing,
// so there every push shows
const QUIET = !/AppleWebKit/.test(navigator.userAgent) || /Chrom|Android/.test(navigator.userAgent);

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(CACHE).then((cache) => Promise.allSettled(SHELL.map((path) => cache.add(path)))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  const url = new URL(req.url);
  const page = req.mode === "navigate" && PAGES.includes(url.pathname);
  if (req.method !== "GET" || url.origin !== location.origin || !(page || SHELL.includes(url.pathname))) {
    return;
  }
  ev.respondWith(fresh(req, page ? "/" : url.pathname));
});

async function fresh(req, key) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req.mode === "navigate" ? req.url : req, { cache: "no-cache" });
    if (res.ok) {
      await cache.put(key, res.clone());
    }
    return res.status < 500 ? res : (await cache.match(key)) ?? res;
  } catch (err) {
    const kept = await cache.match(key);
    if (kept === undefined) {
      throw err;
    }
    return kept;
  }
}

self.addEventListener("push", (ev) => {
  let title = "UniiChat";
  let text = "";
  let tag = "unii";
  try {
    const data = ev.data?.json();
    title = String(data?.title ?? title);
    text = String(data?.text ?? "");
    tag = String(data?.tag ?? tag);
  } catch {}
  ev.waitUntil(notify(text, tag, title));
});

async function notify(text, tag, title) {
  const tabs = await self.clients.matchAll({ type: "window" });
  if (QUIET && tabs.some((tab) => tab.focused)) {
    return;
  }
  await self.registration.showNotification(title, { body: text, icon: "/icon-192.png", tag, renotify: true, requireInteraction: tag !== "unii" });
}

self.addEventListener("notificationclick", (ev) => {
  ev.notification.close();
  ev.waitUntil(open_chat());
});

async function open_chat() {
  const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const tab = tabs.find((t) => new URL(t.url).origin === location.origin);
  return tab !== undefined ? tab.focus() : self.clients.openWindow("/");
}
