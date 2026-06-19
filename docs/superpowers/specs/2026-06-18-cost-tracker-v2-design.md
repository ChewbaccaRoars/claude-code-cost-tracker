# Cost Tracker v2.0 — Design Spec

## Summary

Upgrade the Claude Code Cost Tracker plugin to add context bloat analysis (skills, MCPs, plugins, hooks, memory files), dual-runtime support (Claude Code + Cursor), and a two-layer eval system (Jest unit tests + subagent behavior evals).

## Goals

1. **Context Audit** — Show users exactly what's eating their context window and what it costs in dollars, with actionable disable/reduce recommendations
2. **Cursor Support** — Apply Cursor's pricing formula `(provider_price × 0.93) + $0.25/1M tokens` alongside Claude Code direct pricing
3. **Evals** — Jest tests for calculation correctness + subagent pressure tests for skill behavior correctness
4. **Cleanup** — Consolidate duplicate dashboard.js, externalize pricing, fix skill frontmatter

## Non-Goals

- Cursor hook integration (Cursor doesn't support Claude Code's hook system — data comes via manual import)
- Real-time MCP tool schema size measurement (would require introspecting the running MCP connection; we estimate from tool counts instead)
- Auto-disabling skills/MCPs (recommendations only — user decides)

---

## Architecture

```
EXISTING (preserved)               NEW
────────────────────               ───
session-logger.js                  lib/pricing-engine.js
cost-monitor.js                    lib/context-auditor.js
budget-check.js                    lib/usage-correlator.js
weekly-digest.js                   hooks/context-snapshot.js
report.js                          skills/cost-audit/
recommend.js (7 analyzers)         evals/
dashboard.js
```

Data flow for context audit:

```
context-snapshot.js (SessionStart)
  → scans installed skills, MCPs, plugins, hooks, memory
  → writes snapshot to context-snapshots.jsonl (separate from cost-log)

/cost-audit (on demand)
  → context-auditor.js scans current installation
  → usage-correlator.js greps cost-log.jsonl for actual invocations
  → compares installed cost vs usage frequency
  → produces prioritized waste report with dollar savings
```

---

## Module Specifications

### lib/pricing-engine.js

Replaces the hardcoded `PRICING` object in session-logger.js. Single source of truth for all cost calculations.

```javascript
const RUNTIMES = {
  "claude-code": { markup: 1.0, per_million_surcharge: 0 },
  "cursor":      { markup: 0.93, per_million_surcharge: 0.25 }
};

const BASE_PRICING = {
  "claude-opus-4-7":          { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  "claude-opus-4-6":          { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  "claude-sonnet-4-6":        { input: 3,  output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4-5-20250929": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-haiku-4-5-20251001":  { input: 1, output: 5,  cache_read: 0.1, cache_write: 1.25 }
};
```

**Exports:** `getPricing(modelId, runtime)`, `calcCost(tokens, modelId, runtime)`, `COMPARISON_MODELS`, `detectRuntime()`

**Runtime detection:** Checks `process.env.CURSOR_SESSION`, `process.env.CURSOR_TRACE_ID`, or reads from `~/.claude/cost-tracker/config.json`.

### lib/context-auditor.js

Six scanners, each returning a standardized finding object:

```javascript
{
  source: "skill" | "mcp" | "plugin" | "hook" | "memory" | "system",
  name: "slide-icons",
  path: "~/.claude/skills/slide-icons/SKILL.md",
  bytes: 23249,
  estimated_tokens: 5812,
  cost_per_session_usd: 0.029,
  cost_per_month_usd: 2.32,
  last_used: "2026-04-15",       // null if never
  sessions_used: 3,              // in analysis period
  total_sessions: 150,           // in analysis period
  usage_rate: 0.02,
  verdict: "disable",            // "keep" | "reduce" | "disable"
  reason: "Not used in 64 days, costing $2.32/month in context"
}
```

**Scanners:**

| Scanner | Reads | Token estimate method |
|---------|-------|----------------------|
| `scanSkills()` | `~/.claude/skills/*/SKILL.md` | `bytes × 0.25` |
| `scanMcpServers()` | settings.json `mcpServers` keys + known-servers lookup | `tool_count × 200` tokens avg per tool schema. Tool counts from a bundled `known-mcp-servers.json` lookup (e.g., servicenow-mcp: 80, slack: 50, workspace-mcp: 90, playwright: 20). Unknown servers default to 15 tools. Users can override in config. |
| `scanPlugins()` | `~/.claude/plugins/cache/*/` SKILL.md files | `bytes × 0.25` |
| `scanHooks()` | settings.json `hooks` | Execution time cost only (hooks don't inject into context) |
| `scanMemory()` | CLAUDE.md, MEMORY.md, `~/.claude/projects/*/memory/` | `bytes × 0.25` |
| `scanPermissions()` | settings.json `permissions.allow` array | Entry count, flag if >100 entries |

**Verdict logic:**

```
if (last_used within 7 days OR usage_rate > 0.10): "keep"
if (usage_rate > 0.02 AND bytes > 10240):           "reduce"
if (last_used > 30 days ago OR never used):          "disable"
```

### lib/usage-correlator.js

Scans session transcripts in cost-log.jsonl to determine actual skill and MCP usage.

**Skill detection:** Greps for `/skill-name` invocations and `Skill(skill-name)` tool calls in transcript data.

**MCP detection:** Greps for `mcp__servername__` tool call patterns.

**Output:** Map of `{ name: string, last_used: Date, session_count: number }` for each installed skill and MCP.

**Limitation:** Only works if session-logger captures enough transcript context. The existing logger samples first 10 user messages for classification — we extend this to also scan for skill/MCP invocation patterns across all messages.

### hooks/context-snapshot.js

Fires at `SessionStart`. Lightweight — just lists what's installed, doesn't read file contents.

```javascript
// Writes to a separate snapshot file, not cost-log.jsonl
// (cost-log entries are written at SessionEnd)
{
  timestamp: "2026-06-18T14:30:00Z",
  skills: ["ai-inventory", "slide-deck", ...],  // names only
  skills_total_bytes: 534530,
  mcps: ["slack", "servicenow", ...],
  mcp_tool_count: 280,
  plugins: ["cost-tracker", "superpowers"],
  hooks_count: 12,
  memory_bytes: 15200,
  estimated_context_tokens: 145000,
  estimated_context_cost_usd: 0.043  // per-message at current model
}
```

Stored at `~/.claude/cost-tracker/context-snapshots.jsonl`. Used for trending: "Your context load has grown 20% this month."

### skills/cost-audit/SKILL.md

New skill with frontmatter:

```yaml
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
```

**Output format:** Prioritized table sorted by monthly waste:

```
Context Audit — Last 30 days (147 sessions)

TOTAL CONTEXT LOAD: ~145K tokens/session ($0.043/msg on Opus)

TOP WASTE — Skills not earning their context cost:
  #  Skill              Size     Last Used    Usage   $/Month  Action
  1  slide-icons        23KB     64 days ago  0.7%    $2.32    DISABLE
  2  workday            21KB     45 days ago  1.3%    $2.15    DISABLE
  3  apps-script-builder 21KB   12 days ago  3.4%    $2.12    REDUCE
  ...

MCP SERVER WASTE:
  #  Server          Tools  Last Used     Usage   $/Month  Action
  1  servicenow-mcp  80     2 days ago    8.1%    $4.80    KEEP (but 72 unused tools)
  2  atlan-mcp        18    31 days ago   0.0%    $1.08    DISABLE
  ...

ESTIMATED MONTHLY SAVINGS IF ALL "DISABLE" APPLIED: $14.20/month

Quick actions:
  - Remove 8 unused skills: save ~$12/month in context
  - Disconnect 2 unused MCPs: save ~$2.20/month
  - Consolidate permissions list (207 entries → ~40 with wildcards)
```

---

## Cursor Integration

### Pricing

All cost calculations pass through `pricing-engine.js` which accepts a runtime parameter:

```javascript
calcCost(tokens, "claude-opus-4-6", "cursor")
// → (base_price × 0.93) + (total_tokens / 1_000_000 × 0.25)
```

### Data Collection

**Phase 1 (this version):** Manual import. User provides Cursor usage data:
- `/cost-tracker import cursor <path-to-export.json>`
- Parses Cursor's export format into cost-log.jsonl entries tagged with `runtime: "cursor"`

**Phase 2 (future):** Log scraper for `~/.cursor/` local database.

### Reports

All reports gain a `--runtime` flag:
- `/cost-tracker week` — shows current runtime
- `/cost-tracker week --runtime cursor` — forces Cursor pricing
- `/cost-tracker compare` — shows all models × both runtimes

---

## Existing Code Changes

### Consolidate dashboard.js

Delete `skills/cost-dashboard/scripts/dashboard.js` (307 lines, simpler version). Update cost-dashboard SKILL.md to point to `skills/cost-tracker/scripts/dashboard.js` (594 lines, full version).

### Externalize pricing

Remove `PRICING` and `COMPARISON_MODELS` from session-logger.js. Import from `lib/pricing-engine.js`. All consumers (session-logger, cost-monitor, report, recommend, dashboard) import from the same module.

### Extend session-logger.js

Add skill/MCP usage detection to the transcript parser. When scanning messages, also record:
- Skill invocations found (e.g., `/cost-tracker`, `Skill(gmail-triage)`)
- MCP tool calls found (e.g., `mcp__slack__post_message`)

These get appended to the JSONL entry:

```javascript
{
  // ...existing fields...
  skills_used: ["cost-tracker", "gmail-triage"],
  mcps_used: ["slack", "workspace-mcp"],
  runtime: "claude-code"  // or "cursor"
}
```

### Update weekly-digest.js

Add a context cost summary to the weekly digest:

```
Context Load This Week:
  Avg context: 145K tokens/session
  Context cost: $18.40 (estimated)
  Unused skills costing context: 8 ($12/month waste)
```

### Skill frontmatter updates

All 4 existing SKILL.md files: rewrite descriptions to "Use when..." format per SDO best practices.

---

## Eval Specifications

### Layer 1: Unit Tests (Jest)

**New test files:**

| File | Tests | Coverage target |
|------|-------|-----------------|
| `pricing-engine.test.js` | CC formula, Cursor formula, all 5 models × 2 runtimes, unknown model fallback, surcharge math | 100% of calcCost paths |
| `context-auditor.test.js` | Each scanner with mock filesystem, verdict logic at all thresholds, empty/missing dirs, giant skills, zero-usage MCPs | All 6 scanners + verdict engine |
| `usage-correlator.test.js` | Skill invocation grep, MCP tool call grep, false positive rejection (mentions in text vs actual tool use), empty logs | Pattern matching accuracy |
| `context-snapshot.test.js` | Snapshot creation, JSONL append, trending calculation | SessionStart hook flow |
| `audit.test.js` | Full audit report generation, sorting by waste, action text | End-to-end audit output |

**Expanded existing tests:**

| File | Additions |
|------|-----------|
| `session-logger.test.js` | Skills/MCPs extraction from transcripts, runtime field, pricing-engine integration |
| `budget-check.test.js` | Monthly scenarios, multi-period overlap |
| `weekly-digest.test.js` | Context cost summary, insights for unused skills |
| `recommend.test.js` | Context bloat analyzer using auditor data |

**Test fixtures:**

```
__tests__/fixtures/
  mock-skills/
    used-skill/SKILL.md        # 2KB, used frequently
    bloated-skill/SKILL.md     # 25KB, rarely used
    unused-skill/SKILL.md      # 5KB, never used
  mock-settings.json           # 3 MCPs, 5 hooks, 50 permissions
  mock-cost-log.jsonl          # 30 synthetic sessions with skill/MCP usage data
```

### Layer 2: Agent Evals (Subagent Pressure Tests)

**Harness:** `evals/run-evals.js` spawns a fresh Claude Code subagent per scenario with the cost-audit skill loaded, feeds it a user prompt, and validates the response.

**Scenarios:**

```json
// evals/scenarios/skill-bloat.json
{
  "name": "skill-bloat-detection",
  "description": "Agent correctly identifies unused skills and recommends disabling",
  "user_prompt": "I have 66 skills installed and my sessions are expensive. What should I do?",
  "fixtures": ["mock-skills", "mock-cost-log.jsonl"],
  "required_in_response": [
    "disable",
    "unused",
    "savings",
    "/cost-audit"
  ],
  "forbidden_in_response": [
    "I don't have access",
    "I can't analyze"
  ]
}
```

**5 scenarios:**

| Scenario | Tests | Key assertion |
|----------|-------|--------------|
| `vague-cost-help` | Agent routes to right tool | Response mentions `/cost-optimize` or `/cost-audit` |
| `skill-bloat` | Agent identifies waste | Response includes specific skills to disable with savings |
| `cursor-pricing` | Correct formula | Dollar amounts use Cursor markup, not CC direct |
| `mcp-partial-use` | Nuanced recommendation | Doesn't blanket-disable an MCP used 2 days ago |
| `root-cause` | Multi-factor analysis | Correlates context + model + cache, not single-cause |

---

## File Map

```
plugins/cost-tracker/
  .claude-plugin/plugin.json

  hooks/
    hooks.json
    session-logger.js              # refactored: pricing-engine, skill/MCP extraction
    cost-monitor.js                # unchanged
    budget-check.js                # unchanged
    weekly-digest.js               # updated: context cost in digest
    context-snapshot.js            # NEW

  lib/
    pricing-engine.js              # NEW
    context-auditor.js             # NEW
    usage-correlator.js            # NEW

  skills/
    cost-tracker/
      SKILL.md
      scripts/
        report.js                  # refactored: pricing-engine
        dashboard.js               # consolidated
    cost-optimize/
      SKILL.md
      scripts/
        recommend.js               # refactored: pricing-engine, context analyzer
    cost-dashboard/
      SKILL.md                     # points to cost-tracker/scripts/dashboard.js
    cost-budget/
      SKILL.md                     # unchanged
    cost-audit/                    # NEW
      SKILL.md
      scripts/
        audit.js

  __tests__/
    hooks/
      session-logger.test.js
      cost-monitor.test.js
      budget-check.test.js
      weekly-digest.test.js
      context-snapshot.test.js     # NEW
    lib/
      pricing-engine.test.js      # NEW
      context-auditor.test.js     # NEW
      usage-correlator.test.js    # NEW
    skills/
      report.test.js
      recommend.test.js
      audit.test.js               # NEW
    fixtures/
      mock-skills/                # NEW
      mock-settings.json          # NEW
      mock-cost-log.jsonl         # NEW

  evals/
    run-evals.js                  # NEW
    scenarios/                    # NEW (5 scenarios)
    fixtures/                     # NEW

  README.md                       # updated for v2
  package.json                    # version bump to 2.0.0
```

**Net new:** 10 source files, 5 test files, 5 eval scenarios, fixture directories.
**Modified:** 6 existing files (session-logger, weekly-digest, report, recommend, 2 SKILL.mds).
**Deleted:** 1 file (duplicate dashboard.js).
