/* ===== THD Studio engine — back button closes the open overlay =====
   The render gallery and the drawing viewer are full-screen overlays inside one page, so
   Android's back button / gesture (and iOS Safari's swipe back) would leave the page or
   exit the installed app. Opening an overlay pushes a history entry; going back pops it and
   closes the overlay instead.

   THDHistory.open(onBack)  call when an overlay opens; onBack() must close it
   THDHistory.close()       call from the overlay's own close (×, Escape, backdrop, and
                            onBack itself). If the entry is still there it is removed with
                            history.back(), so no dangling entry needs a second back press;
                            the popstate that causes is recognised and ignored.

   One overlay is open at a time. */
(function () {
  "use strict";

  var KEY = "thdOverlay";
  var current = null;      // { onBack, pushed } of the open overlay
  var pendingBack = false; // our own history.back() whose popstate hasn't arrived yet

  function push() {
    var state = {};
    state[KEY] = true;
    history.pushState(state, "");
    current.pushed = true;
  }

  function open(onBack) {
    current = { onBack: onBack, pushed: false };
    // Opened again before our last history.back() landed: push once it has.
    if (!pendingBack) push();
  }

  function close() {
    if (!current) return; // already closed by the back button
    var pushed = current.pushed;
    current = null;
    if (pushed && history.state && history.state[KEY]) {
      pendingBack = true;
      history.back();
    }
  }

  window.addEventListener("popstate", function () {
    if (pendingBack) {
      pendingBack = false;
      if (current && !current.pushed) push();
      return;
    }
    if (!current) return;
    var onBack = current.onBack;
    current = null; // the entry is already gone: close() must not go back again
    onBack();
  });

  // A reload while an overlay was open leaves its entry current, with nothing open.
  if (history.state && history.state[KEY]) history.replaceState(null, "");

  window.THDHistory = { open: open, close: close };
})();
