/* ===== THD Space — team hub =====
   Bottom tab bar with three sections: Projects (default), Reports, News.
   - Projects lists ../projects-index.json (written by tools/generate-projects-index.js); each
     row is a plain link to ../projects/<slug>/, i.e. a normal navigation into that project's
     own presentation and service worker.
   - Reports and News are placeholders pending direction: static "coming soon" screens, no data.
   The open tab is kept in the URL hash (#projects / #reports / #news) with replaceState, so a
   reload keeps it without adding history entries.

   Opening animation: plays on a cold start only, i.e. the first page load of a browsing session
   (sessionStorage, deliberately not localStorage: a fresh launch replays it, resuming the app
   from the background never does, and neither does a reload or a return from a project in the
   same session). The inline script in index.html decides before first paint by adding
   html.intro-playing; this file ends it when the sequence is over. It always plays to completion:
   taps and keys during it do nothing (there is no skip). */
(function () {
  "use strict";

  var TABS = ["projects", "reports", "news"];
  var TITLES = { projects: "Projects", reports: "Reports", news: "News" };
  var INDEX_URL = "../projects-index.json";
  var INTRO_KEY = "thd-hub-intro";
  var INTRO_MS = 1500;          // sequence length before the fade-out (styles.css timeline)
  var INTRO_REDUCED_MS = 900;   // prefers-reduced-motion: a brief still frame instead
  var INTRO_FADE_MS = 300;

  var CHEVRON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>';

  function $(id) {
    return document.getElementById(id);
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function setThemeColor() {
    var ink = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
    if (!ink) return;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = ink;
  }

  // ===================== TABS =====================

  function show(tab) {
    if (TABS.indexOf(tab) < 0) tab = "projects";
    TABS.forEach(function (name) {
      var selected = name === tab;
      $("tab-" + name).setAttribute("aria-selected", selected ? "true" : "false");
      $("panel-" + name).hidden = !selected;
    });
    $("hub-title").textContent = TITLES[tab];
    document.title = TITLES[tab] + " — THD Space";
    if (location.hash !== "#" + tab) history.replaceState(null, "", "#" + tab);
  }

  function bindTabs() {
    TABS.forEach(function (name) {
      $("tab-" + name).addEventListener("click", function () {
        show(name);
        window.scrollTo(0, 0);
      });
    });
  }

  // ===================== PROJECTS =====================

  function setStatus(text, isError) {
    var status = $("projects-status");
    status.textContent = text;
    status.classList.toggle("is-error", !!isError);
    status.setAttribute("role", isError ? "alert" : "status");
    status.hidden = !text;
  }

  function renderProjects(projects) {
    var list = $("project-list");
    list.textContent = "";
    if (!projects.length) {
      setStatus("No projects yet", false);
      return;
    }
    projects.forEach(function (p, i) {
      var row = document.createElement("a");
      row.className = "project-row";
      row.href = "../projects/" + encodeURIComponent(p.slug) + "/";

      var index = document.createElement("span");
      index.className = "project-index";
      index.textContent = pad(i + 1);

      var text = document.createElement("span");
      text.className = "project-text";
      var title = document.createElement("span");
      title.className = "project-title";
      title.textContent = p.title;
      var client = document.createElement("span");
      client.className = "project-client";
      client.textContent = p.client;
      text.appendChild(title);
      text.appendChild(client);

      var chevron = document.createElement("span");
      chevron.className = "project-chevron";
      chevron.innerHTML = CHEVRON;

      row.appendChild(index);
      row.appendChild(text);
      row.appendChild(chevron);
      list.appendChild(row);
    });
    setStatus("", false);
    list.hidden = false;
  }

  // Failures are shown with the path, never skipped silently (as in the presentations).
  function loadProjects() {
    var httpError = null;
    fetch(INDEX_URL).then(function (res) {
      if (!res.ok) throw (httpError = new Error("HTTP " + res.status));
      return res.json();
    }).then(function (data) {
      renderProjects((data && data.projects) || []);
    }).catch(function (err) {
      var path = new URL(INDEX_URL, location.href).pathname;
      var reason = err === httpError ? err.message
        : err instanceof SyntaxError ? "not valid JSON"
        : "no connection, and not saved on this device yet";
      setStatus("Could not load the project list: " + path + " (" + reason + ")", true);
      console.error("Could not load " + path + ":", err);
    });
  }

  // ===================== ZOOM LOCK =====================

  // iOS ignores user-scalable=no in the viewport meta; block its pinch gesture directly, so page
  // zoom is locked everywhere (the hub has nothing that needs zooming).
  function lockZoom() {
    ["gesturestart", "gesturechange", "gestureend"].forEach(function (type) {
      document.addEventListener(type, function (e) { e.preventDefault(); }, { passive: false });
    });
    document.addEventListener("touchmove", function (e) {
      if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });
  }

  // ===================== SAFE AREAS =====================

  // Remembers the safe-area insets per orientation (largest measured this session) and hands them
  // to the CSS as --sa-*-known; styles.css pads with max(live env(), known). Reason: in an
  // installed hub on iOS, returning from a project opened in the in-app Safari sheet (Done) can
  // leave env(safe-area-inset-*) at 0 until the next viewport change, and iOS may fire no event on
  // that return at all, so the remembered value has to already be in place. Measured through a
  // hidden probe whose padding is the env() values, on load and on every event that can follow a
  // real change (rotation, resize, page shown again, focus).
  function watchSafeAreas() {
    var SIDES = ["top", "bottom"];
    var known = {};
    var probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px) 0";
    document.body.appendChild(probe);

    function measure() {
      var key = window.innerWidth > window.innerHeight ? "landscape" : "portrait";
      var k = known[key] || (known[key] = { top: 0, bottom: 0 });
      var cs = getComputedStyle(probe);
      SIDES.forEach(function (side) {
        var value = parseFloat(cs[side === "top" ? "paddingTop" : "paddingBottom"]) || 0;
        if (value > k[side]) k[side] = value;
        document.documentElement.style.setProperty("--sa-" + side + "-known", k[side] + "px");
      });
    }

    function soon() {
      measure();
      requestAnimationFrame(function () { requestAnimationFrame(measure); });
    }

    measure();
    ["resize", "orientationchange", "pageshow", "focus"].forEach(function (type) {
      window.addEventListener(type, soon);
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") soon();
    });
  }

  // ===================== OPENING ANIMATION =====================

  function runIntro() {
    var root = document.documentElement;
    var intro = $("intro");
    if (!root.classList.contains("intro-playing")) {
      intro.remove();
      return;
    }
    try {
      sessionStorage.setItem(INTRO_KEY, "1"); // seen this session
    } catch (e) {}

    var ended = false;
    var reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

    function end() {
      if (ended) return;
      ended = true;
      show("projects");
      intro.classList.add("is-leaving");
      setTimeout(function () {
        root.classList.remove("intro-playing");
        intro.remove();
      }, reduced ? 0 : INTRO_FADE_MS);
    }

    setTimeout(end, reduced ? INTRO_REDUCED_MS : INTRO_MS);
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
    navigator.serviceWorker.register("sw.js").catch(function (err) {
      console.error("Service worker registration failed:", err);
    });
  }

  lockZoom();
  watchSafeAreas();
  bindTabs();
  show(location.hash.slice(1));
  runIntro();
  setThemeColor();
  loadProjects();
  registerServiceWorker();
})();
