// Import of the history: registrations made before this app existed (e.g. the old "rapportages" CSV).
//
// CSV with a header row, separated by ; or , — columns (names are not case-sensitive):
//   email, afzender (or naam), gepost (optional, "d/mm/yyyy h:mm"), datum ("d/mm/yyyy" or "yyyy-mm-dd"),
//   dagdeel (VM/NM), club, and one column per field (L, C, A, P, I, R, F, …). Empty or missing numbers count as 0.
//
// The rule "one entry per person per daypart" stays: if a person has several reports for the same daypart
// (also in different clubs), only the one posted last is imported.
//
// Old rows have no Microsoft account id yet. They get a fixed stand-in id derived from the e-mail address;
// the first time that person signs in, relink() moves the rows to their real account.

const crypto = require('crypto');

// Fixed stand-in id per e-mail address, in UUID form so it fits the user_oid column.
function placeholderOid(email) {
  const h = crypto.createHash('sha1').update('huphup-import:' + String(email).trim().toLowerCase()).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function splitLine(line, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const pad = n => String(n).padStart(2, '0');
function parseDate(s) {
  s = String(s || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return valid(+m[3], +m[2], +m[1]);
  return null;
}
function valid(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
}
// "11/06/2026 19:51" → "2026-06-11 19:51" (Belgian time); null if missing or unreadable.
function parsePosted(s) {
  const m = /^(\S+)\s+(\d{1,2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  const d = parseDate(m[1]);
  return d && +m[2] < 24 ? `${d} ${pad(m[2])}:${m[3]}` : null;
}
function parsePart(s) {
  const v = String(s || '').trim().toLowerCase();
  if (v === 'vm' || v.startsWith('voormid') || v === 'ochtend') return 'VM';
  if (v === 'nm' || v.startsWith('namid') || v === 'avond') return 'NM';
  return null;
}
// "HUPHUP Dendermonde - Oude Vest", "Dendermonde-Oude Vest" and "dendermonde oude vest" are the same club.
const normClub = s => String(s || '').toLowerCase().trim().replace(/^huphup\s+/, '').replace(/[\s_-]+/g, '-');

/**
 * Reads the CSV and decides what would be imported. No database access.
 * fields: FIELD_DEFS; clubList: [{id, name}]; isExtraClub(name); min/max: allowed number range.
 */
function plan(text, { fields, clubList, isExtraClub, min, max }) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { error: 'Het bestand is leeg of heeft geen kopregel.' };
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const head = splitLine(lines[0], sep).map(h => h.toLowerCase());
  const col = (...names) => head.findIndex(h => names.includes(h));
  const at = {
    email: col('email', 'e-mail', 'mail'), name: col('afzender', 'naam', 'name', 'ingevoerd_door'),
    posted: col('gepost', 'aangemaakt', 'posted'), date: col('datum', 'date', 'dag'), part: col('dagdeel', 'part'), club: col('club'),
  };
  const missing = ['email', 'date', 'part', 'club'].filter(k => at[k] < 0);
  if (missing.length) return { error: `Kolom(men) ontbreken in de kopregel: ${missing.map(k => ({ email: 'email', date: 'datum', part: 'dagdeel', club: 'club' })[k]).join(', ')}.` };
  // field columns: "L" or the export's "L Aantal opportunities"
  const fieldAt = Object.fromEntries(fields.map(f => [f.key, head.findIndex(h => h === f.key.toLowerCase() || h.startsWith(f.key.toLowerCase() + ' '))]));

  const clubsByNorm = new Map(clubList.map(c => [normClub(c.name), c]));
  const problems = [];          // {line, reason}
  const unknownClubs = {};      // name → number of rows
  const best = new Map();       // email|day|part → row (the one posted last)
  const dropped = [];           // reports replaced by a later one for the same person and daypart
  let order = 0;

  for (let i = 1; i < lines.length; i++) {
    const c = splitLine(lines[i], sep), line = i + 1;
    const email = (c[at.email] || '').toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { problems.push({ line, reason: `geen geldig e-mailadres (“${c[at.email] || ''}”)` }); continue; }
    const day = parseDate(c[at.date]);
    if (!day) { problems.push({ line, reason: `datum onleesbaar (“${c[at.date] || ''}”)` }); continue; }
    const part = parsePart(c[at.part]);
    if (!part) { problems.push({ line, reason: `dagdeel moet VM of NM zijn (“${c[at.part] || ''}”)` }); continue; }
    const clubRaw = c[at.club] || '';
    const club = clubsByNorm.get(normClub(clubRaw));
    if (!club) { unknownClubs[clubRaw] = (unknownClubs[clubRaw] || 0) + 1; continue; }
    const values = {}; let bad = null;
    for (const f of fields) {
      if (f.extra && !isExtraClub(club.name)) { values[f.key] = null; continue; }
      const raw = fieldAt[f.key] >= 0 ? (c[fieldAt[f.key]] || '') : '';
      const n = raw === '' ? 0 : Number(raw);
      if (!Number.isInteger(n) || n < min || n > max) { bad = `${f.key} moet een geheel getal van ${min} tot ${max} zijn (“${raw}”)`; break; }
      values[f.key] = n;
    }
    if (bad) { problems.push({ line, reason: bad }); continue; }
    const name = (at.name >= 0 && c[at.name]) || email.split('@')[0];
    const posted = at.posted >= 0 ? parsePosted(c[at.posted]) : null;
    const row = { line, email, name, day, part, club: club.name, clubId: club.id, posted, values, order: order++ };
    const key = `${email}|${day}|${part}`;
    const prev = best.get(key);
    // keep the one posted last; same or unknown time → the one further down the file
    const later = !prev || (row.posted || '') > (prev.posted || '') || ((row.posted || '') === (prev.posted || '') && row.order > prev.order);
    if (!prev) best.set(key, row);
    else if (later) { dropped.push({ ...prev, keptLine: row.line, keptClub: row.club }); best.set(key, row); }
    else dropped.push({ ...row, keptLine: prev.line, keptClub: prev.club });
  }
  return { rows: [...best.values()].sort((a, b) => a.order - b.order), dropped, problems, unknownClubs, total: lines.length - 1 };
}

/**
 * Runs the import. dryRun = only count, write nothing.
 * Rows for a person + daypart that already exist (entered in the app, or imported before) are skipped.
 */
async function run(pool, text, opts, dryRun) {
  const p = plan(text, opts);
  if (p.error) return { error: p.error };
  const emails = [...new Set(p.rows.map(r => r.email))];
  const { rows: have } = await pool.query(
    `SELECT lower(user_email) AS email, user_oid::text AS oid, to_char(day,'YYYY-MM-DD') AS d, part FROM entries
      WHERE lower(user_email) = ANY($1) OR user_oid = ANY($2::uuid[])`,
    [emails, emails.map(placeholderOid)]);
  const oidToEmail = new Map(emails.map(e => [placeholderOid(e), e]));
  const existing = new Set(have.map(h => `${h.email || oidToEmail.get(h.oid)}|${h.d}|${h.part}`));
  const todo = p.rows.filter(r => !existing.has(`${r.email}|${r.day}|${r.part}`));
  const already = p.rows.length - todo.length;

  let inserted = 0;
  if (!dryRun && todo.length) {
    const cols = opts.fields.map(opts.column);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of todo) {
        const vals = [placeholderOid(r.email), r.name, r.email, r.club, r.clubId, r.day, r.part, r.posted, ...opts.fields.map(f => r.values[f.key])];
        const { rowCount } = await client.query(
          `INSERT INTO entries (user_oid, user_name, user_email, club, club_id, day, part, created_at, updated_at, ${cols.join(', ')})
           VALUES ($1,$2,$3,$4,$5,$6,$7,
             COALESCE(($8::timestamp AT TIME ZONE 'Europe/Brussels'), now()), COALESCE(($8::timestamp AT TIME ZONE 'Europe/Brussels'), now()),
             ${cols.map((_, i) => '$' + (i + 9)).join(',')})
           ON CONFLICT DO NOTHING`, vals);
        inserted += rowCount;
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }

  const days = p.rows.map(r => r.day).sort();
  const perClub = {};
  for (const r of todo) perClub[r.club] = (perClub[r.club] || 0) + 1;
  return {
    dryRun,
    total: p.total,
    people: emails.length,
    from: days[0] || null, to: days[days.length - 1] || null,
    toImport: todo.length,
    inserted,
    alreadyInApp: already,
    perClub,
    dropped: p.dropped.map(d => ({ line: d.line, email: d.email, day: d.day, part: d.part, club: d.club, keptLine: d.keptLine, keptClub: d.keptClub })),
    unknownClubs: p.unknownClubs,
    problems: p.problems,
  };
}

/**
 * At sign-in: move imported rows (stand-in id of one of the person's e-mail addresses) to their real account.
 * A daypart they already entered themselves in the app wins; the imported duplicate then stays behind unlinked
 * and is removed. Runs once per account per server start.
 */
const relinked = new Set();
async function relink(pool, user, force = false) {
  if (!user?.oid || (relinked.has(user.oid) && !force)) return;
  relinked.add(user.oid);
  const stand = (user.emails || []).map(placeholderOid);
  if (!stand.length) return;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM entries e WHERE e.user_oid = ANY($2::uuid[])
           AND EXISTS (SELECT 1 FROM entries x WHERE x.user_oid = $1 AND x.day = e.day AND x.part = e.part)`, [user.oid, stand]);
      // two addresses of the same person with the same daypart: keep one
      await client.query(
        `DELETE FROM entries e WHERE e.user_oid = ANY($1::uuid[])
           AND EXISTS (SELECT 1 FROM entries x WHERE x.user_oid = ANY($1::uuid[]) AND x.day = e.day AND x.part = e.part AND x.id > e.id)`, [stand]);
      const { rowCount } = await client.query('UPDATE entries SET user_oid = $1 WHERE user_oid = ANY($2::uuid[])', [user.oid, stand]);
      await client.query('COMMIT');
      if (rowCount) console.log(`History: ${rowCount} imported rows linked to ${user.email}`);
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (e) {
    relinked.delete(user.oid); // try again at the next request
    console.warn('History relink failed:', e.message);
  }
}

/**
 * Links imported rows for everyone whose real account is already known: a person who entered at least one
 * daypart in the app has their real account id next to their e-mail address. Runs at server start and after
 * every import, so people don't have to sign in again (and nobody shows up twice in Resultaten).
 */
async function linkKnown(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT lower(user_email) AS email, user_oid::text AS oid FROM entries WHERE user_email IS NOT NULL`);
  const real = new Map(), stand = new Set();
  for (const r of rows) {
    if (r.oid === placeholderOid(r.email)) stand.add(r.email);
    else (real.get(r.email) || real.set(r.email, new Set()).get(r.email)).add(r.oid);
  }
  let linked = 0;
  for (const email of stand) {
    const oids = [...(real.get(email) || [])];
    if (oids.length !== 1) continue; // not signed in yet (or ambiguous): linked at their first sign-in
    await relink(pool, { oid: oids[0], email, emails: [email] }, true);
    linked++;
  }
  return linked;
}

module.exports = { plan, run, relink, linkKnown, placeholderOid, parseDate, parsePosted };
