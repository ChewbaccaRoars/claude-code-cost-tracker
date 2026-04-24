const fs = require('fs');
const path = require('path');
const os = require('os');
const { getPricing, scanTranscript, THRESHOLDS, loadState, saveState, getStatePath } = require('../cost-monitor');

// --- getPricing ---

describe('getPricing', () => {
  test('exact match returns correct pricing', () => {
    const p = getPricing('claude-opus-4-6');
    expect(p.input).toBe(15 / 1e6);
    expect(p.output).toBe(75 / 1e6);
  });

  test('fuzzy match for opus variant', () => {
    const p = getPricing('claude-opus-4-6[1m]');
    expect(p.input).toBe(15 / 1e6);
  });

  test('unknown model defaults to sonnet', () => {
    const p = getPricing('gpt-4');
    expect(p.input).toBe(3 / 1e6);
  });

  test('null model defaults to sonnet', () => {
    const p = getPricing(null);
    expect(p.input).toBe(3 / 1e6);
  });
});

// --- scanTranscript ---

describe('scanTranscript', () => {
  let tmpDir;
  let tmpFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-monitor-test-'));
    tmpFile = path.join(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLines(lines) {
    fs.writeFileSync(tmpFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  }

  test('returns null for non-existent file', () => {
    expect(scanTranscript('/nonexistent/file.jsonl')).toBeNull();
  });

  test('returns null for null path', () => {
    expect(scanTranscript(null)).toBeNull();
  });

  test('returns null for empty transcript', () => {
    fs.writeFileSync(tmpFile, '');
    expect(scanTranscript(tmpFile)).toBeNull();
  });

  test('calculates basic stats from single message', () => {
    writeLines([
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 } } },
    ]);
    const stats = scanTranscript(tmpFile);
    expect(stats).not.toBeNull();
    expect(stats.totalInput).toBe(1000);
    expect(stats.totalOutput).toBe(500);
    expect(stats.totalCacheRead).toBe(5000);
    expect(stats.messageCount).toBe(1);
    expect(stats.primaryModel).toBe('claude-sonnet-4-6');
    expect(stats.isOpus).toBe(false);
  });

  test('identifies opus as primary model', () => {
    writeLines([
      { message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 1000, output_tokens: 500 } } },
      { message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 2000, output_tokens: 1000 } } },
    ]);
    const stats = scanTranscript(tmpFile);
    expect(stats.isOpus).toBe(true);
  });

  test('tracks peak context correctly', () => {
    writeLines([
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 50000, cache_creation_input_tokens: 100000, cache_read_input_tokens: 200000, output_tokens: 1000 } } },
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 10000, cache_creation_input_tokens: 0, cache_read_input_tokens: 50000, output_tokens: 500 } } },
    ]);
    const stats = scanTranscript(tmpFile);
    expect(stats.peakContext).toBe(350000); // 50k + 100k + 200k
  });

  test('skips non-assistant messages', () => {
    writeLines([
      { message: { role: 'user', usage: { input_tokens: 999 } } },
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } } },
    ]);
    const stats = scanTranscript(tmpFile);
    expect(stats.messageCount).toBe(1);
    expect(stats.totalInput).toBe(100);
  });

  test('calculates cost correctly', () => {
    writeLines([
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]);
    const stats = scanTranscript(tmpFile);
    expect(stats.totalCost).toBe(3.0); // 1M * $3/M
  });
});

// --- THRESHOLDS ---

describe('THRESHOLDS', () => {
  function makeStats(overrides = {}) {
    return {
      totalCost: 5.0,
      totalInput: 50000,
      totalOutput: 10000,
      totalCacheWrite: 100000,
      totalCacheRead: 400000,
      messageCount: 15,
      peakContext: 100000,
      lastContext: 50000,
      primaryModel: 'claude-sonnet-4-6',
      isOpus: false,
      ...overrides,
    };
  }

  test('context_200k triggers at 200K', () => {
    const threshold = THRESHOLDS.find(t => t.id === 'context_200k');
    expect(threshold.check(makeStats({ peakContext: 250000 }))).not.toBeNull();
    expect(threshold.check(makeStats({ peakContext: 250000 }))).toContain('/compact');
  });

  test('context_200k does not trigger below 200K', () => {
    const threshold = THRESHOLDS.find(t => t.id === 'context_200k');
    expect(threshold.check(makeStats({ peakContext: 150000 }))).toBeNull();
  });

  test('context_200k does not trigger at 500K+ (context_500k handles that)', () => {
    const threshold = THRESHOLDS.find(t => t.id === 'context_200k');
    expect(threshold.check(makeStats({ peakContext: 600000 }))).toBeNull();
  });

  test('context_500k triggers at 500K+', () => {
    const threshold = THRESHOLDS.find(t => t.id === 'context_500k');
    const msg = threshold.check(makeStats({ peakContext: 600000, totalCost: 50, messageCount: 10 }));
    expect(msg).not.toBeNull();
    expect(msg).toContain('600K');
  });

  test('cost_50 triggers between $50-$200', () => {
    const threshold = THRESHOLDS.find(t => t.id === 'cost_50');
    expect(threshold.check(makeStats({ totalCost: 75 }))).not.toBeNull();
    expect(threshold.check(makeStats({ totalCost: 30 }))).toBeNull();
    expect(threshold.check(makeStats({ totalCost: 250 }))).toBeNull();
  });

  test('cost_50 mentions Sonnet when on Opus', () => {
    const threshold = THRESHOLDS.find(t => t.id === 'cost_50');
    const msg = threshold.check(makeStats({ totalCost: 75, isOpus: true }));
    expect(msg).toContain('Sonnet');
  });

  test('cost_200 triggers at $200+', () => {
    const threshold = THRESHOLDS.find(t => t.id === 'cost_200');
    expect(threshold.check(makeStats({ totalCost: 250 }))).not.toBeNull();
    expect(threshold.check(makeStats({ totalCost: 150 }))).toBeNull();
  });

  test('opus_routine triggers at message count multiples of 20', () => {
    const threshold = THRESHOLDS.find(t => t.id === 'opus_routine');
    expect(threshold.check(makeStats({ isOpus: true, messageCount: 20, totalCost: 100 }))).not.toBeNull();
    expect(threshold.check(makeStats({ isOpus: true, messageCount: 40, totalCost: 200 }))).not.toBeNull();
    expect(threshold.check(makeStats({ isOpus: true, messageCount: 15, totalCost: 100 }))).toBeNull();
    expect(threshold.check(makeStats({ isOpus: false, messageCount: 20, totalCost: 50 }))).toBeNull();
  });

  test('low_cache triggers below 30% efficiency', () => {
    const threshold = THRESHOLDS.find(t => t.id === 'low_cache');
    // 20k cache read / (20k + 100k input) = 16.7%
    const msg = threshold.check(makeStats({ totalCacheRead: 20000, totalInput: 100000, messageCount: 10 }));
    expect(msg).not.toBeNull();
    expect(msg).toContain('Cache hit rate');
  });

  test('low_cache does not trigger above 30%', () => {
    const threshold = THRESHOLDS.find(t => t.id === 'low_cache');
    // 400k / (400k + 50k) = 88.9%
    expect(threshold.check(makeStats({ totalCacheRead: 400000, totalInput: 50000, messageCount: 10 }))).toBeNull();
  });

  test('low_cache does not trigger with few messages', () => {
    const threshold = THRESHOLDS.find(t => t.id === 'low_cache');
    expect(threshold.check(makeStats({ totalCacheRead: 1000, totalInput: 100000, messageCount: 2 }))).toBeNull();
  });
});

// --- State management ---

describe('state management', () => {
  const testSessionId = 'test-session-' + Date.now();

  afterAll(() => {
    try { fs.unlinkSync(getStatePath(testSessionId)); } catch {}
  });

  test('loadState returns empty shown array for new session', () => {
    const state = loadState('nonexistent-session-' + Date.now());
    expect(state).toEqual({ shown: [] });
  });

  test('saveState and loadState roundtrip', () => {
    const state = { shown: ['context_200k', 'cost_50'] };
    saveState(testSessionId, state);
    const loaded = loadState(testSessionId);
    expect(loaded).toEqual(state);
  });

  test('state persists across calls', () => {
    saveState(testSessionId, { shown: ['context_200k'] });
    const s1 = loadState(testSessionId);
    expect(s1.shown).toContain('context_200k');

    s1.shown.push('cost_50');
    saveState(testSessionId, s1);
    const s2 = loadState(testSessionId);
    expect(s2.shown).toEqual(['context_200k', 'cost_50']);
  });
});
