const { detectRuntime, getConfigPaths } = require('../../lib/config-paths');
const os = require('os');
const path = require('path');

describe('config-paths', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
    delete process.env.CURSOR_SESSION;
    delete process.env.CURSOR_TRACE_ID;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('detectRuntime', () => {
    test('returns claude-code by default', () => {
      expect(detectRuntime()).toBe('claude-code');
    });

    test('returns cursor when CURSOR_SESSION env var is set', () => {
      process.env.CURSOR_SESSION = 'test-session';
      expect(detectRuntime()).toBe('cursor');
    });

    test('returns cursor when CURSOR_TRACE_ID env var is set', () => {
      process.env.CURSOR_TRACE_ID = 'test-trace-id';
      expect(detectRuntime()).toBe('cursor');
    });

    test('returns cursor when both CURSOR env vars are set', () => {
      process.env.CURSOR_SESSION = 'test-session';
      process.env.CURSOR_TRACE_ID = 'test-trace-id';
      expect(detectRuntime()).toBe('cursor');
    });
  });

  describe('getConfigPaths', () => {
    const homeDir = os.homedir();

    describe('claude-code runtime', () => {
      test('returns correct paths for claude-code', () => {
        const paths = getConfigPaths('claude-code');

        expect(paths).toEqual({
          mcpConfig: path.join(homeDir, '.claude', '.mcp.json'),
          skillsDir: path.join(homeDir, '.claude', 'skills'),
          settingsFile: path.join(homeDir, '.claude', 'settings.json'),
          profilesDir: path.join(homeDir, '.claude', 'cost-tracker', 'profiles'),
          backupsDir: path.join(homeDir, '.claude', 'cost-tracker', 'backups')
        });
      });
    });

    describe('cursor runtime', () => {
      test('returns correct paths for cursor', () => {
        const paths = getConfigPaths('cursor');

        expect(paths).toEqual({
          mcpConfig: path.join(homeDir, '.cursor', 'mcp.json'),
          skillsDir: path.join(homeDir, '.claude', 'skills'),
          settingsFile: path.join(homeDir, '.claude', 'settings.json'),
          profilesDir: path.join(homeDir, '.claude', 'cost-tracker', 'profiles'),
          backupsDir: path.join(homeDir, '.claude', 'cost-tracker', 'backups')
        });
      });

      test('cursor shares profilesDir with claude-code', () => {
        const claudePaths = getConfigPaths('claude-code');
        const cursorPaths = getConfigPaths('cursor');

        expect(cursorPaths.profilesDir).toBe(claudePaths.profilesDir);
      });

      test('cursor shares backupsDir with claude-code', () => {
        const claudePaths = getConfigPaths('claude-code');
        const cursorPaths = getConfigPaths('cursor');

        expect(cursorPaths.backupsDir).toBe(claudePaths.backupsDir);
      });
    });

    describe('path construction', () => {
      test('uses correct home directory', () => {
        const paths = getConfigPaths('claude-code');

        Object.values(paths).forEach(p => {
          expect(p.startsWith(homeDir)).toBe(true);
        });
      });

      test('uses path.join for cross-platform compatibility', () => {
        const paths = getConfigPaths('claude-code');

        // Verify paths don't have mixed separators
        Object.values(paths).forEach(p => {
          // Should use the platform's separator consistently
          const normalized = path.normalize(p);
          expect(p).toBe(normalized);
        });
      });
    });
  });
});
