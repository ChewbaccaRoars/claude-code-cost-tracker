const fs = require('fs');
const path = require('path');
const os = require('os');
const { checkBudgets, formatWarning, getSpend, getTodaySpend, buildWebhookPayload, postWebhook, maybeFireWebhook, webhookKey, loadWebhookState, saveWebhookState } = require('../budget-check');

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

describe('webhook payload', () => {
  test('contains required fields', () => {
    const p = buildWebhookPayload({ level: 'exceeded', period: 'daily', spend: '120.00', limit: 100, pct: 120 });
    expect(p.text).toContain('Claude Code');
    expect(p.spend_usd).toBe(120);
    expect(p.limit_usd).toBe(100);
    expect(p.pct).toBe(120);
    expect(p.period).toBe('daily');
    expect(p.level).toBe('exceeded');
    expect(p.timestamp).toBeDefined();
  });

  test('exceeded uses red icon', () => {
    const p = buildWebhookPayload({ level: 'exceeded', period: 'daily', spend: '120.00', limit: 100, pct: 120 });
    expect(p.text).toContain(':rotating_light:');
  });

  test('warning uses yellow icon', () => {
    const p = buildWebhookPayload({ level: 'warning', period: 'daily', spend: '80.00', limit: 100, pct: 80 });
    expect(p.text).toContain(':warning:');
  });
});

describe('webhookKey', () => {
  test('includes period and level', () => {
    const k = webhookKey({ period: 'weekly', level: 'exceeded' });
    expect(k).toContain('weekly');
    expect(k).toContain('exceeded');
    expect(k).toMatch(/^\d{4}-\d{2}-\d{2}:/);
  });
});

describe('webhook firing', () => {
  // Use a unique key for each test by manipulating the state file
  let stateFile;
  beforeEach(() => {
    const s = loadWebhookState();
    stateFile = s.path;
    s.data = { fired: [] };
    saveWebhookState(s);
  });
  afterEach(() => { try { fs.unlinkSync(stateFile); } catch {} });

  test('skips when webhook_url missing', async () => {
    const res = await maybeFireWebhook({}, { level: 'exceeded', period: 'daily', spend: '100', limit: 50, pct: 200 });
    expect(res).toBeNull();
  });

  test('skips invalid url scheme', async () => {
    const res = await maybeFireWebhook({ webhook_url: 'ftp://nope' }, { level: 'exceeded', period: 'daily', spend: '100', limit: 50, pct: 200 });
    expect(res).toBeNull();
  });

  test('skips duplicates within the same UTC day', async () => {
    // Stub fetch so we don't make a real network call
    const origFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: true, status: 200 }; };
    try {
      const w = { level: 'warning', period: 'daily', spend: '80', limit: 100, pct: 80 };
      const r1 = await maybeFireWebhook({ webhook_url: 'https://example.com/hook' }, w);
      const r2 = await maybeFireWebhook({ webhook_url: 'https://example.com/hook' }, w);
      expect(r1).not.toBeNull();
      expect(r2).toBeNull();
      expect(calls).toBe(1);
    } finally {
      global.fetch = origFetch;
    }
  });
});

describe('postWebhook', () => {
  test('returns ok=false on missing fetch', async () => {
    const origFetch = global.fetch;
    delete global.fetch;
    try {
      const res = await postWebhook('https://example.com', { hello: 'world' });
      expect(res.ok).toBe(false);
    } finally {
      if (origFetch) global.fetch = origFetch;
    }
  });

  test('returns status when fetch succeeds', async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 204 });
    try {
      const res = await postWebhook('https://example.com', { hello: 'world' });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(204);
    } finally {
      global.fetch = origFetch;
    }
  });
});
