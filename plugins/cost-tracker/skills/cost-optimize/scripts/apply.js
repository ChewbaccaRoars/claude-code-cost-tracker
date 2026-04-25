// Closes the loop on `/cost-optimize`: when the optimizer finds projects whose
// usage is dominated by Sonnet-friendly work but ran on Opus, this script writes
// a model default into the project's .claude/settings.json so future sessions
// auto-pick the cheaper tier.
//
// CLI:
//   node apply.js                 # interactive — list candidates only (dry run)
//   node apply.js list            # same as default
//   node apply.js apply <project> # write settings for a specific project
//   node apply.js apply all       # write settings for every recommended project
//
// Safety: never overwrites an existing `model` field — only adds when missing.
// Always emits a JSON summary on stdout for the caller (the skill) to render.

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

function modelTier(model) {
  const lower = (model || '').toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('sonnet')) return 'sonnet';
  return 'unknown';
}

// For each project, compute total spend, opus spend, avg messages, avg cost,
// and the most recent cwd seen for that project. The recommendation criteria
// mirror analyzeProjectPatterns in recommend.js but reduce to a structured candidate.
function computeCandidates(entries) {
  const byProject = {};
  for (const e of entries) {
    if (!e.project || !e.models) continue;
    if (!byProject[e.project]) {
      byProject[e.project] = { project: e.project, sessions: 0, cost: 0, opusCost: 0, messages: 0, cwds: {} };
    }
    const p = byProject[e.project];
    p.sessions += 1;
    p.cost += e.total_cost_usd || 0;
    if (e.cwd) p.cwds[e.cwd] = (p.cwds[e.cwd] || 0) + 1;
    for (const [model, data] of Object.entries(e.models)) {
      p.messages += data.message_count || 0;
      if (modelTier(model) === 'opus') p.opusCost += data.cost_usd || 0;
    }
  }

  const candidates = [];
  for (const data of Object.values(byProject)) {
    if (data.sessions < 3 || data.opusCost <= 0) continue;
    const avgCost = data.cost / data.sessions;
    const avgMessages = data.messages / data.sessions;
    if (avgMessages < 15 && avgCost < 100) {
      const savings = data.opusCost * 0.8;
      if (savings > 1) {
        const cwd = Object.entries(data.cwds).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        candidates.push({
          project: data.project,
          cwd,
          sessions: data.sessions,
          avgMessages: Math.round(avgMessages),
          avgCost: Math.round(avgCost * 100) / 100,
          opusCost: Math.round(data.opusCost * 100) / 100,
          savings: Math.round(savings * 100) / 100,
          recommendedModel: 'sonnet',
        });
      }
    }
  }

  return candidates.sort((a, b) => b.savings - a.savings);
}

function readSettings(settingsPath) {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return null; }
}

function applyToProject(candidate) {
  if (!candidate.cwd || !fs.existsSync(candidate.cwd)) {
    return { project: candidate.project, status: 'skipped', reason: 'cwd not found on disk' };
  }
  const settingsDir = path.join(candidate.cwd, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  const existing = readSettings(settingsPath);

  if (existing && existing.model) {
    return {
      project: candidate.project,
      status: 'skipped',
      reason: `existing model setting "${existing.model}" left untouched`,
      path: settingsPath,
    };
  }

  const merged = { ...(existing || {}), model: candidate.recommendedModel };
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  } catch (err) {
    return { project: candidate.project, status: 'error', reason: err.message };
  }
  return {
    project: candidate.project,
    status: existing ? 'updated' : 'created',
    path: settingsPath,
    model: candidate.recommendedModel,
    estimatedSavings: candidate.savings,
  };
}

function fmtCost(n) { return '$' + n.toFixed(2); }

function printList(candidates) {
  console.log('## Per-Project Model Recommendations\n');
  if (candidates.length === 0) {
    console.log('No projects matched the apply criteria yet (need 3+ sessions on Opus with avg < 15 messages and avg cost < $100).');
    return;
  }
  console.log(`Found ${candidates.length} candidate(s):\n`);
  console.log('| Project | Sessions | Avg msgs | Avg cost | Opus spend | Est. savings | Action |');
  console.log('|---------|---------:|---------:|---------:|-----------:|-------------:|--------|');
  for (const c of candidates) {
    const action = c.cwd ? '`apply ' + c.project + '`' : '_cwd unknown_';
    console.log(`| ${c.project} | ${c.sessions} | ${c.avgMessages} | ${fmtCost(c.avgCost)} | ${fmtCost(c.opusCost)} | ${fmtCost(c.savings)} | ${action} |`);
  }
  console.log('\nTo apply: `node apply.js apply <project>` or `node apply.js apply all`.');
  console.log('This writes `{"model":"sonnet"}` to the project\'s `.claude/settings.json` (never overwrites an existing model field).');
}

function printApplyResults(results) {
  console.log('## Applied Per-Project Model Settings\n');
  console.log('| Project | Status | Path / Reason |');
  console.log('|---------|--------|---------------|');
  let totalSavings = 0;
  for (const r of results) {
    const detail = r.path || r.reason || '';
    console.log(`| ${r.project} | ${r.status} | ${detail} |`);
    if (r.estimatedSavings) totalSavings += r.estimatedSavings;
  }
  if (totalSavings > 0) {
    console.log(`\n**Estimated savings going forward:** ${fmtCost(totalSavings)} based on past usage.`);
  }
}

if (require.main === module) {
  const cmd = (process.argv[2] || 'list').toLowerCase();
  const target = process.argv[3];
  const entries = loadEntries();
  const candidates = computeCandidates(entries);

  if (cmd === 'list') {
    printList(candidates);
    process.exit(0);
  }

  if (cmd === 'apply') {
    if (!target) {
      process.stderr.write('Usage: apply.js apply <project|all>\n');
      process.exit(1);
    }
    const subset = target === 'all' ? candidates : candidates.filter(c => c.project === target);
    if (subset.length === 0) {
      console.log(`No matching candidate for "${target}".`);
      process.exit(0);
    }
    const results = subset.map(applyToProject);
    printApplyResults(results);
    process.exit(0);
  }

  process.stderr.write(`Unknown command "${cmd}". Use: list | apply <project|all>\n`);
  process.exit(1);
}

module.exports = { computeCandidates, applyToProject, modelTier, loadEntries, readSettings };
