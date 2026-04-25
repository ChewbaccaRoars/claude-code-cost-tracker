const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseCsv, detectColumns, modelTier, loadConsoleCsv, summarizeLocal, summarizeConsole } = require('../reconcile');

describe('parseCsv', () => {
  test('parses simple CSV', () => {
    const rows = parseCsv('a,b,c\n1,2,3\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });
  test('handles quoted commas', () => {
    const rows = parseCsv('a,b\n"hello, world",2\n');
    expect(rows[1]).toEqual(['hello, world', '2']);
  });
  test('handles escaped quotes', () => {
    const rows = parseCsv('a\n"He said ""hi"""\n');
    expect(rows[1]).toEqual(['He said "hi"']);
  });
  test('skips totally empty trailing rows', () => {
    const rows = parseCsv('a,b\n1,2\n\n');
    expect(rows.length).toBe(2);
  });
});

describe('detectColumns', () => {
  test('finds standard columns', () => {
    const cols = detectColumns(['Date', 'Model', 'Cost (USD)']);
    expect(cols.date).toBe(0);
    expect(cols.model).toBe(1);
    expect(cols.cost).toBe(2);
  });
  test('handles alternate header naming', () => {
    const cols = detectColumns(['day', 'amount']);
    expect(cols.date).toBe(0);
    expect(cols.cost).toBe(1);
  });
  test('returns -1 for missing columns', () => {
    const cols = detectColumns(['x', 'y']);
    expect(cols.cost).toBe(-1);
  });
});

describe('modelTier', () => {
  test('classifies tiers', () => {
    expect(modelTier('claude-opus-4-7')).toBe('opus');
    expect(modelTier('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelTier('claude-haiku')).toBe('haiku');
    expect(modelTier('something-else')).toBe('other');
  });
});

describe('loadConsoleCsv', () => {
  let tmpDir;
  let csvPath;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-test-'));
    csvPath = path.join(tmpDir, 'usage.csv');
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('parses date,model,cost rows', () => {
    fs.writeFileSync(csvPath, 'Date,Model,Cost\n2026-04-20,claude-opus-4-7,12.34\n2026-04-21,claude-sonnet-4-6,5.00\n');
    const { records } = loadConsoleCsv(csvPath);
    expect(records.length).toBe(2);
    expect(records[0].cost).toBeCloseTo(12.34);
    expect(records[0].tier).toBe('opus');
    expect(records[1].tier).toBe('sonnet');
  });

  test('skips zero-cost rows', () => {
    fs.writeFileSync(csvPath, 'Date,Model,Cost\n2026-04-20,claude-opus-4-7,0\n2026-04-21,claude-sonnet-4-6,5.00\n');
    const { records } = loadConsoleCsv(csvPath);
    expect(records.length).toBe(1);
  });

  test('throws when cost column missing', () => {
    fs.writeFileSync(csvPath, 'Date,Model\n2026-04-20,claude-opus-4-7\n');
    expect(() => loadConsoleCsv(csvPath)).toThrow(/cost column/i);
  });
});

describe('summarizeLocal', () => {
  test('aggregates by tier', () => {
    const entries = [
      { timestamp: '2026-04-20T10:00:00Z', total_cost_usd: 5, models: { 'claude-opus-4-7': { cost_usd: 5 } } },
      { timestamp: '2026-04-20T11:00:00Z', total_cost_usd: 3, models: { 'claude-sonnet-4-6': { cost_usd: 3 } } },
    ];
    const s = summarizeLocal(entries);
    expect(s.total).toBe(8);
    expect(s.byTier.opus).toBe(5);
    expect(s.byTier.sonnet).toBe(3);
    expect(s.byDay['2026-04-20']).toBe(8);
  });

  test('collects unknown models flagged as estimated', () => {
    const entries = [
      { timestamp: '2026-04-20T10:00:00Z', total_cost_usd: 1, models: { 'mystery-model': { cost_usd: 1, pricing_estimated: true } } },
    ];
    const s = summarizeLocal(entries);
    expect([...s.unknownModels]).toEqual(['mystery-model']);
  });
});

describe('summarizeConsole', () => {
  test('aggregates by tier', () => {
    const records = [
      { date: '2026-04-20', model: 'claude-opus-4-7', tier: 'opus', cost: 10, input: 0, output: 0, cacheW: 0, cacheR: 0 },
      { date: '2026-04-20', model: 'claude-sonnet-4-6', tier: 'sonnet', cost: 4, input: 0, output: 0, cacheW: 0, cacheR: 0 },
    ];
    const s = summarizeConsole(records);
    expect(s.total).toBe(14);
    expect(s.byTier.opus).toBe(10);
    expect(s.byTier.sonnet).toBe(4);
    expect(s.seenModels.has('claude-opus-4-7')).toBe(true);
  });
});
