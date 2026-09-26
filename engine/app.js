/* ===== THD Studio engine — presentation app =====
   Reads the page's project.json and builds everything from it: header, floor
   tabs, floor plans and room buttons. project.json is the only source of floor
   and room ids; the HTML shell holds no project content.

   Loading: only project.json, the brand fonts and the first floor's plan block
   the loader. Other floor plans load in the background after the app appears,
   and a room's renders load when it is opened (see gallery.js). Any failure is
   shown on screen with the path that was requested, never skipped silently. */
(function () {
  "use strict";

  var STUDIO = {
    name: "THD Studio",
    kicker: "interior design",
    footer: "THD Studio — Cairo, Egypt"
  };

  var FONTS = ['500 1em "BankGothic"', '600 1em "Inter"'];

  // project.json holds raw on-disk paths (spaces, "&"); encode each segment for use as a URL.
  function assetUrl(path) {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === "text") node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function setThemeColor() {
    var ink = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
    if (!ink) return;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = h("meta", { name: "theme-color" });
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", ink);
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
    navigator.serviceWorker.register("sw.js").catch(function (err) {
      console.error("Service worker registration failed:", err);
    });
  }

  // ===================== LOADER =====================

  var loader = {};

  function buildLoader() {
    loader.bar = h("div", { class: "loader-bar-fill" });
    loader.percent = h("p", { class: "loader-percent", text: "0%" });
    loader.title = h("h1", { class: "loader-title" });
    loader.errorTitle = h("p", { class: "loader-error-title" });
    loader.errorList = h("ul", { class: "loader-error-list" });
    loader.error = h("div", { class: "loader-error", role: "alert" }, [loader.errorTitle, loader.errorList]);
    loader.error.hidden = true;

    loader.root = h("section", { id: "loader", "aria-hidden": "false" }, [
      h("div", { class: "loader-inner" }, [
        h("p", { class: "loader-kicker", text: STUDIO.kicker }),
        loader.title,
        h("div", { class: "loader-bar-track" }, [loader.bar]),
        loader.percent,
        loader.error
      ])
    ]);
    document.body.appendChild(loader.root);
  }

  function setProgress(pct) {
    loader.bar.style.width = pct + "%";
    loader.percent.textContent = pct + "%";
  }

  // failures: [{ name, path }]
  function showLoaderErrors(failures, total) {
    loader.percent.textContent = total
      ? failures.length + " of " + total + " items failed"
      : "Could not start";
    loader.errorTitle.textContent = "Some files could not be loaded:";
    failures.forEach(function (f) {
      var item = h("li", {}, [h("strong", { text: f.name })]);
      item.appendChild(document.createTextNode(" — " + f.path));
      loader.errorList.appendChild(item);
      console.error("Failed to load: " + f.path);
    });
    loader.error.hidden = false;
    loader.root.classList.add("loader-failed");
  }

  function hideLoader() {
    loader.root.classList.add("loader-exit");
    loader.root.setAttribute("aria-hidden", "true");
  }

  // Resolves once every task has settled; reports progress and collects failures.
  function runTasks(tasks) {
    var settled = 0;
    var failures = [];
    setProgress(0);
    return new Promise(function (resolve) {
      tasks.forEach(function (task) {
        task.run().catch(function () {
          failures.push({ name: task.name, path: task.path });
        }).then(function () {
          settled += 1;
          setProgress(Math.round((settled / tasks.length) * 100));
          if (settled === tasks.length) resolve(failures);
        });
      });
    });
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
  }

  function loadFont(spec) {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return document.fonts.load(spec).then(function (faces) {
      if (!faces.length) throw new Error("font not loaded");
    });
  }

  // ===================== PROJECT =====================

  function loadProject() {
    return fetch("project.json").then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  // Catch hand-edited or stale project.json before building anything from it.
  function validate(project) {
    var problems = [];
    if (!project.floors || !project.floors.length) {
      problems.push({ name: "project.json", path: "no floors listed" });
      return problems;
    }
    project.floors.forEach(function (floor) {
      if (!floor.plan) problems.push({ name: floor.label || floor.id, path: "no floor plan in project.json" });
      (floor.rooms || []).forEach(function (room) {
        if (!room.images || !room.images.length) {
          problems.push({ name: room.label || room.id, path: "no images in project.json — run engine/generate-manifest.js" });
        }
      });
    });
    return problems;
  }

  // ===================== APP =====================

  // Tab id for the Drawings section; "--" can't come out of the generator's slugify,
  // so it can't collide with a floor id.
  var DRAWINGS_ID = "drawings--";

  function buildApp(project) {
    var floors = project.floors;
    var tabs = [];
    var panels = [];

    var tablist = h("nav", { class: "tabs", role: "tablist", "aria-label": "Floors and drawings" });
    var main = h("main", { class: "panels" });

    function addTab(id, label, content, onShow) {
      var first = tabs.length === 0;
      var tab = h("button", {
        class: "tab",
        role: "tab",
        "data-floor": id,
        "aria-selected": first ? "true" : "false"
      }, [
        h("span", { class: "tab-index", text: pad(tabs.length + 1) }),
        h("span", { class: "tab-label", text: label })
      ]);
      var panel = h("section", { class: "panel", id: "panel-" + id, role: "tabpanel", "data-floor": id }, [content]);
      panel.hidden = !first;

      tab.addEventListener("click", function () {
        tabs.forEach(function (t) {
          t.setAttribute("aria-selected", t === tab ? "true" : "false");
        });
        panels.forEach(function (p) {
          p.hidden = p !== panel;
        });
        if (onShow) onShow();
      });

      tabs.push(tab);
      panels.push(panel);
      tablist.appendChild(tab);
      main.appendChild(panel);
    }

    floors.forEach(function (floor) {
      var plan = h("img", { class: "floorplan-image", alt: floor.label + " plan" });
      plan.setAttribute("data-src", assetUrl(floor.plan));
      plan.setAttribute("data-path", floor.plan);

      var roomList = h("nav", { class: "space-list", "aria-label": floor.label + " spaces" },
        (floor.rooms || []).map(function (room) {
          var btn = h("button", { class: "space-button", "data-room": room.id, text: room.label });
          btn.addEventListener("click", function () {
            // Medium copies (rooms[].medium) open first; the gallery swaps in the original for zoom.
            THDGallery.open(room.label, room.images.map(function (file, i) {
              var medium = room.medium && room.medium[i];
              return { full: assetUrl(file), medium: medium ? assetUrl(medium) : null };
            }), floor.label);
          });
          return btn;
        }));

      addTab(floor.id, floor.tabLabel || floor.label,
        h("div", { class: "floor-content" }, [h("div", { class: "floorplan" }, [plan]), roomList]),
        function () { showPlan(plan); });
    });

    addTab(DRAWINGS_ID, "Drawings", buildDrawings(project));

    var app = h("div", { id: "app", "aria-hidden": "true" }, [
      h("header", { class: "site-header" }, [
        h("h1", { class: "site-project", text: project.title })
      ]),
      tablist,
      main,
      h("footer", { class: "site-footer" }, [h("p", { text: STUDIO.footer })])
    ]);
    document.body.insertBefore(app, loader.root.nextSibling);

    return {
      root: app,
      plans: Array.prototype.slice.call(app.querySelectorAll(".floorplan-image"))
    };
  }

  // ===================== DRAWINGS =====================

  function documentsOf(project) {
    var files = (project.documents && project.documents.files) || [];
    return files.map(function (d) {
      return typeof d === "string" ? { file: d, label: d.split("/").pop() } : d;
    });
  }

  function buildDrawings(project) {
    var docs = documentsOf(project);
    if (!docs.length) {
      return h("div", { class: "floor-content" }, [h("p", { class: "drawings-empty", text: "No drawings yet" })]);
    }
    return h("div", { class: "floor-content" }, [
      h("nav", { class: "space-list", "aria-label": "Drawings" }, docs.map(function (doc) {
        var link = h("a", { class: "space-button drawing-link", href: assetUrl(doc.file) }, [
          h("span", { text: doc.label }),
          h("span", { class: "drawing-kind", text: "PDF" })
        ]);
        var row = h("div", { class: "drawing-row" }, [link]);
        link.addEventListener("click", function (e) {
          e.preventDefault();
          openDocument(doc, row, link);
        });
        return row;
      }))
    ]);
  }

  function setDocumentError(row, message) {
    var existing = row.querySelector(".drawing-error");
    if (existing) existing.remove();
    if (!message) return;
    row.appendChild(h("p", { class: "drawing-error", role: "alert", text: message }));
    console.error(message);
  }

  // Full-screen in-app PDF viewer on the gallery's dark backdrop. Pages are drawn by
  // pdf-view.js (PDF.js onto canvases), not an <iframe>: iOS shows only page 1 of an
  // embedded PDF and can't zoom it. (And not a new tab: a target="_blank" link in an
  // iOS home-screen app opens inside the app's webview with no way back.)
  var viewer = {};

  function buildViewer() {
    viewer.pages = h("div", { class: "doc-viewer-pages", "aria-label": "Drawing pages" });
    viewer.status = h("p", { class: "gallery-status", "aria-live": "polite", text: "Loading" });
    viewer.title = h("p", { class: "gallery-title" });
    viewer.close = h("button", { class: "gallery-close", "aria-label": "Close drawing" });
    viewer.close.innerHTML = "&times;";
    viewer.root = h("div", { class: "doc-viewer", role: "dialog", "aria-modal": "true", "aria-label": "Drawing" }, [
      viewer.close,
      h("div", { class: "doc-viewer-body" }, [viewer.pages, viewer.status]),
      h("div", { class: "gallery-footer" }, [viewer.title])
    ]);
    viewer.root.hidden = true;
    document.body.appendChild(viewer.root);
    viewer.pdf = THDPdfView.create({ scroller: viewer.pages, root: viewer.root });

    viewer.close.addEventListener("click", closeViewer);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !viewer.root.hidden) closeViewer();
    });
  }

  function openViewer(label, returnFocus) {
    viewer.token = {};
    viewer.returnFocus = returnFocus;
    viewer.title.textContent = label;
    viewer.root.setAttribute("aria-label", label);
    viewer.status.hidden = false;
    viewer.root.hidden = false;
    document.body.style.overflow = "hidden";
    viewer.close.focus();
    THDHistory.open(closeViewer); // back button closes the drawing, not the app
    return viewer.token;
  }

  function closeViewer() {
    if (viewer.root.hidden) return;
    viewer.token = null;
    viewer.root.hidden = true;
    viewer.pdf.clear();
    document.body.style.overflow = "";
    THDHistory.close();
    if (viewer.returnFocus) viewer.returnFocus.focus();
  }

  // The PDF is fetched first (through the service worker, which caches it on this
  // first view) so a missing file or an offline miss shows an inline error on the
  // list instead of a broken viewer. Those bytes are then handed to PDF.js.
  function openDocument(doc, row, link) {
    setDocumentError(row, "");
    var url = assetUrl(doc.file);
    var token = openViewer(doc.label, link);
    link.setAttribute("aria-busy", "true");
    THDPdfView.preload();

    var httpError = null;
    var viewError = null;
    fetch(url).then(function (res) {
      if (!res.ok) throw (httpError = new Error("HTTP " + res.status));
      return res.arrayBuffer();
    }).then(function (data) {
      if (viewer.token !== token) return null; // closed while loading
      return viewer.pdf.load(data).catch(function (err) {
        throw (viewError = err);
      });
    }).then(function () {
      if (viewer.token !== token) return;
      viewer.status.hidden = true;
    }).catch(function (err) {
      if (viewer.token === token) closeViewer();
      // No HTTP status means the request never got an answer: offline (or server
      // unreachable) and the service worker has no saved copy yet.
      var reason = err === httpError || err === viewError ? err.message : "no connection, and not saved on this device yet";
      setDocumentError(row, "Could not open drawing: " + doc.file + " (" + reason + ")");
    }).then(function () {
      link.removeAttribute("aria-busy");
    });
  }

  // Attach a floor plan's src (once). A plan that fails after the app is visible
  // is replaced by an inline error naming the path.
  function showPlan(img) {
    var src = img.getAttribute("data-src");
    if (!src) return;
    img.removeAttribute("data-src");
    img.onerror = function () {
      var path = img.getAttribute("data-path");
      console.error("Floor plan failed to load: " + path);
      img.replaceWith(h("p", { class: "floorplan-error", role: "alert", text: "Could not load floor plan: " + path }));
    };
    img.src = src;
  }

  function revealApp(app) {
    app.root.removeAttribute("aria-hidden");
    app.root.classList.add("app-visible");
  }

  function start() {
    buildLoader();
    THDGallery.init();
    buildViewer();
    setThemeColor();
    registerServiceWorker();

    loadProject().catch(function (err) {
      showLoaderErrors([{ name: "project.json", path: new URL("project.json", location.href).pathname + " (" + err.message + ")" }], 0);
      throw err;
    }).then(function (project) {
      document.title = project.title + " — " + STUDIO.name;
      loader.title.textContent = project.title;

      var problems = validate(project);
      if (problems.length) {
        showLoaderErrors(problems, 0);
        return;
      }

      var app = buildApp(project);
      var firstPlan = project.floors[0].plan;

      var tasks = [{
        name: firstPlan.split("/").pop(),
        path: firstPlan,
        run: function () { return loadImage(assetUrl(firstPlan)); }
      }].concat(FONTS.map(function (spec) {
        return { name: spec, path: "engine font " + spec, run: function () { return loadFont(spec); } };
      }));

      return runTasks(tasks).then(function (failures) {
        if (failures.length) {
          showLoaderErrors(failures, tasks.length);
          return;
        }
        showPlan(app.plans[0]);
        hideLoader();
        revealApp(app);
        app.plans.slice(1).forEach(showPlan);
      });
    }).catch(function (err) {
      console.error(err);
    });
  }

  start();
})();
