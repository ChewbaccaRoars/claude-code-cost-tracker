const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Pricing per token (not per million)
const PRICING = {
  'claude-opus-4-6':            { input: 15/1e6, output: 75/1e6, cache_write: 18.75/1e6, cache_read: 1.50/1e6 },
  'claude-sonnet-4-6':          { input: 3/1e6,  output: 15/1e6, cache_write: 3.75/1e6,  cache_read: 0.30/1e6 },
  'claude-sonnet-4-5-20250929': { input: 3/1e6,  output: 15/1e6, cache_write: 3.75/1e6,  cache_read: 0.30/1e6 },
  'claude-haiku-4-5-20251001':  { input: 0.80/1e6, output: 4/1e6, cache_write: 1/1e6,    cache_read: 0.08/1e6 },
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
  try {
    const url = execSync('git remote get-url origin', { cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const match = url.match(/\/([^/]+?)(?:\.git)?$/) || url.match(/:([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {}
  try {
    const toplevel = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return path.basename(toplevel);
  } catch {}
  return path.basename(cwd);
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

    // Peak context approximation: input + cache tokens for this exchange
    const contextTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    if (contextTokens > peakContext) peakContext = contextTokens;
  }

  return { models, peakContext };
}

async function main() {
  // Read hook payload from stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  const { session_id, cwd, reason } = payload;
  const transcript_path = normalizePath(payload.transcript_path);

  if (!transcript_path || !fs.existsSync(transcript_path)) process.exit(0);

  // Parse main transcript
  const main = parseTranscript(transcript_path);

  // Parse subagent transcripts (stored in <session-id>/subagents/ next to the transcript)
  const subagentDir = path.join(path.dirname(transcript_path), session_id, 'subagents');
  if (fs.existsSync(subagentDir)) {
    const files = fs.readdirSync(subagentDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const result = parseTranscript(path.join(subagentDir, file));
      for (const [model, tokens] of Object.entries(result.models)) {
        if (!main.models[model]) {
          main.models[model] = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, message_count: 0 };
        }
        const m = main.models[model];
        m.input_tokens += tokens.input_tokens;
        m.output_tokens += tokens.output_tokens;
        m.cache_creation_input_tokens += tokens.cache_creation_input_tokens;
        m.cache_read_input_tokens += tokens.cache_read_input_tokens;
        m.message_count += tokens.message_count;
      }
      if (result.peakContext > main.peakContext) main.peakContext = result.peakContext;
    }
  }

  // Calculate costs per model
  let totalCost = 0;
  const modelsWithCost = {};
  const totalTokens = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  for (const [model, tokens] of Object.entries(main.models)) {
    const { pricing, estimated } = getPricing(model);
    const cost = calcCost(pricing, tokens);
    totalCost += cost;
    modelsWithCost[model] = { ...tokens, cost_usd: Math.round(cost * 10000) / 10000 };
    if (estimated) modelsWithCost[model].pricing_estimated = true;

    totalTokens.input_tokens += tokens.input_tokens;
    totalTokens.output_tokens += tokens.output_tokens;
    totalTokens.cache_creation_input_tokens += tokens.cache_creation_input_tokens;
    totalTokens.cache_read_input_tokens += tokens.cache_read_input_tokens;
  }

  // Model comparison: what would this session cost on each model?
  const modelComparison = {};
  for (const [name, pricing] of Object.entries(COMPARISON_MODELS)) {
    modelComparison[name] = Math.round(calcCost(pricing, totalTokens) * 10000) / 10000;
  }

  // Resolve project name
  const normalizedCwd = cwd ? normalizePath(cwd) : process.cwd();
  const project = getProjectName(normalizedCwd);

  const logEntry = {
    timestamp: new Date().toISOString(),
    session_id,
    project,
    cwd: normalizedCwd,
    models: modelsWithCost,
    total_cost_usd: Math.round(totalCost * 10000) / 10000,
    model_comparison: modelComparison,
    peak_context_tokens: main.peakContext,
    reason: reason || 'unknown',
  };

  // Write to user's home directory (persists across plugin updates)
  const logPath = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'cost-tracker', 'cost-log.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
}

main().catch(() => process.exit(0));
