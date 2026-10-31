/**
 * Extracted from an inline <script> in index.html so the CSP can keep
 * script-src 'self'. Guards on DrevAuth being present: the remote auth
 * script is a cross-origin load that our CSP does not allow.
 */
(function () {
  if (!window.DrevAuth) return; // cross-site auth lib blocked/unavailable — profile link stays plain
  DrevAuth.on('login', function (s) {
    var el = document.getElementById('assist-profile-link');
    if (el) el.textContent = '👤 ' + s.name.split(' ')[0];
  });
  DrevAuth.init();
})();
