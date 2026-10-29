// People with extra rights, kept in the database and managed on the Beheer page.
//
//   scope       'none' | 'club' | 'global'  — what they see on the results page
//   clubs       club names (for scope 'club')
//   can_export  may download entries as CSV (limited to what they may see)
//   is_admin    may open Beheer and manage managers
//   is_owner    admin + may grant/remove admin and owner rights
//
// Rules, checked inside the same transaction as every change:
//   - at least one owner must remain
//   - at least one admin must remain (an owner counts as admin)
//   - only owners change admin/owner rights or remove an admin/owner
//
// First start (empty table): the old list (MANAGERS variable or managers.csv secret file) is imported,
// and the addresses in ADMIN_EMAILS become owners. ADMIN_EMAILS also acts as a safety net: if no
// owner exists at all, those addresses are treated as owners.

const fs = require('fs');
const path = require('path');

let pool = null;
let people = new Map(); // email -> row (cache, reloaded after every change)

const ADMIN_SEED = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function readOldList() {
  if (process.env.MANAGERS && process.env.MANAGERS.trim()) return process.env.MANAGERS;
  for (const p of ['/etc/secrets/managers.csv', path.join(__dirname, 'managers.csv')]) {
    try { return fs.readFileSync(p, 'utf8'); } catch (e) { /* next */ }
  }
  return '';
}

// "email;club" or "email;global" per line (new lines or commas between lines).
// Optional extra columns from the CSV export are understood too: email;scope;clubs(|-separated);csv;admin;owner
function parseCsv(text) {
  const out = new Map();
  const lines = text.replace(/^﻿/, '').split(/\r?\n|,(?=[^;]*@)/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^e-?mail;/i.test(line)) continue;
    const cols = line.split(/[;\t]/).map(s => s.trim());
    const email = (cols[0] || '').toLowerCase();
    if (!email.includes('@')) continue;
    const p = out.get(email) || { email, scope: 'none', clubs: [], can_export: true, is_admin: false, is_owner: false };
    if (cols.length >= 3 && ['none', 'club', 'global'].includes((cols[1] || '').toLowerCase())) {
      // full export format
      p.scope = cols[1].toLowerCase();
      p.clubs = (cols[2] || '').split('|').map(s => s.trim()).filter(Boolean);
      if (cols[3] !== undefined && cols[3] !== '') p.can_export = /^(1|ja|yes|true|x)$/i.test(cols[3]);
      if (cols[4] !== undefined) p.is_admin = /^(1|ja|yes|true|x)$/i.test(cols[4]);
      if (cols[5] !== undefined) p.is_owner = /^(1|ja|yes|true|x)$/i.test(cols[5]);
    } else {
      const club = cols[1] || '';
      if (club.toLowerCase() === 'global') p.scope = 'global';
      else if (club) { if (p.scope !== 'global') p.scope = 'club'; p.clubs.push(club); }
    }
    out.set(email, p);
  }
  return [...out.values()];
}

async function reload() {
  const { rows } = await pool.query('SELECT email, scope, clubs, can_export, is_admin, is_owner, updated_by, updated_at FROM people ORDER BY email');
  people = new Map(rows.map(r => [r.email, r]));
}

async function init(pgPool) {
  pool = pgPool;
  await pool.query(`CREATE TABLE IF NOT EXISTS people (
    email      TEXT PRIMARY KEY,
    scope      TEXT NOT NULL DEFAULT 'none' CHECK (scope IN ('none','club','global')),
    clubs      TEXT[] NOT NULL DEFAULT '{}',
    can_export BOOLEAN NOT NULL DEFAULT true,
    is_admin   BOOLEAN NOT NULL DEFAULT false,
    is_owner   BOOLEAN NOT NULL DEFAULT false,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM people');
  if (rows[0].n === 0) {
    const list = parseCsv(readOldList());
    for (const e of ADMIN_SEED) {
      const p = list.find(x => x.email === e) || (list.push({ email: e, scope: 'none', clubs: [], can_export: true }), list.at(-1));
      p.is_admin = true; p.is_owner = true;
    }
    for (const p of list) {
      await pool.query(`INSERT INTO people (email, scope, clubs, can_export, is_admin, is_owner, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,'eerste import') ON CONFLICT (email) DO NOTHING`,
        [p.email, p.scope, p.clubs, p.can_export !== false, !!p.is_admin, !!p.is_owner]);
    }
    console.log(`Beheer: first import of ${list.length} people (${ADMIN_SEED.length} owner(s) from ADMIN_EMAILS)`);
  }
  await reload();
  console.log(`Beheer: ${people.size} people, ${[...people.values()].filter(p => p.is_owner).length} owner(s), ${[...people.values()].filter(p => p.is_admin || p.is_owner).length} admin(s)`);
}

// The first matching address wins (guests can sign in with more than one).
function personFor(emails) {
  for (const e of (emails || []).filter(Boolean).map(x => x.toLowerCase())) if (people.has(e)) return people.get(e);
  return null;
}
const noOwners = () => ![...people.values()].some(p => p.is_owner);

// Rights of the signed-in person.
function rightsFor(emails) {
  const p = personFor(emails);
  const seedOwner = noOwners() && (emails || []).some(e => ADMIN_SEED.includes(String(e).toLowerCase()));
  const owner = !!(p && p.is_owner) || seedOwner;
  return {
    email: p ? p.email : (emails || [])[0] || '',
    owner,
    admin: owner || !!(p && p.is_admin),
    export: !!(p && p.can_export && p.scope !== 'none'),
  };
}

// Results role: { type: 'global' | 'club', clubs } or null. clubNames = current club list (real spelling).
function roleFor(emails, clubNames) {
  const p = personFor(emails);
  if (!p) return null;
  if (p.scope === 'global') return { type: 'global', clubs: clubNames.slice() };
  if (p.scope === 'club') {
    const mine = new Set(p.clubs.map(c => c.toLowerCase()));
    const clubs = clubNames.filter(c => mine.has(c.toLowerCase()));
    return clubs.length ? { type: 'club', clubs } : null;
  }
  return null;
}

const list = () => [...people.values()];

class RuleError extends Error { constructor(msg, status = 409) { super(msg); this.status = status; } }

// Runs fn(client) in a transaction with the table locked, then checks the rules.
async function change(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE people IN EXCLUSIVE MODE');
    await fn(client);
    const { rows } = await client.query(`SELECT count(*) FILTER (WHERE is_owner)::int AS owners,
      count(*) FILTER (WHERE is_owner OR is_admin)::int AS admins FROM people`);
    if (rows[0].owners < 1) throw new RuleError('Er moet altijd minstens één owner blijven.');
    if (rows[0].admins < 1) throw new RuleError('Er moet altijd minstens één admin blijven.');
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); await reload(); }
}

function clean(input, clubNames) {
  const scope = ['none', 'club', 'global'].includes(input.scope) ? input.scope : 'none';
  const known = new Map(clubNames.map(c => [c.toLowerCase(), c]));
  const clubs = scope === 'club' ? [...new Set((input.clubs || []).map(c => known.get(String(c).toLowerCase())).filter(Boolean))] : [];
  if (scope === 'club' && !clubs.length) throw new RuleError('Kies minstens één club voor een clubmanager.', 400);
  return { scope, clubs, can_export: input.can_export !== false };
}

// actor = rightsFor(...) of whoever makes the change (an API key acts as admin, not owner)
async function upsert(actor, email, input, clubNames) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s;]+@[^@\s;]+\.[^@\s;]+$/.test(email)) throw new RuleError('Geef een geldig e-mailadres.', 400);
  const c = clean(input, clubNames);
  await change(async client => {
    const { rows } = await client.query('SELECT is_admin, is_owner FROM people WHERE email=$1', [email]);
    const cur = rows[0] || { is_admin: false, is_owner: false };
    let isAdmin = input.is_admin === undefined ? cur.is_admin : !!input.is_admin;
    let isOwner = input.is_owner === undefined ? cur.is_owner : !!input.is_owner;
    if ((isAdmin !== cur.is_admin || isOwner !== cur.is_owner) && !actor.owner)
      throw new RuleError('Alleen een owner kan admin- of owner-rechten geven of afnemen.', 403);
    await client.query(`INSERT INTO people (email, scope, clubs, can_export, is_admin, is_owner, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,now())
      ON CONFLICT (email) DO UPDATE SET scope=$2, clubs=$3, can_export=$4, is_admin=$5, is_owner=$6, updated_by=$7, updated_at=now()`,
      [email, c.scope, c.clubs, c.can_export, isAdmin, isOwner, actor.email]);
  });
  return people.get(email);
}

async function remove(actor, email) {
  email = String(email || '').trim().toLowerCase();
  await change(async client => {
    const { rows } = await client.query('SELECT is_admin, is_owner FROM people WHERE email=$1', [email]);
    if (!rows.length) throw new RuleError('Deze persoon staat niet (meer) in de lijst.', 404);
    if ((rows[0].is_admin || rows[0].is_owner) && !actor.owner)
      throw new RuleError('Alleen een owner kan een admin of owner verwijderen.', 403);
    await client.query('DELETE FROM people WHERE email=$1', [email]);
  });
}

// CSV import: adds/updates the manager part (scope, clubs, csv) of every line.
// replace=true also takes the manager role away from people not in the file (their admin/owner rights stay).
// Admin/owner columns in the file are only applied when an owner imports.
async function importCsv(actor, text, clubNames, replace) {
  const rows = parseCsv(text);
  if (!rows.length) throw new RuleError('Geen geldige regels gevonden. Verwacht: e-mail;club of e-mail;global per regel.', 400);
  const unknown = new Set();
  await change(async client => {
    for (const p of rows) {
      const known = new Map(clubNames.map(c => [c.toLowerCase(), c]));
      p.clubs.filter(c => !known.has(c.toLowerCase())).forEach(c => unknown.add(c));
      const clubs = p.clubs.map(c => known.get(c.toLowerCase())).filter(Boolean);
      const scope = p.scope === 'club' && !clubs.length ? 'none' : p.scope;
      const { rows: cur } = await client.query('SELECT is_admin, is_owner FROM people WHERE email=$1', [p.email]);
      if (scope === 'none' && !cur.length && !(actor.owner && (p.is_admin || p.is_owner))) continue; // nothing to store
      const isAdmin = actor.owner && p.is_admin !== undefined ? !!p.is_admin : !!cur[0]?.is_admin;
      const isOwner = actor.owner && p.is_owner !== undefined ? !!p.is_owner : !!cur[0]?.is_owner;
      await client.query(`INSERT INTO people (email, scope, clubs, can_export, is_admin, is_owner, updated_by, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now())
        ON CONFLICT (email) DO UPDATE SET scope=$2, clubs=$3, can_export=$4, is_admin=$5, is_owner=$6, updated_by=$7, updated_at=now()`,
        [p.email, scope, clubs, p.can_export !== false, isAdmin, isOwner, actor.email + ' (CSV)']);
    }
    if (replace) {
      const keep = rows.map(p => p.email);
      await client.query(`UPDATE people SET scope='none', clubs='{}', updated_by=$2, updated_at=now() WHERE NOT (email = ANY($1)) AND scope<>'none'`, [keep, actor.email + ' (CSV)']);
      await client.query(`DELETE FROM people WHERE NOT (email = ANY($1)) AND NOT is_admin AND NOT is_owner`, [keep]);
    }
  });
  return { count: rows.length, unknownClubs: [...unknown] };
}

function exportCsv() {
  const yes = b => (b ? 'ja' : 'nee');
  return '﻿' + ['email;rol;clubs;csv;admin;owner',
    ...list().map(p => [p.email, p.scope, p.clubs.join('|'), yes(p.can_export), yes(p.is_admin), yes(p.is_owner)].join(';'))].join('\r\n');
}

module.exports = { init, roleFor, rightsFor, list, upsert, remove, importCsv, exportCsv, RuleError, parseCsv };
