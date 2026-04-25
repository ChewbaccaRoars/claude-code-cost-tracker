const fs = require('fs');
const path = require('path');
const os = require('os');

const home = process.env.HOME || process.env.USERPROFILE;
const budgetPath = path.join(home, '.claude', 'cost-tracker', 'budget.json');
const logPath = path.join(home, '.claude', 'cost-tracker', 'cost-log.jsonl');
const webhookStateDir = path.join(os.tmpdir(), 'claude-cost-monitor');

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

// Webhook de-duplication: fire each (period, level) at most once per UTC day
// so users don't get a Slack ping every turn after they cross a threshold.
function webhookKey(warning) {
  const today = new Date().toISOString().slice(0, 10);
  return `${today}:${warning.period}:${warning.level}`;
}

function loadWebhookState() {
  try { fs.mkdirSync(webhookStateDir, { recursive: true }); } catch {}
  const p = path.join(webhookStateDir, 'webhook-fired.json');
  try { return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch { return { path: p, data: { fired: [] } }; }
}

function saveWebhookState(state) {
  try { fs.writeFileSync(state.path, JSON.stringify(state.data)); } catch {}
}

// Build a Slack-compatible payload; works as plain JSON for any generic webhook too.
function buildWebhookPayload(warning) {
  const icon = warning.level === 'exceeded' ? ':rotating_light:' : ':warning:';
  const text = `${icon} Claude Code budget ${warning.level}: $${warning.spend} of $${warning.limit} ${warning.period} (${warning.pct}%)`;
  return {
    text,
    level: warning.level,
    period: warning.period,
    spend_usd: Number(warning.spend),
    limit_usd: warning.limit,
    pct: warning.pct,
    timestamp: new Date().toISOString(),
  };
}

// Fire-and-forget POST. Resolves to { ok, status } or { ok: false, error }.
// Uses global fetch (Node 18+); silently no-ops if fetch is missing.
async function postWebhook(url, payload, timeoutMs = 4000) {
  if (typeof fetch !== 'function') return { ok: false, error: 'fetch unavailable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function maybeFireWebhook(budget, warning) {
  if (!budget.webhook_url || typeof budget.webhook_url !== 'string') return null;
  if (!/^https?:\/\//i.test(budget.webhook_url)) return null;

  const state = loadWebhookState();
  const key = webhookKey(warning);
  if (state.data.fired.includes(key)) return null;

  const result = await postWebhook(budget.webhook_url, buildWebhookPayload(warning));
  // Record attempt so we don't retry-spam even if the endpoint is down.
  state.data.fired.push(key);
  // Cap history so the file doesn't grow forever.
  if (state.data.fired.length > 200) state.data.fired = state.data.fired.slice(-200);
  saveWebhookState(state);
  return result;
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
    // Fire opt-in webhook (Slack-compatible). Non-blocking from a UX standpoint —
    // we still write the system message regardless of webhook outcome.
    await maybeFireWebhook(budget, worst);
  }
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`budget-check: ${err.message}\n`);
    process.exit(0);
  });
}

module.exports = { loadBudget, loadEntries, getSpend, getTodaySpend, checkBudgets, formatWarning, buildWebhookPayload, postWebhook, maybeFireWebhook, webhookKey, loadWebhookState, saveWebhookState };
