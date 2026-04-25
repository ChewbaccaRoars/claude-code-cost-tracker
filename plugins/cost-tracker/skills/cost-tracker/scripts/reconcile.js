// Reconcile local cost estimates against the Anthropic Console usage CSV.
// Helps detect: missing model pricing entries, miscalibrated rates, sessions not logged.
//
// Usage:
//   node reconcile.js <path-to-console-usage.csv>
//
// The Anthropic Console usage CSV varies in schema over time, so we autodetect
// columns by header match (case-insensitive substring). Expected fields:
//   - a date column (header contains "date")
//   - a model column (header contains "model")
//   - a cost column (header contains "cost" or "amount" or "spend")
// Token columns are optional but parsed when present (input_tokens, output_tokens, etc.).

const fs = require('fs');
const path = require('path');

const home = process.env.HOME || process.env.USERPROFILE;
const logPath = path.join(home, '.claude', 'cost-tracker', 'cost-log.jsonl');

function loadEntries() {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// Minimal RFC 4180-ish CSV parser — handles quoted fields, escaped quotes, and embedded newlines.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else { field += ch; }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 0 && !(r.length === 1 && r[0] === ''));
}

function detectColumns(headers) {
  const find = (...needles) => {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase().trim();
      for (const n of needles) if (h.includes(n)) return i;
    }
    return -1;
  };
  return {
    date:   find('date', 'day', 'timestamp'),
    model:  find('model'),
    cost:   find('cost', 'amount', 'spend', 'usd'),
    input:  find('input_tokens', 'input tokens'),
    output: find('output_tokens', 'output tokens'),
    cacheW: find('cache_creation', 'cache creation', 'cache_write'),
    cacheR: find('cache_read', 'cache read'),
  };
}

function modelTier(model) {
  const lower = (model || '').toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('sonnet')) return 'sonnet';
  return 'other';
}

function loadConsoleCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV has no data rows');

  const headers = rows[0];
  const cols = detectColumns(headers);
  if (cols.cost === -1) {
    throw new Error(`Could not find a cost column in headers: ${headers.join(', ')}`);
  }

  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < headers.length) continue;
    const cost = parseFloat(r[cols.cost]) || 0;
    if (cost === 0) continue;
    records.push({
      date: cols.date >= 0 ? r[cols.date].slice(0, 10) : null,
      model: cols.model >= 0 ? r[cols.model] : 'unknown',
      tier: modelTier(cols.model >= 0 ? r[cols.model] : ''),
      cost,
      input:  cols.input  >= 0 ? parseInt(r[cols.input], 10)  || 0 : 0,
      output: cols.output >= 0 ? parseInt(r[cols.output], 10) || 0 : 0,
      cacheW: cols.cacheW >= 0 ? parseInt(r[cols.cacheW], 10) || 0 : 0,
      cacheR: cols.cacheR >= 0 ? parseInt(r[cols.cacheR], 10) || 0 : 0,
    });
  }
  return { headers, cols, records };
}

function summarizeLocal(entries) {
  const byDay = {};
  const byTier = { opus: 0, sonnet: 0, haiku: 0, other: 0 };
  const unknownModels = new Set();
  let total = 0;

  for (const e of entries) {
    const day = (e.timestamp || '').slice(0, 10);
    if (!day) continue;
    const cost = e.total_cost_usd || 0;
    byDay[day] = (byDay[day] || 0) + cost;
    total += cost;
    if (e.models) {
      for (const [model, data] of Object.entries(e.models)) {
        byTier[modelTier(model)] += data.cost_usd || 0;
        if (data.pricing_estimated) unknownModels.add(model);
      }
    }
  }
  return { total, byDay, byTier, unknownModels };
}

function summarizeConsole(records) {
  const byDay = {};
  const byTier = { opus: 0, sonnet: 0, haiku: 0, other: 0 };
  const seenModels = new Set();
  let total = 0;
  for (const r of records) {
    if (r.date) byDay[r.date] = (byDay[r.date] || 0) + r.cost;
    byTier[r.tier] += r.cost;
    total += r.cost;
    seenModels.add(r.model);
  }
  return { total, byDay, byTier, seenModels };
}

function fmtCost(n) { return '$' + n.toFixed(2); }
function pct(n) { return (n * 100).toFixed(1) + '%'; }

function reconcile(entries, csvPath) {
  const { records } = loadConsoleCsv(csvPath);
  const local = summarizeLocal(entries);
  const remote = summarizeConsole(records);

  const diff = local.total - remote.total;
  const drift = remote.total > 0 ? diff / remote.total : 0;

  console.log('## Reconciliation: Local Estimates vs Anthropic Console\n');
  console.log(`| Source | Total |`);
  console.log(`|--------|------:|`);
  console.log(`| Local cost-tracker | ${fmtCost(local.total)} |`);
  console.log(`| Anthropic Console | ${fmtCost(remote.total)} |`);
  console.log(`| **Drift** | **${diff >= 0 ? '+' : ''}${fmtCost(diff)} (${diff >= 0 ? '+' : ''}${pct(drift)})** |\n`);

  console.log(`### Per-Tier Comparison\n`);
  console.log(`| Tier | Local | Console | Drift |`);
  console.log(`|------|------:|--------:|------:|`);
  for (const tier of ['opus', 'sonnet', 'haiku', 'other']) {
    const l = local.byTier[tier];
    const r = remote.byTier[tier];
    const d = l - r;
    if (l === 0 && r === 0) continue;
    console.log(`| ${tier} | ${fmtCost(l)} | ${fmtCost(r)} | ${d >= 0 ? '+' : ''}${fmtCost(d)} |`);
  }

  // Daily diff for whichever days appear in both
  const days = Array.from(new Set([...Object.keys(local.byDay), ...Object.keys(remote.byDay)])).sort();
  const driftDays = [];
  for (const day of days) {
    const l = local.byDay[day] || 0;
    const r = remote.byDay[day] || 0;
    const d = l - r;
    if (Math.abs(d) >= 0.10 && (l > 0 || r > 0)) {
      driftDays.push({ day, local: l, remote: r, diff: d });
    }
  }

  if (driftDays.length > 0) {
    console.log(`\n### Days with drift > $0.10\n`);
    console.log(`| Date | Local | Console | Drift |`);
    console.log(`|------|------:|--------:|------:|`);
    for (const d of driftDays.slice(0, 30)) {
      console.log(`| ${d.day} | ${fmtCost(d.local)} | ${fmtCost(d.remote)} | ${d.diff >= 0 ? '+' : ''}${fmtCost(d.diff)} |`);
    }
    if (driftDays.length > 30) console.log(`| ... | | | (${driftDays.length - 30} more) |`);
  }

  // Insights
  console.log(`\n### Insights\n`);
  if (Math.abs(drift) < 0.05) {
    console.log(`- Local estimates track the console within ${pct(Math.abs(drift))} — pricing tables look healthy.`);
  } else if (drift > 0.10) {
    console.log(`- Local total is ${pct(drift)} higher than the console — local PRICING may be too high for some models.`);
  } else if (drift < -0.10) {
    console.log(`- Local total is ${pct(-drift)} lower than the console — likely missing sessions (e.g. crashes that skipped SessionEnd) or model IDs falling through to Sonnet pricing.`);
  }

  if (local.unknownModels.size > 0) {
    console.log(`- ${local.unknownModels.size} model(s) used estimated pricing locally: ${[...local.unknownModels].join(', ')}. Add them to the PRICING table in \`session-logger.js\`.`);
  }

  // Models seen in console but never priced exactly locally
  const knownModelIds = new Set(['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001']);
  const consoleOnly = [...remote.seenModels].filter(m => m && !knownModelIds.has(m) && modelTier(m) !== 'other');
  if (consoleOnly.length > 0) {
    console.log(`- Console models not in local PRICING: ${consoleOnly.join(', ')}. Update \`session-logger.js\` so estimates stay accurate.`);
  }

  return { local, remote, drift, driftDays };
}

if (require.main === module) {
  const csvPath = process.argv[2];
  if (!csvPath) {
    process.stderr.write('Usage: node reconcile.js <path-to-anthropic-console-usage.csv>\n');
    process.stderr.write('Export from: https://console.anthropic.com (Settings → Usage → Export CSV)\n');
    process.exit(1);
  }
  try {
    const entries = loadEntries();
    reconcile(entries, csvPath);
  } catch (err) {
    process.stderr.write(`reconcile: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { parseCsv, detectColumns, modelTier, loadConsoleCsv, summarizeLocal, summarizeConsole, reconcile };
