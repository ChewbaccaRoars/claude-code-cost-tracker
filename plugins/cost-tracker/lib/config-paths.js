const os = require('os');
const path = require('path');

/**
 * Detects the runtime environment.
 * Checks for Cursor-specific environment variables (CURSOR_SESSION, CURSOR_TRACE_ID).
 * Falls back to 'claude-code' if neither is present.
 *
 * @returns {'claude-code' | 'cursor'} The detected runtime
 */
function detectRuntime() {
  if (process.env.CURSOR_SESSION || process.env.CURSOR_TRACE_ID) {
    return 'cursor';
  }
  return 'claude-code';
}

/**
 * Returns configuration file paths for the specified runtime.
 *
 * Both runtimes share:
 * - skillsDir: ~/.claude/skills/ (Cursor users may also have Claude Code skills)
 * - settingsFile: ~/.claude/settings.json
 * - profilesDir: ~/.claude/cost-tracker/profiles/
 * - backupsDir: ~/.claude/cost-tracker/backups/
 *
 * Differences:
 * - mcpConfig: ~/.claude/.mcp.json (claude-code) vs ~/.cursor/mcp.json (cursor)
 *
 * @param {'claude-code' | 'cursor'} runtime - The runtime to get paths for
 * @returns {Object} Configuration paths
 * @returns {string} return.mcpConfig - Path to MCP configuration file
 * @returns {string} return.skillsDir - Path to skills directory
 * @returns {string} return.settingsFile - Path to settings file
 * @returns {string} return.profilesDir - Path to profiles directory
 * @returns {string} return.backupsDir - Path to backups directory
 */
function getConfigPaths(runtime) {
  const homeDir = os.homedir();

  // MCP config path differs by runtime
  const mcpConfig = runtime === 'cursor'
    ? path.join(homeDir, '.cursor', 'mcp.json')
    : path.join(homeDir, '.claude', '.mcp.json');

  // All other paths are shared between runtimes
  return {
    mcpConfig,
    skillsDir: path.join(homeDir, '.claude', 'skills'),
    settingsFile: path.join(homeDir, '.claude', 'settings.json'),
    profilesDir: path.join(homeDir, '.claude', 'cost-tracker', 'profiles'),
    backupsDir: path.join(homeDir, '.claude', 'cost-tracker', 'backups')
  };
}

module.exports = { detectRuntime, getConfigPaths };
