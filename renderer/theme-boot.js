// Applies the saved theme to <html> before the first paint.
//
// Loaded synchronously in the head of index.html, ahead of renderer.js. The
// alternative — letting renderer.js resolve settings over IPC and set the
// theme on DOMContentLoaded — shows one frame of the default palette on every
// launch, which on a light theme is a full-window flash.
(function () {
  try {
    var settings = window.api.settingsSync();
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = window.api.resolveTheme(settings, dark);
  } catch (_) {
    // Losing this costs the chosen theme, not the app: the tokens in
    // colors.css are a complete working palette on their own.
  }
})();
