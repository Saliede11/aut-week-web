/*
 * Library sync. Runs inside the library site's own page (digitallib.aut.ac.ir, same origin, the user's own login).
 * READ ONLY. The only thing this script ever clicks is the site's «مدارک امانتی» menu item, which opens the
 * user's loan list (a plain GET request the site sends itself). It never calls any renew / delete / print function.
 *
 * Site facts (from the page code the user sent):
 *  - Loan list = table#LendDocsList; one tr per book with attributes title, barcode, doccopycode.
 *  - Columns (matched by their header text, not by position): عنوان مدرك, باركد, محل نگهداري (faculty / library branch),
 *    تاريخ (loan date), مدت (days), تاريخ بازگشت (due date), مدت تاخير, تعداد رزرو, ...
 *  - The list comes from ShowDetail_UserInfo.aspx as JSON {"arrayborrow":[{DocCopyCode, ...}]}; if it carries a
 *    renewal counter we pick it up, otherwise the app counts renewals itself.
 */
(function () {
  var DENY = /renew|extend|tamdid|delete|remove|cancel|reserve|borrow|lend|return|receipt|print|pay/i;
  var DATE_RE = /(1[34]\d\d)\/(\d\d)\/(\d\d)/;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  // the site writes Arabic yeh / kaf; the app uses Persian ones
  function norm(s) { return clean(String(s == null ? '' : s).replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/‌/g, ' ')); }
  function enDigits(s) {
    return String(s).replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06f0); })
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); });
  }

  function installHooks() {
    if (window.__libHooked) return;
    window.__libHooked = true;
    var xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__lm = String(m || 'GET').toUpperCase();
      this.__lu = String(u);
      if (this.__lm !== 'GET' && DENY.test(this.__lu)) throw new Error('BLOCKED (read-only)');
      return xo.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var x = this;
      if (/ShowDetail_UserInfo/i.test(x.__lu || '')) {
        x.addEventListener('load', function () {
          try { window.__libJson = JSON.parse(x.responseText); } catch (e) { window.__libJsonBad = String(x.responseText).slice(0, 300); }
        });
      }
      return xs.apply(this, arguments);
    };
    if (window.fetch) {
      var of = window.fetch;
      window.fetch = function (u, o) {
        var m = String((o && o.method) || (u && u.method) || 'GET').toUpperCase();
        var url = String(u && u.url ? u.url : u);
        if (m !== 'GET' && DENY.test(url)) return Promise.reject(new TypeError('Blocked (read-only)'));
        return of.apply(this, arguments);
      };
    }
  }

  function docs() {
    var out = [document];
    try {
      document.querySelectorAll('iframe,frame').forEach(function (f) {
        try { if (f.contentDocument) out.push(f.contentDocument); } catch (e) {}
      });
    } catch (e) {}
    return out;
  }
  function findTable() {
    var ds = docs();
    for (var i = 0; i < ds.length; i++) {
      var t = ds[i].querySelector('#LendDocsList');
      if (t) return t;
    }
    return null;
  }

  // the menu item that opens the loan list: smallest element whose whole text is «مدارک امانتی»
  function findMenu(skip) {
    var all = [];
    docs().forEach(function (d) {
      d.querySelectorAll('a,span,li,td,div,button,b,font,p').forEach(function (el) {
        if (norm(el.textContent) === 'مدارک امانتی' && !el.closest('#LendDocsList')) all.push(el);
      });
    });
    var deepest = all.filter(function (el) { return !all.some(function (o) { return o !== el && el.contains(o); }); });
    for (var i = 0; i < deepest.length; i++) if (skip.indexOf(deepest[i]) < 0) return deepest[i];
    return null;
  }
  function loginVisible() {
    var d = document;
    if (d.querySelector('input[type="password"]')) return true;
    return norm(d.body ? d.body.textContent : '').indexOf('ورود به سیستم') >= 0 && !findMenu([]);
  }

  async function waitFor(fn, ms) {
    var t = Date.now();
    while (Date.now() - t < ms) { var v = fn(); if (v) return v; await sleep(250); }
    return fn();
  }

  function colMap(tbl) {
    var head = tbl.querySelector('tr.HeadTable') || tbl.querySelector('tr');
    var map = {};
    if (!head) return map;
    Array.prototype.forEach.call(head.children, function (td, i) {
      var t = norm(td.textContent);
      if (t.indexOf('عنوان') >= 0) map.title = i;
      else if (t.indexOf('بارکد') >= 0) map.barcode = i;
      else if (t.indexOf('محل') >= 0) map.loc = i;
      else if (t.indexOf('تعداد رزرو') >= 0) map.resv = i;
      else if (t.indexOf('بازگشت') >= 0) map.due = i;
      else if (t.indexOf('تاخیر') >= 0) map.late = i;
      else if (t === 'تاریخ') map.loan = i;
      else if (t === 'مدت') map.period = i;
    });
    return map;
  }
  function cellText(tr, i) { return i == null || !tr.children[i] ? '' : norm(tr.children[i].textContent); }
  function dateIn(s) { var m = DATE_RE.exec(enDigits(s)); return m ? m[0] : ''; }

  function parseTable(tbl) {
    var cm = colMap(tbl), books = [];
    tbl.querySelectorAll('tr').forEach(function (tr) {
      if (tr.classList.contains('HeadTable')) return;
      var id = tr.getAttribute('doccopycode') || '';
      if (!id && !tr.getAttribute('barcode')) return;
      var due = dateIn(cellText(tr, cm.due));
      var title = norm(tr.getAttribute('title') || cellText(tr, cm.title));
      if (!title && !due) return;
      var days = parseInt(enDigits(cellText(tr, cm.period)), 10);
      var resv = parseInt(enDigits(cellText(tr, cm.resv)), 10);
      books.push({
        id: id || tr.getAttribute('barcode'),
        title: title,
        barcode: tr.getAttribute('barcode') || cellText(tr, cm.barcode),
        loc: cellText(tr, cm.loc),
        loan: dateIn(cellText(tr, cm.loan)),
        days: isFinite(days) ? days : null,
        due: due,
        late: cellText(tr, cm.late),
        resv: isFinite(resv) ? resv : 0,
        rc: null
      });
    });
    return books;
  }

  // renewal counter from the JSON the site itself loaded (field name is detected, not assumed)
  function addRenewCounts(books, res) {
    var j = window.__libJson;
    if (!j || typeof j !== 'object') return;
    var arr = j.arrayborrow || j.ArrayBorrow || null;
    if (!Array.isArray(arr)) return;
    if (arr[0] && typeof arr[0] === 'object') res.jsonKeys = Object.keys(arr[0]).slice(0, 60);
    var byId = {};
    arr.forEach(function (o) { if (o && o.DocCopyCode != null) byId[String(o.DocCopyCode)] = o; });
    books.forEach(function (b) {
      var o = byId[b.id];
      if (!o) return;
      for (var k in o) {
        if (/renew|tamdid|extend/i.test(k) && /^\d{1,3}$/.test(String(o[k]).trim())) {
          b.rc = parseInt(o[k], 10);
          res.renewKey = k;
          break;
        }
      }
    });
  }

  window.__runLibrary = function () {
    window.__syncRes = null;
    window.__syncProg = 'در حال باز شدن کتابخانه';
    (async function () {
      try {
        if (location.host.indexOf('digitallib.aut.ac.ir') < 0) {
          window.__syncRes = { error: 'LOGIN', detail: 'صفحه فعلی: ' + location.host };
          return;
        }
        installHooks();
        window.__libJson = null;
        var tbl = await waitFor(function () { return findTable() || findMenu([]); }, 20000);
        var clicked = [];
        if (tbl && tbl.tagName !== 'TABLE') {
          // menu found, table not there yet: open the loan list the way the user would
          window.__syncProg = 'در حال خواندن مدارک امانتی';
          for (var attempt = 0; attempt < 3 && !findTable(); attempt++) {
            var m = findMenu(clicked) || findMenu([]);
            if (!m) break;
            clicked.push(m);
            m.click();
            await waitFor(function () { return findTable(); }, 9000);
          }
          tbl = findTable();
        }
        if (!tbl || tbl.tagName !== 'TABLE') {
          // an empty loan list may come back as JSON with no table
          if (window.__libJson && Array.isArray(window.__libJson.arrayborrow) && window.__libJson.arrayborrow.length === 0) {
            window.__syncRes = { syncedAt: Date.now(), books: [] };
            return;
          }
          if (loginVisible()) window.__syncRes = { error: 'LOGIN', detail: 'صفحه ورود کتابخانه دیده شد' };
          else window.__syncRes = { error: 'FAIL', detail: 'فهرست مدارک امانتی پیدا نشد' };
          return;
        }
        await waitFor(function () { return window.__libJson; }, 2500);
        var res = { syncedAt: Date.now(), books: [] };
        res.books = parseTable(tbl);
        addRenewCounts(res.books, res);
        window.__syncRes = res;
      } catch (e) {
        window.__syncRes = { error: 'FAIL', detail: String(e && e.message ? e.message : e) };
      }
    })();
  };

  // exposed for offline tests only
  window.__parseLibTable = parseTable;
})();
