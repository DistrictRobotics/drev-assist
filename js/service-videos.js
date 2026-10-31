/**
 * Extracted from an inline <script> in index.html so the CSP can keep
 * script-src 'self' (no 'unsafe-inline'). Loaded at the same position,
 * so execution order is unchanged.
 */
/* Force-play all service card videos — iOS blocks multiple autoplay, so we
   trigger .play() after first user interaction and again via IntersectionObserver */
(function(){
  var videos = Array.from(document.querySelectorAll('.svc-card-video'));
  function playAll(){
    videos.forEach(function(v){
      if(v.tagName!=='VIDEO')return;
      v.play().catch(function(){});
    });
  }
  // Attempt immediate play (works on Android / desktop)
  playAll();
  // On first touch/click unlock iOS audio context and retry
  document.addEventListener('touchstart', playAll, {once:true, passive:true});
  document.addEventListener('click', playAll, {once:true});
  // IntersectionObserver: play when card scrolls into view, pause when out
  if('IntersectionObserver' in window){
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        var v = e.target.querySelector('.svc-card-video');
        if(!v || v.tagName!=='VIDEO')return;
        if(e.isIntersecting){ v.play().catch(function(){}); }
        else { v.pause(); }
      });
    },{threshold:0.1});
    document.querySelectorAll('.svc-card').forEach(function(c){ io.observe(c); });
  }
})();
