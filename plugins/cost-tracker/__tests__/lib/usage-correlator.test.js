// plugins/cost-tracker/__tests__/lib/usage-correlator.test.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { correlateUsage, extractSkillsFromTranscript, extractMcpsFromTranscript } = require('../../lib/usage-correlator');

describe('correlateUsage', () => {
  test('counts skill usage from skills_used field', () => {
    const entries = [
      { timestamp: '2026-06-10T10:00:00Z', skills_used: ['cost-tracker', 'gmail-triage'], mcps_used: [] },
      { timestamp: '2026-06-12T10:00:00Z', skills_used: ['cost-tracker'], mcps_used: [] },
      { timestamp: '2026-06-15T10:00:00Z', skills_used: [], mcps_used: [] },
    ];
    const result = correlateUsage(entries, ['cost-tracker', 'gmail-triage', 'unused-skill'], []);
    expect(result.skills.get('cost-tracker')).toEqual({ last_used: '2026-06-12T10:00:00Z', session_count: 2 });
    expect(result.skills.get('gmail-triage')).toEqual({ last_used: '2026-06-10T10:00:00Z', session_count: 1 });
    expect(result.skills.get('unused-skill')).toEqual({ last_used: null, session_count: 0 });
  });

  test('counts MCP usage from mcps_used field', () => {
    const entries = [
      { timestamp: '2026-06-10T10:00:00Z', skills_used: [], mcps_used: ['slack', 'servicenow-mcp'] },
      { timestamp: '2026-06-15T10:00:00Z', skills_used: [], mcps_used: ['slack'] },
    ];
    const result = correlateUsage(entries, [], ['slack', 'servicenow-mcp', 'atlan-mcp']);
    expect(result.mcps.get('slack')).toEqual({ last_used: '2026-06-15T10:00:00Z', session_count: 2 });
    expect(result.mcps.get('atlan-mcp')).toEqual({ last_used: null, session_count: 0 });
  });

  test('handles entries without skills_used/mcps_used fields', () => {
    const entries = [
      { timestamp: '2026-06-10T10:00:00Z' },
      { timestamp: '2026-06-15T10:00:00Z', skills_used: ['cost-tracker'], mcps_used: [] },
    ];
    const result = correlateUsage(entries, ['cost-tracker'], []);
    expect(result.skills.get('cost-tracker').session_count).toBe(1);
  });

  test('empty entries returns all zeroes', () => {
    const result = correlateUsage([], ['skill-a'], ['mcp-b']);
    expect(result.skills.get('skill-a')).toEqual({ last_used: null, session_count: 0 });
    expect(result.mcps.get('mcp-b')).toEqual({ last_used: null, session_count: 0 });
  });
});

describe('extractSkillsFromTranscript', () => {
  let tmpDir, tmpFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'correlator-test-'));
    tmpFile = path.join(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('finds Skill() tool calls in assistant messages', () => {
    const lines = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'gmail-triage' } }] } }),
    ];
    fs.writeFileSync(tmpFile, lines.join('\n'));
    expect(extractSkillsFromTranscript(tmpFile)).toContain('gmail-triage');
  });

  test('finds /skill-name in user messages', () => {
    const lines = [
      JSON.stringify({ message: { role: 'user', content: '/cost-tracker week' } }),
    ];
    fs.writeFileSync(tmpFile, lines.join('\n'));
    expect(extractSkillsFromTranscript(tmpFile)).toContain('cost-tracker');
  });

  test('does not double-count the same skill', () => {
    const lines = [
      JSON.stringify({ message: { role: 'user', content: '/cost-tracker week' } }),
      JSON.stringify({ message: { role: 'user', content: '/cost-tracker month' } }),
    ];
    fs.writeFileSync(tmpFile, lines.join('\n'));
    const skills = extractSkillsFromTranscript(tmpFile);
    expect(skills.filter(s => s === 'cost-tracker')).toHaveLength(1);
  });

  test('returns empty array for empty file', () => {
    fs.writeFileSync(tmpFile, '');
    expect(extractSkillsFromTranscript(tmpFile)).toEqual([]);
  });
});

describe('extractMcpsFromTranscript', () => {
  let tmpDir, tmpFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'correlator-test-'));
    tmpFile = path.join(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('finds mcp__server__tool patterns in tool_use calls', () => {
    const lines = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__slack__post_message', input: {} }] } }),
    ];
    fs.writeFileSync(tmpFile, lines.join('\n'));
    expect(extractMcpsFromTranscript(tmpFile)).toContain('slack');
  });

  test('extracts unique server names from multiple tool calls', () => {
    const lines = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__slack__post_message', input: {} }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__slack__search_messages', input: {} }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__servicenow-mcp__list_incidents', input: {} }] } }),
    ];
    fs.writeFileSync(tmpFile, lines.join('\n'));
    const mcps = extractMcpsFromTranscript(tmpFile);
    expect(mcps).toContain('slack');
    expect(mcps).toContain('servicenow-mcp');
    expect(mcps.filter(m => m === 'slack')).toHaveLength(1);
  });

  test('returns empty array for no MCP usage', () => {
    const lines = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } }),
    ];
    fs.writeFileSync(tmpFile, lines.join('\n'));
    expect(extractMcpsFromTranscript(tmpFile)).toEqual([]);
  });
});
