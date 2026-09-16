// Registers the service worker and makes sure a new version actually gets
// used, instead of a phone sitting on an old cached copy indefinitely.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    // Ask the browser to check for a newer sw.js straight away, and again
    // every time the app is reopened/brought back to the foreground —
    // phones don't reliably check on their own for a while.
    reg.update();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update();
    });
  }).catch(() => {});

  // The new service worker (sw.js) calls skipWaiting()/clients.claim() on
  // install/activate, so once it takes over, this fires — reload once so
  // the page actually starts using the new cached files instead of the
  // old ones it already loaded.
  let alreadyRefreshed = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (alreadyRefreshed) return;
    alreadyRefreshed = true;
    window.location.reload();
  });
}
