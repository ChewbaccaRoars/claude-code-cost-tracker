const fs = require('fs');
const path = require('path');
const os = require('os');
const {
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
} = require('../../lib/profile-manager');

function createTestEnv() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-test-'));

  const mcpConfig = path.join(tempRoot, '.mcp.json');
  const skillsDir = path.join(tempRoot, 'skills');
  const profilesDir = path.join(tempRoot, 'profiles');
  const backupsDir = path.join(tempRoot, 'backups');

  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });

  // Create mock .mcp.json with 3 servers
  const mockMcp = {
    mcpServers: {
      slack: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] },
      playwright: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-playwright'] },
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    },
  };
  fs.writeFileSync(mcpConfig, JSON.stringify(mockMcp, null, 2));

  // Create 3 mock skills
  const skillNames = ['skill-a', 'skill-b', 'skill-c'];
  for (const skillName of skillNames) {
    const skillDir = path.join(skillsDir, skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${skillName}\nTest skill`);
  }

  const paths = { mcpConfig, skillsDir, settingsFile: null, profilesDir, backupsDir };

  return { tempRoot, paths, skillNames };
}

function cleanup(tempRoot) {
  if (fs.existsSync(tempRoot)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe('profile-manager', () => {
  describe('backupMcpConfig', () => {
    test('creates a copy in backupsDir', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        const backupPath = backupMcpConfig(paths);
        expect(backupPath).toBeTruthy();
        expect(fs.existsSync(backupPath)).toBe(true);
        expect(backupPath).toBe(path.join(paths.backupsDir, 'mcp.json.backup'));

        const original = JSON.parse(fs.readFileSync(paths.mcpConfig, 'utf-8'));
        const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
        expect(backup).toEqual(original);
      } finally {
        cleanup(tempRoot);
      }
    });

    test('returns null if no mcp config exists', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        fs.unlinkSync(paths.mcpConfig);
        const backupPath = backupMcpConfig(paths);
        expect(backupPath).toBeNull();
      } finally {
        cleanup(tempRoot);
      }
    });
  });

  describe('restoreMcpConfig', () => {
    test('restores from backup and removes backup file', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        const backupPath = backupMcpConfig(paths);
        expect(backupPath).toBeTruthy();

        // Modify the original
        fs.writeFileSync(paths.mcpConfig, JSON.stringify({ mcpServers: {} }, null, 2));

        const restored = restoreMcpConfig(paths);
        expect(restored).toBe(true);

        const restoredContent = JSON.parse(fs.readFileSync(paths.mcpConfig, 'utf-8'));
        expect(Object.keys(restoredContent.mcpServers)).toHaveLength(3);
        expect(fs.existsSync(backupPath)).toBe(false);
      } finally {
        cleanup(tempRoot);
      }
    });

    test('returns false when no backup exists', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        const restored = restoreMcpConfig(paths);
        expect(restored).toBe(false);
      } finally {
        cleanup(tempRoot);
      }
    });
  });

  describe('hasBackup', () => {
    test('returns true when backup exists', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        backupMcpConfig(paths);
        expect(hasBackup(paths)).toBe(true);
      } finally {
        cleanup(tempRoot);
      }
    });

    test('returns false when no backup exists', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        expect(hasBackup(paths)).toBe(false);
      } finally {
        cleanup(tempRoot);
      }
    });
  });

  describe('applyMcpFilter', () => {
    test('keeps only named servers, returns kept/removed lists', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        const result = applyMcpFilter(paths, ['slack', 'playwright']);
        expect(result.kept.sort()).toEqual(['playwright', 'slack']);
        expect(result.removed).toEqual(['github']);

        const config = JSON.parse(fs.readFileSync(paths.mcpConfig, 'utf-8'));
        expect(Object.keys(config.mcpServers).sort()).toEqual(['playwright', 'slack']);
      } finally {
        cleanup(tempRoot);
      }
    });

    test('with empty list removes all servers', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        const result = applyMcpFilter(paths, []);
        expect(result.kept).toEqual([]);
        expect(result.removed.sort()).toEqual(['github', 'playwright', 'slack']);

        const config = JSON.parse(fs.readFileSync(paths.mcpConfig, 'utf-8'));
        expect(Object.keys(config.mcpServers)).toHaveLength(0);
      } finally {
        cleanup(tempRoot);
      }
    });
  });

  describe('disableSkills', () => {
    test('renames SKILL.md to SKILL.md.disabled', () => {
      const { tempRoot, paths, skillNames } = createTestEnv();
      try {
        const result = disableSkills(paths, ['skill-a', 'skill-b']);
        expect(result.disabled.sort()).toEqual(['skill-a', 'skill-b']);
        expect(result.notFound).toEqual([]);

        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-a', 'SKILL.md'))).toBe(false);
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-a', 'SKILL.md.disabled'))).toBe(true);
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-b', 'SKILL.md'))).toBe(false);
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-b', 'SKILL.md.disabled'))).toBe(true);
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-c', 'SKILL.md'))).toBe(true);
      } finally {
        cleanup(tempRoot);
      }
    });

    test('returns notFound for missing skills', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        const result = disableSkills(paths, ['skill-a', 'nonexistent']);
        expect(result.disabled).toEqual(['skill-a']);
        expect(result.notFound).toEqual(['nonexistent']);
      } finally {
        cleanup(tempRoot);
      }
    });
  });

  describe('enableSkills', () => {
    test('renames SKILL.md.disabled to SKILL.md', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        disableSkills(paths, ['skill-a', 'skill-b']);

        const result = enableSkills(paths, ['skill-a']);
        expect(result.enabled).toEqual(['skill-a']);
        expect(result.notFound).toEqual([]);

        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-a', 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-a', 'SKILL.md.disabled'))).toBe(false);
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-b', 'SKILL.md.disabled'))).toBe(true);
      } finally {
        cleanup(tempRoot);
      }
    });

    test('enableSkills("all") re-enables everything', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        disableSkills(paths, ['skill-a', 'skill-b', 'skill-c']);

        const result = enableSkills(paths, ['all']);
        expect(result.enabled.sort()).toEqual(['skill-a', 'skill-b', 'skill-c']);

        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-a', 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-b', 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-c', 'SKILL.md'))).toBe(true);
      } finally {
        cleanup(tempRoot);
      }
    });
  });

  describe('listDisabledSkills', () => {
    test('finds disabled skills', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        disableSkills(paths, ['skill-a', 'skill-c']);

        const disabled = listDisabledSkills(paths);
        expect(disabled.sort()).toEqual(['skill-a', 'skill-c']);
      } finally {
        cleanup(tempRoot);
      }
    });
  });

  describe('saveProfile', () => {
    test('writes JSON to profilesDir', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        const profile = {
          name: 'lean',
          description: 'Minimal setup',
          mcps: ['slack'],
          skills: ['cost-tracker'],
          created: '2026-06-20T10:00:00Z',
        };

        saveProfile(paths, 'lean', profile);

        const savedPath = path.join(paths.profilesDir, 'lean.json');
        expect(fs.existsSync(savedPath)).toBe(true);

        const loaded = JSON.parse(fs.readFileSync(savedPath, 'utf-8'));
        expect(loaded).toEqual(profile);
      } finally {
        cleanup(tempRoot);
      }
    });
  });

  describe('loadProfile', () => {
    test('reads and parses profile JSON', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        const profile = {
          name: 'lean',
          description: 'Minimal setup',
          mcps: ['slack'],
          skills: ['cost-tracker'],
          created: '2026-06-20T10:00:00Z',
        };

        saveProfile(paths, 'lean', profile);

        const loaded = loadProfile(paths, 'lean');
        expect(loaded).toEqual(profile);
      } finally {
        cleanup(tempRoot);
      }
    });

    test('returns null for nonexistent profile', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        const loaded = loadProfile(paths, 'nonexistent');
        expect(loaded).toBeNull();
      } finally {
        cleanup(tempRoot);
      }
    });
  });

  describe('listProfiles', () => {
    test('returns all saved profiles', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        const profiles = [
          { name: 'lean', description: 'Minimal', mcps: ['slack'], skills: ['cost-tracker'] },
          { name: 'full', description: 'Everything', mcps: ['slack', 'playwright'], skills: ['skill-a', 'skill-b'] },
        ];

        for (const profile of profiles) {
          saveProfile(paths, profile.name, profile);
        }

        const list = listProfiles(paths);
        expect(list.sort()).toEqual(['full', 'lean']);
      } finally {
        cleanup(tempRoot);
      }
    });
  });

  describe('deleteProfile', () => {
    test('deletes a profile', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        const profile = { name: 'lean', description: 'Minimal', mcps: [], skills: [] };
        saveProfile(paths, 'lean', profile);

        deleteProfile(paths, 'lean');

        const savedPath = path.join(paths.profilesDir, 'lean.json');
        expect(fs.existsSync(savedPath)).toBe(false);
      } finally {
        cleanup(tempRoot);
      }
    });
  });

  describe('applyProfile', () => {
    test('backs up, filters MCPs, disables unselected skills', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        const profile = {
          name: 'lean',
          description: 'Minimal setup',
          mcps: ['slack'],
          skills: ['skill-a'],
          created: '2026-06-20T10:00:00Z',
        };

        const result = applyProfile(paths, profile);

        expect(result.mcpResult.kept).toEqual(['slack']);
        expect(result.mcpResult.removed.sort()).toEqual(['github', 'playwright']);
        expect(result.skillsDisabled.sort()).toEqual(['skill-b', 'skill-c']);

        // Verify backup exists
        expect(hasBackup(paths)).toBe(true);

        // Verify MCP config
        const config = JSON.parse(fs.readFileSync(paths.mcpConfig, 'utf-8'));
        expect(Object.keys(config.mcpServers)).toEqual(['slack']);

        // Verify skills
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-a', 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-b', 'SKILL.md.disabled'))).toBe(true);
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-c', 'SKILL.md.disabled'))).toBe(true);
      } finally {
        cleanup(tempRoot);
      }
    });
  });

  describe('restoreAll', () => {
    test('restores MCP config and re-enables all skills', () => {
      const { tempRoot, paths } = createTestEnv();
      try {
        const profile = {
          name: 'lean',
          description: 'Minimal setup',
          mcps: ['slack'],
          skills: ['skill-a'],
          created: '2026-06-20T10:00:00Z',
        };

        applyProfile(paths, profile);

        const result = restoreAll(paths);
        expect(result.mcpRestored).toBe(true);
        expect(result.skillsEnabled.sort()).toEqual(['skill-b', 'skill-c']);

        // Verify MCP config restored
        const config = JSON.parse(fs.readFileSync(paths.mcpConfig, 'utf-8'));
        expect(Object.keys(config.mcpServers).sort()).toEqual(['github', 'playwright', 'slack']);

        // Verify all skills enabled
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-a', 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-b', 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(paths.skillsDir, 'skill-c', 'SKILL.md'))).toBe(true);

        // Verify no backup remains
        expect(hasBackup(paths)).toBe(false);
      } finally {
        cleanup(tempRoot);
      }
    });
  });
});
