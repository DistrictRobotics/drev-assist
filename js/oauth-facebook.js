/**
 * Extracted from an inline <script> in index.html so the CSP can keep
 * script-src 'self' (no 'unsafe-inline'). Loaded at the same position,
 * so execution order is unchanged.
 */
(function() {
  var WORKER = 'https://drev-instagram.wtdc202.workers.dev';
  var RETURN_URL = 'https://assist.drev.space';
  document.getElementById('assist-fb-login')?.addEventListener('click', function() {
    window.location.href = WORKER + '/auth/facebook?return=' + encodeURIComponent(RETURN_URL);
  });
  // Handle OAuth return
  var p = new URLSearchParams(location.search);
  if (p.get('auth_success') === '1') {
    var name = p.get('auth_name') || 'User';
    var sid = p.get('session_id');
    if (sid) {
      try { localStorage.setItem('assist_session_id', sid); } catch(e) {}
      try { localStorage.setItem('assist_session_name', name); } catch(e) {}
    }
    history.replaceState(null, '', location.pathname);
    var el = document.getElementById('assist-fb-user');
    if (el) { el.textContent = '✓ Signed in as ' + name; el.hidden = false; }
    var btn = document.getElementById('assist-fb-login');
    if (btn) btn.textContent = 'Signed in — ' + name;
  }
})();
