/*
 * Runs inside the reservation site's own page (same origin, the user's own login session).
 * READ ONLY: only view endpoints are called (the same ones the site's week buttons use).
 *
 * Site facts (from the structure analysis report):
 *  - The server remembers which week the session is looking at. GetCurrentReservePage always
 *    resets to the current week; GetNextReservePage / GetPreReservePage move relative to the
 *    remembered week. So every place starts with GetCurrentReservePage and ends the run on it.
 *  - Every response contains the 7 Jalali dates of its week (#TopDateDiv), so a week is identified
 *    by its dates, never by guessing which week the server happened to return.
 *  - Summary table: td.summeryTd per (meal/session row x day); colour class background-<colour>
 *    and a tooltip ("خالی", "فرستاده نشده", "دریافت شده", ...).
 *  - Desktop view lists checkboxes per day/meal; a checked one is the food that is reserved.
 */
(function () {
  var ALLOWED = [
    '/Reserves/GetCurrentReservePage',
    '/Reserves/GetNextReservePage',
    '/Reserves/GetRestaurantByPersonGroup'
  ];

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  async function post(path, params) {
    if (ALLOWED.indexOf(path) < 0) throw new Error('BLOCKED ' + path);
    var r = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: new URLSearchParams(params).toString()
    });
    if (r.redirected && r.url.indexOf(location.host) < 0) throw new Error('LOGIN');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  }

  function findStr(v) {
    if (typeof v === 'string') return v.indexOf('summeryTable') >= 0 ? v : null;
    if (v && typeof v === 'object') {
      for (var k in v) { var f = findStr(v[k]); if (f) return f; }
    }
    return null;
  }
  function htmlOf(t) {
    if (t.indexOf('summeryTable') >= 0) return t;
    try { var f = findStr(JSON.parse(t)); if (f) return f; } catch (e) {}
    return t;
  }

  var DATE_RE = /(1[34]\d\d)\/(\d\d)\/(\d\d)/;

  // The 7 Jalali dates of the week, Saturday first, or null.
  function weekDates(doc) {
    var out = [];
    doc.querySelectorAll('#TopDateDiv .backWeek1').forEach(function (el) {
      var m = DATE_RE.exec(el.textContent);
      if (m) out.push(m[0]);
    });
    if (out.length !== 7) {
      out = [];
      doc.querySelectorAll('.PhoneView .dayContainer .date').forEach(function (el) {
        var m = DATE_RE.exec(el.textContent);
        if (m) out.push(m[0]);
      });
    }
    return out.length === 7 ? out : null;
  }

  // Foods that are ticked in the desktop view, keyed "date|meal name".
  function reservedFoods(doc) {
    var map = {};
    var dv = doc.querySelector('.DesktopView');
    if (!dv) return map;
    var names = [];
    dv.querySelectorAll('.reserveFoodMeal .TimeMeal').forEach(function (e) { names.push(clean(e.textContent)); });
    var blocks = dv.querySelectorAll('.WeekMeal');
    if (!names.length || blocks.length !== names.length * 7) return map;
    blocks.forEach(function (b, k) {
      var meal = names[Math.floor(k / 7)];
      var dm = DATE_RE.exec((b.querySelector('#DateDiv') || {}).textContent || '');
      if (!dm) return;
      b.querySelectorAll('input.reserveFoodCheckBox').forEach(function (cb) {
        if (!cb.hasAttribute('checked')) return;
        var wrap = cb.closest('.reserveFoodFoodDiv') || cb.parentElement;
        var lab = wrap && wrap.querySelector('label.reserveFoodCheckBox');
        if (!lab) return;
        var c = lab.cloneNode(true);
        c.querySelectorAll('span, label').forEach(function (x) { x.remove(); });
        var name = clean(c.textContent);
        if (!name) return;
        var key = dm[0] + '|' + meal;
        (map[key] = map[key] || []).push(name);
      });
    });
    return map;
  }

  // -> { dates, start, items } or null when the response has no reservation table.
  function parseWeek(text) {
    var doc = new DOMParser().parseFromString(htmlOf(text), 'text/html');
    var table = doc.querySelector('table.summeryTable');
    if (!table) return null;
    var dates = weekDates(doc);
    var foods = reservedFoods(doc);
    var items = [];
    table.querySelectorAll('tr').forEach(function (tr) {
      var lab = tr.querySelector('td.TimeMeal');
      if (!lab) return;
      var label = clean(lab.textContent);
      tr.querySelectorAll('td.summeryTd').forEach(function (td, i) {
        var tip = td.querySelector('.mytooltiptext');
        var tipText = tip ? clean(tip.textContent) : '';
        var colored = /background-/.test(td.className);
        if (!colored && (!tipText || tipText === 'خالی')) return;
        var it = { day: i, label: label, tip: tipText, cls: clean(td.className) };
        if (dates) {
          it.date = dates[i];
          var f = foods[dates[i] + '|' + label];
          if (f) it.food = f.join(' + ');
        }
        items.push(it);
      });
    });
    return { dates: dates, start: dates ? dates[0] : '', items: items };
  }

  window.__runSync = function (places) {
    window.__syncRes = null;
    window.__syncProg = '';
    (async function () {
      try {
        if (location.host.indexOf('food.aut.ac.ir') < 0) {
          window.__syncRes = { error: 'LOGIN', detail: 'صفحه فعلی: ' + location.host };
          return;
        }
        var res = { syncedAt: Date.now(), places: [], errors: [], weekStart: '' };
        var lastBase = null, lastGroup = null;
        for (var i = 0; i < places.length; i++) {
          var p = places[i];
          window.__syncProg = p.name;
          try {
            var base = { personGroupId: String(p.group), restId: String(p.rest), isKiosk: 'false' };
            lastBase = base;
            // same first step the site itself takes when a group is chosen
            if (lastGroup !== p.group) {
              await post('/Reserves/GetRestaurantByPersonGroup', { personGroupId: String(p.group) });
              lastGroup = p.group;
            }
            var t0 = await post('/Reserves/GetCurrentReservePage', base);
            var w0 = parseWeek(t0);
            if (w0 === null) throw new Error('NOTABLE ' + clean(t0).slice(0, 160));
            var t1 = await post('/Reserves/GetNextReservePage', base);
            var w1 = parseWeek(t1);
            if (w1 === null) throw new Error('NOTABLE ' + clean(t1).slice(0, 160));
            if (w0.start && w1.start && w0.start === w1.start) {
              throw new Error('هفتهٔ بعد با این هفته یکسان برگشت (' + w0.start + ')');
            }
            if (!res.weekStart && w0.start) res.weekStart = w0.start;
            res.places.push({
              id: p.id, type: p.type, name: p.name,
              weeks: [
                { offset: 0, start: w0.start, items: w0.items },
                { offset: 1, start: w1.start, items: w1.items }
              ]
            });
          } catch (e) {
            var m = String(e && e.message ? e.message : e);
            if (res.places.length === 0 && (m === 'LOGIN' || m.indexOf('NOTABLE') === 0) && i === 0) {
              window.__syncRes = { error: 'LOGIN', detail: m };
              return;
            }
            res.errors.push(p.name + ': ' + m);
          }
          await sleep(300);
        }
        // leave the site's own week view on the current week
        if (lastBase) {
          try { await post('/Reserves/GetCurrentReservePage', lastBase); } catch (e) {}
        }
        window.__syncRes = res;
      } catch (e) {
        window.__syncRes = { error: 'FAIL', detail: String(e && e.message ? e.message : e) };
      }
    })();
  };

  // exposed for offline tests only
  window.__parseWeek = parseWeek;
})();
