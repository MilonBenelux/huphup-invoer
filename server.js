const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { availableParts, isAllowed, brusselsNow, shiftDate } = require('./dayparts');

// ---- configuration (Render environment variables) ----
const {
  TENANT_ID,            // Directory (tenant) ID of your Entra tenant
  CLIENT_ID,            // Application (client) ID of the app registration
  DATABASE_URL,         // set by Render from the Postgres database
  ADMIN_EMAILS = '',    // comma-separated; these people may download all entries as CSV
  PORT = 3000,
} = process.env;

for (const [k, v] of Object.entries({ TENANT_ID, CLIENT_ID, DATABASE_URL })) {
  if (!v) { console.error(`Missing environment variable ${k}`); process.exit(1); }
}

const clubs = require('./clubs'); // one club list: names come from the GHL agency dashboard
const ADMINS = ADMIN_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
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
    req.user = {
      oid: payload.oid,
      name: payload.name || payload.preferred_username || 'Onbekend',
      email: (payload.preferred_username || payload.email || payload.upn || '').toLowerCase(),
    };
    next();
  } catch (e) {
    res.status(401).json({ error: 'Je aanmelding is verlopen of ongeldig. Meld je opnieuw aan.' });
  }
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
    user: { name: req.user.name, email: req.user.email, isAdmin: ADMINS.includes(req.user.email) },
  });
});

app.get('/api/entries', auth, async (req, res, next) => {
  try {
    const from = shiftDate(brusselsNow().date, -30);
    const { rows } = await pool.query(`${SELECT} WHERE user_oid=$1 AND day >= $2 ORDER BY day DESC, part DESC, created_at DESC`, [req.user.oid, from]);
    res.json(rows.map(toClient));
  } catch (e) { next(e); }
});

app.post('/api/entries', auth, async (req, res, next) => {
  const { errors, entry: e } = validateEntry(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  try {
    const { rows } = await pool.query(
      `INSERT INTO entries (user_oid, user_name, user_email, club, club_id, day, part, ${COLS.join(', ')})
       VALUES (${[...Array(7 + COLS.length)].map((_, i) => '$' + (i + 1)).join(',')}) ${RETURNING}`,
      [req.user.oid, req.user.name, req.user.email, e.club, e.clubId, e.date, e.part, ...fieldValues(e)]);
    res.status(201).json(toClient(rows[0]));
  } catch (err) { if (err.code === '23505') return taken(req, res, e); next(err); }
});

app.put('/api/entries/:id', auth, async (req, res, next) => {
  const { errors, entry: e } = validateEntry(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  try {
    const { rows } = await pool.query(
      `UPDATE entries SET club=$3, club_id=$4, day=$5, part=$6, ${COLS.map((c, i) => `${c}=$${i + 7}`).join(', ')}, updated_at=now()
       WHERE id=$1 AND user_oid=$2 ${RETURNING}`,
      [req.params.id, req.user.oid, e.club, e.clubId, e.date, e.part, ...fieldValues(e)]);
    if (!rows.length) return res.status(404).json({ error: 'Deze rij bestaat niet (meer).' });
    res.json(toClient(rows[0]));
  } catch (err) { if (err.code === '23505') return taken(req, res, e); next(err); }
});

app.delete('/api/entries/:id', auth, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM entries WHERE id=$1 AND user_oid=$2', [req.params.id, req.user.oid]);
    if (!rowCount) return res.status(404).json({ error: 'Deze rij bestaat niet (meer).' });
    res.status(204).end();
  } catch (e) { next(e); }
});

// All entries as CSV, for the people listed in ADMIN_EMAILS.
app.get('/api/export.csv', auth, async (req, res, next) => {
  if (!ADMINS.includes(req.user.email)) return res.status(403).json({ error: 'Alleen voor beheerders.' });
  try {
    const { rows } = await pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS datum, part AS dagdeel, club, club_id AS "location_id", user_name AS ingevoerd_door, user_email AS email, ${FIELD_DEFS.map(f => `${column(f)} AS "${f.key} ${f.label}"`).join(', ')}, created_at AS aangemaakt FROM entries ORDER BY day DESC, part DESC, club`);
    const cols = ['datum', 'dagdeel', 'club', 'location_id', 'ingevoerd_door', 'email', ...FIELD_DEFS.map(f => `${f.key} ${f.label}`), 'aangemaakt'];
    const esc = v => { const s = v instanceof Date ? v.toISOString() : String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.join(';'), ...rows.map(r => cols.map(c => esc(r[c])).join(';'))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="huphup-invoer-${brusselsNow().date}.csv"`);
    res.send('﻿' + csv); // BOM so Excel opens it as UTF-8
  } catch (e) { next(e); }
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
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await pool.query('ALTER TABLE entries ADD COLUMN IF NOT EXISTS club_id TEXT'); // GHL LocationId of the club
  await clubs.init(pool);
  for (const f of FIELD_DEFS) {
    // Pelvi-type fields stay empty (NULL) for clubs they don't apply to.
    await pool.query(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS ${column(f)} SMALLINT CHECK (${column(f)} BETWEEN ${MIN} AND ${MAX})`);
  }
  app.listen(PORT, () => console.log(`HUPHUP invoer luistert op poort ${PORT}`));
})().catch(e => { console.error(e); process.exit(1); });
