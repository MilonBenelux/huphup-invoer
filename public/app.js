/* HUPHUP invoer — browser side. Sign-in with MSAL, then everything goes through /api. */
setTimeout(() => document.getElementById('slides')?.classList.add('out'), 4000);
(async function () {
  const $ = id => document.getElementById(id);
  const DAYS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  const MON = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

  // ---------- sign-in ----------
  const pub = await fetch('/api/public-config').then(r => r.json());
  const msalApp = new msal.PublicClientApplication({
    auth: {
      clientId: pub.clientId,
      authority: `https://login.microsoftonline.com/${pub.tenantId}`, // own tenant: members + invited guests
      redirectUri: location.origin + '/',
      postLogoutRedirectUri: location.origin + '/',
    },
    cache: { cacheLocation: 'localStorage' },
  });
  await msalApp.initialize();

  let account = null;
  try {
    const result = await msalApp.handleRedirectPromise();
    account = result?.account || msalApp.getAllAccounts()[0] || null;
  } catch (e) {
    showGate(e.errorCode === 'access_denied' || /AADSTS50105/.test(e.message)
      ? 'Je account heeft geen toegang tot dit formulier. Vraag de beheerder om je toe te voegen.'
      : 'Aanmelden is niet gelukt. Probeer het opnieuw.');
    return;
  }
  if (!account) { showGate(''); return; }
  msalApp.setActiveAccount(account);

  function showGate(text) {
    $('gate').hidden = false; $('app').hidden = true; $('gateMsg').textContent = text; $('gateMsg').hidden = !text;
    $('slides').classList.add('out');
    $('login').onclick = () => msalApp.loginRedirect({ scopes: [pub.scope], extraScopesToConsent: ['User.Read'] });
  }

  async function token(scopes) {
    try {
      return (await msalApp.acquireTokenSilent({ scopes, account })).accessToken;
    } catch (e) {
      if (e instanceof msal.InteractionRequiredAuthError) await msalApp.acquireTokenRedirect({ scopes, account });
      throw e;
    }
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + await token([pub.scope]), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.blob();
    if (!res.ok) throw Object.assign(new Error(data.error || 'Er ging iets mis.'), { status: res.status, existingId: data.existingId });
    return data;
  }

  // ---------- load ----------
  let config, rows;
  try {
    [config, rows] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/entries')]);
  } catch (e) { showGate(e.message); return; }
  if (config.clubsError || !config.clubs.length) { showGate(config.clubsError || 'De clublijst is leeg.'); $('login').textContent = 'Opnieuw proberen'; $('login').onclick = () => location.reload(); return; }
  let PARTS = config.parts;
  const CLUBS = config.clubs;
  const FIELDS = config.fields;                       // [{key, label, extra}] in screen order
  const isExtraClub = club => config.extraClubs.includes(club);
  const applies = (f, club) => !f.extra || isExtraClub(club);
  const hasExtra = FIELDS.some(f => f.extra) && config.extraClubs.length > 0;

  // Default club: Office location (or Department) on the user's Entra account, else the club used last.
  let DEFAULT_CLUB = null;
  try {
    const me = await fetch('https://graph.microsoft.com/v1.0/me?$select=officeLocation,department', {
      headers: { Authorization: 'Bearer ' + await token(['User.Read']) },
    }).then(r => r.ok ? r.json() : {});
    DEFAULT_CLUB = [me.officeLocation, me.department].find(v => v && CLUBS.includes(v)) || null;
  } catch (e) { /* no profile access: fall back below */ }
  if (!DEFAULT_CLUB) DEFAULT_CLUB = rows[0]?.club || CLUBS[0];

  $('app').hidden = false; $('userBox').hidden = false;
  $('me').textContent = config.user.name;
  $('logout').onclick = () => msalApp.logoutRedirect({ account });
  if (config.user.isAdmin) {
    $('export').hidden = false;
    $('export').onclick = async () => {
      const blob = await api('GET', '/api/export.csv');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `huphup-invoer-${config.today}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
  }

  // Sliding blocks (huphup.be style): a quick sweep after each save.
  function slide() {
    const s = $('slides'), bars = s.querySelectorAll('i');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    s.classList.remove('out'); s.classList.add('wipe'); void s.offsetWidth; s.classList.remove('wipe');
    bars.forEach(b => b.style.transform = 'translateX(0)');
    requestAnimationFrame(() => requestAnimationFrame(() => { bars.forEach(b => b.style.transform = ''); s.classList.add('out'); }));
  }

  // ---------- helpers ----------
  const key = o => o.date + '|' + o.part;
  const fromIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  function label(o) {
    const diff = Math.round((fromIso(config.today) - fromIso(o.date)) / 864e5);
    const d = fromIso(o.date);
    const rel = diff === 0 ? 'Vandaag' : diff === 1 ? 'Gisteren' : `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
    return `${rel} · ${o.part}`;
  }
  const valid = v => /^\d+$/.test(String(v)) && +v >= config.min && +v <= config.max;

  function recentClubs() {
    const seen = [];
    for (const r of [...rows].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))) {
      if (r.club !== DEFAULT_CLUB && !seen.includes(r.club)) seen.push(r.club);
      if (seen.length === 2) break;
    }
    return seen;
  }
  function clubOptions(sel, value) {
    sel.innerHTML = '';
    const rec = recentClubs();
    const groups = [['Standaard', [DEFAULT_CLUB]], ['Recent', rec], ['Alle clubs', CLUBS.filter(c => c !== DEFAULT_CLUB && !rec.includes(c))]];
    if (value && !CLUBS.includes(value)) groups.push(['Niet meer in de lijst', [value]]);
    for (const [name, list] of groups) {
      if (!list.length) continue;
      const g = document.createElement('optgroup'); g.label = name;
      list.forEach(c => g.appendChild(new Option(c, c)));
      sel.appendChild(g);
    }
    sel.value = value || DEFAULT_CLUB;
  }
  function partOptions(sel, value, rowId) {
    sel.innerHTML = '';
    PARTS.forEach(p => { const o = new Option(label(p) + (isTaken(p, rowId) ? ' ✓' : ''), key(p)); o.disabled = isTaken(p, rowId); sel.appendChild(o); });
    if (!PARTS.some(p => key(p) === value)) {
      const [d, p] = value.split('|'); const o = new Option(label({ date: d, part: p }) + ' (te oud)', value); o.disabled = true;
      sel.appendChild(o);
    }
    sel.value = value;
  }

  // ---------- quick entry ----------
  const qClub = $('qClub'), qDate = $('qDate'), bVM = $('bVM'), bNM = $('bNM'), chips = $('chips'), msg = $('msg');
  const isTaken = (p, exceptId) => rows.some(r => key(r) === key(p) && r.id !== exceptId);
  const firstFree = () => PARTS.find(p => !isTaken(p)) || PARTS[0];
  let qPart = firstFree();
  FIELDS.forEach(f => {
    const l = document.createElement('label'); l.className = 'num';
    l.innerHTML = `<span class="code">${f.key}</span><input id="q${f.key}" inputmode="numeric" type="number" min="${config.min}" max="${config.max}" step="1" value="0"><small>${f.label}</small>`;
    $(f.extra ? 'qExtraNums' : 'qNums').appendChild(l);
  });
  // Typing replaces the 0 instead of appending to it.
  document.querySelectorAll('.nums input').forEach(i => {
    i.addEventListener('focus', () => i.select());
    i.addEventListener('input', () => i.parentElement.classList.toggle('bad', i.value !== '' && !valid(i.value)));
  });
  const syncExtra = () => { $('qExtra').hidden = !(hasExtra && isExtraClub(qClub.value)); };
  qClub.addEventListener('change', syncExtra);

  function syncQuick() {
    qDate.min = PARTS[PARTS.length - 1].date; qDate.max = PARTS[0].date; qDate.value = qPart.date;
    bVM.disabled = !PARTS.some(p => p.date === qPart.date && p.part === 'VM');
    bNM.disabled = !PARTS.some(p => p.date === qPart.date && p.part === 'NM');
    bVM.setAttribute('aria-pressed', qPart.part === 'VM'); bNM.setAttribute('aria-pressed', qPart.part === 'NM');
    const done = isTaken(qPart);
    $('add').disabled = done;
    if (done) say('warn', `${label(qPart)} heb je al ingevuld. Pas het aan in de tabel of kies een ander dagdeel.`);
    else if (msg.classList.contains('warn')) say('', '');
    chips.innerHTML = '';
    PARTS.slice(0, 4).forEach(p => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
      const done = isTaken(p);
      b.textContent = label(p) + (done ? ' ✓' : ''); b.disabled = done;
      if (done) b.title = 'Al ingevuld';
      b.setAttribute('aria-pressed', !done && key(p) === key(qPart)); b.onclick = () => { qPart = p; syncQuick(); };
      chips.appendChild(b);
    });
  }
  qDate.addEventListener('change', () => {
    const opts = PARTS.filter(p => p.date === qDate.value);
    if (!opts.length) { say('err', 'Kies een datum van vandaag tot 30 dagen terug.'); qDate.value = qPart.date; return; }
    qPart = opts.find(p => p.part === qPart.part) || opts[0]; say('', ''); syncQuick();
  });
  bVM.onclick = () => { qPart = { date: qPart.date, part: 'VM' }; syncQuick(); };
  bNM.onclick = () => { qPart = { date: qPart.date, part: 'NM' }; syncQuick(); };
  function say(kind, text) { msg.className = 'msg ' + kind; msg.textContent = text; }

  $('add').onclick = async () => {
    const vals = {};
    const club = qClub.value;
    for (const f of FIELDS) {
      if (!applies(f, club)) continue;
      const v = $('q' + f.key).value.trim();
      if (v !== '' && !valid(v)) { say('err', `${f.key} (${f.label}) moet een geheel getal van ${config.min} tot ${config.max} zijn.`); $('q' + f.key).focus(); return; }
      vals[f.key] = v === '' ? 0 : +v;
    }
    $('add').disabled = true;
    try {
      const saved = await api('POST', '/api/entries', { club, ...qPart, ...vals });
      rows.unshift(saved); sortRows(); render();
      FIELDS.forEach(f => { $('q' + f.key).value = '0'; $('q' + f.key).parentElement.classList.remove('bad'); });
      clubOptions(qClub, club);
      const doneLabel = label(qPart);
      qPart = firstFree(); syncQuick();
      say('ok', `Opgeslagen: ${club} · ${doneLabel}. Hup!`); slide();
      $('q' + FIELDS[0].key).focus();
    } catch (e) {
      $('add').disabled = false;
      say('err', e.message);
      if (e.existingId) focusRow(e.existingId);
    }
  };
  $('qFields').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('add').click(); } });

  // ---------- grid ----------
  const tbody = document.querySelector('#grid tbody');
  let nextFocus = null; // where the cursor goes after a cell is saved
  const sortRows = () => rows.sort((a, b) => b.date.localeCompare(a.date) || b.part.localeCompare(a.part) || new Date(b.createdAt) - new Date(a.createdAt));

  function render() {
    tbody.innerHTML = '';
    // Pelvi columns only appear when one of your rows is for a club that uses them.
    document.body.classList.toggle('no-extra', !rows.some(r => isExtraClub(r.club)));
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="${FIELDS.length + 4}" style="padding:28px;text-align:center;color:var(--grey)">Nog niets ingevuld. Hup, begin hierboven!</td></tr>`; return; }
    rows.forEach((r, i) => {
      const tr = document.createElement('tr'); tr.dataset.id = r.id;
      tr.innerHTML = `<td class="rn">${i + 1}</td><td class="col-club"><select id="c-club-${i}" aria-label="Club rij ${i + 1}"></select></td><td class="col-part"><select id="c-part-${i}" aria-label="Dagdeel rij ${i + 1}"></select></td>` +
        FIELDS.map(f => applies(f, r.club)
          ? `<td class="num-cell${f.extra ? ' xcol' : ''}" title="${f.label}"><input id="c-${f.key}-${i}" data-r="${i}" data-f="${f.key}" inputmode="numeric" value="${r[f.key] ?? 0}" aria-label="${f.label} rij ${i + 1}"></td>`
          : `<td class="na xcol" title="Alleen voor ${config.extraClubs.join(', ')}">–</td>`).join('') +
        `<td class="act"><button class="del" data-del="${i}" aria-label="Rij ${i + 1} verwijderen">✕</button></td>`;
      tbody.appendChild(tr);
      const cs = tr.querySelector(`#c-club-${i}`); clubOptions(cs, r.club);
      cs.onchange = () => saveRow(i, { club: cs.value }, `c-club-${i}`);
      const ps = tr.querySelector(`#c-part-${i}`); partOptions(ps, key(r), r.id);
      ps.onchange = () => { const [date, part] = ps.value.split('|'); saveRow(i, { date, part }, `c-part-${i}`); };
    });
  }

  function focusRow(id) {
    const i = rows.findIndex(r => r.id === id); if (i < 0) return;
    const el = $(`c-${FIELDS[0].key}-${i}`); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); el.select?.(); }
  }

  async function saveRow(i, change, focusId) {
    const r = rows[i]; const next = { ...r, ...change };
    const tr = tbody.children[i];
    FIELDS.forEach(f => { if (applies(f, next.club) && (next[f.key] == null || next[f.key] === '')) next[f.key] = 0; });
    const active = FIELDS.filter(f => applies(f, next.club));
    if (active.some(f => !valid(next[f.key]))) { tr.classList.add('err'); say('err', `Rij ${i + 1}: gebruik gehele getallen van ${config.min} tot ${config.max}.`); return; }
    tr.querySelectorAll('td').forEach(td => td.classList.add('saving'));
    try {
      const saved = await api('PUT', '/api/entries/' + r.id, { club: next.club, date: next.date, part: next.part, ...Object.fromEntries(active.map(f => [f.key, +next[f.key]])) });
      rows[i] = saved; say('ok', `Rij ${i + 1} opgeslagen.`);
    } catch (e) { say('err', `Rij ${i + 1}: ${e.message}`); }
    sortRows(); render(); syncQuick();
    const newIndex = rows.findIndex(x => x.id === r.id);
    const target = focusId.startsWith('c-club-') || focusId.startsWith('c-part-') ? focusId.replace(/-\d+$/, '-' + newIndex) : focusId;
    const el = $(target); if (el) { el.focus(); el.select?.(); }
  }

  tbody.addEventListener('change', e => {
    const t = e.target; if (!t.dataset.f) return;
    saveRow(+t.dataset.r, { [t.dataset.f]: t.value.trim() }, nextFocus || t.id);
  });
  tbody.addEventListener('input', e => {
    const t = e.target; if (!t.dataset.f) return;
    t.parentElement.classList.toggle('bad', !valid(t.value.trim()));
  });
  tbody.addEventListener('keydown', e => {
    const t = e.target; if (!t.dataset || !t.dataset.f) return;
    const i = +t.dataset.r, f = t.dataset.f;
    const go = id => { const el = $(id); if (el) { el.focus(); el.select?.(); } };
    const move = to => { e.preventDefault(); nextFocus = `c-${f}-${to}`; t.blur(); go(nextFocus); nextFocus = null; };
    if (e.key === 'Enter' || e.key === 'ArrowDown') move(i + 1);
    if (e.key === 'ArrowUp') move(i - 1);
  });
  // Delete takes two clicks: × then "Zeker?"
  tbody.addEventListener('click', async e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    if (!b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = 'Zeker?'; setTimeout(() => { b.classList.remove('sure'); b.textContent = '✕'; }, 3000); return; }
    const i = +b.dataset.del;
    try { await api('DELETE', '/api/entries/' + rows[i].id); rows.splice(i, 1); render(); clubOptions(qClub, qClub.value); syncQuick(); say('ok', 'Rij verwijderd.'); }
    catch (err) { say('err', err.message); }
  });

  // Dayparts unlock at 11:00 and 18:00 (Belgian time): refresh the list every few minutes.
  setInterval(async () => {
    try {
      const c = await api('GET', '/api/config');
      if (c.parts.length !== PARTS.length || c.today !== config.today) {
        const wasTop = key(qPart) === key(firstFree());
        config = c; PARTS = c.parts;
        if (wasTop || !PARTS.some(p => key(p) === key(qPart))) qPart = firstFree();
        syncQuick(); render();
      }
    } catch (e) { /* try again next round */ }
  }, 3 * 60 * 1000);

  // Grid header from the field list (codes, with the full name as a hint).
  $('headRow').innerHTML = '<th></th><th class="col-club">Club</th><th class="col-part">Dagdeel</th>' +
    FIELDS.map(f => `<th class="n${f.extra ? ' x xcol' : ''}" title="${f.key} = ${f.label}">${f.key}</th>`).join('') + '<th></th>';

  clubOptions(qClub); syncExtra(); syncQuick(); render();
  $('slides').classList.add('out'); // the coloured blocks slide away once the page is ready
})();
