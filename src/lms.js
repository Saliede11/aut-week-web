/*
 * Course site (Moodle, courses.aut.ac.ir) sync. Runs inside the site's own page (same origin, the user's own login).
 * READ ONLY. It sends exactly three kinds of POST, the same ones the site's own calendar / "my courses" screens send,
 * all of them "get" functions of Moodle's web-service gateway:
 *    core_calendar_get_calendar_monthly_view, core_calendar_get_calendar_upcoming_view,
 *    core_course_get_enrolled_courses_by_timeline_classification
 * Every event carries a Unix timestamp, so no date text is parsed.
 */
(function () {
  var ALLOWED = [
    'core_calendar_get_calendar_monthly_view',
    'core_calendar_get_calendar_upcoming_view',
    'core_course_get_enrolled_courses_by_timeline_classification'
  ];
  var EXAM_RE = /امتحان|آزمون|پایان\s?ترم|میان\s?ترم|final|midterm|exam/i;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clean(s) { return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }

  function sesskey() { try { return window.M && M.cfg && M.cfg.sesskey ? String(M.cfg.sesskey) : ''; } catch (e) { return ''; } }
  function loggedOut() {
    if (/\/login\//.test(location.pathname)) return true;
    return !!(document.body && document.body.classList.contains('notloggedin'));
  }

  async function call(method, args) {
    if (ALLOWED.indexOf(method) < 0) throw new Error('BLOCKED ' + method);
    var r = await fetch('/lib/ajax/service.php?sesskey=' + encodeURIComponent(sesskey()) + '&info=' + method, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ index: 0, methodname: method, args: args }])
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json();
    var x = Array.isArray(j) ? j[0] : j;
    if (!x || x.error) {
      var code = x && x.exception ? (x.exception.errorcode || x.exception.message || '') : 'no response';
      throw new Error(/sesskey|requireloginerror|servicerequireslogin/i.test(code) ? 'LOGIN' : 'API ' + code);
    }
    return x.data;
  }

  // current Jalali year / month, from the browser's own calendar
  function jalaliNow(offsetMonths) {
    var parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date());
    var y = 0, m = 0;
    parts.forEach(function (p) { if (p.type === 'year') y = parseInt(p.value, 10); if (p.type === 'month') m = parseInt(p.value, 10); });
    var t = y * 12 + (m - 1) + offsetMonths;
    return { year: Math.floor(t / 12), month: (t % 12) + 1 };
  }

  // every object that looks like a calendar event, wherever it sits in the response
  function collectEvents(node, out, seen) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(function (n) { collectEvents(n, out, seen); }); return; }
    if (typeof node.timestart === 'number' && typeof node.name === 'string') {
      var key = node.id != null ? 'e' + node.id : node.name + '|' + node.timestart;
      if (!seen[key]) { seen[key] = 1; out.push(node); }
      return;
    }
    for (var k in node) collectEvents(node[k], out, seen);
  }

  function cleanTitle(e) {
    var t = clean(e.activityname || '');
    if (!t) {
      t = clean(e.name);
      t = t.replace(/^(موعد تحویل|مهلت تحویل|مهلت)\s*[:：]?\s*/, '')
        .replace(/\s*(رسیده است|به پایان می‌رسد|بسته می‌شود|باز می‌شود|is due|closes|opens)\s*$/i, '')
        .replace(/\s*\((تحویل|Assignment|Quiz|کوئیز)[^)]*\)\s*$/i, '').trim();
    }
    return t || clean(e.name);
  }

  function courseName(e) {
    var c = e.course;
    if (c && typeof c === 'object') return clean(c.fullname || c.shortname || '');
    return '';
  }

  function build(events) {
    var items = [], quiz = {};
    events.forEach(function (e) {
      var mod = String(e.modulename || ''), type = String(e.eventtype || '');
      var title = cleanTitle(e), start = e.timestart * 1000, dur = (e.timeduration || 0) * 1000;
      var base = {
        id: String(e.id != null ? e.id : title + start), title: title, course: courseName(e),
        todo: e.action ? (e.action.actionable !== false) : null,
        actionName: e.action ? clean(e.action.name || '') : '',
        url: String(e.viewurl || e.url || '')
      };
      if (mod === 'quiz' && (type === 'open' || type === 'close')) {
        var k = String(e.instance != null ? e.instance : title);
        var q = quiz[k] || (quiz[k] = { base: base });
        q[type] = start;
        return;
      }
      if (mod === 'assign' && type !== 'due') return;
      if (type === 'gradingdue' || type === 'expectcompletionon') return;
      var kind = mod === 'quiz' ? 'quiz' : mod === 'assign' ? 'assign' : 'other';
      if (EXAM_RE.test(title)) kind = 'exam';
      items.push(Object.assign(base, { kind: kind, start: start, end: dur > 0 ? start + dur : start, point: !(dur > 0) }));
    });
    Object.keys(quiz).forEach(function (k) {
      var q = quiz[k], kind = EXAM_RE.test(q.base.title) ? 'exam' : 'quiz';
      var s = q.open != null ? q.open : q.close, en = q.close != null ? q.close : q.open;
      items.push(Object.assign(q.base, { id: 'q' + k, kind: kind, start: s, end: en, point: s === en, only: q.open == null ? 'close' : q.close == null ? 'open' : '' }));
    });
    items.sort(function (a, b) { return a.start - b.start; });
    return items;
  }

  window.__runLms = function () {
    window.__syncRes = null;
    window.__syncProg = 'در حال باز شدن سامانه درس‌ها';
    (async function () {
      try {
        if (location.host.indexOf('courses.aut.ac.ir') < 0) { window.__syncRes = { error: 'LOGIN', detail: 'صفحه فعلی: ' + location.host }; return; }
        var t0 = Date.now();
        while (!sesskey() && !loggedOut() && Date.now() - t0 < 12000) await sleep(300);
        if (loggedOut() || !sesskey()) { window.__syncRes = { error: 'LOGIN', detail: 'صفحه ورود دیده شد' }; return; }

        var res = { syncedAt: Date.now(), items: [], courses: [], months: [], errors: [] };
        var events = [], seen = {};
        for (var off = -1; off <= 2; off++) {
          var jm = jalaliNow(off);
          window.__syncProg = 'تقویم ' + jm.year + '/' + jm.month;
          try {
            var d = await call('core_calendar_get_calendar_monthly_view', { year: jm.year, month: jm.month, courseid: 1, categoryid: 0, includenavigation: false, mini: false, day: 1 });
            collectEvents(d, events, seen);
            res.months.push(jm.year + '/' + jm.month);
          } catch (e) {
            var m = String(e && e.message ? e.message : e);
            if (m === 'LOGIN') { window.__syncRes = { error: 'LOGIN', detail: m }; return; }
            res.errors.push('تقویم ' + jm.year + '/' + jm.month + ': ' + m);
          }
          await sleep(250);
        }
        if (!res.months.length) {
          // the monthly view failed everywhere: try the short "upcoming" view
          try {
            var u = await call('core_calendar_get_calendar_upcoming_view', { courseid: 1, categoryid: 0 });
            collectEvents(u, events, seen);
            res.months.push('upcoming');
          } catch (e2) { res.errors.push('upcoming: ' + String(e2 && e2.message ? e2.message : e2)); }
        }
        if (!res.months.length) { window.__syncRes = { error: 'FAIL', detail: 'تقویم خوانده نشد: ' + res.errors.join(' | ').slice(0, 300) }; return; }
        res.items = build(events);

        window.__syncProg = 'فهرست درس‌ها';
        try {
          var c = await call('core_course_get_enrolled_courses_by_timeline_classification', { classification: 'inprogress', limit: 0, offset: 0, sort: 'fullname', customfieldname: '', customfieldvalue: '' });
          (c && c.courses || []).forEach(function (x) { if (x && x.fullname) res.courses.push({ id: String(x.id), name: clean(x.fullname) }); });
        } catch (e3) { res.errors.push('درس‌ها: ' + String(e3 && e3.message ? e3.message : e3)); }
        if (!res.courses.length) {
          var have = {};
          res.items.forEach(function (i) { if (i.course && !have[i.course]) { have[i.course] = 1; res.courses.push({ id: '', name: i.course }); } });
        }
        window.__syncRes = res;
      } catch (e) {
        window.__syncRes = { error: 'FAIL', detail: String(e && e.message ? e.message : e) };
      }
    })();
  };

  window.__lmsBuild = build; window.__lmsCollect = collectEvents; // offline tests only
})();
