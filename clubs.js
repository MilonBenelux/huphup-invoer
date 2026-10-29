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
let lastError = null;   // why the last fetch failed (shown in the log and to admins)
let lastTry = 0;
let pool = null;
let retryTimer = null;

const clean = list => list
  .filter(c => c && c.id && c.name && !exclude.has(c.name.toLowerCase()))
  .sort((a, b) => a.name.localeCompare(b.name, 'nl'));

async function fetchFromDashboard() {
  const { DASHBOARD_URL, DASHBOARD_KEY } = process.env;
  if (!DASHBOARD_URL || !DASHBOARD_KEY) throw new Error('DASHBOARD_URL or DASHBOARD_KEY is not set');
  const url = new URL('/clubs.json', DASHBOARD_URL);
  url.searchParams.set('key', DASHBOARD_KEY);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`dashboard answered HTTP ${res.status}${res.status === 403 ? ' (wrong DASHBOARD_KEY)' : res.status === 404 ? ' (wrong DASHBOARD_URL, or /clubs.json not deployed on the dashboard yet)' : ''}`);
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

// A club renamed in the dashboard keeps its LocationId: carry the new name over to the stored
// registrations and to the managers' club lists, so nothing stays behind under the old name.
let renameListener = null;
const onRename = fn => { renameListener = fn; };
async function applyRenames(oldList, newList) {
  const oldById = new Map(oldList.filter(c => !c.id.startsWith('name:')).map(c => [c.id, c.name]));
  for (const c of newList) {
    const before = oldById.get(c.id);
    if (!before || before === c.name) continue;
    const e = await pool.query('UPDATE entries SET club=$1 WHERE club_id=$2 OR (club_id IS NULL AND club=$3)', [c.name, c.id, before]);
    const p = await pool.query('UPDATE people SET clubs=array_replace(clubs, $2, $1) WHERE $2 = ANY(clubs)', [c.name, before]).catch(() => ({ rowCount: 0 }));
    console.log(`Club renamed: "${before}" → "${c.name}" (${e.rowCount} registrations, ${p.rowCount} managers updated)`);
    if (renameListener) await renameListener(before, c.name);
  }
}

async function refresh() {
  lastTry = Date.now();
  try {
    const list = await fetchFromDashboard();
    const previous = clubs;
    clubs = list; loadedAt = new Date(); lastError = null;
    await applyRenames(previous, list);
    await saveToDb(list);
    console.log(`Club list: ${list.length} clubs from the GHL dashboard`);
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    return true;
  } catch (e) {
    lastError = e.name === 'TimeoutError' ? 'the dashboard did not answer in time (asleep?)' : e.message;
    console.warn(`Club list: could not get it from the GHL dashboard: ${lastError}. Keeping the last known list (${clubs.length} clubs).`);
    // Without any list, try again every 2 minutes instead of waiting for the hourly refresh.
    if (!clubs.length && !retryTimer) retryTimer = setInterval(refresh, 2 * 60 * 1000);
    return false;
  }
}

// Called before answering the page: if the list is still empty, try once more (at most every 30 s).
async function ensure() {
  if (!clubs.length && Date.now() - lastTry > 30 * 1000) await refresh();
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

module.exports = { init, list, byName, refresh, ensure, onRename, status: () => ({ count: clubs.length, loadedAt, error: lastError }) };
