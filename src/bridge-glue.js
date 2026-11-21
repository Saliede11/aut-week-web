
/*
 * Connector glue. This file is appended to sync.js; the whole thing is loaded into the reservation site's page
 * by the user's bookmark. It talks only to the AutWeek app tab it opens itself.
 */
(function () {
  var cs = document.currentScript;
  var base = cs && cs.src ? cs.src.replace(/[^\/]*$/, '') : '';
  if (!base) return;
  var APP = new URL(base).origin;
  var IS_LIB = location.host === 'digitallib.aut.ac.ir', IS_LMS = location.host === 'courses.aut.ac.ir';
  if (location.host !== 'food.aut.ac.ir' && !IS_LIB && !IS_LMS) {
    alert('AutWeek: open the reservation site (food.aut.ac.ir), the library (digitallib.aut.ac.ir) or the course site (courses.aut.ac.ir) and sign in first.');
    return;
  }
  var TARGET = IS_LIB ? 'lib' : IS_LMS ? 'lms' : 'food';
  // the bookmark opens the app tab itself (inside the tap, so pop-up blockers allow it)
  var w = window.__awW || window.open(base + '?bridge=' + Date.now(), 'autweek-app');
  if (!w) { alert('AutWeek: the new tab was blocked. Allow pop-ups for this site and try again.'); return; }
  function send(o) { try { o.aw = 1; o.target = TARGET; w.postMessage(o, APP); } catch (e) {} }

  var started = false;
  window.addEventListener('message', function (e) {
    if (e.origin !== APP || e.source !== w || !e.data || e.data.aw !== 1 || e.data.t !== 'hello' || started) return;
    started = true;
    var list = (e.data.places || []).filter(function (p) {
      return p && isFinite(Number(p.group)) && isFinite(Number(p.rest));
    }).slice(0, 20).map(function (p) {
      return { id: String(p.id), type: String(p.type), name: String(p.name), group: Number(p.group), rest: Number(p.rest) };
    });
    if (IS_LIB) window.__runLibrary(); else if (IS_LMS) window.__runLms(); else window.__runSync(list);
    var n = 0;
    (function poll() {
      var r = window.__syncRes;
      if (r) {
        if (r.error) send({ t: 'error', code: r.error, msg: r.detail || '' });
        else send({ t: 'result', data: r });
        return;
      }
      send({ t: 'progress', msg: window.__syncProg ? 'در حال خواندن: ' + window.__syncProg : 'در حال خواندن رزروها…' });
      if (++n > 400) { send({ t: 'error', code: 'FAIL', msg: 'زمان به‌روزرسانی تمام شد' }); return; }
      setTimeout(poll, 800);
    })();
  });
})();
