# Cost Tracker v2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the cost-tracker plugin with context bloat analysis, Cursor pricing support, and comprehensive evals.

**Architecture:** Extract pricing into a shared module (`lib/pricing-engine.js`), add context auditing (`lib/context-auditor.js` + `lib/usage-correlator.js`), add a SessionStart snapshot hook, create a new `/cost-audit` skill, and restructure tests into a top-level `__tests__/` directory.

**Tech Stack:** Node.js (stdlib only, no external deps), Jest 29 for tests

## Global Constraints

- Zero production dependencies (Node.js stdlib only)
- All prices are per-token (divided by 1e6), not per-million
- JSONL format for all log files (one JSON object per line)
- Windows path normalization required (Git Bash `/c/Users/...` to `C:\Users\...`)
- All modules use `require()` / `module.exports` (CommonJS)
- Existing test patterns: `makeEntry()` factories, `fs.mkdtempSync` for file tests, `toBeCloseTo` for floats
- Plugin root referenced as `${CLAUDE_PLUGIN_ROOT}` in hooks.json and SKILL.md

---

### Task 1: Create lib/pricing-engine.js with Tests

**Files:**
- Create: `plugins/cost-tracker/lib/pricing-engine.js`
- Create: `plugins/cost-tracker/__tests__/lib/pricing-engine.test.js`

**Interfaces:**
- Produces: `BASE_PRICING` (object), `RUNTIMES` (object), `COMPARISON_MODELS` (object), `getPricing(modelId, runtime?)` returns `{pricing, estimated}`, `calcCost(pricing, tokens, runtime?)` returns number, `detectRuntime()` returns string, `round4(n)` returns number

- [ ] **Step 1: Write the failing tests**

```javascript
// plugins/cost-tracker/__tests__/lib/pricing-engine.test.js
const path = require('path');

// pricing-engine doesn't exist yet, so this will fail
const {
  BASE_PRICING, RUNTIMES, COMPARISON_MODELS,
  getPricing, calcCost, detectRuntime, round4,
} = require('../../lib/pricing-engine');

describe('BASE_PRICING', () => {
  test('has all 5 known models', () => {
    expect(Object.keys(BASE_PRICING)).toHaveLength(5);
    expect(BASE_PRICING['claude-opus-4-7']).toBeDefined();
    expect(BASE_PRICING['claude-opus-4-6']).toBeDefined();
    expect(BASE_PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(BASE_PRICING['claude-sonnet-4-5-20250929']).toBeDefined();
    expect(BASE_PRICING['claude-haiku-4-5-20251001']).toBeDefined();
  });

  test('each model has input, output, cache_write, cache_read', () => {
    for (const model of Object.values(BASE_PRICING)) {
      expect(model).toHaveProperty('input');
      expect(model).toHaveProperty('output');
      expect(model).toHaveProperty('cache_write');
      expect(model).toHaveProperty('cache_read');
    }
  });

  test('opus input is 5/1e6', () => {
    expect(BASE_PRICING['claude-opus-4-6'].input).toBeCloseTo(5 / 1e6, 10);
  });

  test('sonnet input is 3/1e6', () => {
    expect(BASE_PRICING['claude-sonnet-4-6'].input).toBeCloseTo(3 / 1e6, 10);
  });

  test('haiku input is 1/1e6', () => {
    expect(BASE_PRICING['claude-haiku-4-5-20251001'].input).toBeCloseTo(1 / 1e6, 10);
  });
});

describe('RUNTIMES', () => {
  test('claude-code has markup 1.0 and surcharge 0', () => {
    expect(RUNTIMES['claude-code']).toEqual({ markup: 1.0, per_million_surcharge: 0 });
  });

  test('cursor has markup 0.93 and surcharge 0.25', () => {
    expect(RUNTIMES['cursor']).toEqual({ markup: 0.93, per_million_surcharge: 0.25 });
  });
});

describe('getPricing', () => {
  test('exact match returns pricing and estimated=false', () => {
    const { pricing, estimated } = getPricing('claude-opus-4-6');
    expect(pricing).toBe(BASE_PRICING['claude-opus-4-6']);
    expect(estimated).toBe(false);
  });

  test('fuzzy match: string containing "opus"', () => {
    const { pricing, estimated } = getPricing('claude-opus-4-6[1m]');
    expect(pricing).toBe(BASE_PRICING['claude-opus-4-6']);
    expect(estimated).toBe(false);
  });

  test('fuzzy match: string containing "haiku"', () => {
    const { pricing } = getPricing('some-haiku-variant');
    expect(pricing).toBe(BASE_PRICING['claude-haiku-4-5-20251001']);
  });

  test('unknown model defaults to sonnet with estimated=true', () => {
    const { pricing, estimated } = getPricing('gpt-4-turbo');
    expect(pricing).toBe(BASE_PRICING['claude-sonnet-4-6']);
    expect(estimated).toBe(true);
  });

  test('runtime parameter does not affect which pricing row is returned', () => {
    const cc = getPricing('claude-opus-4-6', 'claude-code');
    const cursor = getPricing('claude-opus-4-6', 'cursor');
    expect(cc.pricing).toBe(cursor.pricing);
  });
});

describe('calcCost', () => {
  const sonnet = BASE_PRICING['claude-sonnet-4-6'];
  const tokens = { input_tokens: 1000000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  test('claude-code runtime: no markup, no surcharge', () => {
    const cost = calcCost(sonnet, tokens, 'claude-code');
    expect(cost).toBeCloseTo(3.0, 6);
  });

  test('cursor runtime: 93% markup + $0.25/M surcharge', () => {
    const cost = calcCost(sonnet, tokens, 'cursor');
    // base cost = 3.0, cursor = (3.0 * 0.93) + (1M / 1M * 0.25) = 2.79 + 0.25 = 3.04
    expect(cost).toBeCloseTo(3.04, 2);
  });

  test('defaults to claude-code when no runtime specified', () => {
    const cost = calcCost(sonnet, tokens);
    expect(cost).toBeCloseTo(3.0, 6);
  });

  test('cursor surcharge scales with total tokens', () => {
    const bigTokens = { input_tokens: 5000000, output_tokens: 5000000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const cost = calcCost(sonnet, bigTokens, 'cursor');
    const baseCost = 5000000 * sonnet.input + 5000000 * sonnet.output;
    const expected = (baseCost * 0.93) + (10000000 / 1e6 * 0.25);
    expect(cost).toBeCloseTo(expected, 2);
  });

  test('all zeros returns zero for both runtimes', () => {
    const z = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    expect(calcCost(sonnet, z, 'claude-code')).toBe(0);
    expect(calcCost(sonnet, z, 'cursor')).toBe(0);
  });

  test('missing fields treated as zero', () => {
    const cost = calcCost(sonnet, { input_tokens: 1000 });
    expect(cost).toBeCloseTo(1000 * 3 / 1e6, 10);
  });
});

describe('COMPARISON_MODELS', () => {
  test('has opus, sonnet, haiku keys', () => {
    expect(COMPARISON_MODELS).toHaveProperty('opus');
    expect(COMPARISON_MODELS).toHaveProperty('sonnet');
    expect(COMPARISON_MODELS).toHaveProperty('haiku');
  });

  test('opus points to opus-4-6 pricing', () => {
    expect(COMPARISON_MODELS.opus).toBe(BASE_PRICING['claude-opus-4-6']);
  });
});

describe('detectRuntime', () => {
  const origEnv = process.env;

  afterEach(() => {
    process.env = origEnv;
  });

  test('returns claude-code by default', () => {
    process.env = { ...origEnv };
    delete process.env.CURSOR_SESSION;
    delete process.env.CURSOR_TRACE_ID;
    expect(detectRuntime()).toBe('claude-code');
  });

  test('returns cursor when CURSOR_SESSION is set', () => {
    process.env = { ...origEnv, CURSOR_SESSION: '1' };
    expect(detectRuntime()).toBe('cursor');
  });

  test('returns cursor when CURSOR_TRACE_ID is set', () => {
    process.env = { ...origEnv, CURSOR_TRACE_ID: 'abc' };
    expect(detectRuntime()).toBe('cursor');
  });
});

describe('round4', () => {
  test('rounds to 4 decimal places', () => {
    expect(round4(1.23456789)).toBe(1.2346);
  });

  test('zero stays zero', () => {
    expect(round4(0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plugins/cost-tracker && npx jest __tests__/lib/pricing-engine.test.js --no-coverage 2>&1 | head -5
```

Expected: `Cannot find module '../../lib/pricing-engine'`

- [ ] **Step 3: Write the implementation**

```javascript
// plugins/cost-tracker/lib/pricing-engine.js
const fs = require('fs');
const path = require('path');

const BASE_PRICING = {
  'claude-opus-4-7':            { input: 5/1e6, output: 25/1e6, cache_write: 6.25/1e6, cache_read: 0.50/1e6 },
  'claude-opus-4-6':            { input: 5/1e6, output: 25/1e6, cache_write: 6.25/1e6, cache_read: 0.50/1e6 },
  'claude-sonnet-4-6':          { input: 3/1e6, output: 15/1e6, cache_write: 3.75/1e6, cache_read: 0.30/1e6 },
  'claude-sonnet-4-5-20250929': { input: 3/1e6, output: 15/1e6, cache_write: 3.75/1e6, cache_read: 0.30/1e6 },
  'claude-haiku-4-5-20251001':  { input: 1/1e6, output: 5/1e6,  cache_write: 1.25/1e6, cache_read: 0.10/1e6 },
};

const RUNTIMES = {
  'claude-code': { markup: 1.0, per_million_surcharge: 0 },
  'cursor':      { markup: 0.93, per_million_surcharge: 0.25 },
};

const COMPARISON_MODELS = {
  opus:   BASE_PRICING['claude-opus-4-6'],
  sonnet: BASE_PRICING['claude-sonnet-4-6'],
  haiku:  BASE_PRICING['claude-haiku-4-5-20251001'],
};

function getPricing(model, _runtime) {
  if (BASE_PRICING[model]) return { pricing: BASE_PRICING[model], estimated: false };
  const lower = model.toLowerCase();
  if (lower.includes('opus'))   return { pricing: BASE_PRICING['claude-opus-4-6'], estimated: false };
  if (lower.includes('haiku'))  return { pricing: BASE_PRICING['claude-haiku-4-5-20251001'], estimated: false };
  if (lower.includes('sonnet')) return { pricing: BASE_PRICING['claude-sonnet-4-6'], estimated: false };
  return { pricing: BASE_PRICING['claude-sonnet-4-6'], estimated: true };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function calcCost(pricing, tokens, runtime) {
  const input   = (tokens.input_tokens || 0) * pricing.input;
  const output  = (tokens.output_tokens || 0) * pricing.output;
  const cacheW  = (tokens.cache_creation_input_tokens || 0) * pricing.cache_write;
  const cacheR  = (tokens.cache_read_input_tokens || 0) * pricing.cache_read;
  const baseCost = input + output + cacheW + cacheR;

  if (baseCost === 0) return 0;

  const rt = RUNTIMES[runtime] || RUNTIMES['claude-code'];
  const totalTokens = (tokens.input_tokens || 0) + (tokens.output_tokens || 0)
    + (tokens.cache_creation_input_tokens || 0) + (tokens.cache_read_input_tokens || 0);
  return (baseCost * rt.markup) + (totalTokens / 1e6 * rt.per_million_surcharge);
}

function detectRuntime() {
  if (process.env.CURSOR_SESSION || process.env.CURSOR_TRACE_ID) return 'cursor';
  const home = process.env.HOME || process.env.USERPROFILE;
  try {
    const configPath = path.join(home, '.claude', 'cost-tracker', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.runtime && RUNTIMES[config.runtime]) return config.runtime;
  } catch {}
  return 'claude-code';
}

module.exports = {
  BASE_PRICING, RUNTIMES, COMPARISON_MODELS,
  getPricing, calcCost, detectRuntime, round4,
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd plugins/cost-tracker && npx jest __tests__/lib/pricing-engine.test.js --no-coverage
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/cost-tracker/lib/pricing-engine.js plugins/cost-tracker/__tests__/lib/pricing-engine.test.js
git commit -m "feat: add pricing-engine with Cursor support"
```

---

### Task 2: Create lib/usage-correlator.js with Tests

**Files:**
- Create: `plugins/cost-tracker/lib/usage-correlator.js`
- Create: `plugins/cost-tracker/__tests__/lib/usage-correlator.test.js`

**Interfaces:**
- Consumes: JSONL entries from `cost-log.jsonl` (loaded externally, passed as array)
- Produces: `correlateUsage(entries, installedSkills, installedMcps)` returns `{ skills: Map, mcps: Map }` where each map value is `{ last_used: string|null, session_count: number }`. Also `extractSkillsFromTranscript(filePath)` returns `string[]` and `extractMcpsFromTranscript(filePath)` returns `string[]`.

- [ ] **Step 1: Write the failing tests**

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plugins/cost-tracker && npx jest __tests__/lib/usage-correlator.test.js --no-coverage 2>&1 | head -5
```

Expected: `Cannot find module '../../lib/usage-correlator'`

- [ ] **Step 3: Write the implementation**

```javascript
// plugins/cost-tracker/lib/usage-correlator.js
const fs = require('fs');

function correlateUsage(entries, installedSkills, installedMcps) {
  const skills = new Map();
  const mcps = new Map();

  for (const name of installedSkills) {
    skills.set(name, { last_used: null, session_count: 0 });
  }
  for (const name of installedMcps) {
    mcps.set(name, { last_used: null, session_count: 0 });
  }

  for (const entry of entries) {
    const ts = entry.timestamp;
    for (const skill of (entry.skills_used || [])) {
      if (skills.has(skill)) {
        const s = skills.get(skill);
        s.session_count += 1;
        if (!s.last_used || ts > s.last_used) s.last_used = ts;
      }
    }
    for (const mcp of (entry.mcps_used || [])) {
      if (mcps.has(mcp)) {
        const m = mcps.get(mcp);
        m.session_count += 1;
        if (!m.last_used || ts > m.last_used) m.last_used = ts;
      }
    }
  }

  return { skills, mcps };
}

function extractSkillsFromTranscript(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const found = new Set();

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.message) continue;

    const role = entry.message.role;
    const msgContent = entry.message.content;

    if (role === 'user' && typeof msgContent === 'string') {
      const match = msgContent.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)/);
      if (match) found.add(match[1]);
    }

    if (role === 'assistant' && Array.isArray(msgContent)) {
      for (const block of msgContent) {
        if (block.type === 'tool_use' && block.name === 'Skill' && block.input && block.input.skill) {
          found.add(block.input.skill);
        }
      }
    }
  }

  return [...found];
}

function extractMcpsFromTranscript(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const found = new Set();

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.message || entry.message.role !== 'assistant') continue;
    const msgContent = entry.message.content;
    if (!Array.isArray(msgContent)) continue;

    for (const block of msgContent) {
      if (block.type === 'tool_use' && block.name) {
        const match = block.name.match(/^mcp__([^_]+)__/);
        if (match) found.add(match[1]);
      }
    }
  }

  return [...found];
}

module.exports = { correlateUsage, extractSkillsFromTranscript, extractMcpsFromTranscript };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd plugins/cost-tracker && npx jest __tests__/lib/usage-correlator.test.js --no-coverage
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/cost-tracker/lib/usage-correlator.js plugins/cost-tracker/__tests__/lib/usage-correlator.test.js
git commit -m "feat: add usage-correlator for skill/MCP tracking"
```

---

### Task 3: Create lib/context-auditor.js with Tests

**Files:**
- Create: `plugins/cost-tracker/lib/context-auditor.js`
- Create: `plugins/cost-tracker/lib/known-mcp-servers.json`
- Create: `plugins/cost-tracker/__tests__/lib/context-auditor.test.js`
- Create: `plugins/cost-tracker/__tests__/fixtures/mock-skills/used-skill/SKILL.md`
- Create: `plugins/cost-tracker/__tests__/fixtures/mock-skills/bloated-skill/SKILL.md`
- Create: `plugins/cost-tracker/__tests__/fixtures/mock-skills/unused-skill/SKILL.md`
- Create: `plugins/cost-tracker/__tests__/fixtures/mock-settings.json`

**Interfaces:**
- Consumes: `correlateUsage()` from `lib/usage-correlator.js`, `BASE_PRICING` and `calcCost` from `lib/pricing-engine.js`
- Produces: `scanSkills(skillsDir)` returns `Finding[]`, `scanMcpServers(settingsPath)` returns `Finding[]`, `scanPlugins(pluginsDir)` returns `Finding[]`, `scanHooks(settingsPath)` returns `Finding[]`, `scanMemory(projectDir)` returns `Finding[]`, `scanPermissions(settingsPath)` returns `Finding[]`, `getVerdict(finding)` returns `"keep"|"reduce"|"disable"`, `runFullAudit(options)` returns `Finding[]`

Where `Finding` is:
```javascript
{
  source: "skill"|"mcp"|"plugin"|"hook"|"memory"|"system",
  name: string,
  path: string,
  bytes: number,
  estimated_tokens: number,
  cost_per_session_usd: number,
  cost_per_month_usd: number,
  last_used: string|null,
  sessions_used: number,
  total_sessions: number,
  usage_rate: number,
  verdict: "keep"|"reduce"|"disable",
  reason: string,
}
```

- [ ] **Step 1: Create test fixtures**

```markdown
<!-- plugins/cost-tracker/__tests__/fixtures/mock-skills/used-skill/SKILL.md -->
---
name: used-skill
description: A skill that is used frequently
---
# Used Skill
This is a small skill used often.
```

```markdown
<!-- plugins/cost-tracker/__tests__/fixtures/mock-skills/bloated-skill/SKILL.md -->
---
name: bloated-skill
description: A large skill rarely used
---
# Bloated Skill
<!-- Generate 25KB of content by padding -->
This skill contains extensive documentation that inflates context.
Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.
<!-- Repeat the above paragraph ~150 times to reach ~25KB -->
```

Note: the bloated-skill fixture should be at least 10241 bytes. Pad with repeated lines to exceed 10KB.

```markdown
<!-- plugins/cost-tracker/__tests__/fixtures/mock-skills/unused-skill/SKILL.md -->
---
name: unused-skill
description: A skill never invoked
---
# Unused Skill
Small unused skill.
```

```json
// plugins/cost-tracker/__tests__/fixtures/mock-settings.json
{
  "mcpServers": {
    "slack": { "type": "stdio", "command": "node", "args": ["slack-server.js"] },
    "playwright": { "type": "stdio", "command": "npx", "args": ["@anthropic/playwright-mcp"] },
    "custom-mcp": { "type": "http", "url": "https://example.com/mcp" }
  },
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node hook1.js", "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node hook2.js", "timeout": 5 }, { "type": "command", "command": "node hook3.js", "timeout": 5 }] }]
  },
  "permissions": {
    "allow": ["Bash(node *)", "Bash(git *)", "Read"]
  }
}
```

- [ ] **Step 2: Write the failing tests**

```javascript
// plugins/cost-tracker/__tests__/lib/context-auditor.test.js
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
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd plugins/cost-tracker && npx jest __tests__/lib/context-auditor.test.js --no-coverage 2>&1 | head -5
```

Expected: `Cannot find module '../../lib/context-auditor'`

- [ ] **Step 4: Write the implementation**

```javascript
// plugins/cost-tracker/lib/context-auditor.js
const fs = require('fs');
const path = require('path');

const KNOWN_MCP_SERVERS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'known-mcp-servers.json'), 'utf8')
);
const DEFAULT_MCP_TOOLS = 15;
const TOKENS_PER_TOOL = 200;
const CHARS_TO_TOKENS = 0.25;

function scanSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  const findings = [];
  for (const dir of fs.readdirSync(skillsDir)) {
    const skillPath = path.join(skillsDir, dir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const bytes = fs.statSync(skillPath).size;
    findings.push({
      source: 'skill',
      name: dir,
      path: skillPath,
      bytes,
      estimated_tokens: Math.ceil(bytes * CHARS_TO_TOKENS),
      cost_per_session_usd: 0,
      cost_per_month_usd: 0,
      last_used: null,
      sessions_used: 0,
      total_sessions: 0,
      usage_rate: 0,
      verdict: 'disable',
      reason: '',
    });
  }
  return findings;
}

function scanMcpServers(settingsPath) {
  if (!fs.existsSync(settingsPath)) return [];
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const servers = settings.mcpServers || {};
  const findings = [];
  for (const [name, _config] of Object.entries(servers)) {
    const toolCount = KNOWN_MCP_SERVERS[name] || DEFAULT_MCP_TOOLS;
    const estimatedTokens = toolCount * TOKENS_PER_TOOL;
    findings.push({
      source: 'mcp',
      name,
      path: settingsPath,
      bytes: 0,
      estimated_tokens: estimatedTokens,
      cost_per_session_usd: 0,
      cost_per_month_usd: 0,
      last_used: null,
      sessions_used: 0,
      total_sessions: 0,
      usage_rate: 0,
      verdict: 'disable',
      reason: '',
    });
  }
  return findings;
}

function scanPlugins(pluginsDir) {
  if (!fs.existsSync(pluginsDir)) return [];
  const findings = [];
  for (const pluginDir of fs.readdirSync(pluginsDir)) {
    const skillsSubdir = path.join(pluginsDir, pluginDir, 'skills');
    if (!fs.existsSync(skillsSubdir)) continue;
    for (const skillDir of fs.readdirSync(skillsSubdir)) {
      const skillPath = path.join(skillsSubdir, skillDir, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const bytes = fs.statSync(skillPath).size;
      findings.push({
        source: 'plugin',
        name: `${pluginDir}/${skillDir}`,
        path: skillPath,
        bytes,
        estimated_tokens: Math.ceil(bytes * CHARS_TO_TOKENS),
        cost_per_session_usd: 0,
        cost_per_month_usd: 0,
        last_used: null,
        sessions_used: 0,
        total_sessions: 0,
        usage_rate: 0,
        verdict: 'disable',
        reason: '',
      });
    }
  }
  return findings;
}

function scanHooks(settingsPath) {
  if (!fs.existsSync(settingsPath)) return [];
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const hooks = settings.hooks || {};
  const findings = [];
  for (const [event, hookList] of Object.entries(hooks)) {
    let count = 0;
    const arr = Array.isArray(hookList) ? hookList : [hookList];
    for (const group of arr) {
      count += (group.hooks || []).length;
    }
    findings.push({
      source: 'hook',
      name: event,
      path: settingsPath,
      bytes: 0,
      estimated_tokens: 0,
      cost_per_session_usd: 0,
      cost_per_month_usd: 0,
      last_used: null,
      sessions_used: 0,
      total_sessions: 0,
      usage_rate: 0,
      verdict: 'keep',
      reason: `${count} hook(s) on ${event}`,
    });
  }
  return findings;
}

function scanMemory(projectDir) {
  const findings = [];
  const home = process.env.HOME || process.env.USERPROFILE;
  const candidates = [];
  if (projectDir) {
    candidates.push(path.join(projectDir, 'CLAUDE.md'));
  }
  if (home) {
    candidates.push(path.join(home, 'CLAUDE.md'));
    const memDir = path.join(home, '.claude', 'projects');
    if (fs.existsSync(memDir)) {
      for (const dir of fs.readdirSync(memDir)) {
        const memoryMd = path.join(memDir, dir, 'memory', 'MEMORY.md');
        if (fs.existsSync(memoryMd)) candidates.push(memoryMd);
      }
    }
  }

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    const bytes = fs.statSync(filePath).size;
    findings.push({
      source: 'memory',
      name: path.basename(filePath),
      path: filePath,
      bytes,
      estimated_tokens: Math.ceil(bytes * CHARS_TO_TOKENS),
      cost_per_session_usd: 0,
      cost_per_month_usd: 0,
      last_used: null,
      sessions_used: 0,
      total_sessions: 0,
      usage_rate: 0,
      verdict: 'keep',
      reason: 'Memory files are always loaded',
    });
  }
  return findings;
}

function scanPermissions(settingsPath) {
  if (!fs.existsSync(settingsPath)) return [];
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const perms = (settings.permissions || {}).allow || [];
  const count = perms.length;
  return [{
    source: 'system',
    name: 'permissions',
    path: settingsPath,
    bytes: count,
    estimated_tokens: 0,
    cost_per_session_usd: 0,
    cost_per_month_usd: 0,
    last_used: null,
    sessions_used: 0,
    total_sessions: 0,
    usage_rate: 0,
    verdict: count > 100 ? 'reduce' : 'keep',
    reason: count > 100 ? `${count} permission entries - consider consolidating with wildcards` : `${count} permission entries`,
  }];
}

function getVerdict(finding) {
  const now = Date.now();
  const lastUsedMs = finding.last_used ? new Date(finding.last_used).getTime() : 0;
  const daysSinceUsed = finding.last_used ? (now - lastUsedMs) / (1000 * 60 * 60 * 24) : Infinity;

  if (daysSinceUsed <= 7 || finding.usage_rate > 0.10) return 'keep';
  if (finding.usage_rate > 0.02 && finding.bytes > 10240) return 'reduce';
  if (daysSinceUsed > 30 || !finding.last_used) return 'disable';
  return 'keep';
}

module.exports = {
  scanSkills, scanMcpServers, scanPlugins, scanHooks,
  scanMemory, scanPermissions, getVerdict,
  KNOWN_MCP_SERVERS, DEFAULT_MCP_TOOLS, TOKENS_PER_TOOL, CHARS_TO_TOKENS,
};
```

```json
// plugins/cost-tracker/lib/known-mcp-servers.json
{
  "servicenow-mcp": 80,
  "slack": 50,
  "workspace-mcp": 90,
  "playwright": 20,
  "atlan-mcp": 18,
  "n8n-mcp": 7,
  "red-sky": 10,
  "dataverse-mcp": 5,
  "compliance-dashboard": 5,
  "productpages": 5,
  "miro": 10
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd plugins/cost-tracker && npx jest __tests__/lib/context-auditor.test.js --no-coverage
```

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add plugins/cost-tracker/lib/context-auditor.js plugins/cost-tracker/lib/known-mcp-servers.json plugins/cost-tracker/__tests__/lib/context-auditor.test.js plugins/cost-tracker/__tests__/fixtures/
git commit -m "feat: add context-auditor with 6 scanners and verdict engine"
```

---

### Task 4: Create cost-audit Skill and audit.js Script

**Files:**
- Create: `plugins/cost-tracker/skills/cost-audit/SKILL.md`
- Create: `plugins/cost-tracker/skills/cost-audit/scripts/audit.js`
- Create: `plugins/cost-tracker/__tests__/skills/audit.test.js`

**Interfaces:**
- Consumes: `scanSkills`, `scanMcpServers`, `scanPlugins`, `scanPermissions`, `getVerdict` from `lib/context-auditor.js`; `correlateUsage` from `lib/usage-correlator.js`; `BASE_PRICING`, `calcCost` from `lib/pricing-engine.js`
- Produces: `runAudit(options)` returns `{ findings: Finding[], totalContextTokens: number, totalMonthlyCost: number, totalSavings: number }`; `formatAuditReport(auditResult)` prints markdown report to stdout

- [ ] **Step 1: Write the failing tests**

```javascript
// plugins/cost-tracker/__tests__/skills/audit.test.js
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plugins/cost-tracker && npx jest __tests__/skills/audit.test.js --no-coverage 2>&1 | head -5
```

Expected: `Cannot find module`

- [ ] **Step 3: Write the SKILL.md**

```markdown
---
name: cost-audit
description: >-
  Use when asking about context bloat, skill bloat, unused MCPs, what's
  eating context, why sessions are expensive, or which skills to disable.
  Triggers on: "audit my setup", "what's using context", "disable unused",
  "skill bloat", "MCP bloat", "context cost".
argument-hint: "[today|week|month|all]"
allowed-tools:
  - Bash(node *)
  - Read
---

## Context Audit - Find and Fix Context Bloat

You are a context cost analyst. The user wants to know what's inflating their context window and costing them money.

### How It Works

The auditor scans the user's installed skills, MCP servers, plugins, hooks, memory files, and permissions. It estimates the token cost of each, correlates against actual usage from `~/.claude/cost-tracker/cost-log.jsonl`, and produces a prioritized waste report.

### Running the Audit

```
node "${CLAUDE_PLUGIN_ROOT}/skills/cost-audit/scripts/audit.js" $ARGUMENTS
```

Available arguments: `today`, `week`, `month`, `all` (default: `month`)

### Instructions

1. Run the audit script with the user's requested time range
2. Present the output directly - it produces markdown tables sorted by monthly waste
3. For follow-up questions, explain what each finding means and how to act on it
4. "disable" means the user should remove the skill or disconnect the MCP
5. "reduce" means the skill is used but oversized - suggest trimming the SKILL.md
6. Never auto-disable anything - always let the user decide

### Verdict Meanings

- **KEEP**: Used in >10% of sessions or used in last 7 days
- **REDUCE**: Used occasionally but the SKILL.md is >10KB - could be trimmed
- **DISABLE**: Not used in 30+ days, costing money for no value
```

- [ ] **Step 4: Write the audit.js script**

```javascript
// plugins/cost-tracker/skills/cost-audit/scripts/audit.js
const fs = require('fs');
const path = require('path');
const { scanSkills, scanMcpServers, scanPlugins, scanPermissions, getVerdict } = require('../../../lib/context-auditor');
const { correlateUsage } = require('../../../lib/usage-correlator');
const { BASE_PRICING, calcCost } = require('../../../lib/pricing-engine');

const home = process.env.HOME || process.env.USERPROFILE;
const logPath = path.join(home, '.claude', 'cost-tracker', 'cost-log.jsonl');

function loadEntries() {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function filterByDate(entries, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return entries.filter(e => new Date(e.timestamp) >= cutoff);
}

function runAudit(options = {}) {
  const skillsDir = options.skillsDir || path.join(home, '.claude', 'skills');
  const settingsPath = options.settingsPath || path.join(home, '.claude', 'settings.json');
  const pluginsDir = options.pluginsDir || path.join(home, '.claude', 'plugins', 'cache');
  const entries = options.entries || [];
  const sessionsPerMonth = options.sessionsPerMonth || Math.max(entries.length, 1);

  const allFindings = [
    ...scanSkills(skillsDir),
    ...scanMcpServers(settingsPath),
    ...scanPlugins(pluginsDir),
    ...scanPermissions(settingsPath),
  ];

  const installedSkills = allFindings.filter(f => f.source === 'skill').map(f => f.name);
  const installedMcps = allFindings.filter(f => f.source === 'mcp').map(f => f.name);
  const { skills: skillUsage, mcps: mcpUsage } = correlateUsage(entries, installedSkills, installedMcps);

  const opusPricing = BASE_PRICING['claude-opus-4-6'];
  const avgMessagesPerSession = 15;

  for (const f of allFindings) {
    let usage = null;
    if (f.source === 'skill') usage = skillUsage.get(f.name);
    if (f.source === 'mcp') usage = mcpUsage.get(f.name);

    if (usage) {
      f.last_used = usage.last_used;
      f.sessions_used = usage.session_count;
    }
    f.total_sessions = entries.length;
    f.usage_rate = entries.length > 0 ? f.sessions_used / entries.length : 0;

    const perMessageCost = (f.estimated_tokens * opusPricing.input);
    f.cost_per_session_usd = perMessageCost * avgMessagesPerSession;
    f.cost_per_month_usd = f.cost_per_session_usd * sessionsPerMonth;

    if (f.source !== 'system' && f.source !== 'hook') {
      f.verdict = getVerdict(f);
      if (f.verdict === 'disable') f.reason = f.last_used ? `Not used in ${Math.round((Date.now() - new Date(f.last_used).getTime()) / (1000*60*60*24))} days` : 'Never used';
      else if (f.verdict === 'reduce') f.reason = `Used ${(f.usage_rate * 100).toFixed(1)}% of sessions but ${(f.bytes / 1024).toFixed(0)}KB is large`;
      else f.reason = 'Actively used';
    }
  }

  allFindings.sort((a, b) => b.cost_per_month_usd - a.cost_per_month_usd);

  const totalContextTokens = allFindings.reduce((s, f) => s + f.estimated_tokens, 0);
  const totalMonthlyCost = allFindings.reduce((s, f) => s + f.cost_per_month_usd, 0);
  const totalSavings = allFindings.filter(f => f.verdict === 'disable' || f.verdict === 'reduce').reduce((s, f) => s + f.cost_per_month_usd, 0);

  return { findings: allFindings, totalContextTokens, totalMonthlyCost, totalSavings };
}

function formatAuditReport(result) {
  const { findings, totalContextTokens, totalMonthlyCost, totalSavings } = result;
  let out = '';

  out += `## Context Audit\n\n`;
  out += `**Total context load:** ~${Math.round(totalContextTokens / 1000)}K tokens/session\n`;
  out += `**Estimated monthly context cost:** $${totalMonthlyCost.toFixed(2)}\n\n`;

  if (findings.length === 0) {
    out += `No context waste detected - your setup looks lean.\n`;
    return out;
  }

  const skills = findings.filter(f => f.source === 'skill' && f.verdict !== 'keep');
  const mcps = findings.filter(f => f.source === 'mcp' && f.verdict !== 'keep');
  const plugins = findings.filter(f => f.source === 'plugin' && f.verdict !== 'keep');
  const system = findings.filter(f => f.source === 'system' && f.verdict !== 'keep');

  if (skills.length > 0) {
    out += `### Skills\n\n`;
    out += `| # | Skill | Size | Last Used | Usage | $/Month | Action |\n`;
    out += `|---|-------|------|-----------|-------|---------|--------|\n`;
    skills.forEach((f, i) => {
      const lastUsed = f.last_used ? `${Math.round((Date.now() - new Date(f.last_used).getTime()) / (1000*60*60*24))}d ago` : 'never';
      out += `| ${i + 1} | ${f.name} | ${(f.bytes / 1024).toFixed(0)}KB | ${lastUsed} | ${(f.usage_rate * 100).toFixed(1)}% | $${f.cost_per_month_usd.toFixed(2)} | ${f.verdict.toUpperCase()} |\n`;
    });
    out += `\n`;
  }

  if (mcps.length > 0) {
    out += `### MCP Servers\n\n`;
    out += `| # | Server | Est. Tools | Last Used | Usage | $/Month | Action |\n`;
    out += `|---|--------|-----------|-----------|-------|---------|--------|\n`;
    mcps.forEach((f, i) => {
      const tools = f.estimated_tokens / 200;
      const lastUsed = f.last_used ? `${Math.round((Date.now() - new Date(f.last_used).getTime()) / (1000*60*60*24))}d ago` : 'never';
      out += `| ${i + 1} | ${f.name} | ${tools} | ${lastUsed} | ${(f.usage_rate * 100).toFixed(1)}% | $${f.cost_per_month_usd.toFixed(2)} | ${f.verdict.toUpperCase()} |\n`;
    });
    out += `\n`;
  }

  if (system.length > 0) {
    for (const f of system) {
      out += `### ${f.name}\n\n${f.reason}\n\n`;
    }
  }

  if (totalSavings > 0) {
    out += `---\n\n`;
    out += `**Estimated monthly savings if all DISABLE applied:** $${totalSavings.toFixed(2)}/month\n`;
  }

  return out;
}

if (require.main === module) {
  const arg = (process.argv[2] || 'month').toLowerCase();
  let entries = loadEntries();

  switch (arg) {
    case 'today': entries = filterByDate(entries, 1); break;
    case 'week': entries = filterByDate(entries, 7); break;
    case 'month': entries = filterByDate(entries, 30); break;
    case 'all': break;
    default: entries = filterByDate(entries, 30);
  }

  const result = runAudit({ entries, sessionsPerMonth: Math.max(Math.round(entries.length * (30 / Math.max(1, getDaysInRange(entries)))), 1) });
  console.log(formatAuditReport(result));
}

function getDaysInRange(entries) {
  if (entries.length < 2) return 1;
  const times = entries.map(e => new Date(e.timestamp).getTime());
  return Math.max(1, (Math.max(...times) - Math.min(...times)) / (1000 * 60 * 60 * 24));
}

module.exports = { runAudit, formatAuditReport };
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd plugins/cost-tracker && npx jest __tests__/skills/audit.test.js --no-coverage
```

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add plugins/cost-tracker/skills/cost-audit/ plugins/cost-tracker/__tests__/skills/audit.test.js
git commit -m "feat: add cost-audit skill with context bloat analysis"
```

---

### Task 5: Refactor Existing Code to Use pricing-engine.js

**Files:**
- Modify: `plugins/cost-tracker/hooks/session-logger.js`
- Modify: `plugins/cost-tracker/hooks/cost-monitor.js`
- Modify: `plugins/cost-tracker/skills/cost-tracker/scripts/report.js`
- Modify: `plugins/cost-tracker/skills/cost-optimize/scripts/recommend.js`

**Interfaces:**
- Consumes: `BASE_PRICING`, `COMPARISON_MODELS`, `getPricing`, `calcCost`, `round4` from `lib/pricing-engine.js`
- Produces: Same exports as before (backwards compatible), but delegating to pricing-engine

- [ ] **Step 1: Refactor session-logger.js**

Replace lines 1-41 (the `PRICING`, `COMPARISON_MODELS`, `getPricing`, `round4`, `calcCost` definitions) with imports from pricing-engine:

```javascript
// At top of session-logger.js, replace the PRICING block and helper functions with:
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { BASE_PRICING, COMPARISON_MODELS, getPricing, calcCost, round4, detectRuntime } = require('../lib/pricing-engine');
// Keep PRICING as alias for backwards compat in module.exports
const PRICING = BASE_PRICING;
```

Remove the old `PRICING`, `COMPARISON_MODELS`, `getPricing`, `round4`, `calcCost` function definitions (lines 6-40 in original).

Add skill/MCP extraction to `parseTranscript()` — after the existing message loop, add:

```javascript
// Inside parseTranscript, after the for loop, before return:
const skillsUsed = new Set();
const mcpsUsed = new Set();
for (const line of lines) {
  let entry;
  try { entry = JSON.parse(line); } catch { continue; }
  if (!entry.message) continue;
  const role = entry.message.role;
  const content = entry.message.content;

  if (role === 'user' && typeof content === 'string') {
    const match = content.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)/);
    if (match) skillsUsed.add(match[1]);
  }
  if (role === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_use') {
        if (block.name === 'Skill' && block.input && block.input.skill) {
          skillsUsed.add(block.input.skill);
        }
        const mcpMatch = (block.name || '').match(/^mcp__([^_]+)__/);
        if (mcpMatch) mcpsUsed.add(mcpMatch[1]);
      }
    }
  }
}

return { models, peakContext, skillsUsed: [...skillsUsed], mcpsUsed: [...mcpsUsed] };
```

In `main()`, add the new fields to `logEntry`:

```javascript
// After const sessionCategory = classifySession(transcript_path);
const runtime = detectRuntime();

const logEntry = {
  // ...existing fields...
  skills_used: primaryResult.skillsUsed || [],
  mcps_used: primaryResult.mcpsUsed || [],
  runtime,
};
```

- [ ] **Step 2: Refactor cost-monitor.js**

Replace the `PRICING` and `getPricing` at the top with:

```javascript
const fs = require('fs');
const path = require('path');
const os = require('os');
const { BASE_PRICING, getPricing: engineGetPricing } = require('../lib/pricing-engine');

const PRICING = BASE_PRICING;

function getPricing(model) {
  const { pricing } = engineGetPricing(model);
  return pricing;
}
```

Remove the old `PRICING` and `getPricing` definitions (lines 5-19).

- [ ] **Step 3: Refactor report.js**

No pricing to change in report.js (it reads costs from the JSONL entries, doesn't calculate them). No changes needed.

- [ ] **Step 4: Refactor recommend.js**

No pricing to change in recommend.js (it reads `cost_usd` from entries, doesn't recalculate). No changes needed.

- [ ] **Step 5: Run all existing tests to verify nothing broke**

```bash
cd plugins/cost-tracker && npx jest --no-coverage
```

Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add plugins/cost-tracker/hooks/session-logger.js plugins/cost-tracker/hooks/cost-monitor.js
git commit -m "refactor: use shared pricing-engine in session-logger and cost-monitor"
```

---

### Task 6: Add context-snapshot Hook and Update hooks.json

**Files:**
- Create: `plugins/cost-tracker/hooks/context-snapshot.js`
- Create: `plugins/cost-tracker/__tests__/hooks/context-snapshot.test.js`
- Modify: `plugins/cost-tracker/hooks/hooks.json`

**Interfaces:**
- Consumes: `scanSkills`, `scanMcpServers` from `lib/context-auditor.js`; `BASE_PRICING` from `lib/pricing-engine.js`
- Produces: Appends snapshot entry to `~/.claude/cost-tracker/context-snapshots.jsonl`

- [ ] **Step 1: Write the failing tests**

```javascript
// plugins/cost-tracker/__tests__/hooks/context-snapshot.test.js
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plugins/cost-tracker && npx jest __tests__/hooks/context-snapshot.test.js --no-coverage 2>&1 | head -5
```

- [ ] **Step 3: Write the implementation**

```javascript
// plugins/cost-tracker/hooks/context-snapshot.js
const fs = require('fs');
const path = require('path');
const { scanSkills, scanMcpServers } = require('../lib/context-auditor');

const home = process.env.HOME || process.env.USERPROFILE;
const snapshotPath = path.join(home, '.claude', 'cost-tracker', 'context-snapshots.jsonl');

function createSnapshot(options = {}) {
  const skillsDir = options.skillsDir || path.join(home, '.claude', 'skills');
  const settingsPath = options.settingsPath || path.join(home, '.claude', 'settings.json');

  const skillFindings = scanSkills(skillsDir);
  const mcpFindings = scanMcpServers(settingsPath);

  const snapshot = {
    timestamp: new Date().toISOString(),
    skills: skillFindings.map(f => f.name),
    skills_total_bytes: skillFindings.reduce((s, f) => s + f.bytes, 0),
    mcps: mcpFindings.map(f => f.name),
    mcp_tool_count: mcpFindings.reduce((s, f) => s + (f.estimated_tokens / 200), 0),
    estimated_context_tokens: skillFindings.reduce((s, f) => s + f.estimated_tokens, 0)
      + mcpFindings.reduce((s, f) => s + f.estimated_tokens, 0),
  };

  return snapshot;
}

async function main() {
  const snapshot = createSnapshot();

  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.appendFileSync(snapshotPath, JSON.stringify(snapshot) + '\n');
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`context-snapshot: ${err.message}\n`);
    process.exit(0);
  });
}

module.exports = { createSnapshot };
```

- [ ] **Step 4: Update hooks.json**

Add the context-snapshot hook to the SessionStart array:

```json
{
  "description": "Cost tracking: logs on exit, monitors costs and budgets in real-time, weekly digests, context snapshots",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/weekly-digest.js\" --system-message",
            "timeout": 10
          },
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/context-snapshot.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/cost-monitor.js\"",
            "timeout": 5
          },
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/budget-check.js\"",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/session-logger.js\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd plugins/cost-tracker && npx jest __tests__/hooks/context-snapshot.test.js --no-coverage
```

- [ ] **Step 6: Commit**

```bash
git add plugins/cost-tracker/hooks/context-snapshot.js plugins/cost-tracker/hooks/hooks.json plugins/cost-tracker/__tests__/hooks/context-snapshot.test.js
git commit -m "feat: add context-snapshot SessionStart hook"
```

---

### Task 7: Consolidate Dashboard and Update Skill Frontmatter

**Files:**
- Delete: `plugins/cost-tracker/skills/cost-dashboard/scripts/dashboard.js`
- Modify: `plugins/cost-tracker/skills/cost-dashboard/SKILL.md`
- Modify: `plugins/cost-tracker/skills/cost-tracker/SKILL.md`
- Modify: `plugins/cost-tracker/skills/cost-optimize/SKILL.md`
- Modify: `plugins/cost-tracker/skills/cost-budget/SKILL.md`
- Modify: `plugins/cost-tracker/.claude-plugin/plugin.json`
- Modify: `plugins/cost-tracker/../../package.json` (root)

**Interfaces:**
- No interface changes. Dashboard script path in SKILL.md changes.

- [ ] **Step 1: Delete duplicate dashboard**

```bash
rm plugins/cost-tracker/skills/cost-dashboard/scripts/dashboard.js
```

- [ ] **Step 2: Update cost-dashboard SKILL.md to point to consolidated script**

Change the script path from:
```
node "${CLAUDE_PLUGIN_ROOT}/skills/cost-dashboard/scripts/dashboard.js"
```
to:
```
node "${CLAUDE_PLUGIN_ROOT}/skills/cost-tracker/scripts/dashboard.js"
```

- [ ] **Step 3: Update all 4 existing SKILL.md descriptions to "Use when..." format**

cost-tracker SKILL.md description:
```yaml
description: >-
  Use when the user asks about costs, spending, token usage, how much
  they have spent, or wants to see a cost report or dashboard. Triggers
  on: "show costs", "cost report", "how much", "spending", "token usage".
```

cost-optimize SKILL.md description:
```yaml
description: >-
  Use when asking about saving money, reducing costs, optimizing spending,
  or getting recommendations. Triggers on: "optimize costs", "save money",
  "reduce spending", "cost tips", "too expensive", "spending too much".
```

cost-dashboard SKILL.md description:
```yaml
description: >-
  Use when the user asks for a visual dashboard, cost charts, or spending
  visualization. Triggers on: "show me a dashboard", "cost graph",
  "visualize spending", "cost dashboard".
```

cost-budget SKILL.md description (already good, minor tweak):
```yaml
description: >-
  Use when the user asks to set a budget, spending limit, cost cap, or
  check budget status. Triggers on: "set budget", "limit spending",
  "budget", "how much budget left".
```

- [ ] **Step 4: Bump version in plugin.json to 2.0.0**

```json
{
  "name": "cost-tracker",
  "description": "Track Claude Code and Cursor costs across sessions. Analyze context bloat, compare model pricing, and optimize spending.",
  "version": "2.0.0",
  "author": { "name": "befoster" },
  "repository": "https://github.com/ChewbaccaRoars/claude-code-cost-tracker",
  "license": "MIT",
  "keywords": ["cost", "tracking", "usage", "tokens", "billing", "analytics", "context", "audit", "cursor"]
}
```

- [ ] **Step 5: Bump version in package.json to 2.0.0**

```json
{
  "private": true,
  "name": "claude-code-cost-tracker",
  "version": "2.0.0",
  "description": "Cost tracking, context audit, and analytics for Claude Code and Cursor",
  "scripts": { "test": "jest" },
  "devDependencies": { "jest": "^29" },
  "license": "MIT"
}
```

- [ ] **Step 6: Run all tests to verify nothing broke**

```bash
cd plugins/cost-tracker && npx jest --no-coverage
```

Expected: All tests PASS (the deleted dashboard.js had no tests of its own)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: consolidate dashboard, update frontmatter, bump to v2.0.0"
```

---

### Task 8: Move Existing Tests to Top-Level __tests__/ Structure

**Files:**
- Move: `plugins/cost-tracker/hooks/__tests__/*.test.js` to `plugins/cost-tracker/__tests__/hooks/`
- Move: `plugins/cost-tracker/skills/cost-tracker/scripts/__tests__/report.test.js` to `plugins/cost-tracker/__tests__/skills/report.test.js`
- Move: `plugins/cost-tracker/skills/cost-optimize/scripts/__tests__/recommend.test.js` to `plugins/cost-tracker/__tests__/skills/recommend.test.js`

**Interfaces:**
- No interface changes. Only `require()` paths in test files update.

- [ ] **Step 1: Move hook tests**

```bash
cd plugins/cost-tracker
mkdir -p __tests__/hooks
mv hooks/__tests__/session-logger.test.js __tests__/hooks/
mv hooks/__tests__/cost-monitor.test.js __tests__/hooks/
mv hooks/__tests__/budget-check.test.js __tests__/hooks/
mv hooks/__tests__/weekly-digest.test.js __tests__/hooks/
rmdir hooks/__tests__
```

- [ ] **Step 2: Update require paths in moved hook tests**

In each file under `__tests__/hooks/`, change:
```javascript
// From:
require('../session-logger');
// To:
require('../../hooks/session-logger');
```

Apply the same pattern for cost-monitor, budget-check, weekly-digest.

- [ ] **Step 3: Move skill tests**

```bash
mkdir -p __tests__/skills
mv skills/cost-tracker/scripts/__tests__/report.test.js __tests__/skills/
mv skills/cost-optimize/scripts/__tests__/recommend.test.js __tests__/skills/
rmdir skills/cost-tracker/scripts/__tests__
rmdir skills/cost-optimize/scripts/__tests__
```

- [ ] **Step 4: Update require paths in moved skill tests**

```javascript
// report.test.js - from:
require('../report');
// To:
require('../../skills/cost-tracker/scripts/report');

// recommend.test.js - from:
require('../recommend');
// To:
require('../../skills/cost-optimize/scripts/recommend');
```

- [ ] **Step 5: Run all tests to verify paths are correct**

```bash
cd plugins/cost-tracker && npx jest --no-coverage
```

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: consolidate tests into top-level __tests__/ directory"
```

---

### Task 9: Create Eval Harness and Scenarios

**Files:**
- Create: `plugins/cost-tracker/evals/run-evals.js`
- Create: `plugins/cost-tracker/evals/scenarios/vague-cost-help.json`
- Create: `plugins/cost-tracker/evals/scenarios/skill-bloat.json`
- Create: `plugins/cost-tracker/evals/scenarios/cursor-pricing.json`
- Create: `plugins/cost-tracker/evals/scenarios/mcp-partial-use.json`
- Create: `plugins/cost-tracker/evals/scenarios/root-cause.json`

**Interfaces:**
- Produces: `runEval(scenarioPath)` returns `{ name, passed, failures[], response }`. CLI: `node evals/run-evals.js` runs all scenarios and prints results.

- [ ] **Step 1: Create eval scenarios**

```json
// evals/scenarios/vague-cost-help.json
{
  "name": "vague-cost-help",
  "description": "Agent routes a vague cost question to the right tool",
  "user_prompt": "My Claude Code usage feels expensive. What can I do?",
  "required_in_response": ["cost-optimize", "cost-audit"],
  "required_any": true,
  "forbidden_in_response": ["I don't have access", "I cannot"]
}
```

```json
// evals/scenarios/skill-bloat.json
{
  "name": "skill-bloat-detection",
  "description": "Agent identifies unused skills and recommends disabling",
  "user_prompt": "I have 66 skills installed and my sessions are expensive. Can you audit what's eating my context?",
  "required_in_response": ["disable", "unused", "context"],
  "required_any": false,
  "forbidden_in_response": ["I don't have access", "I can't analyze"]
}
```

```json
// evals/scenarios/cursor-pricing.json
{
  "name": "cursor-pricing",
  "description": "Agent applies Cursor pricing formula correctly",
  "user_prompt": "I use Cursor. Show me what my last week of usage cost with Cursor pricing.",
  "required_in_response": ["cursor", "93%"],
  "required_any": false,
  "forbidden_in_response": []
}
```

```json
// evals/scenarios/mcp-partial-use.json
{
  "name": "mcp-partial-use",
  "description": "Agent does not blanket-disable recently used MCPs",
  "user_prompt": "Should I disable the Slack MCP? I used it yesterday but not much otherwise.",
  "required_in_response": ["keep", "recently"],
  "required_any": true,
  "forbidden_in_response": ["disable slack", "remove slack"]
}
```

```json
// evals/scenarios/root-cause.json
{
  "name": "root-cause-analysis",
  "description": "Agent correlates multiple cost factors, not single cause",
  "user_prompt": "My last session cost $47. Why was it so expensive?",
  "required_in_response": ["context", "model"],
  "required_any": false,
  "forbidden_in_response": ["I don't know"]
}
```

- [ ] **Step 2: Create the eval harness**

```javascript
// evals/run-evals.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const scenariosDir = path.join(__dirname, 'scenarios');

function loadScenarios() {
  return fs.readdirSync(scenariosDir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(scenariosDir, f), 'utf8')));
}

function checkResponse(response, scenario) {
  const failures = [];
  const lower = response.toLowerCase();

  if (scenario.required_any) {
    const found = scenario.required_in_response.some(term => lower.includes(term.toLowerCase()));
    if (!found) {
      failures.push(`Missing any of: ${scenario.required_in_response.join(', ')}`);
    }
  } else {
    for (const term of (scenario.required_in_response || [])) {
      if (!lower.includes(term.toLowerCase())) {
        failures.push(`Missing required term: "${term}"`);
      }
    }
  }

  for (const term of (scenario.forbidden_in_response || [])) {
    if (lower.includes(term.toLowerCase())) {
      failures.push(`Contains forbidden term: "${term}"`);
    }
  }

  return failures;
}

function runEval(scenario) {
  console.log(`\nRunning: ${scenario.name}`);
  console.log(`  Prompt: "${scenario.user_prompt}"`);

  try {
    const response = execSync(
      `claude -p ${JSON.stringify(scenario.user_prompt)} --output-format text --model sonnet`,
      { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    const failures = checkResponse(response, scenario);
    const passed = failures.length === 0;

    console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
    if (!passed) {
      for (const f of failures) console.log(`    - ${f}`);
      console.log(`  Response excerpt: ${response.slice(0, 200)}...`);
    }

    return { name: scenario.name, passed, failures, response };
  } catch (err) {
    console.log(`  Result: ERROR - ${err.message}`);
    return { name: scenario.name, passed: false, failures: [`Execution error: ${err.message}`], response: '' };
  }
}

if (require.main === module) {
  const scenarios = loadScenarios();
  console.log(`Running ${scenarios.length} eval scenarios...\n`);

  const results = scenarios.map(runEval);
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${results.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

module.exports = { loadScenarios, checkResponse, runEval };
```

- [ ] **Step 3: Verify the harness loads scenarios**

```bash
cd plugins/cost-tracker && node -e "const {loadScenarios} = require('./evals/run-evals'); console.log(loadScenarios().length + ' scenarios loaded')"
```

Expected: `5 scenarios loaded`

- [ ] **Step 4: Commit**

```bash
git add plugins/cost-tracker/evals/
git commit -m "feat: add eval harness with 5 agent behavior scenarios"
```

---

### Task 10: Run Full Test Suite and Final Verification

**Files:**
- No new files

- [ ] **Step 1: Run the full Jest test suite**

```bash
cd plugins/cost-tracker && npx jest --no-coverage --verbose
```

Expected: All tests PASS across all test files

- [ ] **Step 2: Verify file structure matches spec**

```bash
find plugins/cost-tracker -type f -not -path '*node_modules*' -not -path '*.git*' | sort
```

Verify the output matches the file map in the design spec.

- [ ] **Step 3: Verify the audit script runs against real data**

```bash
cd plugins/cost-tracker && node skills/cost-audit/scripts/audit.js month
```

Expected: Markdown table output with real skill/MCP findings from the user's installation

- [ ] **Step 4: Verify pricing-engine Cursor formula**

```bash
cd plugins/cost-tracker && node -e "
const {BASE_PRICING, calcCost} = require('./lib/pricing-engine');
const opus = BASE_PRICING['claude-opus-4-6'];
const tokens = {input_tokens: 1000000, output_tokens: 100000};
console.log('Claude Code:', calcCost(opus, tokens, 'claude-code').toFixed(4));
console.log('Cursor:', calcCost(opus, tokens, 'cursor').toFixed(4));
"
```

Expected: Cursor cost is `(CC_cost * 0.93) + (1.1M / 1M * 0.25)`

- [ ] **Step 5: Final commit with any fixes**

```bash
git add -A
git commit -m "chore: final verification and cleanup for v2.0.0"
```
