// Cost forecast: project end-of-day, end-of-week, and end-of-month spend
// using a simple trailing-average over the last N active days.
//
// Output is a markdown table the cost-budget skill renders.

const fs = require('fs');
const path = require('path');

const home = process.env.HOME || process.env.USERPROFILE;
const logPath = path.join(home, '.claude', 'cost-tracker', 'cost-log.jsonl');
const budgetPath = path.join(home, '.claude', 'cost-tracker', 'budget.json');

function loadEntries() {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function loadBudget() {
  try { return JSON.parse(fs.readFileSync(budgetPath, 'utf8')); } catch { return null; }
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Group spend by local day. Returns { day -> usd } for every day with activity.
function byDay(entries) {
  const map = {};
  for (const e of entries) {
    if (!e.timestamp) continue;
    const d = new Date(e.timestamp);
    const k = dayKey(d);
    map[k] = (map[k] || 0) + (e.total_cost_usd || 0);
  }
  return map;
}

// Average daily spend over the last `windowDays` calendar days,
// counting zero on days with no sessions (so a quiet weekend pulls the average down).
function trailingAverage(spendByDay, now, windowDays) {
  let sum = 0;
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    sum += spendByDay[dayKey(d)] || 0;
  }
  return sum / windowDays;
}

function spendInRange(spendByDay, start, end) {
  let total = 0;
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setHours(0, 0, 0, 0);
  while (cur <= last) {
    total += spendByDay[dayKey(cur)] || 0;
    cur.setDate(cur.getDate() + 1);
  }
  return total;
}

function fmtCost(n) { return '$' + n.toFixed(2); }

function forecast(entries, now = new Date()) {
  const spendByDay = byDay(entries);
  const dailyAvg7  = trailingAverage(spendByDay, now, 7);
  const dailyAvg30 = trailingAverage(spendByDay, now, 30);

  // End-of-month projection using both 7-day and 30-day windows.
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const daysInMonth = monthEnd.getDate();
  const dayOfMonth = now.getDate();
  const daysRemaining = daysInMonth - dayOfMonth;
  const monthSoFar = spendInRange(spendByDay, monthStart, now);
  const eomLow  = monthSoFar + dailyAvg30 * daysRemaining;
  const eomHigh = monthSoFar + dailyAvg7  * daysRemaining;

  // End-of-week projection (week starts Sunday).
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const weekDaysRemaining = 6 - now.getDay();
  const weekSoFar = spendInRange(spendByDay, weekStart, now);
  const eowLow  = weekSoFar + dailyAvg30 * weekDaysRemaining;
  const eowHigh = weekSoFar + dailyAvg7  * weekDaysRemaining;

  return {
    today: spendByDay[dayKey(now)] || 0,
    weekSoFar,
    monthSoFar,
    dailyAvg7,
    dailyAvg30,
    eowLow,
    eowHigh,
    eomLow,
    eomHigh,
    daysRemainingInMonth: daysRemaining,
    daysRemainingInWeek: weekDaysRemaining,
  };
}

function formatReport(f, budget) {
  const lines = [];
  lines.push('## Cost Forecast\n');
  lines.push('| Window | Spent so far | Trailing avg/day | Projected total |');
  lines.push('|--------|-------------:|-----------------:|----------------:|');
  lines.push(`| This week | ${fmtCost(f.weekSoFar)} | ${fmtCost(f.dailyAvg7)} (7d) | ${fmtCost(f.eowLow)} – ${fmtCost(f.eowHigh)} |`);
  lines.push(`| This month | ${fmtCost(f.monthSoFar)} | ${fmtCost(f.dailyAvg30)} (30d) | ${fmtCost(f.eomLow)} – ${fmtCost(f.eomHigh)} |`);
  lines.push('');
  lines.push(`Range = projection using 30-day average (low) vs 7-day average (high). ${f.daysRemainingInMonth} day(s) remain this month.`);
  lines.push('');

  if (budget) {
    lines.push('### vs Budget\n');
    lines.push('| Period | Limit | Projection | Status |');
    lines.push('|--------|------:|-----------:|--------|');
    if (budget.daily) {
      const proj = f.dailyAvg7;
      const status = proj >= budget.daily ? '🚨 over' : proj >= budget.daily * 0.8 ? '⚠️ near' : '✅ ok';
      lines.push(`| Daily | ${fmtCost(budget.daily)} | ${fmtCost(proj)} (avg) | ${status} |`);
    }
    if (budget.weekly) {
      const proj = f.eowHigh;
      const status = proj >= budget.weekly ? '🚨 over' : proj >= budget.weekly * 0.8 ? '⚠️ near' : '✅ ok';
      lines.push(`| Weekly | ${fmtCost(budget.weekly)} | ${fmtCost(proj)} | ${status} |`);
    }
    if (budget.monthly) {
      const proj = f.eomHigh;
      const status = proj >= budget.monthly ? '🚨 over' : proj >= budget.monthly * 0.8 ? '⚠️ near' : '✅ ok';
      lines.push(`| Monthly | ${fmtCost(budget.monthly)} | ${fmtCost(proj)} | ${status} |`);
    }
    lines.push('');

    // If projected over a budget, suggest actions
    const overBudgets = [];
    if (budget.daily && f.dailyAvg7 >= budget.daily) overBudgets.push('daily');
    if (budget.weekly && f.eowHigh >= budget.weekly) overBudgets.push('weekly');
    if (budget.monthly && f.eomHigh >= budget.monthly) overBudgets.push('monthly');
    if (overBudgets.length > 0) {
      lines.push(`**Projected to exceed:** ${overBudgets.join(', ')} budget(s). Consider switching default model to Sonnet (\`/cost-optimize apply\`) or tightening session length.`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

if (require.main === module) {
  const entries = loadEntries();
  const f = forecast(entries);
  console.log(formatReport(f, loadBudget()));
}

module.exports = { byDay, trailingAverage, spendInRange, forecast, formatReport, loadEntries, loadBudget, dayKey };
