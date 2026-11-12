(() => {
  'use strict';

  // ---------------------------------------------------------------
  // Sabitler
  // ---------------------------------------------------------------
  const TAGS = [
    { id: 'study', title: 'Ders Çalışma', color: '#e3c787' },
    { id: 'sport', title: 'Spor', color: '#8fbdc9' },
    { id: 'work', title: 'İş', color: '#d4998f' },
    { id: 'fun', title: 'Eğlence', color: '#c9cc8a' },
  ];
  const TAG = Object.fromEntries(TAGS.map((t) => [t.id, t]));

  // Odaktan çıkınca oturumun bozulmasına kadar tanınan süre
  const GRACE_MS = 15000;
  const RING_LEN = 816.81; // 2 * PI * 130
  const SYNC_FILE = 'odak-data.json';

  const K = {
    sessions: 'odak.sessions.v1',
    running: 'odak.running.v1',
    prefs: 'odak.prefs.v1',
    meta: 'odak.meta.v1',
    sync: 'odak.sync.v1',
  };

  // ---------------------------------------------------------------
  // Yardımcılar
  // ---------------------------------------------------------------
  const $ = (sel, el = document) => el.querySelector(sel);
  const now = () => Date.now();
  const pad = (n) => String(n).padStart(2, '0');

  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* dolu ya da kapalı */ }
  }
  function remove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* yoksay */ }
  }

  const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
  const hhmm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };

  const clock = (sec) => pad(Math.floor(sec / 60)) + ':' + pad(sec % 60);

  /** "8 S 30 D" */
  function fmtShort(sec) {
    const m = Math.floor(sec / 60);
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h === 0 ? r + ' D' : h + ' S ' + r + ' D';
  }
  /** "1 saat 10 dk" */
  function fmtLong(sec) {
    const m = Math.floor(sec / 60);
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h === 0) return r + ' dk';
    if (r === 0) return h + ' saat';
    return h + ' saat ' + r + ' dk';
  }

  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /** UTF-8 güvenli base64 (GitHub API içerik formatı) */
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // ---------------------------------------------------------------
  // Kayıt modeli
  //   id    : cihazlar arası benzersiz kimlik (birleştirmede çift sayılmasın)
  //   added : kaydın eklendiği an ("tümünü sil" işaretiyle karşılaştırılır)
  // ---------------------------------------------------------------
  function normalize(s) {
    if (!s || !Number.isFinite(s.start) || !Number.isFinite(s.seconds) || typeof s.tag !== 'string') return null;
    return {
      id: typeof s.id === 'string' && s.id ? s.id : s.start + '-' + s.seconds, // eski kayıtlar için sabit id
      start: s.start,
      seconds: s.seconds,
      tag: s.tag,
      completed: !!s.completed,
      added: Number.isFinite(s.added) ? s.added : s.start,
    };
  }

  function newSession(start, seconds, tag, completed) {
    return {
      id: start + '-' + Math.random().toString(36).slice(2, 8),
      start, seconds, tag, completed,
      added: now(),
    };
  }

  /**
   * İki kaynağı birleştirir: kimliğe göre birleşim; aynı kimlikte daha yeni `added` kazanır.
   * `wipedAt` (son "tümünü sil" anı) öncesinde eklenmiş kayıtlar atılır.
   */
  function mergeData(localSessions, localWipedAt, remote) {
    const wiped = Math.max(localWipedAt || 0, (remote && Number(remote.wipedAt)) || 0);
    const all = [].concat((remote && Array.isArray(remote.sessions)) ? remote.sessions : [], localSessions);
    const map = new Map();
    for (const raw of all) {
      const n = normalize(raw);
      if (!n || n.added <= wiped) continue;
      const prev = map.get(n.id);
      if (!prev || n.added > prev.added) map.set(n.id, n);
    }
    const list = Array.from(map.values()).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
    return { wipedAt: wiped, sessions: list };
  }

  const sameData = (a, b) => a.wipedAt === b.wipedAt && JSON.stringify(a.sessions) === JSON.stringify(b.sessions);

  /** Verilen aralığa (ms) düşen toplam odak süresi (saniye). */
  function focusSeconds(from, to) {
    let total = 0;
    for (const s of sessions) {
      const end = s.start + s.seconds * 1000;
      const lo = Math.max(s.start, from);
      const hi = Math.min(end, to);
      total += Math.max(0, Math.floor((hi - lo) / 1000));
    }
    return total;
  }

  // ---------------------------------------------------------------
  // Durum
  // ---------------------------------------------------------------
  let sessions = (load(K.sessions, []) || []).map(normalize).filter(Boolean);
  save(K.sessions, sessions); // eski kayıtlara id ekleyerek geri yaz
  const meta = Object.assign({ wipedAt: 0 }, load(K.meta, {}));
  let running = load(K.running, null);
  const prefs = Object.assign({ minutes: 25, tag: 'study' }, load(K.prefs, {}));
  let period = 'today';
  let ticker = null;
  let wakeLock = null;

  // ---------------------------------------------------------------
  // Ayar ekranı
  // ---------------------------------------------------------------
  function renderTagChips() {
    $('#tags').innerHTML = TAGS.map((t) =>
      '<button type="button" class="chip' + (prefs.tag === t.id ? ' sel' : '') + '" data-tag="' + t.id + '"' +
      ' style="--c:' + t.color + ';--c25:' + hexToRgba(t.color, 0.25) + '">' +
      '<i></i>' + t.title + '</button>'
    ).join('');
  }

  /** Kaydırıcının dolu kısmını boyar */
  function paintSlider() {
    const el = $('#slider');
    const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--p', pct + '%');
  }

  function renderSetup() {
    $('#minutes').textContent = prefs.minutes;
    $('#slider').value = prefs.minutes;
    paintSlider();
    renderTagChips();
  }

  function setResult(text) {
    const el = $('#result');
    el.textContent = text || '';
    el.hidden = !text;
  }

  $('#slider').addEventListener('input', (e) => {
    prefs.minutes = Number(e.target.value);
    $('#minutes').textContent = prefs.minutes;
    paintSlider();
    save(K.prefs, prefs);
  });

  $('#tags').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tag]');
    if (!btn) return;
    prefs.tag = btn.dataset.tag;
    save(K.prefs, prefs);
    renderTagChips();
  });

  // ---------------------------------------------------------------
  // Oturum
  // ---------------------------------------------------------------
  function endOf(r) { return r.start + r.totalSeconds * 1000; }

  function enterRunning() {
    document.body.classList.add('running');
    $('#setup').hidden = true;
    $('#running').hidden = false;
    $('#runtag').textContent = TAG[running.tag] ? TAG[running.tag].title : '';
    $('#ring').style.stroke = TAG[running.tag] ? TAG[running.tag].color : '';
    $('#ring').style.transition = 'none';
    tick();
    requestAnimationFrame(() => { $('#ring').style.transition = ''; });
    if (!ticker) ticker = setInterval(tick, 500);
    acquireWake();
    window.scrollTo(0, 0);
  }

  function exitRunning() {
    document.body.classList.remove('running');
    $('#setup').hidden = false;
    $('#running').hidden = true;
    if (ticker) { clearInterval(ticker); ticker = null; }
    releaseWake();
  }

  function tick() {
    if (!running) return;
    const end = endOf(running);
    const remaining = Math.max(0, Math.ceil((end - now()) / 1000));
    $('#time').textContent = clock(remaining);
    const progress = 1 - remaining / running.totalSeconds;
    $('#ring').style.strokeDashoffset = String(RING_LEN * (1 - progress));
    // Süre sadece uygulama öndeyken (leftAt yok) tamamlanır
    if (!running.leftAt && now() >= end) finish('completed', end);
  }

  function start() {
    running = {
      start: now(),
      totalSeconds: prefs.minutes * 60,
      tag: prefs.tag,
      leftAt: null,
    };
    save(K.running, running);
    setResult('');
    enterRunning();
  }

  /** Oturumu bitirir; `at` anına kadar geçen süreyi kaydeder (1 dk altı kaydedilmez). */
  function finish(outcome, at) {
    if (!running) return;
    const r = running;
    const endAt = at == null ? now() : at;
    const elapsed = Math.min(r.totalSeconds, Math.max(0, Math.floor((endAt - r.start) / 1000)));
    const saved = elapsed >= 60;

    if (saved) {
      sessions.push(newSession(r.start, elapsed, r.tag, outcome === 'completed'));
      save(K.sessions, sessions);
    }

    let msg;
    if (outcome === 'completed') {
      msg = 'Oturum tamamlandı · ' + fmtLong(elapsed);
    } else if (outcome === 'stopped') {
      msg = saved ? 'Oturum bitirildi · ' + fmtLong(elapsed) + ' kaydedildi'
                  : '1 dakikadan kısa olduğu için kaydedilmedi';
    } else {
      msg = saved ? 'Odaktan çıktın, oturum bozuldu · ' + fmtLong(elapsed) + ' kaydedildi'
                  : 'Odaktan çıktın, oturum bozuldu · kaydedilmedi';
    }

    running = null;
    remove(K.running);
    exitRunning();
    setResult(msg);
    renderStats();
    if (saved) runSync();
  }

  $('#start').addEventListener('click', start);
  $('#stop').addEventListener('click', () => finish('stopped'));

  // ---------------------------------------------------------------
  // Yumuşak kilit (soft lock): sayfa gizlenirse "odaktan çıktı" say
  // ---------------------------------------------------------------
  function onHidden() {
    if (running && !running.leftAt) {
      running.leftAt = now();
      save(K.running, running);
    }
  }

  function resolveReturn() {
    if (!running) return;
    const t = now();
    if (running.leftAt) {
      const left = running.leftAt;
      running.leftAt = null;
      if (t - left > GRACE_MS) { finish('broken', left); return; }
      save(K.running, running);
    }
    if (t >= endOf(running)) finish('completed', endOf(running));
    else tick();
  }

  function onVisible() {
    if (!running) return;
    resolveReturn();
    if (running) acquireWake();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      onHidden();
    } else {
      onVisible();
      syncSoon(60000);
    }
  });
  window.addEventListener('pagehide', onHidden);
  window.addEventListener('pageshow', () => { if (running && !document.hidden) onVisible(); });

  // Ekran açık kalsın (destekleniyorsa)
  async function acquireWake() {
    try {
      if ('wakeLock' in navigator && !wakeLock && !document.hidden) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { wakeLock = null; }
  }
  function releaseWake() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* yoksay */ }
    wakeLock = null;
  }

  // ---------------------------------------------------------------
  // İstatistik: Kart 1 — Odaklanma Trendi
  // ---------------------------------------------------------------
  function renderTrend() {
    const t = now();
    const todayStart = startOfDay(t);
    const nd = new Date(t);
    const labels = ['Bugün (bu ana kadar)', 'Dün', 'Evvelki Gün'];

    const rows = [0, 1, 2].map((ago) => {
      const dayStart = addDays(todayStart, -ago);
      const dayEnd = addDays(dayStart, 1);
      const c = new Date(dayStart);
      c.setHours(nd.getHours(), nd.getMinutes(), nd.getSeconds(), 0);
      const untilNow = focusSeconds(dayStart, c.getTime());
      const total = ago === 0 ? untilNow : focusSeconds(dayStart, dayEnd);
      return { label: labels[ago], total, untilNow };
    });

    const maxTotal = Math.max(1, ...rows.map((r) => r.total));
    const cmp = (diff) => (Math.abs(diff) < 60
      ? 'aynı'
      : fmtLong(Math.abs(diff)) + (diff > 0 ? ' daha uzun' : ' daha kısa'));

    const bars = rows.map((r) => {
      const fillPct = (r.total / maxTotal) * 100;
      const dotPct = Math.min(Math.max((r.untilNow / maxTotal) * 100, 2), 97);
      return '<div class="barrow"><div class="lbl">' + r.label + '</div>' +
        '<div class="barline"><div class="track">' +
        '<div class="fill" style="width:' + fillPct + '%"></div>' +
        '<div class="dot" style="left:calc(' + dotPct + '% - 4px)"></div></div>' +
        '<div class="val">' + fmtShort(r.total) + '</div></div></div>';
    }).join('');

    $('#trend').innerHTML =
      '<h2>Odaklanma Trendi</h2>' +
      '<p class="line">Bugün ile aynı zamana kıyasla dün: <b>' + cmp(rows[1].untilNow - rows[0].untilNow) + '</b></p>' +
      '<p class="line">Bugün ile aynı zamana kıyasla evvelki gün: <b>' + cmp(rows[2].untilNow - rows[0].untilNow) + '</b></p>' +
      bars +
      '<p class="foot">Beyaz nokta: günün aynı saati (' + hhmm(t) + ')</p>';
  }

  // ---------------------------------------------------------------
  // İstatistik: Kart 2 — Etiket Dağılımı
  // ---------------------------------------------------------------
  function renderBreakdown() {
    const todayStart = startOfDay(now());
    const from = period === 'today' ? todayStart : addDays(todayStart, -6);
    const inRange = sessions.filter((s) => s.start >= from);

    const slices = TAGS
      .map((t) => ({
        tag: t,
        seconds: inRange.filter((s) => s.tag === t.id).reduce((a, s) => a + s.seconds, 0),
      }))
      .filter((s) => s.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds);
    const total = slices.reduce((a, s) => a + s.seconds, 0);

    const head =
      '<div class="cardhead"><h2>Etiket Dağılımı</h2>' +
      '<div class="seg">' +
      '<button type="button" data-period="today" class="' + (period === 'today' ? 'on' : '') + '">Bugün</button>' +
      '<button type="button" data-period="week" class="' + (period === 'week' ? 'on' : '') + '">7 Gün</button>' +
      '</div></div>';

    if (!total) {
      $('#breakdown').innerHTML = head + '<div class="empty">Bu dönemde kayıt yok</div>';
      return;
    }

    const R = 80;
    const CIRC = 2 * Math.PI * R;
    const gap = slices.length > 1 ? 2.5 : 0;
    let cum = 0;
    let arcs = '';
    let labels = '';

    for (const s of slices) {
      const frac = s.seconds / total;
      const len = frac * CIRC;
      arcs += '<circle cx="110" cy="110" r="' + R + '" fill="none" stroke="' + s.tag.color + '" stroke-width="40"' +
        ' stroke-dasharray="' + Math.max(len - gap, 0.01) + ' ' + CIRC + '"' +
        ' stroke-dashoffset="' + (-(cum + gap / 2)) + '" transform="rotate(-90 110 110)"/>';
      const pct = Math.round(frac * 100);
      if (pct >= 6) {
        const ang = ((cum + len / 2) / CIRC) * 2 * Math.PI - Math.PI / 2;
        const x = 110 + R * Math.cos(ang);
        const y = 110 + R * Math.sin(ang);
        labels += '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="middle" dominant-baseline="central">' + pct + '%</text>';
      }
      cum += len;
    }

    const legend = slices.map((s) =>
      '<div class="legend-row"><i style="background:' + s.tag.color + '"></i>' +
      '<span class="name">' + s.tag.title + '</span>' +
      '<span class="pct">' + Math.round((s.seconds / total) * 100) + '%</span>' +
      '<span class="dur">' + fmtShort(s.seconds) + '</span></div>'
    ).join('');

    $('#breakdown').innerHTML = head +
      '<svg class="donut" viewBox="0 0 220 220" aria-label="Etiket dağılımı">' + arcs + labels + '</svg>' +
      '<div>' + legend + '</div>';
  }

  $('#breakdown').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (!b) return;
    period = b.dataset.period;
    renderBreakdown();
  });

  function renderStats() {
    renderTrend();
    renderBreakdown();
  }

  // ---------------------------------------------------------------
  // Senkron (GitHub özel repo, Contents API)
  //   - Dosya: odak-data.json  { version, wipedAt, sessions[] }
  //   - Akış: uzaktakini çek → yerelle birleştir → farklıysa yaz (sha ile)
  //   - Çakışmada (409/422) baştan dener
  //   - Not: CORS izin listesi dar; sadece Authorization / Accept / Content-Type kullanılır
  // ---------------------------------------------------------------
  const sync = {
    cfg: load(K.sync, null),   // { repo, token }
    busy: false,
    again: false,
    lastTry: 0,
    last: 0,
  };

  function httpError(status) {
    const e = new Error('http ' + status);
    e.status = status;
    return e;
  }

  function errorText(e) {
    if (e && e.status === 401) return 'Token geçersiz ya da süresi dolmuş';
    if (e && e.status === 403) return 'Erişim reddedildi: token izni "Contents → Read and write" olmalı';
    if (e && e.status === 404) return 'Repo bulunamadı ya da token bu repoya erişemiyor';
    if (e && e.status) return 'GitHub hatası (' + e.status + ')';
    if (e && e.message === 'conflict') return 'Çakışma çözülemedi, tekrar denenecek';
    return 'Bağlantı yok, sonra tekrar denenecek';
  }

  function setSyncStatus(text, isErr) {
    const line = $('#syncstatus');
    line.hidden = !sync.cfg;
    line.textContent = text || '';
    line.classList.toggle('err', !!isErr);
    const msg = $('#sync-msg');
    msg.textContent = text || '';
    msg.classList.toggle('err', !!isErr);
  }

  const ghHeaders = (cfg, withBody) => {
    const h = { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json' };
    if (withBody) h['Content-Type'] = 'application/json';
    return h;
  };
  const ghBase = (cfg) => 'https://api.github.com/repos/' + cfg.repo;

  async function ghGet(cfg) {
    // no-store: tarayıcı önbelleği eski içerik/sha vermesin
    const res = await fetch(ghBase(cfg) + '/contents/' + SYNC_FILE, { cache: 'no-store', headers: ghHeaders(cfg) });
    if (res.status === 404) {
      // Repo yok mu, dosya mı yok? Ayırt et.
      const r2 = await fetch(ghBase(cfg), { cache: 'no-store', headers: ghHeaders(cfg) });
      if (!r2.ok) throw httpError(r2.status === 200 ? 404 : r2.status);
      return { missing: true };
    }
    if (!res.ok) throw httpError(res.status);
    const json = await res.json();
    let text;
    if (json.encoding === 'base64' && json.content) {
      text = b64decode(json.content);
    } else {
      // Dosya 1 MB'ı geçince içerik inline gelmez: ham içeriği iste
      const raw = await fetch(ghBase(cfg) + '/contents/' + SYNC_FILE, {
        cache: 'no-store',
        headers: Object.assign(ghHeaders(cfg), { Accept: 'application/vnd.github.raw+json' }),
      });
      if (!raw.ok) throw httpError(raw.status);
      text = await raw.text();
    }
    return { sha: json.sha, data: JSON.parse(text) };
  }

  async function ghPut(cfg, payload, sha) {
    const body = {
      message: 'Odak senkron ' + new Date(now()).toISOString(),
      content: b64encode(JSON.stringify(payload)),
    };
    if (sha) body.sha = sha;
    const res = await fetch(ghBase(cfg) + '/contents/' + SYNC_FILE, {
      method: 'PUT',
      headers: ghHeaders(cfg, true),
      body: JSON.stringify(body),
    });
    if (res.status === 409 || res.status === 422) return { conflict: true };
    if (!res.ok) throw httpError(res.status);
    return { ok: true };
  }

  async function runSync() {
    const cfg = sync.cfg;
    if (!cfg) return;
    if (sync.busy) { sync.again = true; return; }
    sync.busy = true;
    sync.lastTry = now();
    setSyncStatus('Senkronlanıyor…');
    try {
      let done = false;
      for (let attempt = 0; attempt < 3 && !done; attempt++) {
        const remote = await ghGet(cfg);
        const merged = mergeData(sessions, meta.wipedAt, remote.missing ? null : remote.data);

        // Yerel veriyi birleşmiş hâliyle güncelle
        sessions = merged.sessions;
        meta.wipedAt = merged.wipedAt;
        save(K.sessions, sessions);
        save(K.meta, meta);
        renderStats();

        const remoteNow = remote.missing ? null : mergeData([], 0, remote.data);
        if (remoteNow && sameData(merged, remoteNow)) { done = true; break; }

        const r = await ghPut(cfg, { version: 1, wipedAt: merged.wipedAt, sessions: merged.sessions }, remote.sha);
        if (r.ok) done = true;
      }
      if (!done) throw new Error('conflict');
      sync.last = now();
      setSyncStatus('Son senkron: ' + hhmm(sync.last));
    } catch (e) {
      setSyncStatus(errorText(e), true);
    } finally {
      sync.busy = false;
      if (sync.again) { sync.again = false; runSync(); }
    }
  }

  /** Son denemeden beri `gap` ms geçtiyse senkronla */
  function syncSoon(gap) {
    if (sync.cfg && now() - sync.lastTry > gap) runSync();
  }

  // Ayar penceresi
  const dlg = $('#syncdlg');
  function openSyncDialog() {
    $('#sync-repo').value = sync.cfg ? sync.cfg.repo : '';
    $('#sync-token').value = sync.cfg ? sync.cfg.token : '';
    $('#sync-msg').textContent = '';
    $('#sync-msg').classList.remove('err');
    dlg.hidden = false;
  }
  function closeSyncDialog() { dlg.hidden = true; }

  $('#sync-close').addEventListener('click', closeSyncDialog);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSyncDialog(); });

  $('#sync-save').addEventListener('click', async () => {
    const repo = $('#sync-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
    const token = $('#sync-token').value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) {
      setSyncStatus('Repo "kullanici/repo" biçiminde, token dolu olmalı', true);
      return;
    }
    sync.cfg = { repo, token };
    save(K.sync, sync.cfg);
    await runSync();
  });

  $('#sync-off').addEventListener('click', () => {
    sync.cfg = null;
    remove(K.sync);
    $('#sync-repo').value = '';
    $('#sync-token').value = '';
    setSyncStatus('Bağlantı kaldırıldı. Bu cihazdaki kayıtlar duruyor.');
    $('#syncstatus').hidden = true;
  });

  // ---------------------------------------------------------------
  // Menü: örnek veri, yedek, silme
  // ---------------------------------------------------------------
  function seedSample() {
    const t = now();
    const today = startOfDay(t);
    const slots = [
      { hour: 8, mins: 90, tag: 'study' },
      { hour: 11, mins: 45, tag: 'sport' },
      { hour: 14, mins: 60, tag: 'work' },
      { hour: 17, mins: 40, tag: 'fun' },
      { hour: 20, mins: 75, tag: 'study' },
    ];
    for (let off = 0; off <= 6; off++) {
      const day = addDays(today, -off);
      for (const sl of slots) {
        const d = new Date(day);
        d.setHours(sl.hour, 0, 0, 0);
        const start = d.getTime();
        if (start >= t) continue;
        const m = Math.max(20, sl.mins + Math.floor(Math.random() * 41) - 20);
        sessions.push(newSession(start, m * 60, sl.tag, true));
      }
    }
    save(K.sessions, sessions);
    renderStats();
    runSync();
  }

  function wipe() {
    const extra = sync.cfg ? ' Senkron açık olduğu için tüm cihazlardan silinir.' : '';
    if (!confirm('Tüm kayıtlar silinecek.' + extra + ' Emin misin?')) return;
    sessions = [];
    meta.wipedAt = now();
    save(K.sessions, sessions);
    save(K.meta, meta);
    renderStats();
    runSync();
  }

  function exportData() {
    const payload = { version: 2, wipedAt: meta.wipedAt, sessions: sessions };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'odak-yedek-' + new Date(now()).toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /** Yedeği mevcut kayıtlara EKLER (aynı kimlikliler tekrar eklenmez). */
  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const list = Array.isArray(data) ? data : data.sessions;
        if (!Array.isArray(list)) throw new Error('format');
        const items = list.map(normalize).filter(Boolean);
        if (!items.length) throw new Error('format');
        if (!confirm(items.length + ' kayıt eklenecek (aynı olanlar tekrar eklenmez). Devam?')) return;
        // Geri yüklenen kayıtlar önceki bir "sil" işaretine takılmasın
        const stamp = now();
        const merged = mergeData(sessions, meta.wipedAt, { wipedAt: 0, sessions: items.map((s) => Object.assign({}, s, { added: stamp })) });
        sessions = merged.sessions;
        save(K.sessions, sessions);
        renderStats();
        runSync();
      } catch (e) {
        alert('Bu dosya geçerli bir Odak yedeği değil.');
      }
    };
    reader.readAsText(file);
  }

  const menu = $('#menu');
  $('#menubtn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    menu.hidden = true;
    const a = act.dataset.act;
    if (a === 'seed') seedSample();
    else if (a === 'wipe') wipe();
    else if (a === 'export') exportData();
    else if (a === 'import') $('#file').click();
    else if (a === 'sync') openSyncDialog();
    else if (a === 'syncnow') {
      if (sync.cfg) runSync(); else openSyncDialog();
    }
  });
  $('#file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importData(f);
    e.target.value = '';
  });

  // ---------------------------------------------------------------
  // Sekmeler
  // ---------------------------------------------------------------
  function showTab(name) {
    $('#view-focus').hidden = name !== 'focus';
    $('#view-stats').hidden = name !== 'stats';
    document.querySelectorAll('#tabbar button').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    if (name === 'stats') renderStats();
    window.scrollTo(0, 0);
  }
  $('#tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  // ---------------------------------------------------------------
  // Başlangıç
  // ---------------------------------------------------------------
  renderSetup();
  setSyncStatus(sync.cfg ? 'Senkron açık' : '');

  if (running) {
    // Sayfa yeniden açıldı: kayıtlı oturumu geri yükle
    enterRunning();
    if (document.hidden) onHidden(); else resolveReturn();
  }

  if (sync.cfg) runSync();
  window.addEventListener('online', () => syncSoon(5000));

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* yoksay */ });
    });
  }
})();
