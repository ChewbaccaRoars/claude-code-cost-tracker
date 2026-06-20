const fs = require('fs');
const path = require('path');
const { scanSkills, scanMcpServers } = require('../lib/context-auditor');

const home = process.env.HOME || process.env.USERPROFILE;
const snapshotPath = path.join(home, '.claude', 'cost-tracker', 'context-snapshots.jsonl');

function createSnapshot(options = {}) {
  const skillsDir = options.skillsDir || path.join(home, '.claude', 'skills');
  const settingsPath = options.settingsPath || path.join(home, '.claude', 'settings.json');

  const skillFindings = scanSkills(skillsDir);
  const mcpFindings = scanMcpServers(settingsPath);

  const snapshot = {
    timestamp: new Date().toISOString(),
    skills: skillFindings.map(f => f.name),
    skills_total_bytes: skillFindings.reduce((s, f) => s + f.bytes, 0),
    mcps: mcpFindings.map(f => f.name),
    mcp_tool_count: mcpFindings.reduce((s, f) => s + (f.estimated_tokens / 200), 0),
    estimated_context_tokens: skillFindings.reduce((s, f) => s + f.estimated_tokens, 0)
      + mcpFindings.reduce((s, f) => s + f.estimated_tokens, 0),
  };

  return snapshot;
}

async function main() {
  const snapshot = createSnapshot();

  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.appendFileSync(snapshotPath, JSON.stringify(snapshot) + '\n');
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`context-snapshot: ${err.message}\n`);
    process.exit(0);
  });
}

module.exports = { createSnapshot };
