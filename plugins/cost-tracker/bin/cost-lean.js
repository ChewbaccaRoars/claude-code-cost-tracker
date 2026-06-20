#!/usr/bin/env node

const { detectRuntime, getConfigPaths } = require('../lib/config-paths');
const { applyProfile, restoreAll, loadProfile, listProfiles, hasBackup } = require('../lib/profile-manager');
const { showStatus } = require('../skills/cost-lean/scripts/lean');

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    return { command: 'status' };
  }

  if (args[0] === '--profile' && args[1]) {
    return { command: 'profile', name: args[1] };
  }

  if (args[0] === '--list') {
    return { command: 'list' };
  }

  if (args[0] === '--save' && args[1]) {
    return { command: 'save', name: args[1] };
  }

  if (args[0] === '--recommend') {
    return { command: 'recommend' };
  }

  if (args[0] === '--restore') {
    return { command: 'restore' };
  }

  console.error('Usage:');
  console.error('  cost-lean                     # show status');
  console.error('  cost-lean --profile <name>    # apply a saved profile');
  console.error('  cost-lean --list              # list saved profiles');
  console.error('  cost-lean --save <name>       # save current config as profile');
  console.error('  cost-lean --recommend         # generate recommendations');
  console.error('  cost-lean --restore           # restore full config from backup');
  process.exit(1);
}

async function main() {
  try {
    const parsed = parseArgs();
    const runtime = detectRuntime();
    const paths = getConfigPaths(runtime);

    switch (parsed.command) {
      case 'status': {
        await showStatus();
        break;
      }

      case 'profile': {
        const profile = loadProfile(paths, parsed.name);
        if (!profile) {
          console.error(`Profile "${parsed.name}" not found.`);
          console.error('Run: cost-lean --list');
          process.exit(1);
        }

        console.log(`\nApplying profile: ${parsed.name}`);
        console.log(`Description: ${profile.description || 'No description'}`);

        if (profile.mcps && profile.mcps.length > 0) {
          console.log(`\nMCP servers to keep: ${profile.mcps.join(', ')}`);
        } else {
          console.log('\nMCP servers: All disabled');
        }

        if (profile.skills && profile.skills.length > 0) {
          console.log(`Skills to keep: ${profile.skills.join(', ')}`);
        } else {
          console.log('Skills: All disabled');
        }

        const result = applyProfile(paths, profile);

        console.log(`\n✓ Profile "${parsed.name}" applied.`);
        console.log(`  ${result.mcpResult.kept.length} MCP servers kept, ${result.skillsDisabled.length} skills disabled.`);
        console.log(`  Backup saved.`);

        const launchCmd = runtime === 'cursor' ? 'Open Cursor' : 'claude';
        console.log(`\nStart your session with: ${launchCmd}`);
        break;
      }

      case 'list': {
        const profileNames = listProfiles(paths);
        if (profileNames.length === 0) {
          console.log('No profiles saved.');
          console.log('Run: cost-lean --save <name>');
        } else {
          console.log('Saved profiles:');
          profileNames.forEach(name => {
            const profile = loadProfile(paths, name);
            const desc = profile && profile.description ? ` - ${profile.description}` : '';
            console.log(`  ${name}${desc}`);
          });
        }
        break;
      }

      case 'save': {
        // For now, just show an error - saving requires the recommend flow
        console.error('Profile saving is done via the cost-lean skill during a session.');
        console.error('Run the skill and use the save action from recommendations.');
        process.exit(1);
        break;
      }

      case 'recommend': {
        const { generateRecommendations } = require('../skills/cost-lean/scripts/lean');
        await generateRecommendations();
        break;
      }

      case 'restore': {
        if (!hasBackup(paths)) {
          console.log('No backup found. Nothing to restore.');
        } else {
          restoreAll(paths);
          console.log('✓ Full configuration restored from backup.');
        }
        break;
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
