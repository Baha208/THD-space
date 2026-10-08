/* ===== THD Studio engine — fullscreen render gallery =====
   Knows nothing about projects: app.js calls THDGallery.open(title, images, context)
   with a room label, its list of image URLs and the floor label, shown in the header
   as "Room · Floor" so the floor stays visible in fullscreen. Images load on demand; the
   neighbours of the current image are fetched in the background.

   Zoom (pinch, double-tap, wheel, double-click; pan while zoomed) comes from zoom.js and
   is scoped to the displayed image. Swipe navigates only at 1x; zoom resets on every image
   change, close and rotation. */
(function () {
  "use strict";

  var ICON_PREV = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"></polyline></svg>';
  var ICON_NEXT = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>';

  var el = {};
  var state = { images: [], index: 0, title: "", context: "", isOpen: false };
  var zoom = null;

  function build() {
    var gallery = document.createElement("div");
    gallery.className = "gallery";
    gallery.id = "gallery";
    gallery.setAttribute("role", "dialog");
    gallery.setAttribute("aria-modal", "true");
    gallery.setAttribute("aria-label", "Space gallery");
    gallery.innerHTML =
      '<button class="gallery-close" aria-label="Close gallery">&times;</button>' +
      '<button class="gallery-nav gallery-prev" aria-label="Previous image">' + ICON_PREV + '</button>' +
      '<div class="gallery-stage">' +
      '  <img class="gallery-image" src="" alt="" draggable="false">' +
      '  <p class="gallery-status" aria-live="polite" hidden></p>' +
      '</div>' +
      '<button class="gallery-nav gallery-next" aria-label="Next image">' + ICON_NEXT + '</button>' +
      '<div class="gallery-footer">' +
      '  <p class="gallery-title"></p>' +
      '  <p class="gallery-count"></p>' +
      '</div>';
    document.body.appendChild(gallery);

    el.gallery = gallery;
    el.stage = gallery.querySelector(".gallery-stage");
    el.image = gallery.querySelector(".gallery-image");
    el.status = gallery.querySelector(".gallery-status");
    el.title = gallery.querySelector(".gallery-title");
    el.count = gallery.querySelector(".gallery-count");
    el.close = gallery.querySelector(".gallery-close");
    el.prev = gallery.querySelector(".gallery-prev");
    el.next = gallery.querySelector(".gallery-next");
  }

  // ===================== IMAGES =====================

  function setStatus(text, isError) {
    el.status.textContent = text;
    el.status.classList.toggle("is-error", !!isError);
    el.status.hidden = !text;
  }

  // An image is { full, medium } (medium may be null) or a plain URL.
  function item(index) {
    var img = state.images[index];
    return typeof img === "string" ? { full: img, medium: null } : img;
  }

  function prefetch(index) {
    var n = state.images.length;
    if (n < 2) return;
    [index + 1, index - 1].forEach(function (i) {
      var next = item((i + n) % n);
      var img = new Image();
      img.src = next.medium || next.full;
    });
  }

  // Progressive renders: the medium copy is shown first (fast to open and light to keep
  // on screen); as soon as it is up, the original is fetched and decoded in the background.
  // Zooming past 1x shows the original (exactly as sharp as before), back at 1x the medium.
  var shown = null; // { index, full, medium, fullReady, fullFailed, showing }

  function showSource(which) {
    if (!shown || shown.showing === which) return;
    if (which === "full") {
      // Keep the laid-out box exactly as it is, so swapping the source can't move the
      // zoomed image even if the two files' natural sizes fit the stage differently.
      // The copy's rounded pixel size can differ from the original's aspect by a hair: keep
      // the constraining side and derive the other from the original, as its own fit would.
      var box = zoom.box();
      var aspect = shown.preloaded ? shown.preloaded.naturalWidth / shown.preloaded.naturalHeight : box.w / box.h;
      var w = box.w, h = box.h;
      if (w / h > aspect) w = h * aspect;
      else h = w / aspect;
      el.image.style.width = w + "px";
      el.image.style.height = h + "px";
    }
    shown.showing = which;
    el.image.src = which === "full" ? shown.full : shown.medium;
    if (which === "medium") {
      el.image.style.width = "";
      el.image.style.height = "";
    }
  }

  function preloadFull(current) {
    var img = new Image();
    img.src = current.full;
    (img.decode ? img.decode() : Promise.resolve()).then(function () {
      if (shown !== current) return;
      current.fullReady = true;
      current.preloaded = img; // keeps the decoded original around while this render is open
      if (zoom.isZoomed()) showSource("full");
    }).catch(function () {
      if (shown !== current) return;
      current.fullFailed = true;
      console.error("Full-resolution render failed to load: " + decodeURIComponent(current.full));
    });
  }

  function render() {
    var index = state.index;
    var src = item(index);

    shown = null; // the zoom reset below must not swap the previous image
    zoom.reset();
    el.image.style.width = "";
    el.image.style.height = "";

    var heading = state.context ? state.title + " · " + state.context : state.title;
    // Each part stays on one line; on narrow screens the floor wraps under the room as "· Floor".
    el.title.textContent = "";
    var roomPart = document.createElement("span");
    roomPart.className = "gallery-title-part";
    roomPart.textContent = state.title;
    el.title.appendChild(roomPart);
    if (state.context) {
      var floorPart = document.createElement("span");
      floorPart.className = "gallery-title-part";
      floorPart.textContent = "· " + state.context;
      el.title.appendChild(document.createTextNode(" "));
      el.title.appendChild(floorPart);
    }
    el.count.textContent = (index + 1) + " / " + state.images.length;
    el.image.alt = heading + " " + (index + 1);
    el.image.hidden = true;
    setStatus("Loading", false);

    var current = { index: index, full: src.full, medium: src.medium, fullReady: !src.medium, fullFailed: false, showing: src.medium ? "medium" : "full" };
    var appeared = false;
    shown = current;

    el.image.onload = function () {
      if (shown !== current || appeared) return;
      appeared = true;
      el.image.hidden = false;
      setStatus("", false);
      prefetch(index);
      if (current.medium) preloadFull(current);
    };
    el.image.onerror = function () {
      if (shown !== current || !state.isOpen) return;
      // A missing medium copy falls back to the original; only the original's failure is shown.
      if (current.showing === "medium" && !appeared) {
        console.error("Medium render failed to load, using the original: " + decodeURIComponent(current.medium));
        current.medium = null;
        current.fullReady = true;
        current.showing = "full";
        el.image.src = current.full;
        return;
      }
      if (appeared) {
        // The original failed while zoomed: stay on the medium copy.
        current.fullFailed = true;
        current.fullReady = false;
        showSource("medium");
        return;
      }
      var path = decodeURIComponent(current.full);
      setStatus("Could not load image: " + path, true);
      console.error("Image failed to load: " + path);
    };
    el.image.src = current.medium || current.full;
  }

  function onZoomChange(zoomed) {
    if (!shown || !shown.medium) return;
    if (zoomed && shown.fullReady && !shown.fullFailed) showSource("full");
    else if (!zoomed) showSource("medium");
  }

  function open(title, images, context) {
    if (!images || !images.length) return;
    state.images = images;
    state.title = title;
    state.context = context || "";
    state.index = 0;
    state.isOpen = true;
    render();
    el.gallery.classList.add("is-open");
    document.body.style.overflow = "hidden";
    THDHistory.open(close);
  }

  function close() {
    if (!state.isOpen) return;
    state.isOpen = false;
    shown = null;
    zoom.reset();
    el.gallery.classList.remove("is-open");
    document.body.style.overflow = "";
    el.image.onload = el.image.onerror = null;
    el.image.removeAttribute("src");
    el.image.style.width = "";
    el.image.style.height = "";
    setStatus("", false);
    THDHistory.close();
  }

  function showNext() {
    state.index = (state.index + 1) % state.images.length;
    render();
  }

  function showPrev() {
    state.index = (state.index - 1 + state.images.length) % state.images.length;
    render();
  }

  function bind() {
    el.close.addEventListener("click", close);
    el.next.addEventListener("click", showNext);
    el.prev.addEventListener("click", showPrev);

    document.addEventListener("keydown", function (e) {
      if (!state.isOpen) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") showNext();
      else if (e.key === "ArrowLeft") showPrev();
    });

    // Rotation changes the fit size, so zoom restarts. Height-only resizes (mobile
    // address bar showing/hiding) just re-clamp, so they don't interrupt a pan.
    var lastWidth = window.innerWidth;
    window.addEventListener("resize", function () {
      if (!state.isOpen) return;
      if (window.innerWidth !== lastWidth) {
        zoom.reset();
      } else if (!zoom.isZoomed()) {
        zoom.invalidate(); // stage height changed: re-measure on the next zoom
      } else {
        zoom.apply();
      }
      lastWidth = window.innerWidth;
    });

    // Tap outside the image (on the stage backdrop) closes the gallery.
    zoom = THDZoom.create({
      surface: el.stage,
      content: el.image,
      marks: [el.image, el.stage, el.gallery],
      gestureRoot: el.gallery,
      viewport: function () {
        return { x: 0, y: 0, w: el.gallery.clientWidth, h: el.gallery.clientHeight };
      },
      ready: function () { return state.isOpen && !el.image.hidden; },
      onSwipe: function (dir) {
        if (dir > 0) showNext();
        else showPrev();
      },
      onTapOutside: close,
      onZoomChange: onZoomChange
    });
  }

  window.THDGallery = {
    init: function () {
      build();
      bind();
    },
    open: open,
    close: close
  };
})();
