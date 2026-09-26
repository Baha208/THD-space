/* ===== THD Studio engine — service worker =====
   Not registered directly. Each project has a two-line sw.js that sets
   self.THD_ENGINE_URL and importScripts() this file, so the worker is scoped
   to that project's folder.

   - Shell (engine code, fonts, icons, and the project's index.html,
     project.json and manifest.json): precached on install. Served network-first
     for the project files so a regenerated project.json shows up when online,
     and stale-while-revalidate for engine files.
   - Images: cache-first. Floor plans are added on install; renders are cached
     the first time they are viewed.
   - PDFs (Drawings tab): cache-first in their own cache, only after first view
     (never precached, they can be large). A PDF opened directly is a navigation,
     so it is routed here before the app-shell navigation rule.
   - PDF.js (engine/pdfjs/): cache-first in a cache named after its version, so an
     engine VERSION bump doesn't drop it. The library and its worker are precached
     when the project has drawings; fonts/wasm it asks for are cached as used.
   - Only complete 200 responses are cached (PDF viewers may send Range requests).

   Bump VERSION whenever engine files change so clients pick up the new shell. */
"use strict";

var VERSION = "v10";
var PDFJS_VERSION = "6.3.289"; // change together with the files in engine/pdfjs/
var ENGINE_URL = self.THD_ENGINE_URL;
var SCOPE = self.registration.scope;
var PREFIX = "thd:" + SCOPE + ":";
var SHELL_CACHE = PREFIX + "shell-" + VERSION;
var IMAGE_CACHE = PREFIX + "images";
var DOC_CACHE = PREFIX + "documents";
var PDFJS_CACHE = PREFIX + "pdfjs-" + PDFJS_VERSION;
var PDFJS_URL = new URL("pdfjs/", ENGINE_URL).href;

var ENGINE_FILES = [
  "app.js",
  "history.js",
  "zoom.js",
  "gallery.js",
  "pdf-view.js",
  "styles.css",
  "tokens.css",
  "fonts/BankGothic-Medium.woff2",
  "fonts/BankGothic-Bold.woff2",
  "fonts/InterVariable.woff2",
  "images/icons/icon-32.png",
  "images/icons/icon-180.png",
  "images/icons/icon-192.png",
  "images/icons/icon-512.png"
].map(function (p) { return new URL(p, ENGINE_URL).href; });

var PROJECT_FILES = ["./", "project.json", "manifest.json"].map(function (p) {
  return new URL(p, SCOPE).href;
});

var IMAGE_EXT = /\.(webp|avif|jpe?g|png)$/i;
var DOC_EXT = /\.pdf$/i;

// Floor plans are shown on first visit, before this worker controls the page,
// so cache them at install time from project.json. Renders are cached as viewed.
// PDF.js is only needed by projects with drawings, so only they precache it.
function cacheFromProject() {
  return fetch(new URL("project.json", SCOPE).href).then(function (res) {
    return res.json();
  }).then(function (project) {
    var urls = (project.floors || []).filter(function (f) { return f.plan; }).map(function (f) {
      return new URL(f.plan.split("/").map(encodeURIComponent).join("/"), SCOPE).href;
    });
    var plans = caches.open(IMAGE_CACHE).then(function (cache) { return cache.addAll(urls); });
    var hasDrawings = project.documents && project.documents.files && project.documents.files.length;
    var viewer = !hasDrawings ? null : caches.open(PDFJS_CACHE).then(function (cache) {
      return cache.addAll(["pdf.min.js", "pdf.worker.min.js"].map(function (p) { return PDFJS_URL + p; }));
    });
    return Promise.all([plans, viewer]);
  }).catch(function (err) {
    console.error("Could not precache floor plans / drawing viewer:", err);
  });
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (cache) { return cache.addAll(ENGINE_FILES.concat(PROJECT_FILES)); })
      .then(cacheFromProject)
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return (key.indexOf(PREFIX + "shell-") === 0 && key !== SHELL_CACHE) ||
          (key.indexOf(PREFIX + "pdfjs-") === 0 && key !== PDFJS_CACHE);
      }).map(function (key) { return caches.delete(key); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (res) {
        if (res.status === 200) cache.put(request, res.clone());
        return res;
      });
    });
  });
}

function networkFirst(request, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return fetch(request).then(function (res) {
      if (res.status === 200) cache.put(request, res.clone());
      return res;
    }).catch(function () {
      return cache.match(request, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        throw new Error("offline and not cached: " + request.url);
      });
    });
  });
}

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(function (cache) {
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

  if (DOC_EXT.test(url.pathname)) {
    event.respondWith(cacheFirst(request, DOC_CACHE));
  } else if (url.href.indexOf(PDFJS_URL) === 0) {
    event.respondWith(cacheFirst(request, PDFJS_CACHE));
  } else if (request.mode === "navigate") {
    event.respondWith(networkFirst(new Request(new URL("./", SCOPE).href), SHELL_CACHE));
  } else if (IMAGE_EXT.test(url.pathname) && url.href.indexOf(ENGINE_URL) !== 0) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
  } else if (url.href.indexOf(ENGINE_URL) === 0) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  } else if (url.href.indexOf(SCOPE) === 0) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});
