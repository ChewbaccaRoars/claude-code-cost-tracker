// plugins/cost-tracker/lib/pricing-engine.js
const fs = require('fs');
const path = require('path');

const BASE_PRICING = {
  'claude-opus-4-7':            { input: 5/1e6, output: 25/1e6, cache_write: 6.25/1e6, cache_read: 0.50/1e6 },
  'claude-opus-4-6':            { input: 5/1e6, output: 25/1e6, cache_write: 6.25/1e6, cache_read: 0.50/1e6 },
  'claude-sonnet-4-6':          { input: 3/1e6, output: 15/1e6, cache_write: 3.75/1e6, cache_read: 0.30/1e6 },
  'claude-sonnet-4-5-20250929': { input: 3/1e6, output: 15/1e6, cache_write: 3.75/1e6, cache_read: 0.30/1e6 },
  'claude-haiku-4-5-20251001':  { input: 1/1e6, output: 5/1e6,  cache_write: 1.25/1e6, cache_read: 0.10/1e6 },
};

const RUNTIMES = {
  'claude-code': { markup: 1.0, per_million_surcharge: 0 },
  'cursor':      { markup: 0.93, per_million_surcharge: 0.25 },
};

const COMPARISON_MODELS = {
  opus:   BASE_PRICING['claude-opus-4-6'],
  sonnet: BASE_PRICING['claude-sonnet-4-6'],
  haiku:  BASE_PRICING['claude-haiku-4-5-20251001'],
};

function getPricing(model, _runtime) {
  if (BASE_PRICING[model]) return { pricing: BASE_PRICING[model], estimated: false };
  const lower = model.toLowerCase();
  if (lower.includes('opus'))   return { pricing: BASE_PRICING['claude-opus-4-6'], estimated: false };
  if (lower.includes('haiku'))  return { pricing: BASE_PRICING['claude-haiku-4-5-20251001'], estimated: false };
  if (lower.includes('sonnet')) return { pricing: BASE_PRICING['claude-sonnet-4-6'], estimated: false };
  return { pricing: BASE_PRICING['claude-sonnet-4-6'], estimated: true };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function calcCost(pricing, tokens, runtime) {
  const input   = (tokens.input_tokens || 0) * pricing.input;
  const output  = (tokens.output_tokens || 0) * pricing.output;
  const cacheW  = (tokens.cache_creation_input_tokens || 0) * pricing.cache_write;
  const cacheR  = (tokens.cache_read_input_tokens || 0) * pricing.cache_read;
  const baseCost = input + output + cacheW + cacheR;

  if (baseCost === 0) return 0;

  const rt = RUNTIMES[runtime] || RUNTIMES['claude-code'];
  const totalTokens = (tokens.input_tokens || 0) + (tokens.output_tokens || 0)
    + (tokens.cache_creation_input_tokens || 0) + (tokens.cache_read_input_tokens || 0);
  return (baseCost * rt.markup) + (totalTokens / 1e6 * rt.per_million_surcharge);
}

function detectRuntime() {
  if (process.env.CURSOR_SESSION || process.env.CURSOR_TRACE_ID) return 'cursor';
  const home = process.env.HOME || process.env.USERPROFILE;
  try {
    const configPath = path.join(home, '.claude', 'cost-tracker', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.runtime && RUNTIMES[config.runtime]) return config.runtime;
  } catch {}
  return 'claude-code';
}

module.exports = {
  BASE_PRICING, RUNTIMES, COMPARISON_MODELS,
  getPricing, calcCost, detectRuntime, round4,
};
