// Per-tool token attribution: which tools (Read, Bash, Grep, subagents, MCP, etc.)
// are driving input-token cost? The transcript records every tool_use and the
// tool_result that follows; tool_result bodies enter the next assistant turn's
// context, so their size is a strong proxy for incremental input cost.
//
// CLI:
//   node tool-attribution.js                           # aggregate across all transcripts
//   node tool-attribution.js --transcript <path>       # single transcript
//
// Note: this is an *attribution* heuristic, not exact accounting. The actual
// usage.input_tokens reported by the API includes everything in context, not
// just the latest tool result. We estimate result tokens at 4 chars per token,
// which is the well-known rough conversion for English/code.

const fs = require('fs');
const path = require('path');

const home = process.env.HOME || process.env.USERPROFILE;
const projectsDir = path.join(home, '.claude', 'projects');
const logPath = path.join(home, '.claude', 'cost-tracker', 'cost-log.jsonl');

const CHARS_PER_TOKEN = 4;

function loadEntries() {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function blockLength(block) {
  if (!block) return 0;
  if (typeof block === 'string') return block.length;
  if (typeof block.text === 'string') return block.text.length;
  if (typeof block.content === 'string') return block.content.length;
  if (Array.isArray(block.content)) return block.content.reduce((s, b) => s + blockLength(b), 0);
  // Fallback: stringify whatever shape it is
  try { return JSON.stringify(block).length; } catch { return 0; }
}

// Walk a transcript file and attribute tool usage.
// Returns: { perTool: { name -> { calls, est_result_tokens, est_input_tokens, est_output_tokens } }, totalCalls }
function attributeTranscript(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);

  // Map tool_use_id -> tool name, recorded when we see the assistant emit it.
  const idToName = new Map();
  const perTool = {};
  let totalCalls = 0;

  function ensure(name) {
    if (!perTool[name]) {
      perTool[name] = { calls: 0, est_result_tokens: 0, est_input_tokens: 0, est_output_tokens: 0 };
    }
    return perTool[name];
  }

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolsThisTurn = [];
      let textChars = 0;
      for (const block of msg.content) {
        if (block && block.type === 'tool_use') {
          const name = block.name || 'unknown';
          if (block.id) idToName.set(block.id, name);
          toolsThisTurn.push(name);
          // Tool input (the args) goes through output tokens of the assistant turn.
          const inputChars = block.input ? JSON.stringify(block.input).length : 0;
          ensure(name).est_input_tokens += Math.round(inputChars / CHARS_PER_TOKEN);
          ensure(name).calls += 1;
          totalCalls += 1;
        } else if (block && block.type === 'text' && block.text) {
          textChars += block.text.length;
        }
      }
      // Distribute the assistant turn's output_tokens across tools used in this turn.
      const out = (msg.usage && msg.usage.output_tokens) || 0;
      if (out > 0 && toolsThisTurn.length > 0) {
        const share = out / toolsThisTurn.length;
        for (const name of toolsThisTurn) ensure(name).est_output_tokens += share;
      }
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && block.type === 'tool_result') {
          const name = idToName.get(block.tool_use_id) || 'unknown';
          const chars = blockLength(block);
          ensure(name).est_result_tokens += Math.round(chars / CHARS_PER_TOKEN);
        }
      }
    }
  }

  return { perTool, totalCalls };
}

// Find every transcript jsonl under ~/.claude/projects
function findAllTranscripts() {
  const out = [];
  if (!fs.existsSync(projectsDir)) return out;
  for (const project of fs.readdirSync(projectsDir)) {
    const projDir = path.join(projectsDir, project);
    let entries;
    try { entries = fs.readdirSync(projDir); } catch { continue; }
    for (const f of entries) {
      if (f.endsWith('.jsonl')) out.push(path.join(projDir, f));
    }
  }
  return out;
}

function aggregate(perToolList) {
  const merged = {};
  let totalCalls = 0;
  for (const result of perToolList) {
    if (!result) continue;
    totalCalls += result.totalCalls;
    for (const [name, data] of Object.entries(result.perTool)) {
      if (!merged[name]) merged[name] = { calls: 0, est_result_tokens: 0, est_input_tokens: 0, est_output_tokens: 0 };
      merged[name].calls += data.calls;
      merged[name].est_result_tokens += data.est_result_tokens;
      merged[name].est_input_tokens += data.est_input_tokens;
      merged[name].est_output_tokens += data.est_output_tokens;
    }
  }
  return { perTool: merged, totalCalls };
}

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function formatReport(agg) {
  const rows = Object.entries(agg.perTool).map(([name, d]) => ({
    name, ...d,
    avg_result: d.calls > 0 ? d.est_result_tokens / d.calls : 0,
  })).sort((a, b) => b.est_result_tokens - a.est_result_tokens);

  console.log('## Per-Tool Token Attribution\n');
  console.log(`Scanned ${agg.totalCalls} tool call(s).\n`);
  if (rows.length === 0) {
    console.log('No tool calls found in transcripts.');
    return;
  }

  console.log('| Tool | Calls | Result tokens (est) | Avg/call | Output tokens (est) |');
  console.log('|------|------:|--------------------:|---------:|--------------------:|');
  for (const r of rows.slice(0, 20)) {
    console.log(`| ${r.name} | ${r.calls} | ${fmtTokens(r.est_result_tokens)} | ${fmtTokens(r.avg_result)} | ${fmtTokens(r.est_output_tokens)} |`);
  }

  console.log('\n*Result tokens* are estimated from tool_result body length (4 chars ≈ 1 token).');
  console.log('Tools with high `Avg/call` are the highest-leverage targets — switching to a more focused alternative (e.g. Grep instead of full-file Read, or scoped Bash output) reduces input cost on every subsequent turn.');

  // Insights
  console.log('\n### Insights\n');
  const top = rows[0];
  if (top && top.est_result_tokens > 100_000) {
    console.log(`- **${top.name}** dominates input footprint at ${fmtTokens(top.est_result_tokens)} tokens of result data across ${top.calls} call(s).`);
  }
  const heavyAvg = rows.filter(r => r.avg_result > 5000 && r.calls >= 5).slice(0, 3);
  for (const r of heavyAvg) {
    console.log(`- **${r.name}** averages ${fmtTokens(r.avg_result)} tokens per call — consider scoping or summarizing.`);
  }
  const readLike = rows.find(r => /^read$/i.test(r.name));
  if (readLike && readLike.avg_result > 4000) {
    console.log(`- Read calls average ${fmtTokens(readLike.avg_result)} tokens. Use \`limit\`/\`offset\` to read only the lines you need.`);
  }
  const bashLike = rows.find(r => /^bash$/i.test(r.name));
  if (bashLike && bashLike.avg_result > 4000) {
    console.log(`- Bash output averages ${fmtTokens(bashLike.avg_result)} tokens. Pipe through \`head\`, \`grep\`, or \`wc\` to limit captured output.`);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let single = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--transcript' && args[i + 1]) { single = args[i + 1]; i++; }
  }

  let agg;
  if (single) {
    const result = attributeTranscript(single);
    if (!result) {
      process.stderr.write(`tool-attribution: cannot read ${single}\n`);
      process.exit(1);
    }
    agg = aggregate([result]);
  } else {
    const transcripts = findAllTranscripts();
    if (transcripts.length === 0) {
      console.log('No transcripts found under ~/.claude/projects.');
      process.exit(0);
    }
    agg = aggregate(transcripts.map(attributeTranscript));
  }

  formatReport(agg);
}

module.exports = { attributeTranscript, aggregate, findAllTranscripts, formatReport, blockLength, loadEntries, CHARS_PER_TOKEN };
