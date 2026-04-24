const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const logPath = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'cost-tracker', 'cost-log.jsonl');
const outDir = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'cost-tracker');

function loadEntries() {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function generateDashboard(entries) {
  // Aggregate data
  const dailyCosts = {};
  const projectCosts = {};
  const modelCosts = {};
  const hourCosts = Array(24).fill(0);
  const hourCounts = Array(24).fill(0);
  const dayCosts = Array(7).fill(0);
  const dayCounts = Array(7).fill(0);
  const sessionList = [];
  let totalCost = 0, totalSessions = entries.length;

  for (const e of entries) {
    const cost = e.total_cost_usd || 0;
    totalCost += cost;

    const day = (e.timestamp || '').slice(0, 10);
    if (day) dailyCosts[day] = (dailyCosts[day] || 0) + cost;

    const proj = e.project || 'unknown';
    projectCosts[proj] = (projectCosts[proj] || 0) + cost;

    if (e.models) {
      for (const [model, data] of Object.entries(e.models)) {
        const tier = model.includes('opus') ? 'Opus' : model.includes('haiku') ? 'Haiku' : 'Sonnet';
        modelCosts[tier] = (modelCosts[tier] || 0) + (data.cost_usd || 0);
      }
    }

    if (e.timestamp) {
      const d = new Date(e.timestamp);
      const h = d.getHours();
      hourCosts[h] += cost;
      hourCounts[h] += 1;
      const dow = d.getDay();
      dayCosts[dow] += cost;
      dayCounts[dow] += 1;
    }

    sessionList.push({
      name: e.session_name || e.session_category || e.session_id || 'unnamed',
      project: proj,
      cost,
      date: day,
      context: e.peak_context_tokens || 0,
    });
  }

  // Sort projects by cost
  const topProjects = Object.entries(projectCosts).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Sort daily for chart
  const sortedDays = Object.entries(dailyCosts).sort((a, b) => a[0].localeCompare(b[0]));

  // Top sessions
  const topSessions = sessionList.sort((a, b) => b.cost - a.cost).slice(0, 15);

  // Heatmap: day of week x hour
  const heatmapData = [];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let dow = 0; dow < 7; dow++) {
    for (let h = 0; h < 24; h++) {
      const idx = dow * 24 + h;
      // We don't have per-dow-hour data in the simple aggregation, so use the simple version
    }
  }

  const data = {
    totalCost: totalCost.toFixed(2),
    totalSessions,
    avgCost: totalSessions > 0 ? (totalCost / totalSessions).toFixed(2) : '0.00',
    dailyLabels: JSON.stringify(sortedDays.map(d => d[0])),
    dailyValues: JSON.stringify(sortedDays.map(d => Math.round(d[1] * 100) / 100)),
    projectLabels: JSON.stringify(topProjects.map(p => p[0])),
    projectValues: JSON.stringify(topProjects.map(p => Math.round(p[1] * 100) / 100)),
    modelLabels: JSON.stringify(Object.keys(modelCosts)),
    modelValues: JSON.stringify(Object.values(modelCosts).map(v => Math.round(v * 100) / 100)),
    hourLabels: JSON.stringify(Array.from({ length: 24 }, (_, i) => `${i}:00`)),
    hourValues: JSON.stringify(hourCosts.map(v => Math.round(v * 100) / 100)),
    topSessions: JSON.stringify(topSessions),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Code Cost Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; padding: 24px; }
  h1 { font-size: 24px; margin-bottom: 8px; color: #fff; }
  .subtitle { color: #8b949e; margin-bottom: 24px; font-size: 14px; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; text-align: center; }
  .stat-value { font-size: 32px; font-weight: 700; color: #58a6ff; }
  .stat-label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; }
  .charts { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; margin-bottom: 24px; }
  .chart-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; }
  .chart-card h3 { font-size: 14px; color: #8b949e; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #30363d; color: #8b949e; font-weight: 500; }
  td { padding: 8px 12px; border-bottom: 1px solid #21262d; }
  tr:hover td { background: #1c2129; }
  .cost { color: #f0883e; font-weight: 600; font-variant-numeric: tabular-nums; }
  .session-name { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  canvas { max-height: 300px; }
</style>
</head>
<body>
<h1>Claude Code Cost Dashboard</h1>
<p class="subtitle">Generated ${new Date().toLocaleString()} from ${data.totalSessions} sessions</p>

<div class="stats">
  <div class="stat-card">
    <div class="stat-value">$${data.totalCost}</div>
    <div class="stat-label">Total Spend</div>
  </div>
  <div class="stat-card">
    <div class="stat-value">${data.totalSessions}</div>
    <div class="stat-label">Sessions</div>
  </div>
  <div class="stat-card">
    <div class="stat-value">$${data.avgCost}</div>
    <div class="stat-label">Avg Per Session</div>
  </div>
</div>

<div class="charts">
  <div class="chart-card">
    <h3>Daily Spend</h3>
    <canvas id="dailyChart"></canvas>
  </div>
  <div class="chart-card">
    <h3>By Model Tier</h3>
    <canvas id="modelChart"></canvas>
  </div>
</div>

<div class="row2">
  <div class="chart-card">
    <h3>By Project</h3>
    <canvas id="projectChart"></canvas>
  </div>
  <div class="chart-card">
    <h3>By Hour of Day</h3>
    <canvas id="hourChart"></canvas>
  </div>
</div>

<div class="chart-card">
  <h3>Top Sessions by Cost</h3>
  <table>
    <thead><tr><th>Session</th><th>Project</th><th>Date</th><th>Context</th><th>Cost</th></tr></thead>
    <tbody id="sessionTable"></tbody>
  </table>
</div>

<script>
const chartDefaults = {
  color: '#8b949e',
  borderColor: '#30363d',
};
Chart.defaults.color = '#8b949e';
Chart.defaults.borderColor = '#30363d';

// Daily spend
new Chart(document.getElementById('dailyChart'), {
  type: 'line',
  data: {
    labels: ${data.dailyLabels},
    datasets: [{
      label: 'Daily Cost ($)',
      data: ${data.dailyValues},
      borderColor: '#58a6ff',
      backgroundColor: 'rgba(88,166,255,0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 2,
    }]
  },
  options: {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { maxTicksLimit: 15, maxRotation: 45 } },
      y: { ticks: { callback: v => '$' + v } }
    }
  }
});

// Model tier
new Chart(document.getElementById('modelChart'), {
  type: 'doughnut',
  data: {
    labels: ${data.modelLabels},
    datasets: [{
      data: ${data.modelValues},
      backgroundColor: ['#da3633', '#58a6ff', '#3fb950'],
      borderWidth: 0,
    }]
  },
  options: {
    responsive: true,
    plugins: {
      legend: { position: 'bottom' },
      tooltip: { callbacks: { label: ctx => ctx.label + ': $' + ctx.parsed.toFixed(2) } }
    }
  }
});

// Project
new Chart(document.getElementById('projectChart'), {
  type: 'bar',
  data: {
    labels: ${data.projectLabels},
    datasets: [{
      label: 'Cost ($)',
      data: ${data.projectValues},
      backgroundColor: '#58a6ff',
      borderRadius: 4,
    }]
  },
  options: {
    responsive: true,
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: { x: { ticks: { callback: v => '$' + v } } }
  }
});

// Hour of day
new Chart(document.getElementById('hourChart'), {
  type: 'bar',
  data: {
    labels: ${data.hourLabels},
    datasets: [{
      label: 'Cost ($)',
      data: ${data.hourValues},
      backgroundColor: '#f0883e',
      borderRadius: 2,
    }]
  },
  options: {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { maxTicksLimit: 12 } },
      y: { ticks: { callback: v => '$' + v } }
    }
  }
});

// Session table
const sessions = ${data.topSessions};
const tbody = document.getElementById('sessionTable');
for (const s of sessions) {
  const tr = document.createElement('tr');
  const ctx = s.context > 1000000 ? (s.context / 1000000).toFixed(1) + 'M' : Math.round(s.context / 1000) + 'K';
  tr.innerHTML = '<td class="session-name">' + s.name + '</td><td>' + s.project + '</td><td>' + s.date + '</td><td>' + ctx + '</td><td class="cost">$' + s.cost.toFixed(2) + '</td>';
  tbody.appendChild(tr);
}
</script>
</body>
</html>`;
}

if (require.main === module) {
  const entries = loadEntries();
  if (entries.length === 0) {
    console.log('No cost data found. Sessions will be logged after your next session ends.');
    process.exit(0);
  }

  const html = generateDashboard(entries);
  const outPath = path.join(outDir, 'dashboard.html');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, html);
  console.log(outPath);

  // Open in browser
  try {
    const platform = process.platform;
    if (platform === 'win32') execSync(`start "" "${outPath}"`, { stdio: 'ignore' });
    else if (platform === 'darwin') execSync(`open "${outPath}"`, { stdio: 'ignore' });
    else execSync(`xdg-open "${outPath}"`, { stdio: 'ignore' });
  } catch {}
}

module.exports = { loadEntries, generateDashboard };
