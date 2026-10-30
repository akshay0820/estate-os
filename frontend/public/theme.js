// Resolve the theme before first paint to avoid a flash. Loaded as a file (not inline) so the Content-Security-Policy
// can allow scripts from 'self' only, with no hash to keep in step.
(function () {
  try {
    var saved = localStorage.getItem('estate-os:theme');
    var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
