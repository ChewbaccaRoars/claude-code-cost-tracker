const fs = require('fs');
const path = require('path');
const os = require('os');
const { scanCost, fmtCost, fmtTokens, modelLabel, buildStatusline, getPricing } = require('../cost-statusline');

describe('fmtCost', () => {
  test('< $10 uses 2 decimals', () => {
    expect(fmtCost(0.5)).toBe('$0.50');
    expect(fmtCost(9.99)).toBe('$9.99');
  });
  test('$10-$99 uses 1 decimal', () => {
    expect(fmtCost(45.67)).toBe('$45.7');
  });
  test('>= $100 uses no decimals', () => {
    expect(fmtCost(123.45)).toBe('$123');
  });
});

describe('fmtTokens', () => {
  test('formats K and M', () => {
    expect(fmtTokens(500)).toBe('500');
    expect(fmtTokens(15_000)).toBe('15K');
    expect(fmtTokens(2_300_000)).toBe('2.3M');
  });
});

describe('modelLabel', () => {
  test('matches family', () => {
    expect(modelLabel('claude-opus-4-7')).toBe('Opus');
    expect(modelLabel('claude-sonnet-4-6')).toBe('Sonnet');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku');
  });
});

describe('getPricing', () => {
  test('exact match', () => {
    expect(getPricing('claude-opus-4-7').input).toBe(5 / 1e6);
  });
  test('falls back to Sonnet for unknown', () => {
    expect(getPricing('something-else').input).toBe(3 / 1e6);
  });
});

describe('scanCost', () => {
  let tmpDir;
  let tmpFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-test-'));
    tmpFile = path.join(tmpDir, 'transcript.jsonl');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns null for missing file', () => {
    expect(scanCost('/nonexistent.jsonl')).toBeNull();
    expect(scanCost(null)).toBeNull();
  });

  test('aggregates cost and last context', () => {
    fs.writeFileSync(tmpFile, [
      JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 4000 } } }),
      JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 2000, output_tokens: 600, cache_read_input_tokens: 10000, cache_creation_input_tokens: 500 } } }),
    ].join('\n'));
    const s = scanCost(tmpFile);
    expect(s.messages).toBe(2);
    expect(s.lastModel).toBe('claude-sonnet-4-6');
    expect(s.lastContext).toBe(2000 + 10000 + 500);
    expect(s.totalCost).toBeGreaterThan(0);
  });
});

describe('buildStatusline', () => {
  let tmpDir;
  let tmpFile;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-build-'));
    tmpFile = path.join(tmpDir, 'transcript.jsonl');
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('returns plain string when transcript is empty', () => {
    const out = buildStatusline({ transcript_path: '/nope', model: { display_name: 'Sonnet 4.6' } });
    expect(typeof out).toBe('string');
  });

  test('includes model and cost when transcript has data', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ message: { role: 'assistant', model: 'claude-opus-4-7', usage: { input_tokens: 1000000, output_tokens: 0 } } }));
    const out = buildStatusline({ transcript_path: tmpFile });
    expect(out).toContain('Opus');
    expect(out).toContain('$');
  });

  test('flags large context with icon', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 600000, output_tokens: 100, cache_read_input_tokens: 0 } } }));
    const out = buildStatusline({ transcript_path: tmpFile });
    expect(out).toContain('🔴');
  });
});
