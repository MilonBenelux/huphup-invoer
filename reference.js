// Summary figures over ALL clubs, computed on the server so that a club manager's browser never
// receives rows (or anonymised rows) from clubs they don't manage. Only these numbers leave the server:
//   totals[month]  = summed L, C, A, P, I, R, F and number of shifts over all clubs (for the averages)
//   scales[level]  = lowest and highest value per column (for the length of the bars)
// The column rules match the results page: L real number; C/L, A/C, I/P percentages;
// R and F real numbers for clubs, and full-time equivalents (÷ shifts × 11·52/12) for people.

const FIELDS = ['L', 'C', 'A', 'P', 'I', 'R', 'F'];
const FULLTIME = 11 * 52 / 12;
const RATIOS = [['C/L', 'C', 'L'], ['A/C', 'A', 'C'], ['I/P', 'I', 'P']];

const emptyAgg = () => Object.fromEntries([['n', 0], ...FIELDS.map(k => [k, 0])]);
function add(a, row) { a.n++; for (const k of FIELDS) a[k] += row[k] || 0; }

function values(a, people) {
  const v = { L: a.L };
  for (const [key, num, den] of RATIOS) v[key] = a[den] ? a[num] / a[den] : null;
  for (const k of ['R', 'F']) v[k] = people ? (a.n ? a[k] / a.n * FULLTIME : null) : a[k];
  return v;
}

function minMax(aggs, people) {
  const out = {};
  for (const a of aggs) for (const [k, v] of Object.entries(values(a, people))) {
    if (v == null) continue;
    const r = out[k] || (out[k] = [v, v]);
    if (v < r[0]) r[0] = v; if (v > r[1]) r[1] = v;
  }
  return out;
}

// rows: [{ person, club, month, L, C, A, P, I, R, F }], one per shift, all clubs
function build(rows) {
  const groups = { club: new Map(), person: new Map(), personclub: new Map(), clubmonth: new Map(), personclubmonth: new Map() };
  const totals = {};
  const put = (map, key, row) => { if (!map.has(key)) map.set(key, emptyAgg()); add(map.get(key), row); };
  for (const r of rows) {
    put(groups.club, `${r.month}|${r.club}`, r);
    put(groups.person, `${r.month}|${r.person}`, r);
    put(groups.personclub, `${r.month}|${r.person}|${r.club}`, r);
    put(groups.clubmonth, `${r.club}|${r.month}`, r);
    put(groups.personclubmonth, `${r.person}|${r.club}|${r.month}`, r);
    add(totals[r.month] || (totals[r.month] = emptyAgg()), r);
  }
  const perMonth = (map, people) => {
    const byMonth = new Map();
    for (const [key, a] of map) { const m = key.split('|')[0]; if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(a); }
    return Object.fromEntries([...byMonth].map(([m, list]) => [m, minMax(list, people)]));
  };
  return {
    totals,
    scales: {
      club: perMonth(groups.club, false),
      person: perMonth(groups.person, true),
      personclub: perMonth(groups.personclub, true),
      clubmonth: minMax([...groups.clubmonth.values()], false),
      personclubmonth: minMax([...groups.personclubmonth.values()], true),
    },
  };
}

module.exports = { build };
