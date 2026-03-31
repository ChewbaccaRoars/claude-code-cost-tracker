#!/usr/bin/env node
/**
 * Claude Code Cost Dashboard Generator
 * Generates a self-contained HTML dashboard from cost-log.jsonl
 *
 * Usage: node dashboard.js [output-path]
 * Default output: ~/.claude/cost-tracker/dashboard.html
 */
const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;
const logPath = path.join(HOME, '.claude', 'cost-tracker', 'cost-log.jsonl');
const outPath = process.argv[2] || path.join(HOME, '.claude', 'cost-tracker', 'dashboard.html');

if (!fs.existsSync(logPath)) {
  console.error('No cost log found at', logPath);
  console.error('Cost data will appear after your first session ends.');
  process.exit(1);
}

// Load entries
const entries = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);

// Auto-discover project transcript directories
const projectsDir = path.join(HOME, '.claude', 'projects');
const transcriptDirs = [];
if (fs.existsSync(projectsDir)) {
  for (const d of fs.readdirSync(projectsDir)) {
    const full = path.join(projectsDir, d);
    if (fs.statSync(full).isDirectory()) transcriptDirs.push(full);
  }
}

// Extract first user message from each session transcript (sanitized)
for (const entry of entries) {
  const sid = entry.session_id || '';
  entry._summary = '';
  for (const dir of transcriptDirs) {
    const tp = path.join(dir, `${sid}.jsonl`);
    if (!fs.existsSync(tp)) continue;
    try {
      const fileContent = fs.readFileSync(tp, { encoding: 'utf8', flag: 'r' });
      const lines = fileContent.split('\n').filter(Boolean);
      for (const line of lines) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'human' || (msg.message && msg.message.role === 'user')) {
          let content = (msg.message && msg.message.content) || '';
          if (Array.isArray(content)) {
            content = content.filter(b => b.type === 'text').map(b => b.text).join(' ');
          }
          // Strip HTML tags and system content
          content = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          // Strip anything that looks like tokens, keys, secrets, paths with usernames, emails
          content = content.replace(/xox[a-z]-[^\s]+/gi, '[token]');
          content = content.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]');
          content = content.replace(/[A-Za-z]:\\Users\\[^\s\\]+/gi, '~');
          content = content.replace(/\/home\/[^\s/]+/gi, '~');
          content = content.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email]');
          content = content.replace(/\b[A-Za-z0-9]{20,}\b/g, '[id]');
          if (content.length > 150) content = content.slice(0, 150) + '...';
          entry._summary = content;
          break;
        }
      }
      break;
    } catch {}
  }
}

// Sort by timestamp
entries.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

// Aggregate data
const dailyCosts = {};
const weeklyCosts = {};
const modelTotals = {};
let totalCost = 0, totalInput = 0, totalOutput = 0, totalCacheWrite = 0, totalCacheRead = 0;
const compTotals = { opus: 0, sonnet: 0, haiku: 0 };
const sessionList = [];

function getDaysBetween(startStr, endStr) {
  const days = [];
  const start = new Date(startStr);
  const end = new Date(endStr);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days.length > 0 ? days : [startStr];
}

function getWeek(dateStr) {
  if (!dateStr) return 'unknown';
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().slice(0, 10);
}

for (const e of entries) {
  const startDay = (e.start_timestamp || e.timestamp || '').slice(0, 10);
  const endDay = (e.end_timestamp || e.timestamp || '').slice(0, 10);
  const activeDays = getDaysBetween(startDay, endDay);
  const costPerDay = (e.total_cost_usd || 0) / activeDays.length;

  totalCost += e.total_cost_usd || 0;
  for (const day of activeDays) {
    dailyCosts[day] = (dailyCosts[day] || 0) + costPerDay;
    const week = getWeek(day);
    weeklyCosts[week] = (weeklyCosts[week] || 0) + costPerDay;
  }

  for (const [model, data] of Object.entries(e.models || {})) {
    if (!modelTotals[model]) modelTotals[model] = { cost: 0, input: 0, output: 0, cache_write: 0, cache_read: 0, messages: 0 };
    modelTotals[model].cost += data.cost_usd || 0;
    modelTotals[model].input += data.input_tokens || 0;
    modelTotals[model].output += data.output_tokens || 0;
    modelTotals[model].cache_write += data.cache_creation_input_tokens || 0;
    modelTotals[model].cache_read += data.cache_read_input_tokens || 0;
    modelTotals[model].messages += data.message_count || 0;
    totalInput += data.input_tokens || 0;
    totalOutput += data.output_tokens || 0;
    totalCacheWrite += data.cache_creation_input_tokens || 0;
    totalCacheRead += data.cache_read_input_tokens || 0;
  }

  if (e.model_comparison) {
    compTotals.opus += e.model_comparison.opus || 0;
    compTotals.sonnet += e.model_comparison.sonnet || 0;
    compTotals.haiku += e.model_comparison.haiku || 0;
  }

  const dateLabel = startDay === endDay ? startDay : startDay + ' to ' + endDay;
  sessionList.push({
    date: startDay,
    dateLabel: dateLabel,
    time: (e.start_timestamp || e.timestamp || '').slice(11, 19),
    cost: e.total_cost_usd || 0,
    days: activeDays.length,
    peak_context: e.peak_context_tokens || 0,
    summary: e._summary || '(no summary)',
    session_id: (e.session_id || '').slice(0, 8),
    project: e.project || '',
    models: Object.keys(e.models || {}),
  });
}

function fmtNum(n, decimals = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function getMedian(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const totalTokens = totalInput + totalOutput + totalCacheWrite + totalCacheRead;
const cacheEfficiency = totalTokens > 0 ? ((totalCacheRead / (totalCacheRead + totalInput + totalCacheWrite)) * 100).toFixed(1) : '0.0';
const avgCostPerSession = entries.length > 0 ? totalCost / entries.length : 0;
const days = Object.keys(dailyCosts).sort();

const today = new Date().toISOString().slice(0, 10);
const todayCost = dailyCosts[today] || 0;
const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const weekCost = Object.entries(dailyCosts).filter(([d]) => d >= sevenDaysAgo).reduce((s, [, c]) => s + c, 0);
const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const monthCost = Object.entries(dailyCosts).filter(([d]) => d >= thirtyDaysAgo).reduce((s, [, c]) => s + c, 0);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Code Cost Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface2: #242836;
    --border: #2e3345;
    --text: #e4e4e7;
    --text-dim: #8b8fa3;
    --accent: #7c6ff7;
    --accent2: #4ecdc4;
    --accent3: #ff6b6b;
    --accent4: #ffd93d;
    --green: #4ade80;
    --red: #f87171;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 16px;
    line-height: 1.4;
    font-size: 13px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .header h1 {
    font-size: 1.15rem;
    font-weight: 700;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .header .meta { color: var(--text-dim); font-size: 0.75rem; }
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 8px;
    margin-bottom: 14px;
  }
  .kpi {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    position: relative;
    overflow: hidden;
  }
  .kpi::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
  }
  .kpi:nth-child(1)::before { background: var(--accent); }
  .kpi:nth-child(2)::before { background: var(--accent2); }
  .kpi:nth-child(3)::before { background: var(--accent4); }
  .kpi:nth-child(4)::before { background: var(--accent3); }
  .kpi:nth-child(5)::before { background: var(--green); }
  .kpi:nth-child(6)::before { background: #a78bfa; }
  .kpi .label { font-size: 0.65rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
  .kpi .value { font-size: 1.1rem; font-weight: 700; }
  .kpi .sub { font-size: 0.65rem; color: var(--text-dim); margin-top: 2px; }
  .charts-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 14px;
  }
  .chart-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
  }
  .chart-card.full { grid-column: 1 / -1; }
  .chart-card h3 { font-size: 0.75rem; color: var(--text-dim); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  .table-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 14px;
  }
  .table-card h3 { font-size: 0.75rem; color: var(--text-dim); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left;
    padding: 5px 8px;
    font-size: 0.65rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--surface);
    cursor: pointer;
  }
  th:hover { color: var(--accent); }
  td {
    padding: 5px 8px;
    font-size: 0.75rem;
    border-bottom: 1px solid var(--border);
  }
  tr:hover td { background: var(--surface2); }
  .cost-high { color: var(--red); font-weight: 600; }
  .cost-med { color: var(--accent4); }
  .cost-low { color: var(--green); }
  .summary-text {
    max-width: 400px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-dim);
    font-size: 0.7rem;
  }
  .model-tag {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 0.6rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .model-opus { background: rgba(124,111,247,0.2); color: var(--accent); }
  .model-sonnet { background: rgba(78,205,196,0.2); color: var(--accent2); }
  .model-haiku { background: rgba(255,217,61,0.2); color: var(--accent4); }
  .search-bar {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }
  .search-bar input {
    flex: 1;
    padding: 6px 10px;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 0.75rem;
    outline: none;
  }
  .search-bar input:focus { border-color: var(--accent); }
  .search-bar select {
    padding: 6px 10px;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 0.75rem;
    outline: none;
  }
  .savings-bar {
    display: flex;
    gap: 8px;
    margin-bottom: 14px;
  }
  .savings-item {
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 12px;
    text-align: center;
  }
  .savings-item .model-name { font-size: 0.65rem; color: var(--text-dim); margin-bottom: 2px; }
  .savings-item .savings-cost { font-size: 1rem; font-weight: 700; }
  .savings-item .savings-pct { font-size: 0.65rem; margin-top: 2px; }
  .scrollable-table {
    max-height: 400px;
    overflow-y: auto;
  }
  .scrollable-table::-webkit-scrollbar { width: 6px; }
  .scrollable-table::-webkit-scrollbar-track { background: var(--surface); }
  .scrollable-table::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  @media (max-width: 900px) {
    .charts-grid { grid-template-columns: 1fr; }
    .kpi-grid { grid-template-columns: repeat(3, 1fr); }
    .savings-bar { flex-direction: column; }
  }
</style>
</head>
<body>
<div class="header">
  <h1>Claude Code Cost Dashboard</h1>
  <div class="meta">Generated ${new Date().toLocaleString()} &middot; ${entries.length} sessions</div>
</div>
<div class="kpi-grid">
  <div class="kpi">
    <div class="label">Total Spend</div>
    <div class="value">$${fmtNum(totalCost)}</div>
    <div class="sub">${entries.length} sessions across ${days.length} days</div>
  </div>
  <div class="kpi">
    <div class="label">Today</div>
    <div class="value">$${fmtNum(todayCost)}</div>
    <div class="sub">${entries.filter(e => (e.start_timestamp||e.timestamp||'').slice(0,10) === today).length} sessions</div>
  </div>
  <div class="kpi">
    <div class="label">Last 7 Days</div>
    <div class="value">$${fmtNum(weekCost)}</div>
    <div class="sub">avg $${fmtNum(weekCost / 7)}/day</div>
  </div>
  <div class="kpi">
    <div class="label">Last 30 Days</div>
    <div class="value">$${fmtNum(monthCost)}</div>
    <div class="sub">avg $${fmtNum(monthCost / 30)}/day</div>
  </div>
  <div class="kpi">
    <div class="label">Cache Efficiency</div>
    <div class="value">${cacheEfficiency}%</div>
    <div class="sub">${fmtNum(totalCacheRead/1e6, 1)}M tokens cached</div>
  </div>
  <div class="kpi">
    <div class="label">Avg / Session</div>
    <div class="value">$${fmtNum(avgCostPerSession)}</div>
    <div class="sub">median $${fmtNum(getMedian(entries.map(e => e.total_cost_usd || 0)))}</div>
  </div>
</div>
<div class="savings-bar">
  <div class="savings-item">
    <div class="model-name">If All Opus</div>
    <div class="savings-cost" style="color:var(--accent)">$${fmtNum(compTotals.opus)}</div>
    <div class="savings-pct" style="color:var(--text-dim)">actual model mix</div>
  </div>
  <div class="savings-item">
    <div class="model-name">If All Sonnet</div>
    <div class="savings-cost" style="color:var(--accent2)">$${fmtNum(compTotals.sonnet)}</div>
    <div class="savings-pct" style="color:var(--green)">-${((1 - compTotals.sonnet / compTotals.opus) * 100).toFixed(0)}% vs Opus</div>
  </div>
  <div class="savings-item">
    <div class="model-name">If All Haiku</div>
    <div class="savings-cost" style="color:var(--accent4)">$${fmtNum(compTotals.haiku)}</div>
    <div class="savings-pct" style="color:var(--green)">-${((1 - compTotals.haiku / compTotals.opus) * 100).toFixed(0)}% vs Opus</div>
  </div>
</div>
<div class="charts-grid">
  <div class="chart-card full">
    <h3>Daily Spend</h3>
    <canvas id="dailyChart" height="55"></canvas>
  </div>
  <div class="chart-card">
    <h3>Cost by Day of Week</h3>
    <canvas id="dowChart"></canvas>
  </div>
  <div class="chart-card">
    <h3>Sessions per Day</h3>
    <canvas id="sessionsChart"></canvas>
  </div>
</div>
<div class="charts-grid">
  <div class="chart-card full">
    <h3>Cumulative Spend Over Time</h3>
    <canvas id="cumulativeChart" height="55"></canvas>
  </div>
</div>
<div class="table-card">
  <h3>Session History</h3>
  <div class="search-bar">
    <input type="text" id="searchInput" placeholder="Search sessions..." oninput="filterTable()">
    <select id="costFilter" onchange="filterTable()">
      <option value="all">All costs</option>
      <option value="high">$100+</option>
      <option value="med">$10-100</option>
      <option value="low">Under $10</option>
    </select>
    <select id="sortSelect" onchange="sortTable()">
      <option value="date-desc">Newest first</option>
      <option value="date-asc">Oldest first</option>
      <option value="cost-desc">Most expensive</option>
      <option value="cost-asc">Cheapest</option>
    </select>
  </div>
  <div class="scrollable-table">
    <table id="sessionTable">
      <thead>
        <tr>
          <th>Date</th>
          <th>Time</th>
          <th>Cost</th>
          <th>Peak Context</th>
          <th>Model</th>
          <th>Summary</th>
        </tr>
      </thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>
</div>
<script>
const sessions = ${JSON.stringify(sessionList)};
const dailyData = ${JSON.stringify(dailyCosts)};
const fmt$ = v => '$' + v.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
function renderTable(data) {
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = data.map(s => {
    const costClass = s.cost >= 100 ? 'cost-high' : s.cost >= 10 ? 'cost-med' : 'cost-low';
    const modelClass = s.models[0]?.includes('opus') ? 'model-opus' : s.models[0]?.includes('sonnet') ? 'model-sonnet' : 'model-haiku';
    const modelName = s.models[0]?.includes('opus') ? 'Opus' : s.models[0]?.includes('sonnet') ? 'Sonnet' : s.models[0]?.includes('haiku') ? 'Haiku' : s.models[0] || '?';
    const context = s.peak_context > 1e6 ? (s.peak_context/1e6).toFixed(1)+'M' : s.peak_context > 1e3 ? (s.peak_context/1e3).toFixed(0)+'K' : s.peak_context;
    return \`<tr data-cost="\${s.cost}" data-date="\${s.date}" data-summary="\${(s.summary||'').toLowerCase()}">
      <td>\${s.dateLabel}\${s.days > 1 ? ' <span style="color:var(--accent);font-size:0.6rem">(' + s.days + 'd)</span>' : ''}</td>
      <td>\${s.time || '-'}</td>
      <td class="\${costClass}">\${fmt$(s.cost)}</td>
      <td>\${context}</td>
      <td><span class="model-tag \${modelClass}">\${modelName}</span></td>
      <td class="summary-text" title="\${escHtml(s.summary)}">\${escHtml(s.summary)}</td>
    </tr>\`;
  }).join('');
}
function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
let currentData = [...sessions].reverse();
renderTable(currentData);
function filterTable() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const costFilter = document.getElementById('costFilter').value;
  currentData = sessions.filter(s => {
    if (search && !(s.summary||'').toLowerCase().includes(search) && !s.date.includes(search)) return false;
    if (costFilter === 'high' && s.cost < 100) return false;
    if (costFilter === 'med' && (s.cost < 10 || s.cost >= 100)) return false;
    if (costFilter === 'low' && s.cost >= 10) return false;
    return true;
  });
  sortTable();
}
function sortTable() {
  const sort = document.getElementById('sortSelect').value;
  currentData.sort((a, b) => {
    if (sort === 'date-desc') return (b.date + b.time).localeCompare(a.date + a.time);
    if (sort === 'date-asc') return (a.date + a.time).localeCompare(b.date + b.time);
    if (sort === 'cost-desc') return b.cost - a.cost;
    if (sort === 'cost-asc') return a.cost - b.cost;
  });
  renderTable(currentData);
}
Chart.defaults.color = '#8b8fa3';
Chart.defaults.borderColor = '#2e3345';
const sortedDays = Object.keys(dailyData).sort();
new Chart(document.getElementById('dailyChart'), {
  type: 'bar',
  data: {
    labels: sortedDays,
    datasets: [{
      label: 'Daily Cost',
      data: sortedDays.map(d => dailyData[d]),
      backgroundColor: sortedDays.map(d => dailyData[d] > 500 ? '#f8717199' : dailyData[d] > 100 ? '#ffd93d99' : '#4ade8099'),
      borderColor: sortedDays.map(d => dailyData[d] > 500 ? '#f87171' : dailyData[d] > 100 ? '#ffd93d' : '#4ade80'),
      borderWidth: 1, borderRadius: 4,
    }]
  },
  options: {
    responsive: true,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => fmt$(ctx.parsed.y) } } },
    scales: { y: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() } }, x: { ticks: { maxRotation: 45 } } }
  }
});
const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dowCosts = [0,0,0,0,0,0,0], dowCounts = [0,0,0,0,0,0,0];
for (const [day, cost] of Object.entries(dailyData)) { const dow = new Date(day).getDay(); dowCosts[dow] += cost; dowCounts[dow]++; }
new Chart(document.getElementById('dowChart'), {
  type: 'bar',
  data: {
    labels: dowNames,
    datasets: [{ label: 'Avg Cost', data: dowCosts.map((c, i) => dowCounts[i] ? c / dowCounts[i] : 0), backgroundColor: '#7c6ff799', borderColor: '#7c6ff7', borderWidth: 1, borderRadius: 4 }]
  },
  options: {
    responsive: true,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => fmt$(ctx.parsed.y) + '/day avg' } } },
    scales: { y: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() } } }
  }
});
const sessionsPerDay = {};
for (const s of sessions) { sessionsPerDay[s.date] = (sessionsPerDay[s.date] || 0) + 1; }
const spdDays = Object.keys(sessionsPerDay).sort();
new Chart(document.getElementById('sessionsChart'), {
  type: 'line',
  data: {
    labels: spdDays,
    datasets: [{ label: 'Sessions', data: spdDays.map(d => sessionsPerDay[d]), borderColor: '#4ecdc4', backgroundColor: '#4ecdc422', fill: true, tension: 0.3, pointRadius: 3 }]
  },
  options: {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } }, x: { ticks: { maxRotation: 45 } } }
  }
});
let cumulative = 0;
const cumData = sortedDays.map(d => { cumulative += dailyData[d]; return cumulative; });
new Chart(document.getElementById('cumulativeChart'), {
  type: 'line',
  data: {
    labels: sortedDays,
    datasets: [{ label: 'Cumulative Spend', data: cumData, borderColor: '#7c6ff7', backgroundColor: '#7c6ff722', fill: true, tension: 0.3, pointRadius: 2 }]
  },
  options: {
    responsive: true,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => fmt$(ctx.parsed.y) } } },
    scales: { y: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() } }, x: { ticks: { maxRotation: 45 } } }
  }
});
<\/script>
</body>
</html>`;

fs.writeFileSync(outPath, html);
console.log(`Dashboard written to: ${outPath}`);
