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
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return entries.filter(e => {
    const d = new Date(e.timestamp);
    const eStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return eStr === todayStr;
  });
}

function fmtNumber(n) { return n.toLocaleString('en-US'); }
function fmtCost(n) { return '$' + n.toFixed(4); }

function escapeCsv(val) {
  const s = String(val == null ? '' : val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportCsv(entries) {
  const headers = ['timestamp', 'session_id', 'session_name', 'session_category', 'project', 'total_cost_usd', 'peak_context_tokens', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'opus_cost', 'sonnet_cost', 'haiku_cost', 'reason'];
  const rows = [headers.join(',')];

  for (const e of entries) {
    let input = 0, output = 0, cacheWrite = 0, cacheRead = 0;
    if (e.models) {
      for (const data of Object.values(e.models)) {
        input += data.input_tokens || 0;
        output += data.output_tokens || 0;
        cacheWrite += data.cache_creation_input_tokens || 0;
        cacheRead += data.cache_read_input_tokens || 0;
      }
    }
    rows.push([
      escapeCsv(e.timestamp),
      escapeCsv(e.session_id),
      escapeCsv(e.session_name),
      escapeCsv(e.session_category),
      escapeCsv(e.project),
      e.total_cost_usd || 0,
      e.peak_context_tokens || 0,
      input, output, cacheWrite, cacheRead,
      (e.model_comparison || {}).opus || 0,
      (e.model_comparison || {}).sonnet || 0,
      (e.model_comparison || {}).haiku || 0,
      escapeCsv(e.reason),
    ].join(','));
  }

  const outPath = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'cost-tracker', 'cost-export.csv');
  fs.writeFileSync(outPath, rows.join('\n') + '\n');
  console.log(`Exported ${entries.length} sessions to ${outPath}`);
  return outPath;
}

function summarize(entries, label, comparisonOnly) {
  if (entries.length === 0) { console.log(`\n**${label}**: No sessions recorded.\n`); return; }

  let totalCost = 0;
  const projectCosts = {};
  const sessionCosts = {};
  const modelTotals = {};
  const compTotals = { opus: 0, sonnet: 0, haiku: 0 };
  let totalInput = 0, totalOutput = 0, totalCacheWrite = 0, totalCacheRead = 0;
  const dailyCosts = {};

  for (const e of entries) {
    totalCost += e.total_cost_usd || 0;
    const day = e.timestamp.slice(0, 10);
    dailyCosts[day] = (dailyCosts[day] || 0) + (e.total_cost_usd || 0);

    if (!projectCosts[e.project]) projectCosts[e.project] = { cost: 0, sessions: 0 };
    projectCosts[e.project].cost += e.total_cost_usd || 0;
    projectCosts[e.project].sessions += 1;

    const sName = e.session_name || e.session_id || 'unnamed';
    if (!sessionCosts[sName]) sessionCosts[sName] = { cost: 0, project: e.project, date: e.timestamp ? e.timestamp.slice(0, 10) : '' };
    sessionCosts[sName].cost += e.total_cost_usd || 0;

    if (e.models) {
      for (const [model, data] of Object.entries(e.models)) {
        if (!modelTotals[model]) modelTotals[model] = { cost: 0, messages: 0 };
        modelTotals[model].cost += data.cost_usd || 0;
        modelTotals[model].messages += data.message_count || 0;
        totalInput += data.input_tokens || 0;
        totalOutput += data.output_tokens || 0;
        totalCacheWrite += data.cache_creation_input_tokens || 0;
        totalCacheRead += data.cache_read_input_tokens || 0;
      }
    }

    if (e.model_comparison) {
      compTotals.opus += e.model_comparison.opus || 0;
      compTotals.sonnet += e.model_comparison.sonnet || 0;
      compTotals.haiku += e.model_comparison.haiku || 0;
    }
  }

  const cacheEfficiency = (totalCacheRead + totalInput) > 0
    ? ((totalCacheRead / (totalCacheRead + totalInput)) * 100).toFixed(1)
    : '0.0';

  console.log(`\n## ${label}`);
  console.log(`\n**Sessions:** ${entries.length} | **Total Cost:** ${fmtCost(totalCost)}`);

  if (!comparisonOnly) {
    console.log(`\n### Token Breakdown`);
    console.log(`| Type | Count |`);
    console.log(`|------|-------|`);
    console.log(`| Input | ${fmtNumber(totalInput)} |`);
    console.log(`| Output | ${fmtNumber(totalOutput)} |`);
    console.log(`| Cache Write | ${fmtNumber(totalCacheWrite)} |`);
    console.log(`| Cache Read | ${fmtNumber(totalCacheRead)} |`);
    console.log(`| **Cache Efficiency** | **${cacheEfficiency}%** |`);

    console.log(`\n### Per-Project Costs`);
    console.log(`| Project | Sessions | Cost |`);
    console.log(`|---------|----------|------|`);
    const sorted = Object.entries(projectCosts).sort((a, b) => b[1].cost - a[1].cost);
    for (const [proj, data] of sorted) {
      console.log(`| ${proj} | ${data.sessions} | ${fmtCost(data.cost)} |`);
    }

    const namedSessions = Object.entries(sessionCosts).filter(([name]) => name !== 'unnamed' && !name.match(/^[0-9a-f]{8}-/));
    if (namedSessions.length > 0) {
      console.log(`\n### Per-Session Costs`);
      console.log(`| Session | Project | Date | Cost |`);
      console.log(`|---------|---------|------|------|`);
      const sortedSessions = namedSessions.sort((a, b) => b[1].cost - a[1].cost);
      for (const [name, data] of sortedSessions) {
        console.log(`| ${name} | ${data.project} | ${data.date} | ${fmtCost(data.cost)} |`);
      }
    }
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

  if (!comparisonOnly && Object.keys(dailyCosts).length > 1) {
    console.log(`\n### Daily Trend`);
    console.log(`| Date | Cost |`);
    console.log(`|------|------|`);
    for (const [day, cost] of Object.entries(dailyCosts).sort()) {
      console.log(`| ${day} | ${fmtCost(cost)} |`);
    }
  }
}

// CLI
if (require.main === module) {
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
      summarize(entries, 'Model Comparison (All-Time)', true);
      break;
    case 'export':
      exportCsv(entries);
      break;
    default:
      if (arg.startsWith('project:')) {
        const projName = arg.slice(8);
        const filtered = entries.filter(e => (e.project || '').toLowerCase().includes(projName));
        summarize(filtered, `Project: ${projName}`);
      } else if (arg.startsWith('session:')) {
        const sessName = arg.slice(8);
        const filtered = entries.filter(e => (e.session_name || '').toLowerCase().includes(sessName));
        summarize(filtered, `Session: ${sessName}`);
      } else {
        console.log(`Unknown argument "${arg}". Valid: today, week, month, all, compare, export, project:<name>, session:<name>`);
        summarize(filterToday(entries), 'Today\'s Cost Summary');
      }
  }
}

module.exports = { loadEntries, filterByDate, filterToday, fmtNumber, fmtCost, escapeCsv, exportCsv, summarize };
