const fs = require('fs');
const path = require('path');

const logPath = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'cost-tracker', 'cost-log.jsonl');

function loadEntries() {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function filterByDate(entries, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return entries.filter(e => new Date(e.timestamp) >= cutoff);
}

function filterToday(entries) {
  const today = new Date().toISOString().slice(0, 10);
  return entries.filter(e => e.timestamp.slice(0, 10) === today);
}

function fmt(n) { return n.toLocaleString('en-US'); }
function fmtCost(n) { return '$' + n.toFixed(4); }

function summarize(entries, label) {
  if (entries.length === 0) { console.log(`\n**${label}**: No sessions recorded.\n`); return; }

  let totalCost = 0;
  const projectCosts = {};
  const modelTotals = {};
  const compTotals = { opus: 0, sonnet: 0, haiku: 0 };
  let totalInput = 0, totalOutput = 0, totalCacheWrite = 0, totalCacheRead = 0;
  const dailyCosts = {};

  for (const e of entries) {
    totalCost += e.total_cost_usd;
    const day = e.timestamp.slice(0, 10);
    dailyCosts[day] = (dailyCosts[day] || 0) + e.total_cost_usd;

    if (!projectCosts[e.project]) projectCosts[e.project] = { cost: 0, sessions: 0 };
    projectCosts[e.project].cost += e.total_cost_usd;
    projectCosts[e.project].sessions += 1;

    for (const [model, data] of Object.entries(e.models)) {
      if (!modelTotals[model]) modelTotals[model] = { cost: 0, messages: 0 };
      modelTotals[model].cost += data.cost_usd;
      modelTotals[model].messages += data.message_count;
      totalInput += data.input_tokens;
      totalOutput += data.output_tokens;
      totalCacheWrite += data.cache_creation_input_tokens;
      totalCacheRead += data.cache_read_input_tokens;
    }

    if (e.model_comparison) {
      compTotals.opus += e.model_comparison.opus || 0;
      compTotals.sonnet += e.model_comparison.sonnet || 0;
      compTotals.haiku += e.model_comparison.haiku || 0;
    }
  }

  const cacheEfficiency = (totalCacheRead + totalInput + totalCacheWrite) > 0
    ? ((totalCacheRead / (totalCacheRead + totalInput + totalCacheWrite)) * 100).toFixed(1)
    : '0.0';

  console.log(`\n## ${label}`);
  console.log(`\n**Sessions:** ${entries.length} | **Total Cost:** ${fmtCost(totalCost)}`);
  console.log(`\n### Token Breakdown`);
  console.log(`| Type | Count |`);
  console.log(`|------|-------|`);
  console.log(`| Input | ${fmt(totalInput)} |`);
  console.log(`| Output | ${fmt(totalOutput)} |`);
  console.log(`| Cache Write | ${fmt(totalCacheWrite)} |`);
  console.log(`| Cache Read | ${fmt(totalCacheRead)} |`);
  console.log(`| **Cache Efficiency** | **${cacheEfficiency}%** |`);

  console.log(`\n### Per-Project Costs`);
  console.log(`| Project | Sessions | Cost |`);
  console.log(`|---------|----------|------|`);
  const sorted = Object.entries(projectCosts).sort((a, b) => b[1].cost - a[1].cost);
  for (const [proj, data] of sorted) {
    console.log(`| ${proj} | ${data.sessions} | ${fmtCost(data.cost)} |`);
  }

  console.log(`\n### Model Comparison`);
  console.log(`*What this work would cost on each model:*`);
  console.log(`| Model | Cost | vs Actual |`);
  console.log(`|-------|------|-----------|`);
  for (const [name, cost] of Object.entries(compTotals)) {
    const diff = cost - totalCost;
    const pct = totalCost > 0 ? ((diff / totalCost) * 100).toFixed(0) : '0';
    const sign = diff >= 0 ? '+' : '';
    console.log(`| ${name.charAt(0).toUpperCase() + name.slice(1)} | ${fmtCost(cost)} | ${sign}${pct}% |`);
  }

  if (Object.keys(dailyCosts).length > 1) {
    console.log(`\n### Daily Trend`);
    console.log(`| Date | Cost |`);
    console.log(`|------|------|`);
    for (const [day, cost] of Object.entries(dailyCosts).sort()) {
      console.log(`| ${day} | ${fmtCost(cost)} |`);
    }
  }
}

// CLI
const arg = (process.argv[2] || 'today').toLowerCase();
const entries = loadEntries();

switch (arg) {
  case 'today':
    summarize(filterToday(entries), 'Today\'s Cost Summary');
    break;
  case 'week':
    summarize(filterByDate(entries, 7), 'Last 7 Days');
    break;
  case 'month':
    summarize(filterByDate(entries, 30), 'Last 30 Days');
    break;
  case 'all':
    summarize(entries, 'All-Time Cost Summary');
    break;
  case 'compare':
    summarize(entries, 'Model Comparison (All-Time)');
    break;
  default:
    if (arg.startsWith('project:')) {
      const projName = arg.slice(8);
      const filtered = entries.filter(e => e.project.toLowerCase().includes(projName));
      summarize(filtered, `Project: ${projName}`);
    } else {
      summarize(filterToday(entries), 'Today\'s Cost Summary');
    }
}
