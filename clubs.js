// The club list has one source: the GHL agency dashboard on Render, which reads its
// subaccounts.csv secret file. This module fetches the names (never the tokens) from
// the dashboard's /clubs.json, refreshes them every hour, and keeps the last good list
// in Postgres so the form keeps working while the dashboard is asleep or redeploying.
//
// Environment:
//   DASHBOARD_URL   e.g. https://ghl-agency-dashboard-xxxx.onrender.com
//   DASHBOARD_KEY   the dashboard's ACCESS_KEY
//   EXCLUDE_CLUBS   optional, comma-separated names to leave out (e.g. Fysioworld,huphup leeg)
//   CLUBS           optional fallback for local testing only: comma-separated names

const REFRESH_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 90 * 1000; // a sleeping free Render instance can take a while to wake up

const exclude = new Set((process.env.EXCLUDE_CLUBS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

let clubs = [];        // [{id, name}] sorted by name
let loadedAt = null;
let pool = null;

const clean = list => list
  .filter(c => c && c.id && c.name && !exclude.has(c.name.toLowerCase()))
  .sort((a, b) => a.name.localeCompare(b.name, 'nl'));

async function fetchFromDashboard() {
  const { DASHBOARD_URL, DASHBOARD_KEY } = process.env;
  if (!DASHBOARD_URL || !DASHBOARD_KEY) return null;
  const url = new URL('/clubs.json', DASHBOARD_URL);
  url.searchParams.set('key', DASHBOARD_KEY);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`dashboard answered HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error('dashboard returned no clubs');
  return clean(data.map(c => ({ id: String(c.id), name: String(c.name).trim() })));
}

async function saveToDb(list) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM club_cache');
    for (const c of list) await client.query('INSERT INTO club_cache (id, name) VALUES ($1, $2)', [c.id, c.name]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function refresh() {
  try {
    const list = await fetchFromDashboard();
    if (list) {
      clubs = list; loadedAt = new Date();
      await saveToDb(list);
      console.log(`Club list: ${list.length} clubs from the GHL dashboard`);
      return;
    }
  } catch (e) {
    console.warn(`Club list: could not reach the GHL dashboard (${e.message}); keeping the last known list`);
  }
}

async function init(pgPool) {
  pool = pgPool;
  await pool.query('CREATE TABLE IF NOT EXISTS club_cache (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  // Start from the last known list so the form works immediately, then refresh.
  const { rows } = await pool.query('SELECT id, name FROM club_cache');
  clubs = clean(rows);
  if (!clubs.length && process.env.CLUBS) {
    clubs = clean(process.env.CLUBS.split(',').map(n => n.trim()).filter(Boolean).map(n => ({ id: 'name:' + n, name: n })));
  }
  const first = refresh();
  if (!clubs.length) await first; // nothing cached yet: wait for the dashboard once
  setInterval(refresh, REFRESH_MS).unref();
}

const list = () => clubs;
const byName = name => clubs.find(c => c.name === name);

module.exports = { init, list, byName, refresh, status: () => ({ count: clubs.length, loadedAt }) };
