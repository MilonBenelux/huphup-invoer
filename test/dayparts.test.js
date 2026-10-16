// node test/dayparts.test.js  — checks the 11:00 / 18:00 / 30-day rules in Belgian time
const assert = require('assert');
const { availableParts, isAllowed } = require('../dayparts');

// Belgian summer time is UTC+2 in October (until 25 Oct 2026), so 09:00Z = 11:00 local.
const at = iso => new Date(iso);

let p = availableParts(at('2026-10-16T08:59:00Z')); // 10:59 local
assert.deepStrictEqual(p[0], { date: '2026-10-15', part: 'NM' }, 'before 11:00 → yesterday NM first');

p = availableParts(at('2026-10-16T09:00:00Z'));     // 11:00 local
assert.deepStrictEqual(p[0], { date: '2026-10-16', part: 'VM' }, 'from 11:00 → today VM');

p = availableParts(at('2026-10-16T16:00:00Z'));     // 18:00 local
assert.deepStrictEqual(p[0], { date: '2026-10-16', part: 'NM' }, 'from 18:00 → today NM');

p = availableParts(at('2026-10-16T22:30:00Z'));     // 00:30 local on the 17th
assert.deepStrictEqual(p[0], { date: '2026-10-16', part: 'NM' }, 'just after midnight → previous evening');

const now = at('2026-10-16T10:00:00Z');             // 12:00 local
assert.ok(isAllowed('2026-10-16', 'VM', now));
assert.ok(!isAllowed('2026-10-16', 'NM', now), 'NM today not before 18:00');
assert.ok(!isAllowed('2026-10-17', 'VM', now), 'no future days');
assert.ok(isAllowed('2026-09-16', 'NM', now), '30 days back is allowed');
assert.ok(!isAllowed('2026-09-15', 'NM', now), '31 days back is not');

// Winter time (UTC+1): 10:00Z = 11:00 local on 2 Dec
assert.deepStrictEqual(availableParts(at('2026-12-02T10:00:00Z'))[0], { date: '2026-12-02', part: 'VM' });

console.log('All daypart rules pass.');
