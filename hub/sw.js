/* ===== THD Space — hub service worker =====
   Scoped to hub/ only. Independent from engine/sw.js: its own VERSION and its own caches
   ("thd-hub:<scope>:…"), so neither worker ever touches the other's.

   - Shell (hub files, icons, engine/tokens.css and the two fonts it uses) and
     projects-index.json are precached on install, so the tab bar, placeholders and project
     list work offline after one visit.
   - Hub files and projects-index.json: network-first (a regenerated index shows up when
     online), falling back to the cache offline. engine/tokens.css and fonts:
     stale-while-revalidate.
   - Opening a project is a navigation outside this scope, so it is never seen here; that
     project's own service worker handles it.

   Bump VERSION whenever a hub file changes. */
"use strict";

var VERSION = "hub-v5";
var SCOPE = self.registration.scope;
var CACHE = "thd-hub:" + SCOPE + ":" + VERSION;

var HUB_FILES = [
  "./",
  "styles.css",
  "hub.js",
  "manifest.json",
  "splash-mark.png",
  "icons/icon-32.png",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-192.png",
  "icons/icon-maskable-512.png",
  "../projects-index.json"
].map(function (p) { return new URL(p, SCOPE).href; });

var SHARED_FILES = [
  "../engine/tokens.css",
  "../engine/fonts/BankGothic-Medium.woff2",
  "../engine/fonts/InterVariable.woff2"
].map(function (p) { return new URL(p, SCOPE).href; });

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(HUB_FILES.concat(SHARED_FILES)); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key.indexOf("thd-hub:" + SCOPE + ":") === 0 && key !== CACHE;
      }).map(function (key) { return caches.delete(key); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function networkFirst(request, cacheKey) {
  return caches.open(CACHE).then(function (cache) {
    return fetch(request).then(function (res) {
      if (res.status === 200) cache.put(cacheKey || request, res.clone());
      return res;
    }).catch(function () {
      return cache.match(cacheKey || request, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        throw new Error("offline and not cached: " + request.url);
      });
    });
  });
}

function staleWhileRevalidate(request) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      var network = fetch(request).then(function (res) {
        if (res.status === 200) cache.put(request, res.clone());
        return res;
      });
      if (hit) {
        network.catch(function () {});
        return hit;
      }
      return network;
    });
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  var bare = url.origin + url.pathname;

  if (request.mode === "navigate") {
    // Only navigations inside hub/ reach this worker: always answer with the hub shell.
    event.respondWith(networkFirst(request, new URL("./", SCOPE).href));
  } else if (HUB_FILES.indexOf(bare) >= 0) {
    event.respondWith(networkFirst(request));
  } else if (SHARED_FILES.indexOf(bare) >= 0) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
