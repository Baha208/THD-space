/* ===== THD Studio engine — presentation app =====
   Reads the page's project.json and builds everything from it: header, the three
   top-level tabs (3D Views, Working Documents, Reports), and inside 3D Views the
   floor tabs, floor plans and room buttons. project.json is the only source of
   floor and room ids; the HTML shell holds no project content.

   The open top-level tab is kept in the URL hash (#3d-views, #working-documents,
   #reports) with replaceState, so a reload keeps it and switching tabs adds no
   history entries. The floor tab always starts on the first floor.

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

  // Thin architectural arrow at the end of every schedule row.
  var ARROW = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M4 12h15M14 7l5 5-5 5"/></svg>';

  function arrow() {
    var span = h("span", { class: "row-arrow" });
    span.innerHTML = ARROW;
    return span;
  }

  // A schedule head: name on the left, sheet number or count on the right.
  function sheetHead(tag, name, meta) {
    return h(tag, { class: "sheet-head" }, [
      h("span", { text: name }),
      h("span", { class: "sheet-head-meta", text: meta })
    ]);
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

  // The three top-level tabs, in order ("tab" is the text on the tab itself).
  var SECTIONS = [
    { id: "3d-views", tab: "3D Views" },
    { id: "working-documents", tab: "Working Documents", list: "documents", name: "Working documents", empty: "No working documents yet" },
    { id: "reports", tab: "Reports", list: "reports", name: "Reports", empty: "No reports yet" }
  ];
  var DEFAULT_SECTION = SECTIONS[0].id;

  // One row of tabs over its panels. kind is "top" or "floor": it prefixes the ids (so a floor
  // called "reports" can never clash with a top-level tab) and names the data attribute.
  function tabSet(nav, container, kind, withIndex) {
    var items = [];
    var attr = kind === "top" ? "data-section" : "data-floor";

    function select(item) {
      items.forEach(function (it) {
        it.tab.setAttribute("aria-selected", it === item ? "true" : "false");
        it.panel.hidden = it !== item;
      });
      if (item.onShow) item.onShow();
    }

    return {
      // panelClass: the top-level 3D Views panel has no fade of its own (its floor panel fades).
      add: function (id, label, content, onShow, panelClass) {
        var first = items.length === 0;
        var tab = h("button", {
          class: kind === "top" ? "tab" : "floor-tab",
          role: "tab",
          id: "tab-" + kind + "-" + id,
          "aria-controls": "panel-" + kind + "-" + id,
          "aria-selected": first ? "true" : "false"
        }, [
          withIndex ? h("span", { class: "tab-index", text: pad(items.length + 1) }) : null,
          h("span", { class: "tab-label", text: label })
        ]);
        tab.setAttribute(attr, id);
        var panel = h("section", {
          class: panelClass || "panel",
          id: "panel-" + kind + "-" + id,
          role: "tabpanel",
          "aria-labelledby": tab.id
        }, [content]);
        panel.setAttribute(attr, id);
        panel.hidden = !first;
        var item = { id: id, tab: tab, panel: panel, onShow: onShow };
        tab.addEventListener("click", function () { select(item); });
        items.push(item);
        nav.appendChild(tab);
        container.appendChild(panel);
        return item;
      },
      select: function (id) {
        var item = items.filter(function (it) { return it.id === id; })[0];
        if (item) select(item);
        return !!item;
      }
    };
  }

  function buildApp(project) {
    var floors = project.floors;

    // Both tab rows sit in one sticky chrome block; the floor row is shown only on 3D Views.
    var sectionNav = h("nav", { class: "tabs", role: "tablist", "aria-label": "Sections" });
    var floorNav = h("nav", { class: "floor-tabs", role: "tablist", "aria-label": "Floors" });
    var main = h("main", { class: "panels" });
    var floorPanels = h("div", { class: "floor-panels" });

    var floorTabs = tabSet(floorNav, floorPanels, "floor", false);
    var sectionTabs = tabSet(sectionNav, main, "top", true);

    floors.forEach(function (floor, f) {
      var plan = h("img", { class: "floorplan-image", alt: floor.label + " plan" });
      plan.setAttribute("data-src", assetUrl(floor.plan));
      plan.setAttribute("data-path", floor.plan);

      // Rooms as an indexed schedule. The room last opened on this floor keeps the marker
      // (is-current), so after closing the gallery the client sees where they were.
      var rooms = floor.rooms || [];
      var roomList = h("nav", { class: "space-list", "aria-label": floor.label + " spaces" },
        rooms.map(function (room, i) {
          var views = room.images.length;
          var btn = h("button", {
            class: "space-button",
            "data-room": room.id,
            "aria-label": room.label + ", " + views + (views === 1 ? " view" : " views")
          }, [
            h("span", { class: "row-index", text: pad(i + 1) }),
            h("span", { class: "row-text" }, [
              h("span", { class: "row-name", text: room.label }),
              h("span", { class: "row-meta", text: views + (views === 1 ? " view" : " views") })
            ]),
            arrow()
          ]);
          btn.addEventListener("click", function () {
            Array.prototype.forEach.call(roomList.children, function (b) {
              b.classList.toggle("is-current", b === btn);
            });
            // Medium copies (rooms[].medium) open first; the gallery swaps in the original for zoom.
            THDGallery.open(room.label, room.images.map(function (file, i) {
              var medium = room.medium && room.medium[i];
              return { full: assetUrl(file), medium: medium ? assetUrl(medium) : null };
            }), floor.label);
          });
          return btn;
        }));

      // The plan is printed on the sheet under its sheet label ("Ground Floor · Sheet 01 / 03").
      floorTabs.add(floor.id, floor.tabLabel || floor.label,
        h("div", { class: "floor-content" }, [
          h("figure", { class: "floorplan" }, [
            sheetHead("figcaption", floor.label, "Sheet " + pad(f + 1) + " / " + pad(floors.length)),
            plan
          ]),
          h("div", { class: "schedule" }, [sheetHead("h2", "Spaces", pad(rooms.length)), roomList])
        ]),
        function () { showPlan(plan); });
    });

    var sectionItems = SECTIONS.map(function (section) {
      return section.list
        ? sectionTabs.add(section.id, section.tab, buildPdfList(project, section))
        : sectionTabs.add(section.id, section.tab, floorPanels, null, "section-3d");
    });

    // Opens a top-level tab by id (unknown ids fall back to 3D Views) and records it in the
    // hash. replaceState keeps history.state as it is, so history.js's overlay marker survives.
    function showSection(id) {
      if (!sectionTabs.select(id)) {
        id = DEFAULT_SECTION;
        sectionTabs.select(id);
      }
      floorNav.hidden = id !== DEFAULT_SECTION;
      if (location.hash !== "#" + id) history.replaceState(history.state, "", "#" + id);
    }
    sectionItems.forEach(function (item) {
      item.tab.addEventListener("click", function () { showSection(item.id); });
    });
    showSection(location.hash.slice(1));

    var app = h("div", { id: "app", "aria-hidden": "true" }, [
      h("header", { class: "site-header" }, [
        h("h1", { class: "site-project", text: project.title })
      ]),
      h("div", { class: "chrome-bars" }, [sectionNav, floorNav]),
      main,
      h("footer", { class: "site-footer" }, [h("p", { text: STUDIO.footer })])
    ]);
    document.body.insertBefore(app, loader.root.nextSibling);

    return {
      root: app,
      plans: Array.prototype.slice.call(app.querySelectorAll(".floorplan-image"))
    };
  }

  // ===================== PDF LISTS (Working Documents, Reports) =====================

  function pdfsOf(project, key) {
    var files = (project[key] && project[key].files) || [];
    return files.map(function (d) {
      return typeof d === "string" ? { file: d, label: d.split("/").pop() } : d;
    });
  }

  // A PDF schedule, or its empty state. A tab is shown even when its list is empty.
  // A dated file's label already starts with its date ("2026-08-23 Cabinets details"); the date
  // part is set in figures, the text stays exactly the label.
  var DATED_LABEL = /^(\d{4}-\d{2}-\d{2}) (.+)$/;

  function docLabel(label) {
    var m = DATED_LABEL.exec(label);
    if (!m) return h("span", { class: "row-name", text: label });
    var name = h("span", { class: "row-name" }, [h("span", { class: "doc-date", text: m[1] })]);
    name.appendChild(document.createTextNode(" " + m[2]));
    return name;
  }

  function buildPdfList(project, section) {
    var docs = pdfsOf(project, section.list);
    var head = sheetHead("h2", section.name, pad(docs.length));
    if (!docs.length) {
      return h("div", { class: "floor-content" }, [
        h("div", { class: "schedule" }, [head, h("p", { class: "doc-empty", text: section.empty })])
      ]);
    }
    return h("div", { class: "floor-content" }, [h("div", { class: "schedule" }, [head,
      h("nav", { class: "space-list", "aria-label": section.name }, docs.map(function (doc) {
        var link = h("a", { class: "space-button doc-link", href: assetUrl(doc.file) }, [
          docLabel(doc.label),
          h("span", { class: "doc-kind", text: "PDF" }),
          arrow()
        ]);
        var row = h("div", { class: "doc-row" }, [link]);
        link.addEventListener("click", function (e) {
          e.preventDefault();
          openDocument(doc, row, link);
        });
        return row;
      }))
    ])]);
  }

  function setDocumentError(row, message) {
    var existing = row.querySelector(".doc-error");
    if (existing) existing.remove();
    if (!message) return;
    row.appendChild(h("p", { class: "doc-error", role: "alert", text: message }));
    console.error(message);
  }

  // Full-screen in-app PDF viewer on the gallery's dark backdrop, for both lists. Pages are
  // drawn by pdf-view.js (PDF.js onto canvases), not an <iframe>: iOS shows only page 1 of
  // an embedded PDF and can't zoom it. (And not a new tab: a target="_blank" link in an
  // iOS home-screen app opens inside the app's webview with no way back.)
  var viewer = {};

  function buildViewer() {
    viewer.pages = h("div", { class: "doc-viewer-pages", "aria-label": "Document pages" });
    viewer.status = h("p", { class: "gallery-status", "aria-live": "polite", text: "Loading" });
    viewer.title = h("p", { class: "gallery-title" });
    viewer.close = h("button", { class: "gallery-close", "aria-label": "Close document" });
    viewer.close.innerHTML = "&times;";
    viewer.root = h("div", { class: "doc-viewer", role: "dialog", "aria-modal": "true", "aria-label": "Document" }, [
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
    THDHistory.open(closeViewer); // back button closes the document, not the app
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
    viewer.status.textContent = "Loading";
    link.setAttribute("aria-busy", "true");
    THDPdfView.preload();

    var httpError = null;
    var viewError = null;
    fetch(url).then(function (res) {
      if (!res.ok) throw (httpError = new Error("HTTP " + res.status));
      return readWithProgress(res, token);
    }).then(function (data) {
      if (viewer.token !== token) return null; // closed while loading
      viewer.status.textContent = "Opening";
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
      setDocumentError(row, "Could not open document: " + doc.file + " (" + reason + ")");
    }).then(function () {
      link.removeAttribute("aria-busy");
    });
  }

  // The whole PDF is downloaded before PDF.js can draw it, which on a slow connection can take
  // minutes for a large file; meanwhile the viewer shows "Downloading 4.2 / 36.0 MB" (the total
  // only when the server sends Content-Length) instead of looking stuck. Same bytes as
  // res.arrayBuffer(), which is the fallback where response streams aren't available.
  function readWithProgress(res, token) {
    if (!res.body || !res.body.getReader) return res.arrayBuffer();
    var total = Number(res.headers.get("Content-Length")) || 0;
    var reader = res.body.getReader();
    var chunks = [];
    var received = 0;
    function mb(n) {
      return (n / 1048576).toFixed(1);
    }
    function next() {
      return reader.read().then(function (step) {
        if (step.done) {
          var data = new Uint8Array(received);
          var at = 0;
          chunks.forEach(function (chunk) {
            data.set(chunk, at);
            at += chunk.length;
          });
          return data.buffer;
        }
        chunks.push(step.value);
        received += step.value.length;
        if (viewer.token === token) {
          viewer.status.textContent = "Downloading " + mb(received) + (total ? " / " + mb(total) : "") + " MB";
        }
        return next();
      });
    }
    return next();
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
    // iOS Safari applies :active (the pressed state of tabs and rows) only when a touch
    // listener exists on the page.
    document.addEventListener("touchstart", function () {}, { passive: true });
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
