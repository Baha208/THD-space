// Scopes the shared engine service worker to this project folder. No project data here.
self.THD_ENGINE_URL = new URL("{{ENGINE}}/", self.location).href;
importScripts("{{ENGINE}}/sw.js");
