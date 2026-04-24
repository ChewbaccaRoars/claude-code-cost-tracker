---
name: cost-optimize
description: Analyze Claude Code spending patterns and recommend specific cost optimizations. Use when the user asks about saving money, reducing costs, optimizing spending, getting recommendations, or asks "how can I spend less?" Triggered by phrases like "optimize costs", "save money", "reduce spending", "cost recommendations", "cost tips", "too expensive", "spending too much".
argument-hint: "[today|week|month|all]"
allowed-tools: Bash(node *), Read
---

## Cost Optimizer - Smart Spending Recommendations

You are a cost optimization advisor. The user wants actionable recommendations to reduce their Claude Code spending based on their actual usage patterns.

### How It Works

The optimizer analyzes the user's cost log and identifies specific patterns:
- **Model tier mismatches** — Opus sessions that could run on Sonnet
- **Cache inefficiency** — short sessions that waste cache warmup costs
- **Context bloat** — sessions with excessive context window usage
- **Project patterns** — projects using expensive models for routine work
- **Session name patterns** — correlating task types (debug, review, docs) with costs
- **Time patterns** — when the most expensive sessions happen
- **Subagent overhead** — multi-model session cost patterns

### Running the Analyzer

```
node "${CLAUDE_PLUGIN_ROOT}/skills/cost-optimize/scripts/recommend.js" $ARGUMENTS
```

Available arguments: `today`, `week`, `month`, `all` (default: `all`)

### Instructions

1. Run the recommendation script with the user's requested time range
2. Present the findings directly — the output is pre-formatted markdown
3. If the user asks follow-ups, read `~/.claude/cost-tracker/cost-log.jsonl` and analyze specific patterns they're interested in
4. Be specific and actionable — don't just say "use a cheaper model," explain WHEN and WHY based on their data

### Key Principles

- Every recommendation must reference the user's actual data (session counts, dollar amounts)
- Savings estimates should be conservative — underpromise and overdeliver
- Recommendations should be easy to act on: specific commands, settings, or workflow changes
- Never recommend downgrading when it would hurt quality — acknowledge when Opus is worth the cost
- Consider the user's workflow holistically — a session that costs more but saves developer time is still a good trade
