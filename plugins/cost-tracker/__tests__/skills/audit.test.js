const path = require('path');
const { runAudit, formatAuditReport } = require('../../skills/cost-audit/scripts/audit');

const fixturesDir = path.join(__dirname, '..', 'fixtures');

describe('runAudit', () => {
  test('returns findings array with verdicts', () => {
    const result = runAudit({
      skillsDir: path.join(fixturesDir, 'mock-skills'),
      settingsPath: path.join(fixturesDir, 'mock-settings.json'),
      entries: [],
      sessionsPerMonth: 100,
    });
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) {
      expect(['keep', 'reduce', 'disable']).toContain(f.verdict);
    }
  });

  test('calculates total context tokens', () => {
    const result = runAudit({
      skillsDir: path.join(fixturesDir, 'mock-skills'),
      settingsPath: path.join(fixturesDir, 'mock-settings.json'),
      entries: [],
      sessionsPerMonth: 100,
    });
    expect(result.totalContextTokens).toBeGreaterThan(0);
  });

  test('calculates monthly cost estimates', () => {
    const result = runAudit({
      skillsDir: path.join(fixturesDir, 'mock-skills'),
      settingsPath: path.join(fixturesDir, 'mock-settings.json'),
      entries: [],
      sessionsPerMonth: 100,
    });
    expect(result.totalMonthlyCost).toBeGreaterThan(0);
  });

  test('totalSavings sums disable and reduce findings', () => {
    const result = runAudit({
      skillsDir: path.join(fixturesDir, 'mock-skills'),
      settingsPath: path.join(fixturesDir, 'mock-settings.json'),
      entries: [],
      sessionsPerMonth: 100,
    });
    const manualSum = result.findings
      .filter(f => f.verdict === 'disable' || f.verdict === 'reduce')
      .reduce((s, f) => s + f.cost_per_month_usd, 0);
    expect(result.totalSavings).toBeCloseTo(manualSum, 4);
  });

  test('handles missing directories gracefully', () => {
    const result = runAudit({
      skillsDir: '/nonexistent',
      settingsPath: '/nonexistent/settings.json',
      pluginsDir: '/nonexistent/plugins',
      entries: [],
      sessionsPerMonth: 100,
    });
    expect(result.findings).toEqual([]);
    expect(result.totalContextTokens).toBe(0);
  });
});

describe('formatAuditReport', () => {
  test('outputs markdown string', () => {
    const result = {
      findings: [
        { source: 'skill', name: 'test-skill', bytes: 5000, estimated_tokens: 1250, cost_per_month_usd: 0.50, verdict: 'disable', reason: 'Not used in 60 days', last_used: null, usage_rate: 0, sessions_used: 0, total_sessions: 100 },
      ],
      totalContextTokens: 1250,
      totalMonthlyCost: 0.50,
      totalSavings: 0.50,
    };
    const output = formatAuditReport(result);
    expect(output).toContain('Context Audit');
    expect(output).toContain('test-skill');
    expect(output).toContain('DISABLE');
  });

  test('handles empty findings', () => {
    const result = { findings: [], totalContextTokens: 0, totalMonthlyCost: 0, totalSavings: 0 };
    const output = formatAuditReport(result);
    expect(output).toContain('No context waste');
  });
});
