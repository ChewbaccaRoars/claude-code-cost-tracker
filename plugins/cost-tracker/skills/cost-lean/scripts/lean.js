#!/usr/bin/env node
// plugins/cost-tracker/skills/cost-lean/scripts/lean.js

const fs = require('fs');
const path = require('path');
const { detectRuntime, getConfigPaths } = require('../../../lib/config-paths');
const {
  saveProfile,
  loadProfile,
  listProfiles: listProfileNames,
  listDisabledSkills,
  restoreAll,
} = require('../../../lib/profile-manager');
const { scanSkills, scanMcpServers } = require('../../../lib/context-auditor');
const { correlateUsage } = require('../../../lib/usage-correlator');
const { BASE_PRICING } = require('../../../lib/pricing-engine');

const home = process.env.HOME || process.env.USERPROFILE;
const logPath = path.join(home, '.claude', 'cost-tracker', 'cost-log.jsonl');

function loadEntries() {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function filterByDate(entries, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return entries.filter((e) => new Date(e.timestamp) >= cutoff);
}

function showStatus() {
  const runtime = detectRuntime();
  const paths = getConfigPaths(runtime);

  const skills = scanSkills(paths.skillsDir);
  const mcps = scanMcpServers(paths.mcpConfig);
  const disabled = listDisabledSkills(paths);

  const opusPricing = BASE_PRICING['claude-opus-4-6'];
  const avgMessagesPerSession = 15;

  let out = '';
  out += `## Current Context Load\n\n`;

  // Context load table
  if (skills.length > 0 || mcps.length > 0) {
    out += `| Source | Name | Size/Tools | Tokens | $/Month |\n`;
    out += `|--------|------|-----------|--------|----------|\n`;

    for (const s of skills) {
      const perMessageCost = s.estimated_tokens * opusPricing.input;
      const perMonth = perMessageCost * avgMessagesPerSession * 30;
      out += `| Skill | ${s.name} | ${(s.bytes / 1024).toFixed(0)}KB | ~${Math.round(s.estimated_tokens / 1000)}K | $${perMonth.toFixed(2)} |\n`;
    }

    for (const m of mcps) {
      const tools = m.estimated_tokens / 200;
      const perMessageCost = m.estimated_tokens * opusPricing.input;
      const perMonth = perMessageCost * avgMessagesPerSession * 30;
      out += `| MCP | ${m.name} | ${tools} tools | ~${Math.round(m.estimated_tokens / 1000)}K | $${perMonth.toFixed(2)} |\n`;
    }

    const totalTokens = [...skills, ...mcps].reduce((s, f) => s + f.estimated_tokens, 0);
    const totalCost = [...skills, ...mcps].reduce((s, f) => {
      const perMessageCost = f.estimated_tokens * opusPricing.input;
      return s + perMessageCost * avgMessagesPerSession * 30;
    }, 0);

    out += `\n**Total context load:** ~${Math.round(totalTokens / 1000)}K tokens/session\n`;
    out += `**Estimated monthly cost:** $${totalCost.toFixed(2)}\n\n`;
  } else {
    out += `No skills or MCPs found.\n\n`;
  }

  // Currently disabled
  if (disabled.length > 0) {
    out += `### Currently Disabled\n\n`;
    disabled.forEach((name, i) => {
      out += `${i + 1}. ${name}\n`;
    });
    out += `\n`;
  }

  console.log(out);
}

function showProfiles() {
  const runtime = detectRuntime();
  const paths = getConfigPaths(runtime);
  const names = listProfileNames(paths);

  if (names.length === 0) {
    console.log(`No saved profiles found.`);
    return;
  }

  let out = `## Saved Profiles\n\n`;
  out += `| Name | Description | MCPs | Skills |\n`;
  out += `|------|-------------|------|--------|\n`;

  for (const name of names) {
    const profile = loadProfile(paths, name);
    if (!profile) continue;
    const desc = profile.description || '';
    const mcpCount = (profile.mcps || []).length;
    const skillCount = (profile.skills || []).length;
    out += `| ${name} | ${desc} | ${mcpCount} | ${skillCount} |\n`;
  }

  console.log(out);
}

function saveCurrentProfile(name, description) {
  if (!name) {
    console.error(`Usage: lean.js save <name> [description]`);
    process.exit(1);
  }

  const runtime = detectRuntime();
  const paths = getConfigPaths(runtime);

  // Scan what's currently enabled
  const allSkills = scanSkills(paths.skillsDir);
  const allMcps = scanMcpServers(paths.mcpConfig);
  const disabled = listDisabledSkills(paths);
  const disabledSet = new Set(disabled);

  const enabledSkills = allSkills.map((s) => s.name).filter((n) => !disabledSet.has(n));
  const enabledMcps = allMcps.map((m) => m.name);

  const profile = {
    name,
    description: description || `Saved on ${new Date().toISOString()}`,
    skills: enabledSkills,
    mcps: enabledMcps,
  };

  saveProfile(paths, name, profile);
  console.log(`Profile "${name}" saved with ${enabledSkills.length} skills and ${enabledMcps.length} MCPs.`);
}

function generateRecommendations() {
  const runtime = detectRuntime();
  const paths = getConfigPaths(runtime);

  const entries = loadEntries();
  if (entries.length === 0) {
    console.log(`No usage data found in ${logPath}. Run some sessions first.`);
    return;
  }

  const entries30d = filterByDate(entries, 30);
  const entries7d = filterByDate(entries, 7);

  const allSkills = scanSkills(paths.skillsDir);
  const allMcps = scanMcpServers(paths.mcpConfig);

  const installedSkills = allSkills.map((s) => s.name);
  const installedMcps = allMcps.map((m) => m.name);

  const { skills: skillUsage30d, mcps: mcpUsage30d } = correlateUsage(entries30d, installedSkills, installedMcps);
  const { skills: skillUsage7d, mcps: mcpUsage7d } = correlateUsage(entries7d, installedSkills, installedMcps);

  const opusPricing = BASE_PRICING['claude-opus-4-6'];
  const avgMessagesPerSession = 15;

  let out = `## Profile Recommendations\n\n`;

  // Lean profile: >20% usage in last 30 days
  const leanSkills = installedSkills.filter((name) => {
    const usage = skillUsage30d.get(name);
    return usage && usage.session_count / entries30d.length > 0.2;
  });
  const leanMcps = installedMcps.filter((name) => {
    const usage = mcpUsage30d.get(name);
    return usage && usage.session_count / entries30d.length > 0.2;
  });

  if (leanSkills.length > 0 || leanMcps.length > 0) {
    const leanProfile = {
      name: 'lean',
      description: 'Skills/MCPs used in >20% of sessions (last 30 days)',
      skills: leanSkills,
      mcps: leanMcps,
    };
    saveProfile(paths, 'lean', leanProfile);

    const savedTokens = allSkills.filter((s) => !leanSkills.includes(s.name)).reduce((sum, s) => sum + s.estimated_tokens, 0) +
      allMcps.filter((m) => !leanMcps.includes(m.name)).reduce((sum, m) => sum + m.estimated_tokens, 0);

    const savedCost = (savedTokens * opusPricing.input * avgMessagesPerSession * 30);

    out += `### "lean" Profile\n\n`;
    out += `${leanSkills.length} skills, ${leanMcps.length} MCPs — used in >20% of sessions\n`;
    out += `**Estimated savings:** ~${Math.round(savedTokens / 1000)}K tokens/session (~$${savedCost.toFixed(2)}/month)\n\n`;
  }

  // Recent profile: used in last 7 days
  const recentSkills = installedSkills.filter((name) => {
    const usage = skillUsage7d.get(name);
    return usage && usage.session_count > 0;
  });
  const recentMcps = installedMcps.filter((name) => {
    const usage = mcpUsage7d.get(name);
    return usage && usage.session_count > 0;
  });

  if (recentSkills.length > 0 || recentMcps.length > 0) {
    const recentProfile = {
      name: 'recent',
      description: 'Skills/MCPs used in the last 7 days',
      skills: recentSkills,
      mcps: recentMcps,
    };
    saveProfile(paths, 'recent', recentProfile);

    const savedTokens = allSkills.filter((s) => !recentSkills.includes(s.name)).reduce((sum, s) => sum + s.estimated_tokens, 0) +
      allMcps.filter((m) => !recentMcps.includes(m.name)).reduce((sum, m) => sum + m.estimated_tokens, 0);

    const savedCost = (savedTokens * opusPricing.input * avgMessagesPerSession * 30);

    out += `### "recent" Profile\n\n`;
    out += `${recentSkills.length} skills, ${recentMcps.length} MCPs — used in last 7 days\n`;
    out += `**Estimated savings:** ~${Math.round(savedTokens / 1000)}K tokens/session (~$${savedCost.toFixed(2)}/month)\n\n`;
  }

  // Project-specific profiles: group by project (inferred from transcript paths)
  const projectMap = new Map();
  for (const entry of entries30d) {
    if (!entry.transcript_path) continue;
    // Extract project identifier from path (e.g., C:\Users\befoster\myproject\ -> myproject)
    const parts = entry.transcript_path.split(/[/\\]/);
    let projectName = null;
    const homeIndex = parts.findIndex((p) => p === 'befoster' || p === home.split(/[/\\]/).pop());
    if (homeIndex !== -1 && homeIndex + 1 < parts.length) {
      projectName = parts[homeIndex + 1];
    }
    if (!projectName || projectName === '.claude') continue;

    if (!projectMap.has(projectName)) {
      projectMap.set(projectName, { sessions: [], skills: new Set(), mcps: new Set() });
    }
    const proj = projectMap.get(projectName);
    proj.sessions.push(entry);
    (entry.skills_used || []).forEach((s) => proj.skills.add(s));
    (entry.mcps_used || []).forEach((m) => proj.mcps.add(m));
  }

  for (const [projectName, data] of projectMap.entries()) {
    if (data.sessions.length < 5) continue; // Only create profile if 5+ sessions

    const projectSkills = [...data.skills].filter((s) => installedSkills.includes(s));
    const projectMcps = [...data.mcps].filter((m) => installedMcps.includes(m));

    if (projectSkills.length === 0 && projectMcps.length === 0) continue;

    const profileName = `project-${projectName}`;
    const projectProfile = {
      name: profileName,
      description: `${projectName} project (${data.sessions.length} sessions)`,
      skills: projectSkills,
      mcps: projectMcps,
    };
    saveProfile(paths, profileName, projectProfile);

    const savedTokens = allSkills.filter((s) => !projectSkills.includes(s.name)).reduce((sum, s) => sum + s.estimated_tokens, 0) +
      allMcps.filter((m) => !projectMcps.includes(m.name)).reduce((sum, m) => sum + m.estimated_tokens, 0);

    const savedCost = (savedTokens * opusPricing.input * avgMessagesPerSession * 30);

    out += `### "${profileName}" Profile\n\n`;
    out += `${projectSkills.length} skills, ${projectMcps.length} MCPs — ${projectName} project (${data.sessions.length} sessions)\n`;
    out += `**Estimated savings:** ~${Math.round(savedTokens / 1000)}K tokens/session (~$${savedCost.toFixed(2)}/month)\n\n`;
  }

  out += `---\n\n`;
  out += `To apply a profile before your next session, run:\n`;
  out += `\`\`\`\nnpx cost-lean --profile <name>\n\`\`\`\n`;

  console.log(out);
}

function restore() {
  const runtime = detectRuntime();
  const paths = getConfigPaths(runtime);

  const result = restoreAll(paths);

  let out = `## Config Restored\n\n`;
  if (result.mcpRestored) {
    out += `MCP config restored from backup.\n`;
  } else {
    out += `No MCP backup found.\n`;
  }

  if (result.skillsEnabled.length > 0) {
    out += `\nRe-enabled ${result.skillsEnabled.length} skills:\n`;
    result.skillsEnabled.forEach((name, i) => {
      out += `${i + 1}. ${name}\n`;
    });
  } else {
    out += `\nNo disabled skills found.\n`;
  }

  console.log(out);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  switch (command) {
    case 'status':
      showStatus();
      break;
    case 'profiles':
      showProfiles();
      break;
    case 'save':
      saveCurrentProfile(args[1], args.slice(2).join(' '));
      break;
    case 'recommend':
      generateRecommendations();
      break;
    case 'restore':
      restore();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(`Usage: lean.js [status|profiles|save <name>|recommend|restore]`);
      process.exit(1);
  }
}

module.exports = {
  showStatus,
  showProfiles,
  saveCurrentProfile,
  generateRecommendations,
  restore,
};
