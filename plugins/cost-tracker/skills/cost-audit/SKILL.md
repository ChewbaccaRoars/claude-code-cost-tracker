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
