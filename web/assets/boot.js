// Runs before first paint so the page never flashes the wrong theme.
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('fleet.theme') || 'system'; } catch (e) { /* ignore */ }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
