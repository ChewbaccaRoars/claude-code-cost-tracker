// plugins/cost-tracker/lib/usage-correlator.js
const fs = require('fs');

function correlateUsage(entries, installedSkills, installedMcps) {
  const skills = new Map();
  const mcps = new Map();

  for (const name of installedSkills) {
    skills.set(name, { last_used: null, session_count: 0 });
  }
  for (const name of installedMcps) {
    mcps.set(name, { last_used: null, session_count: 0 });
  }

  for (const entry of entries) {
    const ts = entry.timestamp;
    for (const skill of (entry.skills_used || [])) {
      if (skills.has(skill)) {
        const s = skills.get(skill);
        s.session_count += 1;
        if (!s.last_used || ts > s.last_used) s.last_used = ts;
      }
    }
    for (const mcp of (entry.mcps_used || [])) {
      if (mcps.has(mcp)) {
        const m = mcps.get(mcp);
        m.session_count += 1;
        if (!m.last_used || ts > m.last_used) m.last_used = ts;
      }
    }
  }

  return { skills, mcps };
}

function extractSkillsFromTranscript(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const found = new Set();

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.message) continue;

    const role = entry.message.role;
    const msgContent = entry.message.content;

    if (role === 'user' && typeof msgContent === 'string') {
      const match = msgContent.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)/);
      if (match) found.add(match[1]);
    }

    if (role === 'assistant' && Array.isArray(msgContent)) {
      for (const block of msgContent) {
        if (block.type === 'tool_use' && block.name === 'Skill' && block.input && block.input.skill) {
          found.add(block.input.skill);
        }
      }
    }
  }

  return [...found];
}

function extractMcpsFromTranscript(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const found = new Set();

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.message || entry.message.role !== 'assistant') continue;
    const msgContent = entry.message.content;
    if (!Array.isArray(msgContent)) continue;

    for (const block of msgContent) {
      if (block.type === 'tool_use' && block.name) {
        const match = block.name.match(/^mcp__([^_]+)__/);
        if (match) found.add(match[1]);
      }
    }
  }

  return [...found];
}

module.exports = { correlateUsage, extractSkillsFromTranscript, extractMcpsFromTranscript };
