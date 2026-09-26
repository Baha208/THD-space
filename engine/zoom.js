/* ===== THD Studio engine — pinch / double-tap / wheel zoom =====
   Shared by the render gallery (gallery.js) and the drawing viewer (pdf-view.js), so both
   zoom the same way. Zoom is a CSS transform on one content element (a render, or the
   stack of PDF pages); the page viewport is never zoomed.

   Touch: pinch, double-tap. Mouse: wheel, double-click. Max 4x. While zoomed in, a
   one-finger / mouse drag pans, clamped so the content keeps covering the viewport on each
   axis where it is larger than it (and stays centred where it is not).

   THDZoom.create(options) → { reset, apply, invalidate, isZoomed }
     surface      element that receives the gestures (gallery stage, PDF scroller)
     content      element that is transformed
     marks        elements that get .is-zoomed while zoomed in (content, surface, overlay…)
     gestureRoot  element on which iOS's own page pinch (gesturestart) is blocked
     viewport()   { x, y, w, h } visible area in client coordinates
     measure()    optional: content's untransformed box { cx, cy, w, h }; called every time.
                  Default: measured once while untransformed, until reset()/invalidate().
     ready()      optional: false while there is nothing to zoom (still loading, failed)
     wheel        "zoom" (default: wheel always zooms) or "scroll" (wheel scrolls; Ctrl+wheel
                  and trackpad pinch zoom; wheel pans while zoomed in)
     onSwipe(dir) optional: 1x one-finger horizontal swipe; dir 1 = next, -1 = previous
     onTapOutside optional: tap/click that starts and ends on the surface itself
     onRest(dx,dy) optional: when back at 1x, the content keeps its pan offset on axes where
                  it is larger than the viewport, then this is called with that offset (after
                  the zoom-out animation) and it is cleared: the owner scrolls by it instead.
     onSettle(scale) optional: a gesture or animation finished at this scale
     onZoomChange(zoomed) optional: zoom went from 1x to zoomed in, or back */
(function () {
  "use strict";

  var SWIPE_THRESHOLD = 40;
  var TAP_TOLERANCE = 10;
  var DOUBLE_TAP_MS = 300;
  var DOUBLE_TAP_DISTANCE = 30;
  var MAX_SCALE = 4;
  var DOUBLE_TAP_SCALE = 2.5;
  var ZOOMED = 1.01;
  var ANIMATION_MS = 260; // .zoom-animate transition (0.25s) plus a frame
  var WHEEL_SETTLE_MS = 200;

  function create(opts) {
    var surface = opts.surface;
    var content = opts.content;
    var ready = opts.ready || function () { return true; };

    // mode: null | "free" (1x: swipe or native scroll) | "pan" | "pinch"
    var touch = { mode: null, startX: 0, startY: 0, moved: false, lastTapTime: 0, lastTapX: 0, lastTapY: 0, lastTouchTime: 0 };
    var zoom = { scale: 1, x: 0, y: 0 };
    var gesture = { startScale: 1, startX: 0, startY: 0, startDist: 0, midX: 0, midY: 0 };
    var mouse = { panning: false, startX: 0, startY: 0, dragged: false, suppressClick: false, pressTarget: null };
    var restTimer = null;
    var wasZoomed = false;
    var settleTimer = null;

    function isZoomed() {
      return zoom.scale > ZOOMED;
    }

    // The content's fit-to-viewport box in client coordinates, measured (sub-pixel) while
    // it is untransformed at 1x and kept until the content or the screen width changes.
    var base = null;
    function baseBox() {
      if (opts.measure) return opts.measure();
      if (!base) {
        var r = content.getBoundingClientRect();
        base = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
      }
      return base;
    }

    // Keep the zoomed content covering the viewport on each axis where it is larger than
    // the viewport, and centred on its fit position where it is not.
    function clampPan() {
      var b = baseBox();
      var v = opts.viewport();
      var w = b.w * zoom.scale;
      var h = b.h * zoom.scale;
      zoom.x = w <= v.w ? 0 : Math.min(v.x + w / 2 - b.cx, Math.max(v.x + v.w - w / 2 - b.cx, zoom.x));
      zoom.y = h <= v.h ? 0 : Math.min(v.y + h / 2 - b.cy, Math.max(v.y + v.h - h / 2 - b.cy, zoom.y));
    }

    function settle() {
      if (opts.onSettle) opts.onSettle(zoom.scale);
    }

    // Back at 1x with a leftover pan offset: hand it to the owner and clear it.
    function rest() {
      restTimer = null;
      var dx = zoom.x;
      var dy = zoom.y;
      zoom.x = 0;
      zoom.y = 0;
      content.classList.remove("zoom-animate");
      content.style.transform = "";
      opts.onRest(dx, dy);
    }

    function applyZoom(animate) {
      clearTimeout(restTimer);
      restTimer = null;
      if (zoom.scale <= ZOOMED) {
        zoom.scale = 1;
        if (opts.onRest) {
          clampPan();
        } else {
          zoom.x = 0;
          zoom.y = 0;
        }
      } else {
        clampPan();
      }
      content.classList.toggle("zoom-animate", !!animate);
      content.style.transform = zoom.scale === 1 && !zoom.x && !zoom.y ? "" : "translate(" + zoom.x + "px, " + zoom.y + "px) scale(" + zoom.scale + ")";
      var zoomed = isZoomed();
      opts.marks.forEach(function (node) {
        node.classList.toggle("is-zoomed", zoomed);
      });
      if (zoomed !== wasZoomed) {
        wasZoomed = zoomed;
        if (opts.onZoomChange) opts.onZoomChange(zoomed);
      }
      if (zoom.scale === 1 && (zoom.x || zoom.y) && opts.onRest) {
        if (animate) restTimer = setTimeout(rest, ANIMATION_MS);
        else rest();
      }
    }

    // Scale to `scale`, keeping the content point under client point (px, py) fixed.
    function zoomAt(px, py, scale, animate) {
      if (!ready()) return;
      var b = baseBox();
      var next = Math.max(1, Math.min(MAX_SCALE, scale));
      var ratio = next / zoom.scale;
      zoom.x = px - b.cx - (px - b.cx - zoom.x) * ratio;
      zoom.y = py - b.cy - (py - b.cy - zoom.y) * ratio;
      zoom.scale = next;
      applyZoom(animate);
    }

    function reset() {
      clearTimeout(settleTimer);
      zoom.scale = 1;
      zoom.x = 0;
      zoom.y = 0;
      applyZoom(false);
      base = null;
    }

    function toggleZoomAt(px, py) {
      if (isZoomed()) {
        zoom.scale = 1;
        applyZoom(true);
      } else {
        zoomAt(px, py, DOUBLE_TAP_SCALE, true);
      }
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, ANIMATION_MS);
    }

    // ===================== TOUCH =====================

    function distance(a, b) {
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }

    function startPinch(t) {
      touch.mode = "pinch";
      gesture.startScale = zoom.scale;
      gesture.startX = zoom.x;
      gesture.startY = zoom.y;
      gesture.startDist = Math.max(1, distance(t[0], t[1]));
      gesture.midX = (t[0].clientX + t[1].clientX) / 2;
      gesture.midY = (t[0].clientY + t[1].clientY) / 2;
    }

    function startSingle(t) {
      touch.mode = isZoomed() ? "pan" : "free";
      touch.startX = t.clientX;
      touch.startY = t.clientY;
      touch.moved = false;
      gesture.startX = zoom.x;
      gesture.startY = zoom.y;
    }

    function isContent(target) {
      return target === content || content.contains(target);
    }

    surface.addEventListener("touchstart", function (e) {
      touch.lastTouchTime = Date.now();
      if (e.touches.length === 2) {
        e.preventDefault();
        if (!ready()) touch.mode = null;
        else startPinch(e.touches);
      } else if (e.touches.length === 1) {
        startSingle(e.touches[0]);
      } else {
        touch.mode = null;
      }
    }, { passive: false });

    surface.addEventListener("touchmove", function (e) {
      if (touch.mode === "pinch" && e.touches.length === 2) {
        e.preventDefault();
        var t = e.touches;
        var midX = (t[0].clientX + t[1].clientX) / 2;
        var midY = (t[0].clientY + t[1].clientY) / 2;
        var scale = Math.max(1, Math.min(MAX_SCALE, gesture.startScale * distance(t[0], t[1]) / gesture.startDist));
        // Keep the content point that was under the fingers' start midpoint under the current midpoint.
        var b = baseBox();
        var ux = (gesture.midX - b.cx - gesture.startX) / gesture.startScale;
        var uy = (gesture.midY - b.cy - gesture.startY) / gesture.startScale;
        zoom.scale = scale;
        zoom.x = midX - b.cx - ux * scale;
        zoom.y = midY - b.cy - uy * scale;
        applyZoom(false);
        touch.moved = true;
      } else if (touch.mode === "pan" && e.touches.length === 1) {
        e.preventDefault();
        var dx = e.touches[0].clientX - touch.startX;
        var dy = e.touches[0].clientY - touch.startY;
        if (Math.abs(dx) > TAP_TOLERANCE || Math.abs(dy) > TAP_TOLERANCE) touch.moved = true;
        zoom.x = gesture.startX + dx;
        zoom.y = gesture.startY + dy;
        applyZoom(false);
      }
    }, { passive: false });

    surface.addEventListener("touchend", function (e) {
      touch.lastTouchTime = Date.now();
      var mode = touch.mode;

      if (mode === "pinch") {
        // Lifting one finger of a pinch continues as a pan with the other; never a swipe or tap.
        if (e.touches.length === 1) {
          startSingle(e.touches[0]);
          touch.mode = isZoomed() ? "pan" : null;
          touch.moved = true;
          if (!touch.mode) settle(); // pinched back to 1x: the zoom is over
        } else if (e.touches.length === 0) {
          touch.mode = null;
          applyZoom(false);
          settle();
        }
        return;
      }
      if (!mode || e.touches.length) return;
      touch.mode = null;

      var end = e.changedTouches[0];
      var deltaX = end.clientX - touch.startX;
      var deltaY = end.clientY - touch.startY;

      if (mode === "pan" && touch.moved) {
        settle();
        return;
      }

      // Swipe to navigate only at fit-to-screen.
      if (mode === "free" && opts.onSwipe && Math.abs(deltaX) > SWIPE_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY)) {
        opts.onSwipe(deltaX < 0 ? 1 : -1);
        return;
      }

      if (Math.abs(deltaX) < TAP_TOLERANCE && Math.abs(deltaY) < TAP_TOLERANCE) {
        if (isContent(e.target)) {
          var now = Date.now();
          var isDouble = now - touch.lastTapTime < DOUBLE_TAP_MS &&
            Math.hypot(end.clientX - touch.lastTapX, end.clientY - touch.lastTapY) < DOUBLE_TAP_DISTANCE;
          if (isDouble) {
            e.preventDefault(); // no synthetic click/dblclick, no browser double-tap zoom
            touch.lastTapTime = 0;
            toggleZoomAt(end.clientX, end.clientY);
          } else {
            touch.lastTapTime = now;
            touch.lastTapX = end.clientX;
            touch.lastTapY = end.clientY;
          }
        } else if (e.target === surface && opts.onTapOutside) {
          opts.onTapOutside();
        }
      }
    });

    // The browser may take over a gesture that ends at 1x (touch-action: pan-y) and
    // cancel it instead of ending it: that still finishes the zoom.
    surface.addEventListener("touchcancel", function () {
      var mode = touch.mode;
      touch.mode = null;
      applyZoom(false);
      if (mode === "pinch" || mode === "pan") settle();
    });

    // iOS Safari ignores user-scalable=no; stop its page pinch-zoom here.
    opts.gestureRoot.addEventListener("gesturestart", function (e) {
      e.preventDefault();
    });

    // ===================== MOUSE =====================

    function recentTouch() {
      return Date.now() - touch.lastTouchTime < 800;
    }

    surface.addEventListener("wheel", function (e) {
      if (!ready()) return;
      var lines = e.deltaMode === 1;
      if (opts.wheel === "scroll" && !e.ctrlKey) {
        if (!isZoomed()) return; // native scroll
        e.preventDefault();
        var k = lines ? 16 : 1;
        zoom.x -= e.deltaX * k;
        zoom.y -= e.deltaY * k;
        applyZoom(false);
      } else {
        e.preventDefault();
        var step = lines ? 0.05 : 0.0015; // lines vs pixels
        // Trackpad pinch arrives as Ctrl+wheel with small deltas; make it as responsive as a pinch.
        if (e.ctrlKey && !lines) step = 0.01;
        zoomAt(e.clientX, e.clientY, zoom.scale * Math.exp(-e.deltaY * step), false);
      }
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, WHEEL_SETTLE_MS);
    }, { passive: false });

    content.addEventListener("dblclick", function (e) {
      if (recentTouch()) return;
      e.preventDefault();
      toggleZoomAt(e.clientX, e.clientY);
    });

    surface.addEventListener("pointerdown", function (e) {
      mouse.pressTarget = e.target;
      if (e.pointerType !== "mouse" || e.button !== 0 || !isZoomed()) return;
      mouse.panning = true;
      mouse.dragged = false;
      mouse.startX = e.clientX;
      mouse.startY = e.clientY;
      gesture.startX = zoom.x;
      gesture.startY = zoom.y;
      e.preventDefault();
    });

    surface.addEventListener("pointermove", function (e) {
      if (!mouse.panning) return;
      var dx = e.clientX - mouse.startX;
      var dy = e.clientY - mouse.startY;
      // Capture only once it is really a drag, so plain clicks and double-clicks
      // on the zoomed content still target the content.
      if (!mouse.dragged && (Math.abs(dx) > TAP_TOLERANCE || Math.abs(dy) > TAP_TOLERANCE)) {
        mouse.dragged = true;
        surface.setPointerCapture(e.pointerId);
        surface.classList.add("is-panning");
      }
      if (!mouse.dragged) return;
      zoom.x = gesture.startX + dx;
      zoom.y = gesture.startY + dy;
      applyZoom(false);
    });

    function endPan() {
      if (!mouse.panning) return;
      mouse.panning = false;
      surface.classList.remove("is-panning");
      // A drag that ends over the backdrop must not count as a click-to-close.
      if (mouse.dragged) {
        mouse.suppressClick = true;
        setTimeout(function () { mouse.suppressClick = false; }, 0);
        settle();
      }
    }
    surface.addEventListener("pointerup", endPan);
    surface.addEventListener("pointercancel", endPan);

    // The press must start on the surface too: while zoomed, the pan's pointer capture
    // retargets a click that began on the content to the surface.
    if (opts.onTapOutside) {
      surface.addEventListener("click", function (e) {
        if (mouse.suppressClick) return;
        if (e.target === surface && mouse.pressTarget === surface) opts.onTapOutside();
      });
    }

    return {
      reset: reset,
      apply: function () { applyZoom(false); },
      invalidate: function () { base = null; },
      isZoomed: isZoomed,
      scale: function () { return zoom.scale; },
      box: baseBox // content's untransformed box (valid mid-animation, unlike getBoundingClientRect)
    };
  }

  window.THDZoom = { create: create };
})();
