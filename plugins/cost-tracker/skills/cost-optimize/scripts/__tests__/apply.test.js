const fs = require('fs');
const path = require('path');
const os = require('os');
const { computeCandidates, applyToProject, modelTier, readSettings } = require('../apply');

describe('modelTier', () => {
  test('detects each tier', () => {
    expect(modelTier('claude-opus-4-7')).toBe('opus');
    expect(modelTier('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelTier('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelTier('something-else')).toBe('unknown');
  });
});

describe('computeCandidates', () => {
  function entry(project, cwd, opusCost, msgs, totalCost = opusCost) {
    return {
      project,
      cwd,
      total_cost_usd: totalCost,
      models: {
        'claude-opus-4-6': { cost_usd: opusCost, message_count: msgs },
      },
    };
  }

  test('returns nothing when fewer than 3 sessions', () => {
    const entries = [entry('p1', '/a', 5, 5), entry('p1', '/a', 5, 5)];
    expect(computeCandidates(entries)).toEqual([]);
  });

  test('flags project with low avg messages and high opus spend', () => {
    const entries = [
      entry('routine-app', '/cwd/routine', 10, 5),
      entry('routine-app', '/cwd/routine', 8, 4),
      entry('routine-app', '/cwd/routine', 12, 6),
    ];
    const cands = computeCandidates(entries);
    expect(cands.length).toBe(1);
    expect(cands[0].project).toBe('routine-app');
    expect(cands[0].cwd).toBe('/cwd/routine');
    expect(cands[0].savings).toBeGreaterThan(0);
    expect(cands[0].recommendedModel).toBe('sonnet');
  });

  test('skips project when avg cost too high', () => {
    const entries = [
      entry('big-app', '/cwd/big', 200, 10),
      entry('big-app', '/cwd/big', 200, 10),
      entry('big-app', '/cwd/big', 200, 10),
    ];
    expect(computeCandidates(entries)).toEqual([]);
  });

  test('uses most-frequent cwd as recommendation target', () => {
    const entries = [
      entry('multi', '/cwd/a', 10, 5),
      entry('multi', '/cwd/a', 10, 5),
      entry('multi', '/cwd/b', 10, 5),
    ];
    const cands = computeCandidates(entries);
    expect(cands[0].cwd).toBe('/cwd/a');
  });
});

describe('applyToProject', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('creates settings.json when missing', () => {
    const result = applyToProject({ project: 'p', cwd: tmpDir, recommendedModel: 'sonnet', savings: 5 });
    expect(result.status).toBe('created');
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const json = readSettings(settingsPath);
    expect(json.model).toBe('sonnet');
  });

  test('merges into existing settings without model field', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'));
    fs.writeFileSync(path.join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ env: { FOO: 'bar' } }));
    const result = applyToProject({ project: 'p', cwd: tmpDir, recommendedModel: 'sonnet', savings: 5 });
    expect(result.status).toBe('updated');
    const json = readSettings(path.join(tmpDir, '.claude', 'settings.json'));
    expect(json.env.FOO).toBe('bar');
    expect(json.model).toBe('sonnet');
  });

  test('skips when existing model field is set', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'));
    fs.writeFileSync(path.join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    const result = applyToProject({ project: 'p', cwd: tmpDir, recommendedModel: 'sonnet', savings: 5 });
    expect(result.status).toBe('skipped');
    const json = readSettings(path.join(tmpDir, '.claude', 'settings.json'));
    expect(json.model).toBe('opus');
  });

  test('skips when cwd does not exist', () => {
    const result = applyToProject({ project: 'p', cwd: '/path/that/does/not/exist', recommendedModel: 'sonnet', savings: 5 });
    expect(result.status).toBe('skipped');
  });
});
