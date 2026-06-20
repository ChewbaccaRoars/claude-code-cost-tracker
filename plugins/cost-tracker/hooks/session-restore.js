#!/usr/bin/env node

/**
 * SessionEnd hook: Restores MCP and skills configuration from backup if present.
 * This ensures users don't accidentally leave their environment in a lean state.
 */

const { detectRuntime, getConfigPaths } = require('../lib/config-paths');
const { hasBackup, restoreMcpConfig, enableSkills } = require('../lib/profile-manager');

try {
  const runtime = detectRuntime();
  const paths = getConfigPaths(runtime);

  if (hasBackup(paths)) {
    // Restore MCP configuration
    restoreMcpConfig(paths);

    // Re-enable all skills
    enableSkills(paths, 'all');

    // Silent success - hook runs automatically
  }

  // Always exit 0 for hook safety
  process.exit(0);
} catch (error) {
  // Suppress errors in hooks to avoid blocking session end
  process.exit(0);
}
