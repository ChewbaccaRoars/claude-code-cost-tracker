const fs = require('fs');
const path = require('path');
const os = require('os');
const { createSnapshot } = require('../../hooks/context-snapshot');

describe('createSnapshot', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
    fs.mkdirSync(path.join(tmpDir, 'skills', 'test-skill'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'skills', 'test-skill', 'SKILL.md'), '# Test\nSome content here.');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns snapshot object with required fields', () => {
    const snapshot = createSnapshot({ skillsDir: path.join(tmpDir, 'skills'), settingsPath: '/nonexistent' });
    expect(snapshot).toHaveProperty('timestamp');
    expect(snapshot).toHaveProperty('skills');
    expect(snapshot).toHaveProperty('skills_total_bytes');
    expect(snapshot).toHaveProperty('mcps');
    expect(snapshot).toHaveProperty('estimated_context_tokens');
    expect(snapshot.skills).toContain('test-skill');
  });

  test('calculates total bytes from skill files', () => {
    const snapshot = createSnapshot({ skillsDir: path.join(tmpDir, 'skills'), settingsPath: '/nonexistent' });
    expect(snapshot.skills_total_bytes).toBeGreaterThan(0);
  });

  test('handles missing skills directory', () => {
    const snapshot = createSnapshot({ skillsDir: '/nonexistent', settingsPath: '/nonexistent' });
    expect(snapshot.skills).toEqual([]);
    expect(snapshot.skills_total_bytes).toBe(0);
  });
});
