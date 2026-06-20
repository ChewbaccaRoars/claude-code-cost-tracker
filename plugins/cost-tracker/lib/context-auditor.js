const fs = require('fs');
const path = require('path');

const KNOWN_MCP_SERVERS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'known-mcp-servers.json'), 'utf8')
);
const DEFAULT_MCP_TOOLS = 15;
const TOKENS_PER_TOOL = 200;
const CHARS_TO_TOKENS = 0.25;

function scanSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  const findings = [];
  for (const dir of fs.readdirSync(skillsDir)) {
    const skillPath = path.join(skillsDir, dir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const bytes = fs.statSync(skillPath).size;
    findings.push({
      source: 'skill',
      name: dir,
      path: skillPath,
      bytes,
      estimated_tokens: Math.ceil(bytes * CHARS_TO_TOKENS),
      cost_per_session_usd: 0,
      cost_per_month_usd: 0,
      last_used: null,
      sessions_used: 0,
      total_sessions: 0,
      usage_rate: 0,
      verdict: 'disable',
      reason: '',
    });
  }
  return findings;
}

function scanMcpServers(settingsPath) {
  if (!fs.existsSync(settingsPath)) return [];
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const servers = settings.mcpServers || {};
  const findings = [];
  for (const [name, _config] of Object.entries(servers)) {
    const toolCount = KNOWN_MCP_SERVERS[name] || DEFAULT_MCP_TOOLS;
    const estimatedTokens = toolCount * TOKENS_PER_TOOL;
    findings.push({
      source: 'mcp',
      name,
      path: settingsPath,
      bytes: 0,
      estimated_tokens: estimatedTokens,
      cost_per_session_usd: 0,
      cost_per_month_usd: 0,
      last_used: null,
      sessions_used: 0,
      total_sessions: 0,
      usage_rate: 0,
      verdict: 'disable',
      reason: '',
    });
  }
  return findings;
}

function scanPlugins(pluginsDir) {
  if (!fs.existsSync(pluginsDir)) return [];
  const findings = [];
  for (const pluginDir of fs.readdirSync(pluginsDir)) {
    const skillsSubdir = path.join(pluginsDir, pluginDir, 'skills');
    if (!fs.existsSync(skillsSubdir)) continue;
    for (const skillDir of fs.readdirSync(skillsSubdir)) {
      const skillPath = path.join(skillsSubdir, skillDir, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const bytes = fs.statSync(skillPath).size;
      findings.push({
        source: 'plugin',
        name: `${pluginDir}/${skillDir}`,
        path: skillPath,
        bytes,
        estimated_tokens: Math.ceil(bytes * CHARS_TO_TOKENS),
        cost_per_session_usd: 0,
        cost_per_month_usd: 0,
        last_used: null,
        sessions_used: 0,
        total_sessions: 0,
        usage_rate: 0,
        verdict: 'disable',
        reason: '',
      });
    }
  }
  return findings;
}

function scanHooks(settingsPath) {
  if (!fs.existsSync(settingsPath)) return [];
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const hooks = settings.hooks || {};
  const findings = [];
  for (const [event, hookList] of Object.entries(hooks)) {
    let count = 0;
    const arr = Array.isArray(hookList) ? hookList : [hookList];
    for (const group of arr) {
      count += (group.hooks || []).length;
    }
    findings.push({
      source: 'hook',
      name: event,
      path: settingsPath,
      bytes: 0,
      estimated_tokens: 0,
      cost_per_session_usd: 0,
      cost_per_month_usd: 0,
      last_used: null,
      sessions_used: 0,
      total_sessions: 0,
      usage_rate: 0,
      verdict: 'keep',
      reason: `${count} hook(s) on ${event}`,
    });
  }
  return findings;
}

function scanMemory(projectDir) {
  const findings = [];
  const home = process.env.HOME || process.env.USERPROFILE;
  const candidates = [];
  if (projectDir) {
    candidates.push(path.join(projectDir, 'CLAUDE.md'));
  }
  if (home) {
    candidates.push(path.join(home, 'CLAUDE.md'));
    const memDir = path.join(home, '.claude', 'projects');
    if (fs.existsSync(memDir)) {
      for (const dir of fs.readdirSync(memDir)) {
        const memoryMd = path.join(memDir, dir, 'memory', 'MEMORY.md');
        if (fs.existsSync(memoryMd)) candidates.push(memoryMd);
      }
    }
  }

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    const bytes = fs.statSync(filePath).size;
    findings.push({
      source: 'memory',
      name: path.basename(filePath),
      path: filePath,
      bytes,
      estimated_tokens: Math.ceil(bytes * CHARS_TO_TOKENS),
      cost_per_session_usd: 0,
      cost_per_month_usd: 0,
      last_used: null,
      sessions_used: 0,
      total_sessions: 0,
      usage_rate: 0,
      verdict: 'keep',
      reason: 'Memory files are always loaded',
    });
  }
  return findings;
}

function scanPermissions(settingsPath) {
  if (!fs.existsSync(settingsPath)) return [];
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const perms = (settings.permissions || {}).allow || [];
  const count = perms.length;
  return [{
    source: 'system',
    name: 'permissions',
    path: settingsPath,
    bytes: count,
    estimated_tokens: 0,
    cost_per_session_usd: 0,
    cost_per_month_usd: 0,
    last_used: null,
    sessions_used: 0,
    total_sessions: 0,
    usage_rate: 0,
    verdict: count > 100 ? 'reduce' : 'keep',
    reason: count > 100 ? `${count} permission entries - consider consolidating with wildcards` : `${count} permission entries`,
  }];
}

function getVerdict(finding) {
  const now = Date.now();
  const lastUsedMs = finding.last_used ? new Date(finding.last_used).getTime() : 0;
  const daysSinceUsed = finding.last_used ? (now - lastUsedMs) / (1000 * 60 * 60 * 24) : Infinity;

  if (daysSinceUsed <= 7 || finding.usage_rate > 0.10) return 'keep';
  if (finding.usage_rate > 0.02 && finding.bytes > 10240) return 'reduce';
  if (daysSinceUsed > 30 || !finding.last_used) return 'disable';
  return 'keep';
}

module.exports = {
  scanSkills, scanMcpServers, scanPlugins, scanHooks,
  scanMemory, scanPermissions, getVerdict,
  KNOWN_MCP_SERVERS, DEFAULT_MCP_TOOLS, TOKENS_PER_TOOL, CHARS_TO_TOKENS,
};
