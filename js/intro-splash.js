/**
 * Extracted from an inline <script> in index.html so the CSP can keep
 * script-src 'self' (no 'unsafe-inline'). Loaded at the same position,
 * so execution order is unchanged.
 */
(function(){
  var splash=document.getElementById('intro-splash');
  if(!splash)return;
  // dismiss after loader animation completes (1.6s delay + 1.8s duration = 3.4s) + short hold
  var t=setTimeout(function(){splash.classList.add('done');},3600);
  // also dismiss immediately if user taps/clicks
  splash.addEventListener('click',function(){clearTimeout(t);splash.classList.add('done');},{once:true});
})();
