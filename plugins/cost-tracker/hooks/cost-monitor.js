const fs = require('fs');
const path = require('path');
const os = require('os');

const PRICING = {
  'claude-opus-4-6':            { input: 15/1e6, output: 75/1e6, cache_write: 18.75/1e6, cache_read: 1.50/1e6 },
  'claude-sonnet-4-6':          { input: 3/1e6,  output: 15/1e6, cache_write: 3.75/1e6,  cache_read: 0.30/1e6 },
  'claude-sonnet-4-5-20250929': { input: 3/1e6,  output: 15/1e6, cache_write: 3.75/1e6,  cache_read: 0.30/1e6 },
  'claude-haiku-4-5-20251001':  { input: 0.80/1e6, output: 4/1e6, cache_write: 1/1e6,    cache_read: 0.08/1e6 },
};

function getPricing(model) {
  if (PRICING[model]) return PRICING[model];
  const lower = (model || '').toLowerCase();
  if (lower.includes('opus'))   return PRICING['claude-opus-4-6'];
  if (lower.includes('haiku'))  return PRICING['claude-haiku-4-5-20251001'];
  if (lower.includes('sonnet')) return PRICING['claude-sonnet-4-6'];
  return PRICING['claude-sonnet-4-6'];
}

function normalizePath(p) {
  if (!p) return p;
  const match = p.match(/^\/([a-zA-Z])\/(.*)/);
  if (match) return match[1].toUpperCase() + ':\\' + match[2].replace(/\//g, '\\');
  return p;
}

// Scan transcript for cumulative session stats
function scanTranscript(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let messageCount = 0;
  let peakContext = 0;
  let primaryModel = null;
  const modelCounts = {};

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.message || entry.message.role !== 'assistant' || !entry.message.usage) continue;

    const model = entry.message.model || 'unknown';
    const usage = entry.message.usage;
    const pricing = getPricing(model);

    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;

    totalInput += input;
    totalOutput += output;
    totalCacheWrite += cacheWrite;
    totalCacheRead += cacheRead;
    messageCount += 1;

    totalCost += input * pricing.input + output * pricing.output +
                 cacheWrite * pricing.cache_write + cacheRead * pricing.cache_read;

    const context = input + cacheWrite + cacheRead;
    if (context > peakContext) peakContext = context;

    modelCounts[model] = (modelCounts[model] || 0) + 1;
  }

  if (messageCount === 0) return null;

  // Determine primary model
  primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0][0];

  const lastContext = totalInput > 0 ? (totalInput + totalCacheRead) : 0;

  return {
    totalCost: Math.round(totalCost * 100) / 100,
    totalInput,
    totalOutput,
    totalCacheWrite,
    totalCacheRead,
    messageCount,
    peakContext,
    lastContext,
    primaryModel,
    isOpus: (primaryModel || '').toLowerCase().includes('opus'),
  };
}

// Threshold definitions — each returns a message or null
const THRESHOLDS = [
  {
    id: 'context_200k',
    check: (stats) => {
      if (stats.peakContext >= 200000 && stats.peakContext < 500000) {
        return `Context is at ${Math.round(stats.peakContext / 1000)}K tokens. Consider using /compact to reduce context size and save on input costs.`;
      }
      return null;
    },
  },
  {
    id: 'context_500k',
    check: (stats) => {
      if (stats.peakContext >= 500000) {
        const costPerMsg = stats.totalCost / stats.messageCount;
        return `Context has grown to ${Math.round(stats.peakContext / 1000)}K tokens — each message now costs ~$${costPerMsg.toFixed(2)}. Use /compact now, or split remaining work into a new session.`;
      }
      return null;
    },
  },
  {
    id: 'cost_50',
    check: (stats) => {
      if (stats.totalCost >= 50 && stats.totalCost < 200) {
        return `Session cost: $${stats.totalCost.toFixed(2)}.${stats.isOpus ? ' Switching to Sonnet (/model sonnet) for remaining work could reduce costs by ~80%.' : ''}`;
      }
      return null;
    },
  },
  {
    id: 'cost_200',
    check: (stats) => {
      if (stats.totalCost >= 200) {
        return `Session cost: $${stats.totalCost.toFixed(2)}. This is a high-cost session. Consider using /compact or finishing remaining tasks in a new session${stats.isOpus ? ' on Sonnet' : ''}.`;
      }
      return null;
    },
  },
  {
    id: 'opus_routine',
    check: (stats) => {
      if (stats.isOpus && stats.messageCount >= 20 && stats.messageCount % 20 === 0) {
        return `${stats.messageCount} messages on Opus ($${stats.totalCost.toFixed(2)} so far). If you're doing edits, refactoring, or tests, /model sonnet handles those well at 80% less cost.`;
      }
      return null;
    },
  },
  {
    id: 'low_cache',
    check: (stats) => {
      const total = stats.totalCacheRead + stats.totalInput;
      if (total > 100000 && stats.messageCount >= 5) {
        const efficiency = stats.totalCacheRead / total;
        if (efficiency < 0.3) {
          return `Cache hit rate is ${Math.round(efficiency * 100)}% — you're paying full price for most input. Avoid clearing context or restarting sessions mid-task.`;
        }
      }
      return null;
    },
  },
];

// State file to track which thresholds have already been shown this session
function getStatePath(sessionId) {
  const dir = path.join(os.tmpdir(), 'claude-cost-monitor');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, `${sessionId}.json`);
}

function loadState(sessionId) {
  const statePath = getStatePath(sessionId);
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { shown: [] };
  }
}

function saveState(sessionId, state) {
  fs.writeFileSync(getStatePath(sessionId), JSON.stringify(state));
}

// Main — reads payload from stdin, checks thresholds, returns systemMessage
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  const sessionId = payload.session_id;
  const transcriptPath = normalizePath(payload.transcript_path);

  if (!sessionId || !transcriptPath) process.exit(0);

  const stats = scanTranscript(transcriptPath);
  if (!stats) process.exit(0);

  const state = loadState(sessionId);

  // Check each threshold, pick the first un-shown one
  for (const threshold of THRESHOLDS) {
    if (state.shown.includes(threshold.id)) continue;

    const message = threshold.check(stats);
    if (message) {
      state.shown.push(threshold.id);
      saveState(sessionId, state);

      const output = JSON.stringify({ systemMessage: `💰 Cost tip: ${message}` });
      process.stdout.write(output);
      process.exit(0);
    }
  }

  // No new thresholds triggered
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`cost-monitor: ${err.message}\n`);
    process.exit(0);
  });
}

module.exports = { PRICING, getPricing, normalizePath, scanTranscript, THRESHOLDS, loadState, saveState, getStatePath };
