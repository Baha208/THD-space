// Scopes the shared engine service worker to this project folder. No project data here.
self.THD_ENGINE_URL = new URL("../../engine/", self.location).href;
importScripts("../../engine/sw.js");
