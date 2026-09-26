/* ===== THD Studio engine — PDF page renderer for the drawing viewer =====
   Draws a PDF with PDF.js (self-hosted in engine/pdfjs/, loaded on first use) as a
   vertical stack of <canvas> pages in a scrollable container, like a native viewer.
   Used instead of an <iframe> because iOS shows only page 1 of an embedded PDF and
   can't zoom it.

   - Every page gets a correctly sized placeholder up front; a page is only drawn when it
     scrolls within one screen of view, and its canvas is freed again when it scrolls
     further away, so long drawing sets stay light on memory.
   - Zoom is zoom.js (same gestures as the render gallery) on the whole page stack. At
     1x the container scrolls natively; zoomed in, a drag pans instead, and zooming back
     out turns the pan into scroll position. When a zoom settles, the pages in view are
     redrawn at the zoomed resolution (capped per canvas) so line work stays sharp.

   THDPdfView.create({ scroller, root }) → { load(ArrayBuffer) → Promise, clear() }
   THDPdfView.preload() starts fetching PDF.js early. */
(function () {
  "use strict";

  var PDFJS_URL = new URL("pdfjs/", document.currentScript.src).href;
  var MAX_PAGE_WIDTH = 1200;          // CSS px; wider screens get side margins
  var MAX_CANVAS_PIXELS = 8388608;    // per page canvas (iOS caps canvas memory)
  var MAX_DEVICE_SCALE = 3;

  var library = null;

  // PDF.js is an ES module; import() works from this classic script. Its worker is
  // started from a same-origin blob that imports the real file: unlike a worker at
  // engine/pdfjs/ (outside the project's service worker scope), a blob worker belongs to
  // this page, so the import is answered from the offline cache. If a worker can't start,
  // PDF.js itself falls back to running the same file on the main thread.
  function loadLibrary() {
    if (!library) {
      library = import(PDFJS_URL + "pdf.min.js").then(function (pdfjs) {
        var wrapper = 'await import("' + PDFJS_URL + 'pdf.worker.min.js");';
        pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([wrapper], { type: "text/javascript" }));
        return pdfjs;
      });
      library.catch(function () {
        library = null; // try again next time (e.g. back online)
      });
    }
    return library;
  }

  function create(opts) {
    var scroller = opts.scroller;
    var stack = document.createElement("div");
    stack.className = "pdf-pages";
    scroller.appendChild(stack);

    var current = null; // { task, pages, observer } of the open document

    function deviceScale() {
      return Math.min(window.devicePixelRatio || 1, MAX_DEVICE_SCALE);
    }

    // Canvas pixels per CSS pixel for a page: sharp at the current zoom while in view,
    // screen resolution otherwise; never over the per-canvas pixel budget.
    function outputScale(page, inView) {
      var wanted = deviceScale() * (inView ? Math.ceil(zoom.scale() - 0.05) : 1);
      return Math.min(wanted, Math.sqrt(MAX_CANVAS_PIXELS / (page.width * page.height)));
    }

    function inView(page) {
      var r = page.el.getBoundingClientRect();
      var v = scroller.getBoundingClientRect();
      return r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right;
    }

    function render(page, scale) {
      if (page.task) page.task.cancel();
      var viewport = page.proxy.getViewport({ scale: page.width / page.size.width * scale });
      var canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      var task = page.proxy.render({ canvas: canvas, viewport: viewport });
      page.task = task;
      page.pending = scale;
      task.promise.then(function () {
        if (page.task !== task) return;
        page.task = null;
        // Swap in the finished canvas, so a sharper redraw never flashes blank.
        if (page.canvas) freeCanvas(page.canvas);
        page.el.appendChild(canvas);
        page.canvas = canvas;
        page.scale = scale;
        page.el.classList.add("is-rendered");
      }).catch(function (err) {
        freeCanvas(canvas);
        if (page.task !== task) return;
        page.task = null;
        if (err && err.name === "RenderingCancelledException") return;
        page.el.classList.add("is-failed");
        page.el.setAttribute("data-error", "Could not draw page " + page.number);
        console.error("PDF page " + page.number + " failed to render:", err);
      });
    }

    function freeCanvas(canvas) {
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    }

    function release(page) {
      if (page.task) page.task.cancel();
      page.task = null;
      if (page.canvas) freeCanvas(page.canvas);
      page.canvas = null;
      page.scale = 0;
      page.el.classList.remove("is-rendered");
    }

    // Draw a page at the resolution it should have now, unless it already has it.
    function refresh(page) {
      if (!page.near) return;
      var scale = outputScale(page, inView(page));
      var have = page.task ? page.pending : page.scale;
      if (Math.abs(have - scale) > 0.01) render(page, scale);
    }

    // Fit each page to the available width (capped), keeping its proportions.
    function layout() {
      var cs = getComputedStyle(stack);
      var available = scroller.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      var width = Math.floor(Math.min(available, MAX_PAGE_WIDTH));
      current.pages.forEach(function (page) {
        page.width = width;
        page.height = Math.round(width * page.size.height / page.size.width);
        page.el.style.width = page.width + "px";
        page.el.style.height = page.height + "px";
      });
    }

    function observe() {
      if (current.observer) current.observer.disconnect();
      var byElement = new Map();
      current.pages.forEach(function (page) { byElement.set(page.el, page); });
      current.observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          var page = byElement.get(entry.target);
          page.near = entry.isIntersecting;
          if (page.near) refresh(page);
          else release(page);
        });
      }, { root: scroller, rootMargin: "100% 0px" });
      current.pages.forEach(function (page) { current.observer.observe(page.el); });
    }

    function clear() {
      zoom.reset();
      if (current) {
        if (current.observer) current.observer.disconnect();
        (current.pages || []).forEach(release);
        if (current.task) current.task.destroy();
        current = null;
      }
      stack.textContent = "";
      scroller.scrollTop = 0;
    }

    function load(data) {
      clear();
      var state = { pages: null };
      current = state;
      return loadLibrary().catch(function (err) {
        console.error(err);
        throw new Error("the drawing viewer could not be loaded");
      }).then(function (pdfjs) {
        if (current !== state) return null;
        state.task = pdfjs.getDocument({
          data: data,
          cMapUrl: PDFJS_URL + "cmaps/",
          cMapPacked: true,
          standardFontDataUrl: PDFJS_URL + "standard_fonts/",
          wasmUrl: PDFJS_URL + "wasm/",
          iccUrl: PDFJS_URL + "iccs/",
          isEvalSupported: false
        });
        return state.task.promise.catch(function (err) {
          throw new Error("not a readable PDF: " + err.message);
        });
      }).then(function (pdf) {
        if (!pdf || current !== state) return null;
        var numbers = [];
        for (var i = 1; i <= pdf.numPages; i++) numbers.push(i);
        return Promise.all(numbers.map(function (n) { return pdf.getPage(n); }));
      }).then(function (proxies) {
        if (!proxies || current !== state) return;
        state.pages = proxies.map(function (proxy, i) {
          var el = document.createElement("div");
          el.className = "pdf-page";
          el.setAttribute("role", "img");
          el.setAttribute("aria-label", "Page " + (i + 1) + " of " + proxies.length);
          stack.appendChild(el);
          var size = proxy.getViewport({ scale: 1 });
          return { number: i + 1, proxy: proxy, el: el, size: { width: size.width, height: size.height },
            width: 0, height: 0, canvas: null, task: null, scale: 0, pending: 0, near: false };
        });
        layout();
        observe();
      });
    }

    var zoom = THDZoom.create({
      surface: scroller,
      content: stack,
      marks: [stack, scroller, opts.root],
      gestureRoot: opts.root,
      wheel: "scroll",
      viewport: function () {
        var r = scroller.getBoundingClientRect();
        return { x: r.left + scroller.clientLeft, y: r.top + scroller.clientTop, w: scroller.clientWidth, h: scroller.clientHeight };
      },
      // Untransformed box of the page stack at the current scroll position.
      measure: function () {
        var r = scroller.getBoundingClientRect();
        var w = stack.offsetWidth;
        var h = stack.offsetHeight;
        return {
          cx: r.left + scroller.clientLeft + stack.offsetLeft - scroller.scrollLeft + w / 2,
          cy: r.top + scroller.clientTop + stack.offsetTop - scroller.scrollTop + h / 2,
          w: w,
          h: h
        };
      },
      ready: function () { return !!(current && current.pages); },
      onRest: function (dx, dy) {
        scroller.scrollLeft -= dx;
        scroller.scrollTop -= dy;
      },
      onSettle: function () {
        if (current && current.pages) current.pages.forEach(refresh);
      }
    });

    // Rotation / width change: refit the pages and keep the same page in view.
    var lastWidth = window.innerWidth;
    window.addEventListener("resize", function () {
      if (!current || !current.pages) return;
      if (window.innerWidth === lastWidth) {
        if (zoom.isZoomed()) zoom.apply(); // height-only change: re-clamp
        return;
      }
      lastWidth = window.innerWidth;
      var anchor = scroller.scrollTop / Math.max(1, stack.offsetHeight);
      zoom.reset();
      current.pages.forEach(release);
      layout();
      scroller.scrollTop = anchor * stack.offsetHeight;
      observe();
    });

    return { load: load, clear: clear };
  }

  window.THDPdfView = {
    create: create,
    preload: function () {
      loadLibrary().catch(function () {});
    }
  };
})();
