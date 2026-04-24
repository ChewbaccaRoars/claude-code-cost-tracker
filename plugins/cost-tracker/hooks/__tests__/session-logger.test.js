const fs = require('fs');
const path = require('path');
const os = require('os');
const { PRICING, getPricing, round4, calcCost, normalizePath, classifySession, parseTranscript } = require('../session-logger');

// --- calcCost ---

describe('calcCost', () => {
  const sonnet = PRICING['claude-sonnet-4-6'];

  test('all zeros returns zero', () => {
    expect(calcCost(sonnet, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })).toBe(0);
  });

  test('input tokens only', () => {
    const cost = calcCost(sonnet, { input_tokens: 1000000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    expect(cost).toBeCloseTo(3.0, 6);
  });

  test('output tokens only', () => {
    const cost = calcCost(sonnet, { output_tokens: 1000000, input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    expect(cost).toBeCloseTo(15.0, 6);
  });

  test('cache write tokens only', () => {
    const cost = calcCost(sonnet, { cache_creation_input_tokens: 1000000, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
    expect(cost).toBeCloseTo(3.75, 6);
  });

  test('cache read tokens only', () => {
    const cost = calcCost(sonnet, { cache_read_input_tokens: 1000000, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0 });
    expect(cost).toBeCloseTo(0.30, 6);
  });

  test('mixed tokens sum correctly', () => {
    const cost = calcCost(sonnet, { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10000 });
    const expected = 1000 * 3/1e6 + 500 * 15/1e6 + 2000 * 3.75/1e6 + 10000 * 0.30/1e6;
    expect(cost).toBeCloseTo(expected, 10);
  });

  test('missing fields treated as zero', () => {
    const cost = calcCost(sonnet, { input_tokens: 1000 });
    expect(cost).toBeCloseTo(1000 * 3/1e6, 10);
  });

  test('opus pricing produces higher costs', () => {
    const opus = PRICING['claude-opus-4-6'];
    const tokens = { input_tokens: 1000000, output_tokens: 1000000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    expect(calcCost(opus, tokens)).toBeGreaterThan(calcCost(sonnet, tokens));
  });
});

// --- getPricing ---

describe('getPricing', () => {
  test('exact match for claude-opus-4-6', () => {
    const { pricing, estimated } = getPricing('claude-opus-4-6');
    expect(pricing).toBe(PRICING['claude-opus-4-6']);
    expect(estimated).toBe(false);
  });

  test('exact match for claude-sonnet-4-6', () => {
    const { pricing, estimated } = getPricing('claude-sonnet-4-6');
    expect(pricing).toBe(PRICING['claude-sonnet-4-6']);
    expect(estimated).toBe(false);
  });

  test('exact match for claude-sonnet-4-5-20250929', () => {
    const { pricing, estimated } = getPricing('claude-sonnet-4-5-20250929');
    expect(pricing).toBe(PRICING['claude-sonnet-4-5-20250929']);
    expect(estimated).toBe(false);
  });

  test('exact match for claude-haiku-4-5-20251001', () => {
    const { pricing, estimated } = getPricing('claude-haiku-4-5-20251001');
    expect(pricing).toBe(PRICING['claude-haiku-4-5-20251001']);
    expect(estimated).toBe(false);
  });

  test('fuzzy match: model string containing "opus"', () => {
    const { pricing, estimated } = getPricing('claude-opus-4-6[1m]');
    expect(pricing).toBe(PRICING['claude-opus-4-6']);
    expect(estimated).toBe(false);
  });

  test('fuzzy match: model string containing "haiku"', () => {
    const { pricing, estimated } = getPricing('some-haiku-variant');
    expect(pricing).toBe(PRICING['claude-haiku-4-5-20251001']);
    expect(estimated).toBe(false);
  });

  test('fuzzy match: model string containing "sonnet"', () => {
    const { pricing, estimated } = getPricing('claude-sonnet-4-7-preview');
    expect(pricing).toBe(PRICING['claude-sonnet-4-6']);
    expect(estimated).toBe(false);
  });

  test('case insensitive: uppercase OPUS', () => {
    const { pricing, estimated } = getPricing('Claude-OPUS-4-6');
    expect(pricing).toBe(PRICING['claude-opus-4-6']);
    expect(estimated).toBe(false);
  });

  test('unknown model defaults to sonnet with estimated flag', () => {
    const { pricing, estimated } = getPricing('gpt-4-turbo');
    expect(pricing).toBe(PRICING['claude-sonnet-4-6']);
    expect(estimated).toBe(true);
  });

  test('empty string defaults to sonnet with estimated flag', () => {
    const { pricing, estimated } = getPricing('');
    expect(pricing).toBe(PRICING['claude-sonnet-4-6']);
    expect(estimated).toBe(true);
  });
});

// --- round4 ---

describe('round4', () => {
  test('rounds to 4 decimal places', () => {
    expect(round4(1.23456789)).toBe(1.2346);
  });

  test('zero stays zero', () => {
    expect(round4(0)).toBe(0);
  });

  test('already 4 decimals unchanged', () => {
    expect(round4(1.2345)).toBe(1.2345);
  });

  test('small value rounds correctly', () => {
    expect(round4(0.00016)).toBe(0.0002);
    expect(round4(0.00014)).toBe(0.0001);
  });
});

// --- normalizePath ---

describe('normalizePath', () => {
  test('converts Git Bash path to Windows path', () => {
    expect(normalizePath('/c/Users/test/project')).toBe('C:\\Users\\test\\project');
  });

  test('converts lowercase drive letter', () => {
    expect(normalizePath('/d/some/path')).toBe('D:\\some\\path');
  });

  test('passes through Windows path unchanged', () => {
    expect(normalizePath('C:\\Users\\test')).toBe('C:\\Users\\test');
  });

  test('passes through Unix path without drive letter unchanged', () => {
    expect(normalizePath('/home/user/project')).toBe('/home/user/project');
  });

  test('returns null for null input', () => {
    expect(normalizePath(null)).toBe(null);
  });

  test('returns undefined for undefined input', () => {
    expect(normalizePath(undefined)).toBe(undefined);
  });

  test('returns empty string for empty string', () => {
    expect(normalizePath('')).toBe('');
  });
});

// --- parseTranscript ---

describe('parseTranscript', () => {
  let tmpDir;
  let tmpFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-tracker-test-'));
    tmpFile = path.join(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTranscript(lines) {
    fs.writeFileSync(tmpFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  }

  test('single assistant message accumulates tokens', () => {
    writeTranscript([
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 500 } } },
    ]);
    const { models, peakContext } = parseTranscript(tmpFile);
    expect(models['claude-sonnet-4-6'].input_tokens).toBe(100);
    expect(models['claude-sonnet-4-6'].output_tokens).toBe(50);
    expect(models['claude-sonnet-4-6'].cache_creation_input_tokens).toBe(200);
    expect(models['claude-sonnet-4-6'].cache_read_input_tokens).toBe(500);
    expect(models['claude-sonnet-4-6'].message_count).toBe(1);
    expect(peakContext).toBe(800);
  });

  test('multiple messages from same model are summed', () => {
    writeTranscript([
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } } },
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 200, output_tokens: 75 } } },
    ]);
    const { models } = parseTranscript(tmpFile);
    expect(models['claude-sonnet-4-6'].input_tokens).toBe(300);
    expect(models['claude-sonnet-4-6'].output_tokens).toBe(125);
    expect(models['claude-sonnet-4-6'].message_count).toBe(2);
  });

  test('multiple models tracked separately', () => {
    writeTranscript([
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } } },
      { message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 300, output_tokens: 80 } } },
    ]);
    const { models } = parseTranscript(tmpFile);
    expect(Object.keys(models)).toHaveLength(2);
    expect(models['claude-sonnet-4-6'].input_tokens).toBe(100);
    expect(models['claude-haiku-4-5-20251001'].input_tokens).toBe(300);
  });

  test('non-assistant messages are skipped', () => {
    writeTranscript([
      { message: { role: 'user', usage: { input_tokens: 999 } } },
      { message: { role: 'system', usage: { input_tokens: 888 } } },
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } } },
    ]);
    const { models } = parseTranscript(tmpFile);
    expect(Object.keys(models)).toHaveLength(1);
    expect(models['claude-sonnet-4-6'].input_tokens).toBe(100);
  });

  test('messages without usage are skipped', () => {
    writeTranscript([
      { message: { role: 'assistant', model: 'claude-sonnet-4-6' } },
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } } },
    ]);
    const { models } = parseTranscript(tmpFile);
    expect(models['claude-sonnet-4-6'].message_count).toBe(1);
  });

  test('malformed JSON lines are skipped', () => {
    fs.writeFileSync(tmpFile, [
      'not valid json',
      JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } } }),
      '{broken json{{{',
    ].join('\n'));
    const { models } = parseTranscript(tmpFile);
    expect(models['claude-sonnet-4-6'].message_count).toBe(1);
  });

  test('empty transcript returns empty models', () => {
    fs.writeFileSync(tmpFile, '');
    const { models, peakContext } = parseTranscript(tmpFile);
    expect(Object.keys(models)).toHaveLength(0);
    expect(peakContext).toBe(0);
  });

  test('peak context tracks the maximum', () => {
    writeTranscript([
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300 } } },
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 } } },
      { message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } } },
    ]);
    const { peakContext } = parseTranscript(tmpFile);
    expect(peakContext).toBe(1500); // 500 + 0 + 1000
  });

  test('missing model field defaults to "unknown"', () => {
    writeTranscript([
      { message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 50 } } },
    ]);
    const { models } = parseTranscript(tmpFile);
    expect(models['unknown']).toBeDefined();
    expect(models['unknown'].input_tokens).toBe(100);
  });
});

// --- classifySession ---

describe('classifySession', () => {
  let tmpDir;
  let tmpFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-test-'));
    tmpFile = path.join(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeUserMessages(messages) {
    const lines = messages.map(text => JSON.stringify({ message: { role: 'user', content: text } }));
    fs.writeFileSync(tmpFile, lines.join('\n') + '\n');
  }

  test('classifies debug session', () => {
    writeUserMessages(['fix this bug in the auth flow', 'the error is on line 42', 'still broken']);
    expect(classifySession(tmpFile)).toBe('debug');
  });

  test('classifies build session', () => {
    writeUserMessages(['create a new React component', 'implement the login feature', 'add a button']);
    expect(classifySession(tmpFile)).toBe('build');
  });

  test('classifies review session', () => {
    writeUserMessages(['review this pull request', 'check the code quality', 'audit the security']);
    expect(classifySession(tmpFile)).toBe('review');
  });

  test('classifies test session', () => {
    writeUserMessages(['write unit tests for this', 'add jest test coverage', 'the test is failing']);
    expect(classifySession(tmpFile)).toBe('test');
  });

  test('classifies docs session', () => {
    writeUserMessages(['update the README', 'document this function', 'write a description']);
    expect(classifySession(tmpFile)).toBe('docs');
  });

  test('returns null for unclassifiable', () => {
    writeUserMessages(['hello', 'thanks']);
    expect(classifySession(tmpFile)).toBeNull();
  });

  test('returns null for empty transcript', () => {
    fs.writeFileSync(tmpFile, '');
    expect(classifySession(tmpFile)).toBeNull();
  });

  test('handles content blocks (array format)', () => {
    const lines = [JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'fix this crash' }] } })];
    fs.writeFileSync(tmpFile, lines.join('\n') + '\n');
    expect(classifySession(tmpFile)).toBe('debug');
  });
});
