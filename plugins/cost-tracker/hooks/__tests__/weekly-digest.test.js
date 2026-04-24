const { summarizePeriod, generateDigest, shouldGenerate, getWeekBounds, filterByDateRange } = require('../weekly-digest');

function makeEntry(daysAgo, cost, project) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return {
    timestamp: d.toISOString(),
    total_cost_usd: cost,
    project: project || 'test',
    models: {
      'claude-sonnet-4-6': {
        input_tokens: 10000,
        output_tokens: 5000,
        cache_read_input_tokens: 50000,
        message_count: 5,
        cost_usd: cost,
      },
    },
  };
}

describe('summarizePeriod', () => {
  test('sums costs and sessions', () => {
    const entries = [makeEntry(0, 10), makeEntry(1, 20)];
    const result = summarizePeriod(entries);
    expect(result.cost).toBe(30);
    expect(result.sessions).toBe(2);
  });

  test('groups by project', () => {
    const entries = [makeEntry(0, 10, 'A'), makeEntry(0, 20, 'B'), makeEntry(0, 5, 'A')];
    const result = summarizePeriod(entries);
    expect(result.projects['A']).toBe(15);
    expect(result.projects['B']).toBe(20);
  });

  test('empty entries', () => {
    const result = summarizePeriod([]);
    expect(result.cost).toBe(0);
    expect(result.sessions).toBe(0);
  });
});

describe('generateDigest', () => {
  test('produces markdown with comparison', () => {
    const thisWeek = summarizePeriod([makeEntry(0, 100), makeEntry(1, 50)]);
    const lastWeek = summarizePeriod([makeEntry(7, 80)]);
    const md = generateDigest(thisWeek, lastWeek, 'Week of 2026-04-20');
    expect(md).toContain('Weekly Cost Digest');
    expect(md).toContain('$150.00');
    expect(md).toContain('$80.00');
    expect(md).toContain('Change');
  });

  test('handles zero last week', () => {
    const thisWeek = summarizePeriod([makeEntry(0, 50)]);
    const lastWeek = summarizePeriod([]);
    const md = generateDigest(thisWeek, lastWeek, 'Test');
    expect(md).toContain('$50.00');
  });
});

describe('filterByDateRange', () => {
  test('filters correctly', () => {
    const now = new Date();
    const entries = [
      { timestamp: new Date(now - 86400000).toISOString() },
      { timestamp: new Date(now - 86400000 * 10).toISOString() },
    ];
    const start = new Date(now - 86400000 * 5);
    const result = filterByDateRange(entries, start, now);
    expect(result).toHaveLength(1);
  });
});

describe('getWeekBounds', () => {
  test('returns valid date ranges', () => {
    const { thisWeekStart, lastWeekStart, thisWeekEnd, lastWeekEnd } = getWeekBounds();
    expect(thisWeekStart < thisWeekEnd).toBe(true);
    expect(lastWeekStart < lastWeekEnd).toBe(true);
    expect(lastWeekEnd.getTime()).toBe(thisWeekStart.getTime());
  });
});
