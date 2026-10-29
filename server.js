const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { availableParts, isAllowed, brusselsNow, shiftDate } = require('./dayparts');
const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

// ---- configuration (Render environment variables) ----
const {
  TENANT_ID,            // Directory (tenant) ID of your Entra tenant
  CLIENT_ID,            // Application (client) ID of the app registration
  DATABASE_URL,         // set by Render from the Postgres database
  ADMIN_EMAILS = '',    // comma-separated; first owners on the Beheer page (and safety net if no owner is left)
  PORT = 3000,
} = process.env;

for (const [k, v] of Object.entries({ TENANT_ID, CLIENT_ID, DATABASE_URL })) {
  if (!v) { console.error(`Missing environment variable ${k}`); process.exit(1); }
}

const clubs = require('./clubs'); // one club list: names come from the GHL agency dashboard
const managers = require('./managers');
const reference = require('./reference');
const history = require('./history'); // import of old registrations (CSV) // all-clubs summary figures for the results page // managers, admins and owners (Beheer page)
const crypto = require('crypto');
const sameKey = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const { FIELD_DEFS, MIN, MAX, column } = require('./fields');
const EXTRA_CLUBS = (process.env.EXTRA_FIELD_CLUBS || 'Zandhoven').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const API_SCOPE = 'access_as_user';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
});

// ---- Microsoft token check ----
// Only accounts of your own tenant (members and invited guests) get a token for this app,
// (Assignment required = No: every member and invited guest of the tenant may use the form.)
const JWKS = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`));
const ISSUERS = [`https://login.microsoftonline.com/${TENANT_ID}/v2.0`, `https://sts.windows.net/${TENANT_ID}/`];
const AUDIENCES = [CLIENT_ID, `api://${CLIENT_ID}`];

async function auth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'Niet aangemeld.' });
  try {
    const { payload } = await jwtVerify(m[1], JWKS, { issuer: ISSUERS, audience: AUDIENCES });
    if (payload.tid !== TENANT_ID) throw new Error('wrong tenant');
    if (!String(payload.scp || '').split(' ').includes(API_SCOPE)) throw new Error('missing scope');
    // Guests' upn looks like "name_domain.com#EXT#@tenant…": turn it back into name@domain.com.
    const fromExt = u => /#EXT#/i.test(u || '') ? u.split(/#EXT#/i)[0].replace(/_([^_]*)$/, '@$1') : u;
    const emails = [payload.preferred_username, payload.email, fromExt(payload.upn), fromExt(payload.unique_name)]
      .filter(Boolean).map(x => String(x).toLowerCase());
    req.user = {
      oid: payload.oid,
      name: payload.name || payload.preferred_username || 'Onbekend',
      email: emails[0] || '',
      emails: [...new Set(emails)],
    };
  } catch (e) {
    return res.status(401).json({ error: 'Je aanmelding is verlopen of ongeldig. Meld je opnieuw aan.' });
  }
  await history.relink(pool, req.user); // first sign-in: imported history rows become this person's
  next();
}

// ---- validation ----
const isExtraClub = club => EXTRA_CLUBS.some(x => club.toLowerCase().includes(x));
const appliesTo = (f, club) => !f.extra || isExtraClub(club);

function validateEntry(body) {
  const errors = [];
  const club = String(body.club || '').trim();
  const clubRow = clubs.byName(club);
  if (!clubRow) errors.push('Kies een club uit de lijst.');
  const date = String(body.date || '');
  const part = String(body.part || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['VM', 'NM'].includes(part) || !isAllowed(date, part)) {
    errors.push('Dit dagdeel kan niet: kies vandaag of maximaal 30 dagen terug, en geen dagdeel dat nog moet beginnen.');
  }
  const values = {};
  for (const f of FIELD_DEFS) {
    if (!appliesTo(f, club)) { values[f.key] = null; continue; } // e.g. Pelvi fields outside Zandhoven
    const v = body[f.key];
    const n = v === '' || v == null ? 0 : Number(v);
    if (!Number.isInteger(n) || n < MIN || n > MAX) errors.push(`${f.key} (${f.label}) moet een geheel getal van ${MIN} tot ${MAX} zijn.`);
    values[f.key] = n;
  }
  return { errors, entry: { club, clubId: clubRow?.id || null, date, part, values } };
}

const COLS = FIELD_DEFS.map(column);
const RETURNING = `RETURNING id, club, to_char(day,'YYYY-MM-DD') AS day_iso, part, ${COLS.join(', ')}, created_at`;
const SELECT = `SELECT id, club, to_char(day,'YYYY-MM-DD') AS day_iso, part, ${COLS.join(', ')}, created_at FROM entries`;
const toClient = r => ({
  id: Number(r.id), club: r.club, date: r.day_iso, part: r.part, createdAt: r.created_at,
  ...Object.fromEntries(FIELD_DEFS.map(f => [f.key, r[column(f)]])),
});
const fieldValues = e => FIELD_DEFS.map(f => e.values[f.key]);

// A person can enter each daypart only once; tell them which row already has it.
async function taken(req, res, e) {
  const { rows } = await pool.query('SELECT id, club FROM entries WHERE user_oid=$1 AND day=$2 AND part=$3', [req.user.oid, e.date, e.part]);
  res.status(409).json({
    error: `Je hebt dit dagdeel al ingevuld${rows[0] ? ` (${rows[0].club})` : ''}. Pas die rij aan in de tabel.`,
    existingId: rows[0] ? Number(rows[0].id) : null,
  });
}

// ---- app ----
const app = express();
app.use(express.json({ limit: '20kb' }));

// Settings the login page needs before anyone is signed in (nothing secret).
app.get('/api/public-config', (req, res) => res.json({ tenantId: TENANT_ID, clientId: CLIENT_ID, scope: `api://${CLIENT_ID}/${API_SCOPE}` }));

app.get('/api/config', auth, async (req, res) => {
  await clubs.ensure();
  res.json({
    clubsError: clubs.list().length ? null : 'De clublijst kon niet geladen worden. Probeer het over enkele minuten opnieuw.',
    clubs: clubs.list().map(c => c.name),
    extraClubs: clubs.list().map(c => c.name).filter(isExtraClub),
    fields: FIELD_DEFS,
    min: MIN, max: MAX,
    parts: availableParts(),
    today: brusselsNow().date,
    user: (() => { const r = managers.rightsFor(req.user.emails); return { name: req.user.name, email: req.user.email,
      isAdmin: r.admin, isOwner: r.owner, canExport: r.export,
      isManager: !!managers.roleFor(req.user.emails, clubs.list().map(c => c.name)) }; })(),
  });
});

// ---- results for managers ----
// A club manager gets their own clubs in full. Rows from other clubs are only there to compute the
// all-clubs averages and bar scales; the people in them are replaced by a code ("Medewerker 12").
const RESULT_MONTHS = 12;
const RESULT_FIELDS = ['L', 'C', 'A', 'P', 'I', 'R', 'F'];
app.get('/api/results', auth, async (req, res, next) => {
  try {
    await clubs.ensure();
    const allClubs = clubs.list().map(c => c.name);
    const role = managers.roleFor(req.user.emails, allClubs);
    if (!role) return res.status(403).json({ error: 'Je staat niet op de lijst van managers. Vraag de beheerder om je toe te voegen.' });
    const today = brusselsNow().date;
    const from = `${shiftMonth(today.slice(0, 7), -(RESULT_MONTHS - 1))}-01`;
    const { rows } = await pool.query(
      `SELECT user_oid, user_name, club, to_char(day,'YYYY-MM-DD') AS d, part, ${RESULT_FIELDS.map(k => column({ key: k })).join(', ')}
       FROM entries WHERE day >= $1 ORDER BY day, part`, [from]);
    const mine = new Set(role.clubs);
    // Club managers only receive the shifts of their own clubs. Everything from the other clubs is
    // reduced on the server to summary figures (all-clubs totals and min/max per column) in `ref`.
    const visibleRows = role.type === 'global' ? rows : rows.filter(r => mine.has(r.club));
    // one display name per person (latest name used), made unique if two people share a name
    const nameOf = new Map(), used = new Map();
    for (const r of visibleRows) nameOf.set(r.user_oid, r.user_name);
    for (const [oid, n] of nameOf) { const k = n.toLowerCase(); used.set(k, (used.get(k) || 0) + 1); if (used.get(k) > 1) nameOf.set(oid, `${n} (${used.get(k)})`); }
    const out = visibleRows.map(r => [nameOf.get(r.user_oid), r.club, r.d, r.part, ...RESULT_FIELDS.map(k => r[column({ key: k })] ?? 0)]);
    // "Werkte deze maand ook in …": only the names of the other clubs where a coach of this manager
    // worked that month — no figures from those clubs.
    const elsewhere = {};
    if (role.type === 'club') {
      const inScope = new Set(visibleRows.map(r => r.user_oid));
      for (const r of rows) if (inScope.has(r.user_oid) && !mine.has(r.club)) {
        const n = nameOf.get(r.user_oid), m = r.d.slice(0, 7);
        const list = ((elsewhere[n] ||= {})[m] ||= []);
        if (!list.includes(r.club)) list.push(r.club);
      }
    }
    const ref = reference.build(rows.map(r => ({ person: r.user_oid, club: r.club, month: r.d.slice(0, 7),
      ...Object.fromEntries(RESULT_FIELDS.map(k => [k, r[column({ key: k })] ?? 0])) })));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ role: { ...role, name: req.user.name }, clubs: allClubs, today, months: RESULT_MONTHS, fields: RESULT_FIELDS, entries: out, ref, elsewhere });
  } catch (e) { next(e); }
});

app.get('/api/entries', auth, async (req, res, next) => {
  try {
    const from = shiftDate(brusselsNow().date, -30);
    const { rows } = await pool.query(`${SELECT} WHERE user_oid=$1 AND day >= $2 ORDER BY day DESC, part DESC, created_at DESC`, [req.user.oid, from]);
    res.json(rows.map(toClient));
  } catch (e) { next(e); }
});

// Someone else already entered this club + daypart? The page asks "are you sure?" first and
// then tells who it was, so the two can sort out which numbers are right.
async function othersFor(req, e, exceptId = 0) {
  const { rows } = await pool.query(
    `SELECT DISTINCT user_name AS name, user_email AS email FROM entries
     WHERE club=$1 AND day=$2 AND part=$3 AND user_oid<>$4 AND id<>$5`,
    [e.club, e.date, e.part, req.user.oid, exceptId]);
  return rows;
}
const overlapAnswer = (res, others) => res.status(409).json({
  error: 'Deze club en dit dagdeel zijn al ingevuld door iemand anders.', overlap: others,
});

app.post('/api/entries', auth, async (req, res, next) => {
  const { errors, entry: e } = validateEntry(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  try {
    const others = await othersFor(req, e);
    if (others.length && !req.body.confirmOverlap) return overlapAnswer(res, others);
    const { rows } = await pool.query(
      `INSERT INTO entries (user_oid, user_name, user_email, club, club_id, day, part, ${COLS.join(', ')})
       VALUES (${[...Array(7 + COLS.length)].map((_, i) => '$' + (i + 1)).join(',')}) ${RETURNING}`,
      [req.user.oid, req.user.name, req.user.email, e.club, e.clubId, e.date, e.part, ...fieldValues(e)]);
    res.status(201).json({ ...toClient(rows[0]), overlap: others });
  } catch (err) { if (err.code === '23505') return taken(req, res, e); next(err); }
});

app.put('/api/entries/:id', auth, async (req, res, next) => {
  const { errors, entry: e } = validateEntry(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  try {
    // Only ask again when the club or daypart of this row changes, not for every number edit.
    const { rows: cur } = await pool.query(`SELECT club, to_char(day,'YYYY-MM-DD') AS d, part FROM entries WHERE id=$1 AND user_oid=$2`, [req.params.id, req.user.oid]);
    const moved = cur[0] && (cur[0].club !== e.club || cur[0].d !== e.date || cur[0].part !== e.part);
    const others = moved ? await othersFor(req, e, Number(req.params.id)) : [];
    if (others.length && !req.body.confirmOverlap) return overlapAnswer(res, others);
    const { rows } = await pool.query(
      `UPDATE entries SET club=$3, club_id=$4, day=$5, part=$6, ${COLS.map((c, i) => `${c}=$${i + 7}`).join(', ')}, updated_at=now()
       WHERE id=$1 AND user_oid=$2 ${RETURNING}`,
      [req.params.id, req.user.oid, e.club, e.clubId, e.date, e.part, ...fieldValues(e)]);
    if (!rows.length) return res.status(404).json({ error: 'Deze rij bestaat niet (meer).' });
    res.json({ ...toClient(rows[0]), overlap: others });
  } catch (err) { if (err.code === '23505') return taken(req, res, e); next(err); }
});

app.delete('/api/entries/:id', auth, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM entries WHERE id=$1 AND user_oid=$2', [req.params.id, req.user.oid]);
    if (!rowCount) return res.status(404).json({ error: 'Deze rij bestaat niet (meer).' });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ---- export ----
// All entries as CSV (semicolon-separated, UTF-8 with BOM, so Belgian Excel opens it directly).
async function exportCsv(onlyClubs = null) {
  const { rows } = await pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS datum, part AS dagdeel, club, club_id AS "location_id",
      user_name AS ingevoerd_door, user_email AS email,
      ${FIELD_DEFS.map(f => `${column(f)} AS "${f.key} ${f.label}"`).join(', ')},
      to_char(created_at AT TIME ZONE 'Europe/Brussels', 'YYYY-MM-DD HH24:MI') AS aangemaakt,
      to_char(updated_at AT TIME ZONE 'Europe/Brussels', 'YYYY-MM-DD HH24:MI') AS gewijzigd
    FROM entries ${onlyClubs ? 'WHERE club = ANY($1)' : ''} ORDER BY day DESC, part DESC, club`, onlyClubs ? [onlyClubs] : []);
  const cols = ['datum', 'dagdeel', 'club', 'location_id', 'ingevoerd_door', 'email', ...FIELD_DEFS.map(f => `${f.key} ${f.label}`), 'aangemaakt', 'gewijzigd'];
  const esc = v => { const s = String(v ?? ''); return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '\uFEFF' + [cols.join(';'), ...rows.map(r => cols.map(c => esc(r[c])).join(';'))].join('\r\n');
}
function sendCsv(res, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename="huphup-invoer-${brusselsNow().date}.csv"`);
  res.send(csv);
}

// "Export (CSV)" button: for people with the CSV option on the Beheer page; only the clubs they may see.
app.get('/api/export.csv', auth, async (req, res, next) => {
  try {
    const r = managers.rightsFor(req.user.emails);
    const role = managers.roleFor(req.user.emails, clubs.list().map(c => c.name));
    if (!r.export || !role) return res.status(403).json({ error: 'Je mag geen CSV downloaden. Vraag het aan een admin.' });
    sendCsv(res, await exportCsv(role.type === 'global' ? null : role.clubs));
  } catch (e) { next(e); }
});

// ---- Beheer (managers, admins, owners) ----
// Signed-in admins/owners, or a script with x-api-key: <ADMIN_API_KEY> (acts as admin, never as owner).
async function adminAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    if (!process.env.ADMIN_API_KEY || !sameKey(apiKey, process.env.ADMIN_API_KEY)) return res.status(403).json({ error: 'Ongeldige API-sleutel.' });
    req.actor = { email: 'API', admin: true, owner: false };
    return next();
  }
  auth(req, res, () => {
    const r = managers.rightsFor(req.user.emails);
    if (!r.admin) return res.status(403).json({ error: 'Alleen voor admins.' });
    req.actor = r; next();
  });
}
const clubNames = () => clubs.list().map(c => c.name);
const peopleOut = () => managers.list().map(p => ({ email: p.email, scope: p.scope, clubs: p.clubs, can_export: p.can_export,
  is_admin: p.is_admin, is_owner: p.is_owner, updated_by: p.updated_by, updated_at: p.updated_at }));
const ruleErr = (res, e, next) => e instanceof managers.RuleError ? res.status(e.status).json({ error: e.message }) : next(e);

app.get('/api/admin/people', adminAuth, async (req, res) => {
  await clubs.ensure();
  const covered = new Set(managers.list().filter(p => p.scope === 'club').flatMap(p => p.clubs.map(c => c.toLowerCase())));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ me: { email: req.actor.email, owner: req.actor.owner }, clubs: clubNames(),
    clubsWithoutManager: clubNames().filter(c => !covered.has(c.toLowerCase())), people: peopleOut() });
});
app.put('/api/admin/people/:email', adminAuth, async (req, res, next) => {
  try { await managers.upsert(req.actor, req.params.email, req.body || {}, clubNames()); res.json({ people: peopleOut() }); }
  catch (e) { ruleErr(res, e, next); }
});
app.delete('/api/admin/people/:email', adminAuth, async (req, res, next) => {
  try { await managers.remove(req.actor, req.params.email); res.json({ people: peopleOut() }); }
  catch (e) { ruleErr(res, e, next); }
});
app.get('/api/admin/people.csv', adminAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="huphup-managers-${brusselsNow().date}.csv"`);
  res.send(managers.exportCsv());
});
// Body: the CSV text. ?replace=1 also removes the manager role from people who are not in the file.
app.post('/api/admin/people.csv', adminAuth, express.text({ type: '*/*', limit: '200kb' }), async (req, res, next) => {
  try {
    const r = await managers.importCsv(req.actor, String(req.body || ''), clubNames(), req.query.replace === '1');
    res.json({ ...r, people: peopleOut() });
  } catch (e) { ruleErr(res, e, next); }
});

// History import (old "rapportages" CSV). Body: the CSV text. ?dryrun=1 only counts and writes nothing.
app.post('/api/admin/entries.csv', adminAuth, express.text({ type: '*/*', limit: '5mb' }), async (req, res, next) => {
  try {
    await clubs.ensure();
    if (!clubs.list().length) return res.status(503).json({ error: 'De clublijst is nog niet geladen. Probeer het over enkele minuten opnieuw.' });
    const r = await history.run(pool, String(req.body || ''),
      { fields: FIELD_DEFS, column, clubList: clubs.list(), isExtraClub, min: MIN, max: MAX }, req.query.dryrun === '1');
    if (r.error) return res.status(400).json({ error: r.error });
    if (!r.dryRun) console.log(`History import by ${req.actor.email}: ${r.inserted} rows`);
    res.json(r);
  } catch (e) { next(e); }
});

// For Excel (Data → From Web): /export.csv?key=<EXPORT_KEY>. Excel can't do the Microsoft sign-in,
// so this address uses its own key. Without EXPORT_KEY on Render this address is switched off.
app.get('/export.csv', async (req, res, next) => {
  const key = process.env.EXPORT_KEY;
  if (!key) return res.status(404).type('text/plain').send('Export via link staat uit (EXPORT_KEY is niet ingesteld).');
  if (!sameKey(req.query.key || '', key)) return res.status(403).type('text/plain').send('Ongeldige sleutel.');
  try { sendCsv(res, await exportCsv()); } catch (e) { next(e); }
});

// MSAL browser library, served from the installed npm package.
const msalDir = path.dirname(require.resolve('@azure/msal-browser/package.json'));
const msalFile = ['lib/msal-browser.min.js', 'lib/msal-browser.js'].map(f => path.join(msalDir, f)).find(f => fs.existsSync(f));
app.get('/vendor/msal-browser.js', (req, res) => msalFile ? res.sendFile(msalFile) : res.status(404).end());

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Er ging iets mis bij het opslaan. Probeer het opnieuw.' });
});

(async () => {
  // Right after a (re)deploy the database may not accept connections yet: wait up to ~60 s.
  for (let attempt = 1; ; attempt++) {
    try { await pool.query('SELECT 1'); break; }
    catch (e) {
      if (attempt >= 12) throw e;
      console.log(`Database not ready yet (${e.code || e.message}), retrying in 5 s…`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await pool.query('ALTER TABLE entries ADD COLUMN IF NOT EXISTS club_id TEXT'); // GHL LocationId of the club
  clubs.onRename(() => managers.reload().catch(() => {})); // a renamed club also changes in the managers' lists
  await clubs.init(pool);
  await managers.init(pool);
  for (const f of FIELD_DEFS) {
    // Pelvi-type fields stay empty (NULL) for clubs they don't apply to.
    await pool.query(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS ${column(f)} SMALLINT CHECK (${column(f)} BETWEEN ${MIN} AND ${MAX})`);
  }
  app.listen(PORT, () => console.log(`HUPHUP invoer luistert op poort ${PORT}`));
})().catch(e => { console.error(e); process.exit(1); });
