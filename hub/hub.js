/* ===== THD Space — team hub =====
   Bottom tab bar with three sections: Projects (default), Library, News.
   - Projects lists ../projects-index.json (written by tools/generate-projects-index.js); each
     row is a plain link to ../projects/<slug>/, i.e. a normal navigation into that project's
     own presentation and service worker.
   - Library and News are placeholders pending direction: static "coming soon" screens, no data.
   The open tab is kept in the URL hash (#projects / #library / #news) with replaceState, so a
   reload keeps it without adding history entries. Any other hash (e.g. the old #reports, from
   before Library replaced it) opens Projects.

   Opening animation: plays on a cold start only, i.e. the first page load of a browsing session
   (sessionStorage, deliberately not localStorage: a fresh launch replays it, resuming the app
   from the background never does, and neither does a reload or a return from a project in the
   same session). The inline script in index.html decides before first paint by adding
   html.intro-playing; this file ends it when the sequence is over. It always plays to completion:
   taps and keys during it do nothing (there is no skip). */
(function () {
  "use strict";

  var TABS = ["projects", "library", "news"];
  var TITLES = { projects: "Projects", library: "Library", news: "News" };
  var INDEX_URL = "../projects-index.json";
  var INTRO_KEY = "thd-hub-intro";
  var INTRO_MS = 1500;          // sequence length before the fade-out (styles.css timeline)
  var INTRO_REDUCED_MS = 900;   // prefers-reduced-motion: a brief still frame instead
  var INTRO_FADE_MS = 300;

  // Same thin arrow as the schedule rows in a presentation (engine/app.js).
  var ARROW = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M4 12h15M14 7l5 5-5 5"/></svg>';

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
    $("projects-count").textContent = pad(projects.length);
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

      var arrow = document.createElement("span");
      arrow.className = "project-arrow";
      arrow.innerHTML = ARROW;

      row.appendChild(index);
      row.appendChild(text);
      row.appendChild(arrow);
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

  // TOP inset only. Remembers it per orientation (largest measured this session) and hands it to
  // the CSS as --sa-top-known; styles.css pads the header with max(live env(), known). Reason: in
  // an installed hub on iOS, returning from a project opened in the in-app Safari sheet (Done) can
  // leave env(safe-area-inset-top) at 0 until the next viewport change, and iOS may fire no event
  // on that return at all, so the remembered value has to already be in place. Measured through a
  // hidden probe whose padding is the env() value, on load and on every event that can follow a
  // real change (rotation, resize, page shown again, focus). The bottom inset is deliberately not
  // remembered: the tab bar uses iOS's constant (styles.css), so its height never varies.
  //
  // Also the VIEWPORT GAP (iOS home-screen app only): with black-translucent, WebKit can lay the
  // page out shorter than the screen by the status-bar height at launch, until the first scroll;
  // a tab bar at bottom: 0 then floats that much too high, with ink under it (seen on an iPhone:
  // 145 pt tall at launch, 98 after scrolling; 145 - 98 = 47 = the top inset). In a home-screen
  // app the page always fills the screen, so any shortfall of innerHeight against the screen is
  // that bug; it is handed to the CSS as --viewport-gap and the bar moves down by exactly that
  // much. Rechecked on scroll too, since WebKit corrects the layout on the first scroll.
  var safe = { probe: null, gap: 0 };

  function isIosHomeScreen() {
    return window.navigator.standalone === true;
  }

  function screenHeight() {
    var portrait = window.innerWidth <= window.innerHeight;
    var a = screen.width, b = screen.height;
    return portrait ? Math.max(a, b) : Math.min(a, b);
  }

  function watchSafeAreas() {
    var known = {};
    var probe = safe.probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px) 0";
    document.body.appendChild(probe);

    function measure() {
      var key = window.innerWidth > window.innerHeight ? "landscape" : "portrait";
      var value = parseFloat(getComputedStyle(probe).paddingTop) || 0;
      if (value > (known[key] || 0)) known[key] = value;
      document.documentElement.style.setProperty("--sa-top-known", (known[key] || 0) + "px");

      var gap = 0;
      if (isIosHomeScreen()) {
        gap = Math.round(screenHeight() - window.innerHeight);
        if (gap < 1 || gap > 80) gap = 0; // only the status-bar-sized shortfall, nothing else
      }
      safe.gap = gap;
      document.documentElement.style.setProperty("--viewport-gap", gap + "px");
      if (safe.onChange) safe.onChange();
    }

    function soon() {
      measure();
      requestAnimationFrame(function () { requestAnimationFrame(measure); });
    }

    measure();
    ["resize", "orientationchange", "pageshow", "focus", "scroll"].forEach(function (type) {
      window.addEventListener(type, soon, { passive: true });
    });
    if (window.visualViewport) window.visualViewport.addEventListener("resize", soon);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") soon();
    });
  }

  // ===================== DIAGNOSTIC (temporary) =====================

  // ?debug=1, or five quick taps on the "THD Space" kicker (an installed app has no address bar;
  // the choice is kept in localStorage until turned off the same way). Shows the numbers behind
  // the tab bar's position, to screenshot on the iPhone. Remove once the bar is confirmed there.
  var DEBUG_KEY = "thd-hub-debug";

  function initDebug() {
    var on = /[?&]debug=1(&|$)/.test(location.search);
    try {
      if (on) localStorage.setItem(DEBUG_KEY, "1");
      on = on || localStorage.getItem(DEBUG_KEY) === "1";
    } catch (e) {}
    var box = null;
    var timer = null;

    function px(v) {
      return Math.round(parseFloat(v) || 0);
    }

    function update() {
      if (!box) return;
      var cs = getComputedStyle(safe.probe);
      var bar = document.querySelector(".tabbar").getBoundingClientRect();
      var standalone = window.matchMedia && matchMedia("(display-mode: standalone)").matches;
      box.textContent = [
        "env inset top " + px(cs.paddingTop) + " / bottom " + px(cs.paddingBottom),
        "innerHeight " + window.innerHeight + "  innerWidth " + window.innerWidth,
        "visualViewport.height " + (window.visualViewport ? Math.round(window.visualViewport.height) : "n/a"),
        "screen " + screen.width + " x " + screen.height,
        "display-mode standalone " + (standalone ? "yes" : "no") + "  navigator.standalone " + (window.navigator.standalone === true ? "yes" : "no"),
        "viewport gap applied " + safe.gap,
        "tab bar top " + Math.round(bar.top) + "  height " + Math.round(bar.height) + "  bottom " + Math.round(bar.bottom),
        "scrollY " + Math.round(window.scrollY)
      ].join("\n");
    }

    function set(value) {
      try {
        if (value) localStorage.setItem(DEBUG_KEY, "1");
        else localStorage.removeItem(DEBUG_KEY);
      } catch (e) {}
      if (value && !box) {
        box = document.createElement("pre");
        box.className = "hub-debug";
        box.setAttribute("aria-hidden", "true");
        document.body.appendChild(box);
        timer = setInterval(update, 500);
        update();
      } else if (!value && box) {
        clearInterval(timer);
        box.remove();
        box = null;
      }
    }

    safe.onChange = update;
    set(on);

    var taps = [];
    document.querySelector(".hub-kicker").addEventListener("click", function () {
      var now = Date.now();
      taps = taps.filter(function (t) { return now - t < 2000; });
      taps.push(now);
      if (taps.length >= 5) {
        taps = [];
        set(!box);
      }
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

  // iOS Safari applies :active (the pressed state of rows and tabs) only when a touch listener
  // exists on the page.
  document.addEventListener("touchstart", function () {}, { passive: true });
  lockZoom();
  watchSafeAreas();
  initDebug();
  bindTabs();
  show(location.hash.slice(1));
  runIntro();
  setThemeColor();
  loadProjects();
  registerServiceWorker();
})();
