// plugins/cost-tracker/skills/cost-audit/scripts/audit.js
const fs = require('fs');
const path = require('path');
const { scanSkills, scanMcpServers, scanPlugins, scanPermissions, getVerdict } = require('../../../lib/context-auditor');
const { correlateUsage } = require('../../../lib/usage-correlator');
const { BASE_PRICING, calcCost } = require('../../../lib/pricing-engine');

const home = process.env.HOME || process.env.USERPROFILE;
const logPath = path.join(home, '.claude', 'cost-tracker', 'cost-log.jsonl');

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

function runAudit(options = {}) {
  const skillsDir = options.skillsDir || path.join(home, '.claude', 'skills');
  const settingsPath = options.settingsPath || path.join(home, '.claude', 'settings.json');
  const pluginsDir = options.pluginsDir || path.join(home, '.claude', 'plugins', 'cache');
  const entries = options.entries || [];
  const sessionsPerMonth = options.sessionsPerMonth || Math.max(entries.length, 1);

  // Return early if directories don't exist
  if (!fs.existsSync(skillsDir) && !fs.existsSync(settingsPath) && !fs.existsSync(pluginsDir)) {
    return { findings: [], totalContextTokens: 0, totalMonthlyCost: 0, totalSavings: 0 };
  }

  const allFindings = [
    ...scanSkills(skillsDir),
    ...scanMcpServers(settingsPath),
    ...scanPlugins(pluginsDir),
    ...scanPermissions(settingsPath),
  ];

  const installedSkills = allFindings.filter(f => f.source === 'skill').map(f => f.name);
  const installedMcps = allFindings.filter(f => f.source === 'mcp').map(f => f.name);
  const { skills: skillUsage, mcps: mcpUsage } = correlateUsage(entries, installedSkills, installedMcps);

  const opusPricing = BASE_PRICING['claude-opus-4-6'];
  const avgMessagesPerSession = 15;

  for (const f of allFindings) {
    let usage = null;
    if (f.source === 'skill') usage = skillUsage.get(f.name);
    if (f.source === 'mcp') usage = mcpUsage.get(f.name);

    if (usage) {
      f.last_used = usage.last_used;
      f.sessions_used = usage.session_count;
    }
    f.total_sessions = entries.length;
    f.usage_rate = entries.length > 0 ? f.sessions_used / entries.length : 0;

    const perMessageCost = (f.estimated_tokens * opusPricing.input);
    f.cost_per_session_usd = perMessageCost * avgMessagesPerSession;
    f.cost_per_month_usd = f.cost_per_session_usd * sessionsPerMonth;

    if (f.source !== 'system' && f.source !== 'hook') {
      f.verdict = getVerdict(f);
      if (f.verdict === 'disable') f.reason = f.last_used ? `Not used in ${Math.round((Date.now() - new Date(f.last_used).getTime()) / (1000*60*60*24))} days` : 'Never used';
      else if (f.verdict === 'reduce') f.reason = `Used ${(f.usage_rate * 100).toFixed(1)}% of sessions but ${(f.bytes / 1024).toFixed(0)}KB is large`;
      else f.reason = 'Actively used';
    }
  }

  allFindings.sort((a, b) => b.cost_per_month_usd - a.cost_per_month_usd);

  const totalContextTokens = allFindings.reduce((s, f) => s + f.estimated_tokens, 0);
  const totalMonthlyCost = allFindings.reduce((s, f) => s + f.cost_per_month_usd, 0);
  const totalSavings = allFindings.filter(f => f.verdict === 'disable' || f.verdict === 'reduce').reduce((s, f) => s + f.cost_per_month_usd, 0);

  return { findings: allFindings, totalContextTokens, totalMonthlyCost, totalSavings };
}

function formatAuditReport(result) {
  const { findings, totalContextTokens, totalMonthlyCost, totalSavings } = result;
  let out = '';

  out += `## Context Audit\n\n`;
  out += `**Total context load:** ~${Math.round(totalContextTokens / 1000)}K tokens/session\n`;
  out += `**Estimated monthly context cost:** $${totalMonthlyCost.toFixed(2)}\n\n`;

  if (findings.length === 0) {
    out += `No context waste detected - your setup looks lean.\n`;
    return out;
  }

  const skills = findings.filter(f => f.source === 'skill' && f.verdict !== 'keep');
  const mcps = findings.filter(f => f.source === 'mcp' && f.verdict !== 'keep');
  const plugins = findings.filter(f => f.source === 'plugin' && f.verdict !== 'keep');
  const system = findings.filter(f => f.source === 'system' && f.verdict !== 'keep');

  if (skills.length > 0) {
    out += `### Skills\n\n`;
    out += `| # | Skill | Size | Last Used | Usage | $/Month | Action |\n`;
    out += `|---|-------|------|-----------|-------|---------|--------|\n`;
    skills.forEach((f, i) => {
      const lastUsed = f.last_used ? `${Math.round((Date.now() - new Date(f.last_used).getTime()) / (1000*60*60*24))}d ago` : 'never';
      out += `| ${i + 1} | ${f.name} | ${(f.bytes / 1024).toFixed(0)}KB | ${lastUsed} | ${(f.usage_rate * 100).toFixed(1)}% | $${f.cost_per_month_usd.toFixed(2)} | ${f.verdict.toUpperCase()} |\n`;
    });
    out += `\n`;
  }

  if (mcps.length > 0) {
    out += `### MCP Servers\n\n`;
    out += `| # | Server | Est. Tools | Last Used | Usage | $/Month | Action |\n`;
    out += `|---|--------|-----------|-----------|-------|---------|--------|\n`;
    mcps.forEach((f, i) => {
      const tools = f.estimated_tokens / 200;
      const lastUsed = f.last_used ? `${Math.round((Date.now() - new Date(f.last_used).getTime()) / (1000*60*60*24))}d ago` : 'never';
      out += `| ${i + 1} | ${f.name} | ${tools} | ${lastUsed} | ${(f.usage_rate * 100).toFixed(1)}% | $${f.cost_per_month_usd.toFixed(2)} | ${f.verdict.toUpperCase()} |\n`;
    });
    out += `\n`;
  }

  if (system.length > 0) {
    for (const f of system) {
      out += `### ${f.name}\n\n${f.reason}\n\n`;
    }
  }

  if (totalSavings > 0) {
    out += `---\n\n`;
    out += `**Estimated monthly savings if all DISABLE applied:** $${totalSavings.toFixed(2)}/month\n`;
  }

  return out;
}

if (require.main === module) {
  const arg = (process.argv[2] || 'month').toLowerCase();
  let entries = loadEntries();

  switch (arg) {
    case 'today': entries = filterByDate(entries, 1); break;
    case 'week': entries = filterByDate(entries, 7); break;
    case 'month': entries = filterByDate(entries, 30); break;
    case 'all': break;
    default: entries = filterByDate(entries, 30);
  }

  const result = runAudit({ entries, sessionsPerMonth: Math.max(Math.round(entries.length * (30 / Math.max(1, getDaysInRange(entries)))), 1) });
  console.log(formatAuditReport(result));
}

function getDaysInRange(entries) {
  if (entries.length < 2) return 1;
  const times = entries.map(e => new Date(e.timestamp).getTime());
  return Math.max(1, (Math.max(...times) - Math.min(...times)) / (1000 * 60 * 60 * 24));
}

module.exports = { runAudit, formatAuditReport };
