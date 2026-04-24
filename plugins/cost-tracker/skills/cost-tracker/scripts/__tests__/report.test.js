const { filterByDate, filterToday, fmtNumber, fmtCost, escapeCsv, summarize } = require('../report');

// --- fmtCost ---

describe('fmtCost', () => {
  test('formats to 4 decimal places with dollar sign', () => {
    expect(fmtCost(1.5)).toBe('$1.5000');
  });

  test('zero', () => {
    expect(fmtCost(0)).toBe('$0.0000');
  });

  test('large number', () => {
    expect(fmtCost(123.456789)).toBe('$123.4568');
  });
});

// --- fmtNumber ---

describe('fmtNumber', () => {
  test('formats with commas', () => {
    expect(fmtNumber(1000000)).toBe('1,000,000');
  });

  test('small number unchanged', () => {
    expect(fmtNumber(42)).toBe('42');
  });
});

// --- filterByDate ---

describe('filterByDate', () => {
  test('filters entries within date range', () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const lastWeek = new Date(now);
    lastWeek.setDate(lastWeek.getDate() - 8);

    const entries = [
      { timestamp: now.toISOString(), total_cost_usd: 1 },
      { timestamp: yesterday.toISOString(), total_cost_usd: 2 },
      { timestamp: lastWeek.toISOString(), total_cost_usd: 3 },
    ];

    const result = filterByDate(entries, 7);
    expect(result).toHaveLength(2);
    expect(result[0].total_cost_usd).toBe(1);
    expect(result[1].total_cost_usd).toBe(2);
  });

  test('returns empty for no matching entries', () => {
    const old = new Date('2020-01-01');
    const entries = [{ timestamp: old.toISOString(), total_cost_usd: 1 }];
    expect(filterByDate(entries, 1)).toHaveLength(0);
  });

  test('empty input returns empty', () => {
    expect(filterByDate([], 7)).toHaveLength(0);
  });
});

// --- filterToday ---

describe('filterToday', () => {
  test('returns only entries from today (local time)', () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    const entries = [
      { timestamp: now.toISOString(), total_cost_usd: 1 },
      { timestamp: yesterday.toISOString(), total_cost_usd: 2 },
    ];

    const result = filterToday(entries);
    expect(result).toHaveLength(1);
    expect(result[0].total_cost_usd).toBe(1);
  });

  test('empty input returns empty', () => {
    expect(filterToday([])).toHaveLength(0);
  });
});

// --- summarize ---

describe('summarize', () => {
  let output;
  const origLog = console.log;

  beforeEach(() => {
    output = [];
    console.log = (...args) => output.push(args.join(' '));
  });

  afterEach(() => {
    console.log = origLog;
  });

  test('handles empty entries', () => {
    summarize([], 'Test');
    expect(output.join('\n')).toContain('No sessions recorded');
  });

  test('handles entry with missing models field', () => {
    const entries = [{ timestamp: new Date().toISOString(), total_cost_usd: 1.5, project: 'test' }];
    expect(() => summarize(entries, 'Test')).not.toThrow();
  });

  test('handles entry with missing total_cost_usd', () => {
    const entries = [{
      timestamp: new Date().toISOString(),
      project: 'test',
      models: { 'claude-sonnet-4-6': { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, message_count: 1, cost_usd: 0.001 } },
    }];
    expect(() => summarize(entries, 'Test')).not.toThrow();
    expect(output.join('\n')).toContain('$0.0000');
  });

  test('comparisonOnly skips token breakdown and per-project', () => {
    const entries = [{
      timestamp: new Date().toISOString(),
      total_cost_usd: 1.5,
      project: 'test',
      models: { 'claude-sonnet-4-6': { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, message_count: 1, cost_usd: 1.5 } },
      model_comparison: { opus: 5.0, sonnet: 1.5, haiku: 0.4 },
    }];
    summarize(entries, 'Compare Test', true);
    const text = output.join('\n');
    expect(text).toContain('Model Comparison');
    expect(text).not.toContain('Token Breakdown');
    expect(text).not.toContain('Per-Project');
  });

  test('cache efficiency uses correct formula (excludes cache_write from denominator)', () => {
    const entries = [{
      timestamp: new Date().toISOString(),
      total_cost_usd: 1.0,
      project: 'test',
      models: {
        'claude-sonnet-4-6': {
          input_tokens: 200,
          output_tokens: 100,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 800,
          message_count: 1,
          cost_usd: 1.0,
        },
      },
      model_comparison: { opus: 5.0, sonnet: 1.0, haiku: 0.3 },
    }];
    summarize(entries, 'Test');
    const text = output.join('\n');
    // cache_read / (cache_read + input) = 800 / (800 + 200) = 80.0%
    expect(text).toContain('80.0%');
  });

  test('correctly sums multiple sessions', () => {
    const entries = [
      {
        timestamp: new Date().toISOString(),
        total_cost_usd: 1.0,
        project: 'app-a',
        models: { 'claude-sonnet-4-6': { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, message_count: 1, cost_usd: 1.0 } },
        model_comparison: { opus: 5.0, sonnet: 1.0, haiku: 0.3 },
      },
      {
        timestamp: new Date().toISOString(),
        total_cost_usd: 2.0,
        project: 'app-b',
        models: { 'claude-sonnet-4-6': { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, message_count: 2, cost_usd: 2.0 } },
        model_comparison: { opus: 10.0, sonnet: 2.0, haiku: 0.6 },
      },
    ];
    summarize(entries, 'Test');
    const text = output.join('\n');
    expect(text).toContain('Sessions:** 2');
    expect(text).toContain('$3.0000');
  });
});

// --- escapeCsv ---

describe('escapeCsv', () => {
  test('plain string unchanged', () => {
    expect(escapeCsv('hello')).toBe('hello');
  });

  test('string with comma gets quoted', () => {
    expect(escapeCsv('hello, world')).toBe('"hello, world"');
  });

  test('string with quotes gets escaped', () => {
    expect(escapeCsv('say "hi"')).toBe('"say ""hi"""');
  });

  test('null becomes empty string', () => {
    expect(escapeCsv(null)).toBe('');
  });

  test('number is stringified', () => {
    expect(escapeCsv(42)).toBe('42');
  });

  test('string with newline gets quoted', () => {
    expect(escapeCsv('line1\nline2')).toBe('"line1\nline2"');
  });
});
