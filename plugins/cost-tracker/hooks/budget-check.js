const fs = require('fs');
const path = require('path');

const home = process.env.HOME || process.env.USERPROFILE;
const budgetPath = path.join(home, '.claude', 'cost-tracker', 'budget.json');
const logPath = path.join(home, '.claude', 'cost-tracker', 'cost-log.jsonl');

function loadBudget() {
  try {
    return JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
  } catch {
    return null;
  }
}

function loadEntries() {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function getSpend(entries, periodDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - periodDays);
  return entries
    .filter(e => new Date(e.timestamp) >= cutoff)
    .reduce((sum, e) => sum + (e.total_cost_usd || 0), 0);
}

function getTodaySpend(entries) {
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return entries
    .filter(e => {
      const d = new Date(e.timestamp);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
    })
    .reduce((sum, e) => sum + (e.total_cost_usd || 0), 0);
}

function checkBudgets(budget, entries) {
  const warnings = [];

  if (budget.daily) {
    const spend = getTodaySpend(entries);
    const pct = spend / budget.daily;
    if (pct >= 1.0) {
      warnings.push({ level: 'exceeded', period: 'daily', spend: spend.toFixed(2), limit: budget.daily, pct: Math.round(pct * 100) });
    } else if (pct >= 0.8) {
      warnings.push({ level: 'warning', period: 'daily', spend: spend.toFixed(2), limit: budget.daily, pct: Math.round(pct * 100) });
    }
  }

  if (budget.weekly) {
    const spend = getSpend(entries, 7);
    const pct = spend / budget.weekly;
    if (pct >= 1.0) {
      warnings.push({ level: 'exceeded', period: 'weekly', spend: spend.toFixed(2), limit: budget.weekly, pct: Math.round(pct * 100) });
    } else if (pct >= 0.8) {
      warnings.push({ level: 'warning', period: 'weekly', spend: spend.toFixed(2), limit: budget.weekly, pct: Math.round(pct * 100) });
    }
  }

  if (budget.monthly) {
    const spend = getSpend(entries, 30);
    const pct = spend / budget.monthly;
    if (pct >= 1.0) {
      warnings.push({ level: 'exceeded', period: 'monthly', spend: spend.toFixed(2), limit: budget.monthly, pct: Math.round(pct * 100) });
    } else if (pct >= 0.8) {
      warnings.push({ level: 'warning', period: 'monthly', spend: spend.toFixed(2), limit: budget.monthly, pct: Math.round(pct * 100) });
    }
  }

  return warnings;
}

function formatWarning(w) {
  if (w.level === 'exceeded') {
    return `Budget EXCEEDED: $${w.spend} spent ${w.period} (${w.pct}% of $${w.limit} limit). Consider switching to Sonnet or wrapping up this session.`;
  }
  return `Budget alert: $${w.spend} of $${w.limit} ${w.period} budget used (${w.pct}%). Approaching your limit.`;
}

// Called from Stop hook — check budget and return systemMessage if needed
async function main() {
  const budget = loadBudget();
  if (!budget) process.exit(0);

  const entries = loadEntries();
  const warnings = checkBudgets(budget, entries);

  if (warnings.length > 0) {
    // Show the most severe warning
    const worst = warnings.sort((a, b) => b.pct - a.pct)[0];
    const icon = worst.level === 'exceeded' ? '🚨' : '⚠️';
    process.stdout.write(JSON.stringify({ systemMessage: `${icon} ${formatWarning(worst)}` }));
  }
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`budget-check: ${err.message}\n`);
    process.exit(0);
  });
}

module.exports = { loadBudget, loadEntries, getSpend, getTodaySpend, checkBudgets, formatWarning };
