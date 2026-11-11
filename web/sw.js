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
  let url = "/";
  try {
    const data = ev.data?.json();
    title = String(data?.title ?? title);
    text = String(data?.text ?? "");
    tag = String(data?.tag ?? tag);
    url = String(data?.url ?? url);
  } catch {}
  ev.waitUntil(notify(text, tag, title, url));
});

// the side chat a page or push is for, "" for the main chat
function chat_of(url) {
  return new URL(url, location.origin).searchParams.get("chat") ?? "";
}

// a push for the chat already in front shows nothing; one for another does
async function notify(text, tag, title, url) {
  const tabs = await self.clients.matchAll({ type: "window" });
  if (QUIET && tabs.some((tab) => tab.focused && chat_of(tab.url) === chat_of(url))) {
    return;
  }
  await self.registration.showNotification(title, { body: text, icon: "/icon-192.png", tag, renotify: true, requireInteraction: tag !== "unii" && !tag.startsWith("side-"), data: { url } });
}

self.addEventListener("notificationclick", (ev) => {
  ev.notification.close();
  ev.waitUntil(open_chat(String(ev.notification.data?.url ?? "/")));
});

// a tap opens the chat the push came from, in the open tab if there is one
async function open_chat(url) {
  const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const tab = tabs.find((t) => new URL(t.url).origin === location.origin);
  if (tab === undefined) {
    return self.clients.openWindow(url);
  }
  await tab.focus();
  if (chat_of(tab.url) !== chat_of(url)) {
    await tab.navigate(new URL(url, location.origin).href).catch(() => self.clients.openWindow(url));
  }
}
