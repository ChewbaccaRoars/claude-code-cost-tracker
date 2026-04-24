const { checkBudgets, formatWarning, getSpend, getTodaySpend } = require('../budget-check');

function makeEntry(daysAgo, cost) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return { timestamp: d.toISOString(), total_cost_usd: cost };
}

describe('checkBudgets', () => {
  test('no warnings when under budget', () => {
    const budget = { daily: 100, weekly: 500, monthly: 2000 };
    const entries = [makeEntry(0, 10)];
    expect(checkBudgets(budget, entries)).toHaveLength(0);
  });

  test('warning at 80% daily', () => {
    const budget = { daily: 100 };
    const entries = [makeEntry(0, 85)];
    const warnings = checkBudgets(budget, entries);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe('warning');
    expect(warnings[0].period).toBe('daily');
  });

  test('exceeded at 100% daily', () => {
    const budget = { daily: 100 };
    const entries = [makeEntry(0, 110)];
    const warnings = checkBudgets(budget, entries);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe('exceeded');
  });

  test('weekly budget checks 7 days', () => {
    const budget = { weekly: 500 };
    const entries = [makeEntry(0, 100), makeEntry(3, 200), makeEntry(5, 250)];
    const warnings = checkBudgets(budget, entries);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe('exceeded');
    expect(warnings[0].period).toBe('weekly');
  });

  test('old entries dont count for weekly', () => {
    const budget = { weekly: 500 };
    const entries = [makeEntry(0, 50), makeEntry(10, 1000)];
    expect(checkBudgets(budget, entries)).toHaveLength(0);
  });

  test('no budget returns no warnings', () => {
    expect(checkBudgets({}, [makeEntry(0, 999)])).toHaveLength(0);
  });
});

describe('formatWarning', () => {
  test('exceeded format', () => {
    const msg = formatWarning({ level: 'exceeded', spend: '110.00', limit: 100, pct: 110, period: 'daily' });
    expect(msg).toContain('EXCEEDED');
    expect(msg).toContain('$110.00');
  });

  test('warning format', () => {
    const msg = formatWarning({ level: 'warning', spend: '85.00', limit: 100, pct: 85, period: 'weekly' });
    expect(msg).toContain('alert');
    expect(msg).toContain('85%');
  });
});
