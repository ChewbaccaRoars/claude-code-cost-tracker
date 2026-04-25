#!/usr/bin/env node
// Claude Code statusline: shows running session cost and context size.
// Receives JSON via stdin: { session_id, transcript_path, model, cwd, ... }
// Emits a single line of plain text on stdout.

const fs = require('fs');
const path = require('path');

const PRICING = {
  'claude-opus-4-7':            { input: 5/1e6, output: 25/1e6, cache_write: 6.25/1e6, cache_read: 0.50/1e6 },
  'claude-opus-4-6':            { input: 5/1e6, output: 25/1e6, cache_write: 6.25/1e6, cache_read: 0.50/1e6 },
  'claude-sonnet-4-6':          { input: 3/1e6, output: 15/1e6, cache_write: 3.75/1e6, cache_read: 0.30/1e6 },
  'claude-sonnet-4-5-20250929': { input: 3/1e6, output: 15/1e6, cache_write: 3.75/1e6, cache_read: 0.30/1e6 },
  'claude-haiku-4-5-20251001':  { input: 1/1e6, output: 5/1e6,  cache_write: 1.25/1e6, cache_read: 0.10/1e6 },
};

function getPricing(model) {
  if (PRICING[model]) return PRICING[model];
  const lower = (model || '').toLowerCase();
  if (lower.includes('opus'))   return PRICING['claude-opus-4-6'];
  if (lower.includes('haiku'))  return PRICING['claude-haiku-4-5-20251001'];
  if (lower.includes('sonnet')) return PRICING['claude-sonnet-4-6'];
  return PRICING['claude-sonnet-4-6'];
}

function normalizePath(p) {
  if (!p) return p;
  const match = p.match(/^\/([a-zA-Z])\/(.*)/);
  if (match) return match[1].toUpperCase() + ':\\' + match[2].replace(/\//g, '\\');
  return p;
}

function modelLabel(model) {
  const lower = (model || '').toLowerCase();
  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('haiku')) return 'Haiku';
  if (lower.includes('sonnet')) return 'Sonnet';
  return model || '?';
}

function scanCost(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const content = fs.readFileSync(transcriptPath, 'utf8');
  const lines = content.split('\n').filter(Boolean);

  let totalCost = 0;
  let lastInput = 0, lastCacheRead = 0, lastCacheWrite = 0;
  let messages = 0;
  let lastModel = null;
  let cacheRead = 0, totalInput = 0;

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.message || entry.message.role !== 'assistant' || !entry.message.usage) continue;
    const usage = entry.message.usage;
    const model = entry.message.model || 'unknown';
    const p = getPricing(model);
    totalCost += (usage.input_tokens || 0) * p.input
              + (usage.output_tokens || 0) * p.output
              + (usage.cache_creation_input_tokens || 0) * p.cache_write
              + (usage.cache_read_input_tokens || 0) * p.cache_read;
    lastInput = usage.input_tokens || 0;
    lastCacheRead = usage.cache_read_input_tokens || 0;
    lastCacheWrite = usage.cache_creation_input_tokens || 0;
    cacheRead += lastCacheRead;
    totalInput += lastInput;
    messages += 1;
    lastModel = model;
  }

  if (messages === 0) return null;
  const lastContext = lastInput + lastCacheRead + lastCacheWrite;
  const cacheEff = (cacheRead + totalInput) > 0 ? cacheRead / (cacheRead + totalInput) : 0;
  return { totalCost, messages, lastContext, lastModel, cacheEff };
}

function loadTodaySpend() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return 0;
  const logPath = path.join(home, '.claude', 'cost-tracker', 'cost-log.jsonl');
  if (!fs.existsSync(logPath)) return 0;
  try {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let total = 0;
    for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.timestamp && e.timestamp.slice(0, 10) === today) total += e.total_cost_usd || 0;
      } catch {}
    }
    return total;
  } catch {
    return 0;
  }
}

function loadBudget() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const budgetPath = path.join(home, '.claude', 'cost-tracker', 'budget.json');
  try { return JSON.parse(fs.readFileSync(budgetPath, 'utf8')); } catch { return null; }
}

function fmtCost(n) {
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 10) return '$' + n.toFixed(1);
  return '$' + n.toFixed(2);
}

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1000) + 'K';
  return String(n);
}

function buildStatusline(payload) {
  const transcriptPath = normalizePath(payload && payload.transcript_path);
  const stats = scanCost(transcriptPath);

  const parts = [];

  if (stats) {
    const sessionCost = fmtCost(stats.totalCost);
    const ctx = fmtTokens(stats.lastContext);
    const model = modelLabel(stats.lastModel || (payload && payload.model && payload.model.id));
    let segment = `${model} • ${sessionCost} • ${ctx}`;
    // Visual cue when context grows large
    if (stats.lastContext >= 500000) segment = '🔴 ' + segment;
    else if (stats.lastContext >= 200000) segment = '🟡 ' + segment;
    parts.push(segment);
  } else if (payload && payload.model && payload.model.display_name) {
    parts.push(payload.model.display_name);
  }

  // Today + budget
  const todaySpend = loadTodaySpend();
  const budget = loadBudget();
  if (budget && budget.daily) {
    const pct = Math.round((todaySpend / budget.daily) * 100);
    let icon = '';
    if (pct >= 100) icon = '🚨 ';
    else if (pct >= 80) icon = '⚠️ ';
    parts.push(`${icon}today ${fmtCost(todaySpend)}/${fmtCost(budget.daily)} (${pct}%)`);
  } else if (todaySpend > 0) {
    parts.push(`today ${fmtCost(todaySpend)}`);
  }

  return parts.join(' │ ');
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch {}
  const line = buildStatusline(payload);
  process.stdout.write(line);
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`cost-statusline: ${err.message}\n`);
    process.exit(0);
  });
}

module.exports = { PRICING, getPricing, modelLabel, scanCost, loadTodaySpend, loadBudget, fmtCost, fmtTokens, buildStatusline, normalizePath };
