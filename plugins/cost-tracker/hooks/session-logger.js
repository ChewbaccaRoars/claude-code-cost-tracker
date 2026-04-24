const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Pricing per token (not per million) — updated April 2026
const PRICING = {
  'claude-opus-4-7':            { input: 5/1e6, output: 25/1e6, cache_write: 6.25/1e6, cache_read: 0.50/1e6 },
  'claude-opus-4-6':            { input: 5/1e6, output: 25/1e6, cache_write: 6.25/1e6, cache_read: 0.50/1e6 },
  'claude-sonnet-4-6':          { input: 3/1e6, output: 15/1e6, cache_write: 3.75/1e6, cache_read: 0.30/1e6 },
  'claude-sonnet-4-5-20250929': { input: 3/1e6, output: 15/1e6, cache_write: 3.75/1e6, cache_read: 0.30/1e6 },
  'claude-haiku-4-5-20251001':  { input: 1/1e6, output: 5/1e6,  cache_write: 1.25/1e6, cache_read: 0.10/1e6 },
};

const COMPARISON_MODELS = {
  opus:   PRICING['claude-opus-4-6'],
  sonnet: PRICING['claude-sonnet-4-6'],
  haiku:  PRICING['claude-haiku-4-5-20251001'],
};

function getPricing(model) {
  if (PRICING[model]) return { pricing: PRICING[model], estimated: false };
  const lower = model.toLowerCase();
  if (lower.includes('opus'))   return { pricing: PRICING['claude-opus-4-6'], estimated: false };
  if (lower.includes('haiku'))  return { pricing: PRICING['claude-haiku-4-5-20251001'], estimated: false };
  if (lower.includes('sonnet')) return { pricing: PRICING['claude-sonnet-4-6'], estimated: false };
  return { pricing: PRICING['claude-sonnet-4-6'], estimated: true };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function calcCost(pricing, tokens) {
  return (
    (tokens.input_tokens || 0) * pricing.input +
    (tokens.output_tokens || 0) * pricing.output +
    (tokens.cache_creation_input_tokens || 0) * pricing.cache_write +
    (tokens.cache_read_input_tokens || 0) * pricing.cache_read
  );
}

// Convert Git Bash paths (/c/Users/...) to Windows paths (C:\Users\...)
function normalizePath(p) {
  if (!p) return p;
  const match = p.match(/^\/([a-zA-Z])\/(.*)/);
  if (match) return match[1].toUpperCase() + ':\\' + match[2].replace(/\//g, '\\');
  return p;
}

function getProjectName(cwd) {
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' };
  try {
    const url = execSync('git remote get-url origin', { cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], env: gitEnv }).trim();
    const match = url.match(/\/([^/]+?)(?:\.git)?$/) || url.match(/:([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {}
  try {
    const toplevel = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], env: gitEnv }).trim();
    return path.basename(toplevel);
  } catch {}
  return path.basename(cwd);
}

function getSessionName(sessionId, projectPath) {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home || !sessionId) return null;

  // Claude Code stores session metadata in project-scoped sessions-index.json
  // The project key is the cwd with path separators replaced by '--'
  const projectKeys = [];
  if (projectPath) {
    const normalized = projectPath.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d) => d.toUpperCase() + ':');
    projectKeys.push(normalized.replace(/[/\\]/g, '-').replace(/:/g, '-'));
  }

  const claudeDir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) return null;

  // Try project-specific index first, then scan all project dirs
  try {
    const dirs = projectKeys.length > 0 ? projectKeys : fs.readdirSync(claudeDir);
    for (const dir of dirs) {
      const indexPath = path.join(claudeDir, dir, 'sessions-index.json');
      if (!fs.existsSync(indexPath)) continue;
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const entries = index.entries || [];
      const match = entries.find(e => e.sessionId === sessionId);
      if (match && match.summary) return match.summary;
    }
  } catch {}
  return null;
}

const CATEGORY_PATTERNS = {
  debug:    /\b(debug|fix|bug|error|broken|crash|issue|fail|wrong|not working|stack ?trace)\b/i,
  build:    /\b(build|create|add|implement|feature|scaffold|new file|generate|write a)\b/i,
  review:   /\b(review|audit|check|inspect|scan|look at|examine|assess)\b/i,
  refactor: /\b(refactor|cleanup|clean up|reorganize|rename|restructure|simplify|extract)\b/i,
  test:     /\b(test|spec|coverage|jest|pytest|unit test|integration test)\b/i,
  docs:     /\b(doc|readme|comment|explain|document|write up|description)\b/i,
  deploy:   /\b(deploy|ship|release|publish|push|merge|ci|cd|pipeline)\b/i,
  config:   /\b(config|setup|install|env|setting|permission|hook|plugin)\b/i,
};

function classifySession(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const scores = {};

  let sampled = 0;
  for (const line of lines) {
    if (sampled >= 10) break;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.message || entry.message.role !== 'user') continue;

    const text = typeof entry.message.content === 'string'
      ? entry.message.content
      : Array.isArray(entry.message.content)
        ? entry.message.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
        : '';

    if (!text) continue;
    sampled++;

    for (const [category, pattern] of Object.entries(CATEGORY_PATTERNS)) {
      const matches = (text.match(pattern) || []).length;
      if (matches > 0) scores[category] = (scores[category] || 0) + matches;
    }
  }

  if (Object.keys(scores).length === 0) return null;
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

function parseTranscript(filePath) {
  const models = {};
  let peakContext = 0;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (!entry.message || entry.message.role !== 'assistant' || !entry.message.usage) continue;

    const model = entry.message.model || 'unknown';
    const usage = entry.message.usage;

    if (!models[model]) {
      models[model] = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        message_count: 0,
      };
    }

    const m = models[model];
    m.input_tokens += usage.input_tokens || 0;
    m.output_tokens += usage.output_tokens || 0;
    m.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
    m.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
    m.message_count += 1;

    const contextTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    if (contextTokens > peakContext) peakContext = contextTokens;
  }

  return { models, peakContext };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  const { session_id, cwd, reason } = payload;
  const transcript_path = normalizePath(payload.transcript_path);

  // Sanitize session_id to prevent path traversal in subagent dir construction
  if (session_id && /[/\\]|\.\./.test(session_id)) {
    process.stderr.write('cost-tracker: invalid session_id, skipping\n');
    process.exit(1);
  }

  if (!transcript_path || !fs.existsSync(transcript_path)) process.exit(0);

  const primaryResult = parseTranscript(transcript_path);

  // Parse subagent transcripts
  const subagentDir = path.join(path.dirname(transcript_path), session_id, 'subagents');
  if (fs.existsSync(subagentDir)) {
    const files = fs.readdirSync(subagentDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const result = parseTranscript(path.join(subagentDir, file));
      for (const [model, tokens] of Object.entries(result.models)) {
        if (!primaryResult.models[model]) {
          primaryResult.models[model] = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, message_count: 0 };
        }
        const m = primaryResult.models[model];
        m.input_tokens += tokens.input_tokens;
        m.output_tokens += tokens.output_tokens;
        m.cache_creation_input_tokens += tokens.cache_creation_input_tokens;
        m.cache_read_input_tokens += tokens.cache_read_input_tokens;
        m.message_count += tokens.message_count;
      }
      if (result.peakContext > primaryResult.peakContext) primaryResult.peakContext = result.peakContext;
    }
  }

  // Calculate costs per model
  let totalCost = 0;
  const modelsWithCost = {};
  const totalTokens = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  for (const [model, tokens] of Object.entries(primaryResult.models)) {
    const { pricing, estimated } = getPricing(model);
    const cost = calcCost(pricing, tokens);
    totalCost += cost;
    modelsWithCost[model] = { ...tokens, cost_usd: round4(cost) };
    if (estimated) modelsWithCost[model].pricing_estimated = true;

    totalTokens.input_tokens += tokens.input_tokens;
    totalTokens.output_tokens += tokens.output_tokens;
    totalTokens.cache_creation_input_tokens += tokens.cache_creation_input_tokens;
    totalTokens.cache_read_input_tokens += tokens.cache_read_input_tokens;
  }

  // Model comparison
  const modelComparison = {};
  for (const [name, pricing] of Object.entries(COMPARISON_MODELS)) {
    modelComparison[name] = round4(calcCost(pricing, totalTokens));
  }

  // Resolve project and session name
  const normalizedCwd = cwd ? normalizePath(cwd) : process.cwd();
  const project = getProjectName(normalizedCwd);
  const sessionName = getSessionName(session_id, normalizedCwd);
  const sessionCategory = classifySession(transcript_path);

  const logEntry = {
    timestamp: new Date().toISOString(),
    session_id,
    session_name: sessionName,
    session_category: sessionCategory,
    project,
    cwd: normalizedCwd,
    models: modelsWithCost,
    total_cost_usd: round4(totalCost),
    model_comparison: modelComparison,
    peak_context_tokens: primaryResult.peakContext,
    reason: reason || 'unknown',
  };

  const logPath = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'cost-tracker', 'cost-log.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`cost-tracker: ${err.message}\n`);
    process.exit(0);
  });
}

module.exports = { PRICING, COMPARISON_MODELS, CATEGORY_PATTERNS, getPricing, round4, calcCost, normalizePath, getProjectName, getSessionName, classifySession, parseTranscript };
