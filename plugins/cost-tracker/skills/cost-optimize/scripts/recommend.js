const fs = require('fs');
const path = require('path');

const logPath = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'cost-tracker', 'cost-log.jsonl');

function loadEntries() {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function round2(n) { return Math.round(n * 100) / 100; }
function fmtCost(n) { return '$' + n.toFixed(2); }
function pct(n) { return Math.round(n * 100) + '%'; }

// --- Analyzers ---
// Each returns { priority: 1-10, title, finding, recommendation, savings_usd } or null

function analyzeModelTier(entries) {
  const modelSessions = {};
  for (const e of entries) {
    if (!e.models) continue;
    for (const [model, data] of Object.entries(e.models)) {
      const tier = model.includes('opus') ? 'opus' : model.includes('haiku') ? 'haiku' : 'sonnet';
      if (!modelSessions[tier]) modelSessions[tier] = [];
      modelSessions[tier].push({
        session_id: e.session_id,
        session_name: e.session_name,
        project: e.project,
        messages: data.message_count || 0,
        cost: data.cost_usd || 0,
        tokens: (data.input_tokens || 0) + (data.output_tokens || 0),
      });
    }
  }

  const results = [];

  // Find Opus sessions that look like they could be Sonnet
  if (modelSessions.opus) {
    const opusSessions = modelSessions.opus;
    const lightOpus = opusSessions.filter(s => s.messages < 10);
    if (lightOpus.length > 0) {
      const opusCost = lightOpus.reduce((sum, s) => sum + s.cost, 0);
      const sonnetEquiv = opusCost * (3 / 15); // input ratio as rough approximation
      const savings = opusCost - sonnetEquiv;
      if (savings > 0.50) {
        results.push({
          priority: 9,
          title: 'Light Opus sessions could use Sonnet',
          finding: `${lightOpus.length} Opus session(s) had fewer than 10 messages each, costing ${fmtCost(opusCost)} total. These short interactions likely don't need Opus-level reasoning.`,
          recommendation: `Start exploratory or quick-question sessions on Sonnet (\`/model sonnet\`), then upgrade to Opus only when you hit complex reasoning tasks. Use \`/model opus\` mid-session when needed.`,
          savings_usd: round2(savings),
        });
      }
    }

    // Find Opus sessions with mostly tool calls (editing, searching) vs reasoning
    const highMessageOpus = opusSessions.filter(s => s.messages >= 10);
    if (highMessageOpus.length > 0) {
      const totalOpusCost = highMessageOpus.reduce((sum, s) => sum + s.cost, 0);
      results.push({
        priority: 5,
        title: 'Consider Sonnet for code editing sessions',
        finding: `${highMessageOpus.length} Opus session(s) with 10+ messages cost ${fmtCost(totalOpusCost)}. Sonnet handles file editing, refactoring, and test writing comparably to Opus.`,
        recommendation: `Reserve Opus for architecture decisions, complex debugging, and multi-file reasoning. Sonnet excels at: writing tests, refactoring, file edits, explaining code, and search tasks.`,
        savings_usd: round2(totalOpusCost * 0.6),
      });
    }
  }

  return results;
}

function analyzeCacheEfficiency(entries) {
  const results = [];
  const lowCacheSessions = [];

  for (const e of entries) {
    if (!e.models) continue;
    let totalInput = 0, totalCacheRead = 0;
    for (const data of Object.values(e.models)) {
      totalInput += data.input_tokens || 0;
      totalCacheRead += data.cache_read_input_tokens || 0;
    }
    const total = totalInput + totalCacheRead;
    if (total > 0) {
      const efficiency = totalCacheRead / total;
      if (efficiency < 0.5 && total > 10000) {
        lowCacheSessions.push({
          session_name: e.session_name || e.session_id,
          project: e.project,
          efficiency,
          cost: e.total_cost_usd || 0,
        });
      }
    }
  }

  if (lowCacheSessions.length >= 3) {
    const avgEff = lowCacheSessions.reduce((s, e) => s + e.efficiency, 0) / lowCacheSessions.length;
    const totalCost = lowCacheSessions.reduce((s, e) => s + e.cost, 0);
    const potentialSavings = totalCost * (1 - avgEff) * 0.3;
    results.push({
      priority: 7,
      title: 'Low cache efficiency in multiple sessions',
      finding: `${lowCacheSessions.length} sessions had cache hit rates below 50% (average ${pct(avgEff)}). Low cache efficiency means you're paying full input price for repeated context.`,
      recommendation: `Keep related work in a single session instead of starting new ones. Use \`/compact\` to reduce context size rather than restarting. Avoid clearing conversation history mid-task.`,
      savings_usd: round2(potentialSavings),
    });
  }

  // Check for many very short sessions (1-3 messages)
  const shortSessions = entries.filter(e => {
    if (!e.models) return false;
    const totalMessages = Object.values(e.models).reduce((s, m) => s + (m.message_count || 0), 0);
    return totalMessages <= 3;
  });

  if (shortSessions.length >= 5) {
    const shortCost = shortSessions.reduce((s, e) => s + (e.total_cost_usd || 0), 0);
    results.push({
      priority: 6,
      title: 'Many very short sessions waste cache warmup',
      finding: `${shortSessions.length} sessions had 3 or fewer messages, costing ${fmtCost(shortCost)} total. Each new session pays full price to load your system prompt and CLAUDE.md into context — that warmup cost is wasted on single-question sessions.`,
      recommendation: `Batch quick questions into existing sessions. If you have a running session, ask follow-up questions there instead of opening new ones.`,
      savings_usd: round2(shortCost * 0.3),
    });
  }

  return results;
}

function analyzeContextBloat(entries) {
  const results = [];
  const highContext = entries.filter(e => e.peak_context_tokens > 500000);

  if (highContext.length > 0) {
    const totalCost = highContext.reduce((s, e) => s + (e.total_cost_usd || 0), 0);
    const avgContext = highContext.reduce((s, e) => s + e.peak_context_tokens, 0) / highContext.length;
    const names = highContext
      .filter(e => e.session_name)
      .map(e => `"${e.session_name}"`)
      .slice(0, 5);

    results.push({
      priority: 8,
      title: 'High context usage driving up costs',
      finding: `${highContext.length} session(s) exceeded 500K context tokens (avg ${Math.round(avgContext / 1000)}K), costing ${fmtCost(totalCost)} total.${names.length > 0 ? ' Sessions: ' + names.join(', ') + '.' : ''} Late messages in high-context sessions cost dramatically more because input tokens scale with conversation length.`,
      recommendation: `Use \`/compact\` when context grows large. Split long tasks into focused sessions. For code reviews, break into per-file reviews rather than reviewing everything at once.`,
      savings_usd: round2(totalCost * 0.25),
    });
  }

  return results;
}

function analyzeProjectPatterns(entries) {
  const results = [];
  const projects = {};

  for (const e of entries) {
    if (!e.project || !e.models) continue;
    if (!projects[e.project]) projects[e.project] = { sessions: 0, cost: 0, opusCost: 0, messages: 0 };
    const p = projects[e.project];
    p.sessions += 1;
    p.cost += e.total_cost_usd || 0;
    for (const [model, data] of Object.entries(e.models)) {
      p.messages += data.message_count || 0;
      if (model.includes('opus')) p.opusCost += data.cost_usd || 0;
    }
  }

  // Find projects where Opus is used but avg session cost is low (simple work)
  for (const [name, data] of Object.entries(projects)) {
    if (data.opusCost > 0 && data.sessions >= 3) {
      const avgCost = data.cost / data.sessions;
      const avgMessages = data.messages / data.sessions;
      if (avgMessages < 15 && avgCost < 100) {
        const savings = data.opusCost * 0.8;
        if (savings > 1) {
          results.push({
            priority: 7,
            title: `Project "${name}" may not need Opus`,
            finding: `${data.sessions} sessions in "${name}" averaged ${Math.round(avgMessages)} messages and ${fmtCost(avgCost)}/session. ${fmtCost(data.opusCost)} was spent on Opus. Low message counts suggest routine work.`,
            recommendation: `Default to Sonnet for "${name}" work. Consider adding a project-specific \`.claude/settings.json\` with \`"model": "sonnet"\` so it auto-selects the right tier.`,
            savings_usd: round2(savings),
          });
        }
      }
    }
  }

  return results;
}

function analyzeSessionNamePatterns(entries) {
  const results = [];
  const namedEntries = entries.filter(e => e.session_name);
  if (namedEntries.length < 5) return results;

  // Group by keyword categories
  const categories = {};
  const keywords = {
    debug: /debug|fix|bug|issue|error|broken|crash/i,
    build: /build|create|add|implement|feature|scaffold/i,
    review: /review|audit|check|inspect|scan/i,
    refactor: /refactor|cleanup|clean up|reorganize|rename/i,
    explore: /explore|research|investigate|look|check|try/i,
    docs: /doc|readme|comment|explain|document/i,
  };

  for (const e of namedEntries) {
    for (const [category, pattern] of Object.entries(keywords)) {
      if (pattern.test(e.session_name)) {
        if (!categories[category]) categories[category] = { sessions: 0, cost: 0, opusCost: 0 };
        categories[category].sessions += 1;
        categories[category].cost += e.total_cost_usd || 0;
        if (e.models) {
          for (const [model, data] of Object.entries(e.models)) {
            if (model.includes('opus')) categories[category].opusCost += data.cost_usd || 0;
          }
        }
        break;
      }
    }
  }

  // Find categories where Sonnet would suffice
  const sonnetCategories = ['docs', 'refactor', 'explore', 'review'];
  for (const cat of sonnetCategories) {
    if (categories[cat] && categories[cat].opusCost > 5 && categories[cat].sessions >= 2) {
      const data = categories[cat];
      const savings = data.opusCost * 0.8;
      results.push({
        priority: 6,
        title: `"${cat}" sessions could run on Sonnet`,
        finding: `${data.sessions} sessions categorized as "${cat}" (by session name) used ${fmtCost(data.opusCost)} of Opus. Tasks like ${cat === 'docs' ? 'documentation' : cat === 'refactor' ? 'refactoring' : cat === 'explore' ? 'exploration' : 'code review'} are well within Sonnet's capabilities.`,
        recommendation: `Switch to Sonnet (\`/model sonnet\`) when starting ${cat} work. Sonnet handles ${cat === 'docs' ? 'writing docs, README files, and comments' : cat === 'refactor' ? 'renaming, restructuring, and cleanup' : cat === 'explore' ? 'searching codebases, reading files, and answering questions' : 'reviewing diffs and suggesting improvements'} effectively.`,
        savings_usd: round2(savings),
      });
    }
  }

  // Find if debug sessions are disproportionately expensive
  if (categories.debug && categories.debug.sessions >= 2) {
    const debugAvg = categories.debug.cost / categories.debug.sessions;
    const overallAvg = entries.reduce((s, e) => s + (e.total_cost_usd || 0), 0) / entries.length;
    if (debugAvg > overallAvg * 1.5) {
      results.push({
        priority: 5,
        title: 'Debug sessions are disproportionately expensive',
        finding: `Debug sessions average ${fmtCost(debugAvg)} vs ${fmtCost(overallAvg)} overall (${Math.round(debugAvg / overallAvg)}x). Debugging often involves long back-and-forth conversations that inflate context.`,
        recommendation: `Start debug sessions on Sonnet — it handles error analysis and stack traces well. Upgrade to Opus only if the root cause requires deep multi-file reasoning. Use \`/compact\` between debugging attempts.`,
        savings_usd: round2(categories.debug.cost * 0.3),
      });
    }
  }

  return results;
}

function analyzeTimePatterns(entries) {
  const results = [];
  const hourBuckets = {};

  for (const e of entries) {
    if (!e.timestamp) continue;
    const hour = new Date(e.timestamp).getHours();
    const bucket = hour < 9 ? 'early' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
    if (!hourBuckets[bucket]) hourBuckets[bucket] = { sessions: 0, cost: 0 };
    hourBuckets[bucket].sessions += 1;
    hourBuckets[bucket].cost += e.total_cost_usd || 0;
  }

  // Find the most expensive time bucket
  const bucketEntries = Object.entries(hourBuckets).filter(([_, d]) => d.sessions >= 3);
  if (bucketEntries.length >= 2) {
    bucketEntries.sort((a, b) => (b[1].cost / b[1].sessions) - (a[1].cost / a[1].sessions));
    const [expBucket, expData] = bucketEntries[0];
    const [cheapBucket, cheapData] = bucketEntries[bucketEntries.length - 1];
    const expAvg = expData.cost / expData.sessions;
    const cheapAvg = cheapData.cost / cheapData.sessions;

    if (expAvg > cheapAvg * 1.5) {
      results.push({
        priority: 3,
        title: `${expBucket.charAt(0).toUpperCase() + expBucket.slice(1)} sessions cost more`,
        finding: `${expBucket} sessions average ${fmtCost(expAvg)}/session vs ${fmtCost(cheapAvg)} for ${cheapBucket}. ${expBucket === 'evening' || expBucket === 'night' ? 'Late sessions tend to be longer and less focused.' : 'This could reflect the complexity of work at this time.'}`,
        recommendation: `Be mindful of session length during ${expBucket} hours. Consider using \`/compact\` more aggressively and setting a mental budget for exploratory sessions.`,
        savings_usd: round2((expAvg - cheapAvg) * expData.sessions * 0.2),
      });
    }
  }

  return results;
}

function analyzeSubagentUsage(entries) {
  const results = [];
  const multiModelSessions = entries.filter(e => e.models && Object.keys(e.models).length > 1);

  if (multiModelSessions.length >= 3) {
    const totalCost = multiModelSessions.reduce((s, e) => s + (e.total_cost_usd || 0), 0);
    const avgCost = totalCost / multiModelSessions.length;
    const overallAvg = entries.reduce((s, e) => s + (e.total_cost_usd || 0), 0) / entries.length;

    if (avgCost > overallAvg * 1.3) {
      results.push({
        priority: 4,
        title: 'Multi-model sessions are more expensive',
        finding: `${multiModelSessions.length} sessions used multiple models (main + subagents), averaging ${fmtCost(avgCost)} vs ${fmtCost(overallAvg)} overall. Subagents add cost but can also parallelize work effectively.`,
        recommendation: `Subagents are cost-effective for independent tasks (searching, testing) but expensive for speculative work. Avoid spawning agents for simple questions. Use \`/model haiku\` for subagent-heavy exploration tasks.`,
        savings_usd: round2((avgCost - overallAvg) * multiModelSessions.length * 0.15),
      });
    }
  }

  return results;
}

// --- Main ---

function generateRecommendations(entries) {
  if (entries.length === 0) return [];

  const allResults = [
    ...analyzeModelTier(entries),
    ...analyzeCacheEfficiency(entries),
    ...analyzeContextBloat(entries),
    ...analyzeProjectPatterns(entries),
    ...analyzeSessionNamePatterns(entries),
    ...analyzeTimePatterns(entries),
    ...analyzeSubagentUsage(entries),
  ];

  return allResults.sort((a, b) => b.priority - a.priority);
}

function formatReport(recommendations, entries) {
  const totalSpend = entries.reduce((s, e) => s + (e.total_cost_usd || 0), 0);
  const totalSavings = recommendations.reduce((s, r) => s + r.savings_usd, 0);

  console.log(`\n## Cost Optimization Report`);
  console.log(`\n**Total spend analyzed:** ${fmtCost(totalSpend)} across ${entries.length} sessions`);
  console.log(`**Potential savings identified:** ${fmtCost(totalSavings)} (${pct(totalSavings / totalSpend)} of total spend)`);

  if (recommendations.length === 0) {
    console.log(`\nNo optimization opportunities found — your usage patterns look efficient.`);
    return;
  }

  console.log(`\n**${recommendations.length} recommendation(s) found**, sorted by impact:\n`);

  for (let i = 0; i < recommendations.length; i++) {
    const r = recommendations[i];
    const emoji = r.priority >= 8 ? '🔴' : r.priority >= 6 ? '🟡' : '🟢';
    console.log(`### ${i + 1}. ${r.title}`);
    console.log(`**Impact:** ${emoji} ${r.priority}/10 | **Est. savings:** ${fmtCost(r.savings_usd)}\n`);
    console.log(`**Finding:** ${r.finding}\n`);
    console.log(`**Action:** ${r.recommendation}\n`);
    console.log(`---\n`);
  }

  // Summary table
  console.log(`### Summary`);
  console.log(`| # | Recommendation | Est. Savings |`);
  console.log(`|---|---------------|-------------|`);
  for (let i = 0; i < recommendations.length; i++) {
    const r = recommendations[i];
    console.log(`| ${i + 1} | ${r.title} | ${fmtCost(r.savings_usd)} |`);
  }
  console.log(`| | **Total potential savings** | **${fmtCost(totalSavings)}** |`);
}

if (require.main === module) {
  const arg = (process.argv[2] || 'all').toLowerCase();
  const entries = loadEntries();

  let filtered;
  switch (arg) {
    case 'today': {
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      filtered = entries.filter(e => {
        const d = new Date(e.timestamp);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
      });
      break;
    }
    case 'week': {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      filtered = entries.filter(e => new Date(e.timestamp) >= cutoff);
      break;
    }
    case 'month': {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      filtered = entries.filter(e => new Date(e.timestamp) >= cutoff);
      break;
    }
    default:
      filtered = entries;
  }

  const recommendations = generateRecommendations(filtered);
  formatReport(recommendations, filtered);
}

module.exports = {
  loadEntries,
  generateRecommendations,
  formatReport,
  analyzeModelTier,
  analyzeCacheEfficiency,
  analyzeContextBloat,
  analyzeProjectPatterns,
  analyzeSessionNamePatterns,
  analyzeTimePatterns,
  analyzeSubagentUsage,
};
