/*
 * Web edition: gives the shared UI the same `Native` object the Android / iOS apps have.
 *
 * How data gets in (nothing ever goes through a server):
 *  1. The user opens food.aut.ac.ir in their own browser and signs in.
 *  2. They tap the AutWeek bookmark ("connector"). It runs bridge-xxxx.js INSIDE the site's page
 *     (same origin, the user's own session) and opens this app in a new tab.
 *  3. This tab asks the site tab for the data with window.postMessage and only accepts answers that come
 *     from https://food.aut.ac.ir and from the tab that opened it.
 */
(function () {
  var FOOD = 'https://food.aut.ac.ir';
  var KEY = 'aut-weekly-planner-web-state';
  var ua = navigator.userAgent || '';
  var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  var isBridge = false;
  try { isBridge = !!window.opener && /(^|[?&])bridge=/.test(location.search); } catch (e) {}
  if (isBridge) { try { history.replaceState(null, '', location.pathname); } catch (e) {} }

  var timer = null, gotReply = false;
  function emit(ev) { if (typeof window.onNative === 'function') window.onNative(ev); }
  function watchdog(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () {
      emit({ t: 'error', code: 'NETWORK', msg: 'میان‌بر در صفحهٔ سایت پاسخ نداد. تب سایت رزرو را بررسی کنید و دوباره میان‌بر را بزنید.' });
    }, ms);
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== FOOD || !window.opener || e.source !== window.opener) return;
    var d = e.data;
    if (!d || d.aw !== 1) return;
    gotReply = true;
    watchdog(90000);
    if (d.t === 'progress') emit({ t: 'progress', msg: String(d.msg || ''), web: true });
    else if (d.t === 'result') { clearTimeout(timer); emit({ t: 'done', data: d.data || {} }); }
    else if (d.t === 'error') { clearTimeout(timer); emit({ t: 'error', code: String(d.code || 'FAIL'), msg: String(d.msg || '') }); }
  });

  function ascii(s) {
    return s.replace(/[^\x00-\x7f]/g, function (c) { return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4); });
  }

  window.Native = {
    web: true,
    getState: function () { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } },
    setState: function (s) { try { localStorage.setItem(KEY, String(s)); } catch (e) {} },
    version: function () { return '0.3 (web)'; },
    platform: function () { return ios ? 'ios' : 'android'; },
    setTheme: function () {},
    bridgeMode: function () { return isBridge; },
    openLogin: function (u) { try { window.open(String(u || FOOD + '/'), '_blank'); } catch (e) {} },
    startSync: function (j) {
      if (!isBridge || !window.opener) {
        emit({ t: 'error', code: 'NOBRIDGE', msg: 'برای به‌روزرسانی، میان‌بر را در صفحهٔ سایت رزرو بزنید.' });
        return;
      }
      var places = [];
      try { places = JSON.parse(j); } catch (e) {}
      // the connector may still be loading in the site tab, so ask again until it answers
      var tries = 0;
      (function hello() {
        if (gotReply || ++tries > 30) return;
        try { window.opener.postMessage({ aw: 1, t: 'hello', places: places }, FOOD); } catch (e) {}
        setTimeout(hello, 800);
      })();
      watchdog(25000);
    },
    analyze: function () { emit({ t: 'error', code: 'FAIL', msg: 'تحلیل ساختار فقط در اپ اندروید ممکن است.' }); },
    logout: function () {},
    // the bookmark (javascript: URL) that loads the connector, pinned to its exact content with SRI
    bridgeCode: function () {
      var m = document.querySelector('meta[name="aw-bridge"]');
      if (!m) return '';
      var src = new URL(m.getAttribute('content'), location.href).href;
      var sri = m.getAttribute('data-sri') || '';
      var baseUrl = src.replace(/[^\/]*$/, '');
      var js = "(function(){var w=window.open(" + JSON.stringify(baseUrl) + "+'?bridge='+Date.now(),'autweek-app');" +
        "if(!w){alert('AutWeek: the new tab was blocked. Allow pop-ups and try again.');return}window.__awW=w;" +
        "var s=document.createElement('script');s.src=" + JSON.stringify(src) +
        ";s.integrity=" + JSON.stringify(sri) + ";s.crossOrigin='anonymous';" +
        "s.onerror=function(){alert('AutWeek: connector failed to load. Make a new bookmark from the app.')};" +
        "(document.head||document.documentElement).appendChild(s)})();";
      return 'javascript:' + ascii(js);
    }
  };

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
