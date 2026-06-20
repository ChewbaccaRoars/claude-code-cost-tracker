const fs = require('fs');
const path = require('path');
const os = require('os');
const { scanSkills, scanMcpServers, scanPlugins, scanHooks, scanMemory, scanPermissions, getVerdict } = require('../../lib/context-auditor');

const fixturesDir = path.join(__dirname, '..', 'fixtures');

describe('scanSkills', () => {
  test('returns findings for each skill directory', () => {
    const findings = scanSkills(path.join(fixturesDir, 'mock-skills'));
    expect(findings).toHaveLength(3);
    const names = findings.map(f => f.name).sort();
    expect(names).toEqual(['bloated-skill', 'unused-skill', 'used-skill']);
  });

  test('each finding has required fields', () => {
    const findings = scanSkills(path.join(fixturesDir, 'mock-skills'));
    for (const f of findings) {
      expect(f.source).toBe('skill');
      expect(f).toHaveProperty('name');
      expect(f).toHaveProperty('bytes');
      expect(f).toHaveProperty('estimated_tokens');
      expect(typeof f.bytes).toBe('number');
      expect(f.estimated_tokens).toBe(Math.ceil(f.bytes * 0.25));
    }
  });

  test('returns empty array for non-existent directory', () => {
    expect(scanSkills('/nonexistent/path')).toEqual([]);
  });
});

describe('scanMcpServers', () => {
  test('returns findings for each MCP server', () => {
    const findings = scanMcpServers(path.join(fixturesDir, 'mock-settings.json'));
    expect(findings).toHaveLength(3);
    expect(findings.map(f => f.name).sort()).toEqual(['custom-mcp', 'playwright', 'slack']);
  });

  test('uses known-servers lookup for tool count estimate', () => {
    const findings = scanMcpServers(path.join(fixturesDir, 'mock-settings.json'));
    const slack = findings.find(f => f.name === 'slack');
    expect(slack.estimated_tokens).toBeGreaterThan(0);
  });

  test('unknown servers default to 15 tools', () => {
    const findings = scanMcpServers(path.join(fixturesDir, 'mock-settings.json'));
    const custom = findings.find(f => f.name === 'custom-mcp');
    expect(custom.estimated_tokens).toBe(15 * 200);
  });
});

describe('scanHooks', () => {
  test('returns findings for hook event groups', () => {
    const findings = scanHooks(path.join(fixturesDir, 'mock-settings.json'));
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.source).toBe('hook');
    }
  });
});

describe('scanPermissions', () => {
  test('returns finding with entry count', () => {
    const findings = scanPermissions(path.join(fixturesDir, 'mock-settings.json'));
    expect(findings).toHaveLength(1);
    expect(findings[0].name).toBe('permissions');
    expect(findings[0].bytes).toBe(3);
  });

  test('does not flag small permission lists', () => {
    const findings = scanPermissions(path.join(fixturesDir, 'mock-settings.json'));
    expect(findings[0].verdict).not.toBe('disable');
  });
});

describe('getVerdict', () => {
  test('keep: used within 7 days', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(getVerdict({ last_used: recent, usage_rate: 0.01, bytes: 5000 })).toBe('keep');
  });

  test('keep: usage rate above 10%', () => {
    expect(getVerdict({ last_used: '2026-01-01T00:00:00Z', usage_rate: 0.15, bytes: 5000 })).toBe('keep');
  });

  test('reduce: moderate usage but large size', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    expect(getVerdict({ last_used: twoWeeksAgo, usage_rate: 0.05, bytes: 25000 })).toBe('reduce');
  });

  test('disable: never used', () => {
    expect(getVerdict({ last_used: null, usage_rate: 0, bytes: 5000 })).toBe('disable');
  });

  test('disable: not used in 30+ days', () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    expect(getVerdict({ last_used: old, usage_rate: 0.005, bytes: 5000 })).toBe('disable');
  });
});
