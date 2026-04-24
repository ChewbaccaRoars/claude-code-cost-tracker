const fs = require('fs');
const path = require('path');

const home = process.env.HOME || process.env.USERPROFILE;
const logPath = path.join(home, '.claude', 'cost-tracker', 'cost-log.jsonl');
const digestDir = path.join(home, '.claude', 'cost-tracker', 'digests');
const lastDigestPath = path.join(home, '.claude', 'cost-tracker', 'last-digest.json');

function loadEntries() {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function filterByDateRange(entries, startDate, endDate) {
  return entries.filter(e => {
    const d = new Date(e.timestamp);
    return d >= startDate && d < endDate;
  });
}

function summarizePeriod(entries) {
  let cost = 0, sessions = entries.length;
  let input = 0, output = 0, cacheRead = 0;
  const projects = {};
  const modelTiers = { opus: 0, sonnet: 0, haiku: 0 };

  for (const e of entries) {
    cost += e.total_cost_usd || 0;
    const proj = e.project || 'unknown';
    projects[proj] = (projects[proj] || 0) + (e.total_cost_usd || 0);
    if (e.models) {
      for (const [model, data] of Object.entries(e.models)) {
        input += data.input_tokens || 0;
        output += data.output_tokens || 0;
        cacheRead += data.cache_read_input_tokens || 0;
        const tier = model.includes('opus') ? 'opus' : model.includes('haiku') ? 'haiku' : 'sonnet';
        modelTiers[tier] += data.cost_usd || 0;
      }
    }
  }

  return { cost, sessions, input, output, cacheRead, projects, modelTiers };
}

function generateDigest(thisWeek, lastWeek, weekLabel) {
  const delta = thisWeek.cost - lastWeek.cost;
  const deltaPct = lastWeek.cost > 0 ? ((delta / lastWeek.cost) * 100).toFixed(0) : 'N/A';
  const sign = delta >= 0 ? '+' : '';

  const topProjects = Object.entries(thisWeek.projects).sort((a, b) => b[1] - a[1]).slice(0, 5);

  let md = `# Weekly Cost Digest — ${weekLabel}\n\n`;
  md += `## Summary\n\n`;
  md += `| Metric | This Week | Last Week | Change |\n`;
  md += `|--------|-----------|-----------|--------|\n`;
  md += `| **Total Cost** | $${thisWeek.cost.toFixed(2)} | $${lastWeek.cost.toFixed(2)} | ${sign}$${delta.toFixed(2)} (${sign}${deltaPct}%) |\n`;
  md += `| **Sessions** | ${thisWeek.sessions} | ${lastWeek.sessions} | ${sign}${thisWeek.sessions - lastWeek.sessions} |\n`;
  md += `| **Avg/Session** | $${thisWeek.sessions > 0 ? (thisWeek.cost / thisWeek.sessions).toFixed(2) : '0.00'} | $${lastWeek.sessions > 0 ? (lastWeek.cost / lastWeek.sessions).toFixed(2) : '0.00'} | |\n`;
  md += `\n`;

  md += `## Model Mix\n\n`;
  md += `| Model | This Week | Last Week |\n`;
  md += `|-------|-----------|----------|\n`;
  for (const tier of ['opus', 'sonnet', 'haiku']) {
    md += `| ${tier.charAt(0).toUpperCase() + tier.slice(1)} | $${thisWeek.modelTiers[tier].toFixed(2)} | $${lastWeek.modelTiers[tier].toFixed(2)} |\n`;
  }
  md += `\n`;

  if (topProjects.length > 0) {
    md += `## Top Projects\n\n`;
    md += `| Project | Cost |\n`;
    md += `|---------|------|\n`;
    for (const [name, cost] of topProjects) {
      md += `| ${name} | $${cost.toFixed(2)} |\n`;
    }
    md += `\n`;
  }

  // Insights
  md += `## Insights\n\n`;
  if (delta > 0 && deltaPct !== 'N/A') {
    md += `- Spending increased ${sign}${deltaPct}% vs last week\n`;
  } else if (delta < 0) {
    md += `- Spending decreased ${deltaPct}% vs last week\n`;
  }
  if (thisWeek.modelTiers.opus > thisWeek.cost * 0.7) {
    md += `- ${Math.round(thisWeek.modelTiers.opus / thisWeek.cost * 100)}% of spend was on Opus — consider Sonnet for routine tasks\n`;
  }
  if (thisWeek.sessions > 0 && thisWeek.cost / thisWeek.sessions > 200) {
    md += `- Average session cost ($${(thisWeek.cost / thisWeek.sessions).toFixed(2)}) is high — use /compact and split long sessions\n`;
  }

  return md;
}

function shouldGenerate() {
  try {
    const last = JSON.parse(fs.readFileSync(lastDigestPath, 'utf8'));
    const daysSince = (Date.now() - new Date(last.generated).getTime()) / (1000 * 60 * 60 * 24);
    return daysSince >= 7;
  } catch {
    return true;
  }
}

function getWeekBounds() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - dayOfWeek);
  thisWeekStart.setHours(0, 0, 0, 0);

  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(thisWeekStart.getDate() - 7);

  return { thisWeekStart, lastWeekStart, thisWeekEnd: now, lastWeekEnd: thisWeekStart };
}

// Can be called from SessionStart hook or manually
async function main() {
  const forceGenerate = process.argv.includes('--force');

  if (!forceGenerate && !shouldGenerate()) process.exit(0);

  const entries = loadEntries();
  if (entries.length === 0) process.exit(0);

  const { thisWeekStart, lastWeekStart, thisWeekEnd, lastWeekEnd } = getWeekBounds();

  const thisWeekEntries = filterByDateRange(entries, thisWeekStart, thisWeekEnd);
  const lastWeekEntries = filterByDateRange(entries, lastWeekStart, lastWeekEnd);

  const thisWeekStats = summarizePeriod(thisWeekEntries);
  const lastWeekStats = summarizePeriod(lastWeekEntries);

  const weekLabel = `Week of ${thisWeekStart.toISOString().slice(0, 10)}`;
  const digest = generateDigest(thisWeekStats, lastWeekStats, weekLabel);

  // Save digest
  fs.mkdirSync(digestDir, { recursive: true });
  const filename = `digest-${thisWeekStart.toISOString().slice(0, 10)}.md`;
  fs.writeFileSync(path.join(digestDir, filename), digest);

  // Update last digest timestamp
  fs.writeFileSync(lastDigestPath, JSON.stringify({ generated: new Date().toISOString(), file: filename }));

  // Output summary for system message
  const delta = thisWeekStats.cost - lastWeekStats.cost;
  const sign = delta >= 0 ? '+' : '';
  const msg = `Weekly digest: $${thisWeekStats.cost.toFixed(2)} this week (${sign}$${delta.toFixed(2)} vs last week), ${thisWeekStats.sessions} sessions. Full digest saved to ~/.claude/cost-tracker/digests/${filename}`;

  if (process.argv.includes('--system-message')) {
    process.stdout.write(JSON.stringify({ systemMessage: `📊 ${msg}` }));
  } else {
    console.log(digest);
  }
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`weekly-digest: ${err.message}\n`);
    process.exit(0);
  });
}

module.exports = { loadEntries, filterByDateRange, summarizePeriod, generateDigest, shouldGenerate, getWeekBounds };
