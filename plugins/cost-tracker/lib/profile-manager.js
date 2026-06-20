const fs = require('fs');
const path = require('path');

const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function validateName(name) {
  if (!name || !SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid name: "${name}". Use only alphanumeric, dash, underscore.`);
  }
}

/**
 * Create a backup of current .mcp.json before modifying
 * @param {object} paths - Config paths object
 * @returns {string|null} - Backup file path, or null if no mcp config exists
 */
function backupMcpConfig(paths) {
  if (!fs.existsSync(paths.mcpConfig)) {
    return null;
  }

  fs.mkdirSync(paths.backupsDir, { recursive: true });
  const backupPath = path.join(paths.backupsDir, 'mcp.json.backup');
  fs.copyFileSync(paths.mcpConfig, backupPath);
  return backupPath;
}

/**
 * Restore .mcp.json from backup
 * @param {object} paths - Config paths object
 * @returns {boolean} - True if restored, false if no backup found
 */
function restoreMcpConfig(paths) {
  const backupPath = path.join(paths.backupsDir, 'mcp.json.backup');
  if (!fs.existsSync(backupPath)) {
    return false;
  }

  fs.copyFileSync(backupPath, paths.mcpConfig);
  fs.unlinkSync(backupPath);
  return true;
}

/**
 * Check if a backup exists
 * @param {object} paths - Config paths object
 * @returns {boolean} - True if backup exists
 */
function hasBackup(paths) {
  const backupPath = path.join(paths.backupsDir, 'mcp.json.backup');
  return fs.existsSync(backupPath);
}

/**
 * Write a filtered .mcp.json containing only the named servers
 * @param {object} paths - Config paths object
 * @param {string[]} mcpNames - Server names to KEEP
 * @returns {object} - { kept: string[], removed: string[] }
 */
function applyMcpFilter(paths, mcpNames) {
  if (!fs.existsSync(paths.mcpConfig)) {
    return { kept: [], removed: [] };
  }

  const config = JSON.parse(fs.readFileSync(paths.mcpConfig, 'utf-8'));
  const originalServers = Object.keys(config.mcpServers || {});
  const keepSet = new Set(mcpNames);

  const kept = [];
  const removed = [];
  const filtered = {};

  for (const [name, value] of Object.entries(config.mcpServers || {})) {
    if (keepSet.has(name)) {
      filtered[name] = value;
      kept.push(name);
    } else {
      removed.push(name);
    }
  }

  config.mcpServers = filtered;
  fs.writeFileSync(paths.mcpConfig, JSON.stringify(config, null, 2));

  return { kept, removed };
}

/**
 * Disable skills by renaming SKILL.md → SKILL.md.disabled
 * @param {object} paths - Config paths object
 * @param {string[]} skillNames - Skill directory names to DISABLE
 * @returns {object} - { disabled: string[], notFound: string[] }
 */
function disableSkills(paths, skillNames) {
  const disabled = [];
  const notFound = [];

  for (const skillName of skillNames) {
    if (!SAFE_NAME_RE.test(skillName)) {
      notFound.push(skillName);
      continue;
    }
    const skillDir = path.join(paths.skillsDir, skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');
    const disabledFile = path.join(skillDir, 'SKILL.md.disabled');

    if (fs.existsSync(skillFile)) {
      fs.renameSync(skillFile, disabledFile);
      disabled.push(skillName);
    } else {
      notFound.push(skillName);
    }
  }

  return { disabled, notFound };
}

/**
 * Re-enable skills by renaming SKILL.md.disabled → SKILL.md
 * @param {object} paths - Config paths object
 * @param {string[]} skillNames - Skill directory names to ENABLE (or 'all')
 * @returns {object} - { enabled: string[], notFound: string[] }
 */
function enableSkills(paths, skillNames) {
  const enabled = [];
  const notFound = [];

  // Handle 'all' special case
  if (skillNames.length === 1 && skillNames[0] === 'all') {
    const disabledSkills = listDisabledSkills(paths);
    return enableSkills(paths, disabledSkills);
  }

  for (const skillName of skillNames) {
    if (!SAFE_NAME_RE.test(skillName)) {
      notFound.push(skillName);
      continue;
    }
    const skillDir = path.join(paths.skillsDir, skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');
    const disabledFile = path.join(skillDir, 'SKILL.md.disabled');

    if (fs.existsSync(disabledFile)) {
      fs.renameSync(disabledFile, skillFile);
      enabled.push(skillName);
    } else {
      notFound.push(skillName);
    }
  }

  return { enabled, notFound };
}

/**
 * List currently disabled skills
 * @param {object} paths - Config paths object
 * @returns {string[]} - Array of disabled skill names
 */
function listDisabledSkills(paths) {
  if (!fs.existsSync(paths.skillsDir)) {
    return [];
  }

  const disabled = [];
  const entries = fs.readdirSync(paths.skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const disabledFile = path.join(paths.skillsDir, entry.name, 'SKILL.md.disabled');
      if (fs.existsSync(disabledFile)) {
        disabled.push(entry.name);
      }
    }
  }

  return disabled;
}

/**
 * Save a profile to profilesDir
 * @param {object} paths - Config paths object
 * @param {string} name - Profile name
 * @param {object} profile - Profile object
 */
function saveProfile(paths, name, profile) {
  validateName(name);
  fs.mkdirSync(paths.profilesDir, { recursive: true });
  const profilePath = path.join(paths.profilesDir, `${name}.json`);
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
}

/**
 * Load a profile by name
 * @param {object} paths - Config paths object
 * @param {string} name - Profile name
 * @returns {object|null} - Profile object or null if not found
 */
function loadProfile(paths, name) {
  validateName(name);
  const profilePath = path.join(paths.profilesDir, `${name}.json`);
  if (!fs.existsSync(profilePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
}

/**
 * List all saved profiles
 * @param {object} paths - Config paths object
 * @returns {string[]} - Array of profile names
 */
function listProfiles(paths) {
  if (!fs.existsSync(paths.profilesDir)) {
    return [];
  }

  const files = fs.readdirSync(paths.profilesDir);
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
}

/**
 * Delete a profile
 * @param {object} paths - Config paths object
 * @param {string} name - Profile name
 */
function deleteProfile(paths, name) {
  validateName(name);
  const profilePath = path.join(paths.profilesDir, `${name}.json`);
  if (fs.existsSync(profilePath)) {
    fs.unlinkSync(profilePath);
  }
}

/**
 * Apply a full profile: backup, filter MCPs, disable skills not in profile
 * @param {object} paths - Config paths object
 * @param {object} profile - Profile object with mcps and skills arrays
 * @returns {object} - { mcpResult, skillsDisabled }
 */
function applyProfile(paths, profile) {
  // Backup MCP config
  backupMcpConfig(paths);

  // Filter MCPs
  const mcpResult = applyMcpFilter(paths, profile.mcps || []);

  // Determine which skills to disable (all except those in profile)
  if (!fs.existsSync(paths.skillsDir)) {
    return { mcpResult, skillsDisabled: [] };
  }

  const profileSkills = new Set(profile.skills || []);
  const allSkills = fs.readdirSync(paths.skillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  const skillsToDisable = allSkills.filter(s => {
    const skillFile = path.join(paths.skillsDir, s, 'SKILL.md');
    return !profileSkills.has(s) && fs.existsSync(skillFile);
  });

  const skillsResult = disableSkills(paths, skillsToDisable);

  return {
    mcpResult,
    skillsDisabled: skillsResult.disabled,
  };
}

/**
 * Restore everything: restore MCP backup, re-enable all skills
 * @param {object} paths - Config paths object
 * @returns {object} - { mcpRestored, skillsEnabled }
 */
function restoreAll(paths) {
  const mcpRestored = restoreMcpConfig(paths);
  const skillsResult = enableSkills(paths, ['all']);

  return {
    mcpRestored,
    skillsEnabled: skillsResult.enabled,
  };
}

module.exports = {
  validateName,
  backupMcpConfig,
  restoreMcpConfig,
  hasBackup,
  applyMcpFilter,
  disableSkills,
  enableSkills,
  listDisabledSkills,
  saveProfile,
  loadProfile,
  listProfiles,
  deleteProfile,
  applyProfile,
  restoreAll,
};
