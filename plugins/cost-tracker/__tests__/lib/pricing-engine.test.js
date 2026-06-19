// plugins/cost-tracker/__tests__/lib/pricing-engine.test.js
const path = require('path');

// pricing-engine doesn't exist yet, so this will fail
const {
  BASE_PRICING, RUNTIMES, COMPARISON_MODELS,
  getPricing, calcCost, detectRuntime, round4,
} = require('../../lib/pricing-engine');

describe('BASE_PRICING', () => {
  test('has all 5 known models', () => {
    expect(Object.keys(BASE_PRICING)).toHaveLength(5);
    expect(BASE_PRICING['claude-opus-4-7']).toBeDefined();
    expect(BASE_PRICING['claude-opus-4-6']).toBeDefined();
    expect(BASE_PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(BASE_PRICING['claude-sonnet-4-5-20250929']).toBeDefined();
    expect(BASE_PRICING['claude-haiku-4-5-20251001']).toBeDefined();
  });

  test('each model has input, output, cache_write, cache_read', () => {
    for (const model of Object.values(BASE_PRICING)) {
      expect(model).toHaveProperty('input');
      expect(model).toHaveProperty('output');
      expect(model).toHaveProperty('cache_write');
      expect(model).toHaveProperty('cache_read');
    }
  });

  test('opus input is 5/1e6', () => {
    expect(BASE_PRICING['claude-opus-4-6'].input).toBeCloseTo(5 / 1e6, 10);
  });

  test('sonnet input is 3/1e6', () => {
    expect(BASE_PRICING['claude-sonnet-4-6'].input).toBeCloseTo(3 / 1e6, 10);
  });

  test('haiku input is 1/1e6', () => {
    expect(BASE_PRICING['claude-haiku-4-5-20251001'].input).toBeCloseTo(1 / 1e6, 10);
  });
});

describe('RUNTIMES', () => {
  test('claude-code has markup 1.0 and surcharge 0', () => {
    expect(RUNTIMES['claude-code']).toEqual({ markup: 1.0, per_million_surcharge: 0 });
  });

  test('cursor has markup 0.93 and surcharge 0.25', () => {
    expect(RUNTIMES['cursor']).toEqual({ markup: 0.93, per_million_surcharge: 0.25 });
  });
});

describe('getPricing', () => {
  test('exact match returns pricing and estimated=false', () => {
    const { pricing, estimated } = getPricing('claude-opus-4-6');
    expect(pricing).toBe(BASE_PRICING['claude-opus-4-6']);
    expect(estimated).toBe(false);
  });

  test('fuzzy match: string containing "opus"', () => {
    const { pricing, estimated } = getPricing('claude-opus-4-6[1m]');
    expect(pricing).toBe(BASE_PRICING['claude-opus-4-6']);
    expect(estimated).toBe(false);
  });

  test('fuzzy match: string containing "haiku"', () => {
    const { pricing } = getPricing('some-haiku-variant');
    expect(pricing).toBe(BASE_PRICING['claude-haiku-4-5-20251001']);
  });

  test('unknown model defaults to sonnet with estimated=true', () => {
    const { pricing, estimated } = getPricing('gpt-4-turbo');
    expect(pricing).toBe(BASE_PRICING['claude-sonnet-4-6']);
    expect(estimated).toBe(true);
  });

  test('runtime parameter does not affect which pricing row is returned', () => {
    const cc = getPricing('claude-opus-4-6', 'claude-code');
    const cursor = getPricing('claude-opus-4-6', 'cursor');
    expect(cc.pricing).toBe(cursor.pricing);
  });
});

describe('calcCost', () => {
  const sonnet = BASE_PRICING['claude-sonnet-4-6'];
  const tokens = { input_tokens: 1000000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  test('claude-code runtime: no markup, no surcharge', () => {
    const cost = calcCost(sonnet, tokens, 'claude-code');
    expect(cost).toBeCloseTo(3.0, 6);
  });

  test('cursor runtime: 93% markup + $0.25/M surcharge', () => {
    const cost = calcCost(sonnet, tokens, 'cursor');
    // base cost = 3.0, cursor = (3.0 * 0.93) + (1M / 1M * 0.25) = 2.79 + 0.25 = 3.04
    expect(cost).toBeCloseTo(3.04, 2);
  });

  test('defaults to claude-code when no runtime specified', () => {
    const cost = calcCost(sonnet, tokens);
    expect(cost).toBeCloseTo(3.0, 6);
  });

  test('cursor surcharge scales with total tokens', () => {
    const bigTokens = { input_tokens: 5000000, output_tokens: 5000000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const cost = calcCost(sonnet, bigTokens, 'cursor');
    const baseCost = 5000000 * sonnet.input + 5000000 * sonnet.output;
    const expected = (baseCost * 0.93) + (10000000 / 1e6 * 0.25);
    expect(cost).toBeCloseTo(expected, 2);
  });

  test('all zeros returns zero for both runtimes', () => {
    const z = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    expect(calcCost(sonnet, z, 'claude-code')).toBe(0);
    expect(calcCost(sonnet, z, 'cursor')).toBe(0);
  });

  test('missing fields treated as zero', () => {
    const cost = calcCost(sonnet, { input_tokens: 1000 });
    expect(cost).toBeCloseTo(1000 * 3 / 1e6, 10);
  });
});

describe('COMPARISON_MODELS', () => {
  test('has opus, sonnet, haiku keys', () => {
    expect(COMPARISON_MODELS).toHaveProperty('opus');
    expect(COMPARISON_MODELS).toHaveProperty('sonnet');
    expect(COMPARISON_MODELS).toHaveProperty('haiku');
  });

  test('opus points to opus-4-6 pricing', () => {
    expect(COMPARISON_MODELS.opus).toBe(BASE_PRICING['claude-opus-4-6']);
  });
});

describe('detectRuntime', () => {
  const origEnv = process.env;

  afterEach(() => {
    process.env = origEnv;
  });

  test('returns claude-code by default', () => {
    process.env = { ...origEnv };
    delete process.env.CURSOR_SESSION;
    delete process.env.CURSOR_TRACE_ID;
    expect(detectRuntime()).toBe('claude-code');
  });

  test('returns cursor when CURSOR_SESSION is set', () => {
    process.env = { ...origEnv, CURSOR_SESSION: '1' };
    expect(detectRuntime()).toBe('cursor');
  });

  test('returns cursor when CURSOR_TRACE_ID is set', () => {
    process.env = { ...origEnv, CURSOR_TRACE_ID: 'abc' };
    expect(detectRuntime()).toBe('cursor');
  });
});

describe('round4', () => {
  test('rounds to 4 decimal places', () => {
    expect(round4(1.23456789)).toBe(1.2346);
  });

  test('zero stays zero', () => {
    expect(round4(0)).toBe(0);
  });
});
