// Control+ figures (members and revenue per club and month) for the KPI page.
// They come from the cplus-report service (the Control+ scraper on Render), endpoint /api/data.
//
// Environment variables:
//   CPLUS_URL  address of the cplus-report service, e.g. https://cplus-report.onrender.com
//   CPLUS_KEY  that service's API_KEY
//
// The answer is kept for 5 minutes, and the last good answer is reused when the service
// can't be reached (e.g. while it is redeploying).

const CPLUS_URL = (process.env.CPLUS_URL || '').replace(/\/+$/, '');
const CPLUS_KEY = process.env.CPLUS_KEY || '';
const TTL_MS = 5 * 60 * 1000;

// Column order and labels on the KPI page (keys = the cplus-report API keys)
const FIELDS = [
  { key: 'start', label: 'Klanten begin' },
  { key: 'end', label: 'Klanten einde' },
  { key: 'growth', label: 'Groei' },
  { key: 'growth_pct', label: 'Groei %' },
  { key: 'new', label: 'Ingeschreven' },
  { key: 'renewed', label: 'Geheractiveerd' },
  { key: 'stopped', label: 'Uitgeschreven' },
  { key: 'blocked', label: 'Geblokkeerd' },
  { key: 'revenue', label: 'Omzet' },
  { key: 'visits', label: 'Bezoeken' },
  { key: 'unique_visitors', label: 'Unieke bezoekers' },
  { key: 'active_pct', label: 'Actief %' }, // unique visitors ÷ clients at end (computed here)
  { key: 'net2_visits', label: 'Badge-bezoeken' },     // Net2: card entries by "HUPHUP <club> - klanten", 1 per member per day
  { key: 'net2_unique', label: 'Badge-bezoekers' },     // Net2: members who badged in at least once
];
const EXTRA = ['net2_accesses']; // summed, shown in the tile (all card entries)
const COMPUTED = ['growth_pct', 'active_pct'];
const activePct = (uv, end) => (typeof uv === 'number' && end ? Math.round(100 * uv / end) : null);

// "HUPHUP Beveren-Waas" and "Beveren-Waas" -> "beverenwaas"
const norm = s => String(s || '').toLowerCase().trim().replace(/^huphup\b/, '').replace(/[^0-9a-z]/g, '');

let cache = { key: '', at: 0, data: null };

const configured = () => !!(CPLUS_URL && CPLUS_KEY);

async function fetchRange(from, to) {
  if (!configured()) throw new Error('CPLUS_URL / CPLUS_KEY zijn niet ingesteld.');
  const key = `${from}|${to}`;
  if (cache.key === key && cache.data && Date.now() - cache.at < TTL_MS) return { data: cache.data, stale: false };
  const url = `${CPLUS_URL}/api/data?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000); // the service may be waking up
    const r = await fetch(url, { headers: { 'X-API-Key': CPLUS_KEY, Accept: 'application/json' }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    cache = { key, at: Date.now(), data };
    return { data, stale: false };
  } catch (e) {
    if (cache.data) return { data: cache.data, stale: true };
    throw new Error(`De Control+-gegevens konden niet opgehaald worden (${e.message}).`);
  }
}

// Sum of all rows per field; growth % recomputed as growth / start. Methods are added up too.
function total(rows) {
  const out = {};
  for (const key of [...FIELDS.map(f => f.key), ...EXTRA]) {
    if (COMPUTED.includes(key)) continue;
    const nums = rows.map(r => r[key]).filter(v => typeof v === 'number');
    out[key] = nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  }
  out.growth_pct = out.start ? Math.round(100 * out.growth / out.start) : null;
  const both = rows.filter(r => typeof r.unique_visitors === 'number' && r.end);
  out.active_pct = both.length ? activePct(both.reduce((a, r) => a + r.unique_visitors, 0), both.reduce((a, r) => a + r.end, 0)) : null;
  const methods = {};
  const excluded = {};
  // "PayConiq" and "Payconiq" from different clubs become one line (first spelling wins)
  const add = (acc, items) => { for (const [m, a] of Object.entries(items || {})) {
    const k = m.trim().toLowerCase(), cur = acc[k] || [m.trim(), 0];
    acc[k] = [cur[0], Math.round((cur[1] + (a || 0)) * 100) / 100]; } };
  for (const r of rows) { add(methods, r.methods); add(excluded, r.excluded); }
  out.methods = Object.fromEntries(Object.values(methods));
  out.excluded = Object.fromEntries(Object.values(excluded));
  out.clubs = rows.length;
  return out;
}

// clubNames: the form's club list (dashboard spelling). Returns rows with the form's club name.
function shape(data, clubNames) {
  const byNorm = new Map(clubNames.map(c => [norm(c), c]));
  const rows = [];
  for (const r of data.rows || []) {
    const club = byNorm.get(norm(r.club));
    if (!club) continue; // Control+ club that isn't in the form's club list
    if (r.error) { rows.push({ month: r.month, club, error: r.error }); continue; }
    rows.push({ month: r.month, club, methods: r.revenue_methods || {},
      excluded: r.revenue_excluded || {}, // e.g. Korting, Reeds geboekt: not part of the revenue
      ...Object.fromEntries([...FIELDS.map(f => f.key), ...EXTRA].map(k => [k, r[k] ?? null])),
      active_pct: activePct(r.unique_visitors, r.end) });
  }
  return rows;
}

module.exports = { FIELDS, configured, fetchRange, shape, total, norm };
