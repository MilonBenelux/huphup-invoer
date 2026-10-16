// Daypart rules, always evaluated in Belgian time (the Render server runs in UTC).
// - VM of a day becomes available at 11:00, NM at 18:00.
// - Nothing in the future, nothing older than 30 days.

const TZ = 'Europe/Brussels';
const MAX_DAYS_BACK = 30;
const VM_FROM_HOUR = 11;
const NM_FROM_HOUR = 18;

function brusselsNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function shiftDate(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Newest first: [{date:'2026-10-16', part:'VM'}, {date:'2026-10-15', part:'NM'}, ...]
function availableParts(now = new Date()) {
  const { date: today, hour } = brusselsNow(now);
  const out = [];
  for (let i = 0; i <= MAX_DAYS_BACK; i++) {
    const date = shiftDate(today, -i);
    for (const part of ['NM', 'VM']) {
      if (i === 0 && part === 'NM' && hour < NM_FROM_HOUR) continue;
      if (i === 0 && part === 'VM' && hour < VM_FROM_HOUR) continue;
      out.push({ date, part });
    }
  }
  return out;
}

function isAllowed(date, part, now = new Date()) {
  return availableParts(now).some(p => p.date === date && p.part === part);
}

module.exports = { availableParts, isAllowed, brusselsNow, shiftDate, TZ };
