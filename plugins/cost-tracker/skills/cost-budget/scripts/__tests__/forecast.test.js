const { byDay, trailingAverage, spendInRange, forecast, formatReport, dayKey } = require('../forecast');

function makeEntry(daysAgo, cost) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return { timestamp: d.toISOString(), total_cost_usd: cost };
}

describe('byDay', () => {
  test('groups entries by local day', () => {
    const entries = [makeEntry(0, 10), makeEntry(0, 5), makeEntry(1, 7)];
    const map = byDay(entries);
    const today = dayKey(new Date());
    const yest = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return dayKey(d); })();
    expect(map[today]).toBe(15);
    expect(map[yest]).toBe(7);
  });
});

describe('trailingAverage', () => {
  test('averages with zeros for inactive days', () => {
    const now = new Date();
    const map = { [dayKey(now)]: 70 };
    // Single $70 day in a 7-day window ⇒ 10/day.
    expect(trailingAverage(map, now, 7)).toBeCloseTo(10, 5);
  });
  test('zero when no activity', () => {
    expect(trailingAverage({}, new Date(), 30)).toBe(0);
  });
});

describe('spendInRange', () => {
  test('sums the inclusive range', () => {
    const now = new Date();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    const map = { [dayKey(now)]: 5, [dayKey(yesterday)]: 8 };
    expect(spendInRange(map, yesterday, now)).toBe(13);
  });
});

describe('forecast', () => {
  test('produces sane projections when there is recent activity', () => {
    const entries = [];
    for (let i = 0; i < 7; i++) entries.push(makeEntry(i, 10)); // $10/day for 7 days
    const f = forecast(entries);
    expect(f.dailyAvg7).toBeCloseTo(10, 5);
    expect(f.dailyAvg30).toBeGreaterThan(0);
    expect(f.eowHigh).toBeGreaterThanOrEqual(f.weekSoFar);
    expect(f.eomHigh).toBeGreaterThanOrEqual(f.monthSoFar);
  });

  test('zero spend when no entries', () => {
    const f = forecast([]);
    expect(f.weekSoFar).toBe(0);
    expect(f.monthSoFar).toBe(0);
    expect(f.dailyAvg7).toBe(0);
  });
});

describe('formatReport', () => {
  test('renders forecast section', () => {
    const f = forecast([makeEntry(0, 25)]);
    const text = formatReport(f, null);
    expect(text).toContain('Cost Forecast');
    expect(text).toContain('This week');
    expect(text).toContain('This month');
  });

  test('includes budget table when budget provided', () => {
    const f = forecast([makeEntry(0, 25)]);
    const text = formatReport(f, { daily: 10 });
    expect(text).toContain('vs Budget');
    expect(text).toContain('Daily');
    expect(text).toMatch(/over|near|ok/);
  });
});
