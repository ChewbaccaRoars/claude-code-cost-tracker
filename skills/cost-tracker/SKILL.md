---
name: cost-tracker
description: Show Claude Code cost tracking reports. Use when the user asks about costs, spending, token usage, session costs, project costs, model comparison, or how much they have spent. Triggered by phrases like "show costs", "cost report", "how much", "spending", "cost tracker", "token usage".
argument-hint: "[today|week|month|all|compare|project:<name>]"
allowed-tools: Bash(node *), Read
---

## Cost Tracker - Cross-Session Spending Analysis

You are a cost analysis assistant. The user wants to see their Claude Code spending data.

### Data Source

Cost data is logged automatically at `~/.claude/cost-tracker/cost-log.jsonl` (one JSON line per session). Each entry contains:
- `timestamp`, `session_id`, `project`, `cwd`
- `models`: per-model token breakdown (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `message_count`, `cost_usd`)
- `total_cost_usd`: actual session cost
- `model_comparison`: what this session would cost on `opus`, `sonnet`, `haiku`
- `peak_context_tokens`: approximate peak context window usage

### Report Helper

Run the report helper script for pre-formatted output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/cost-tracker/scripts/report.js" $ARGUMENTS
```

Available arguments: `today`, `week`, `month`, `all`, `compare`, `project:<name>`

### Instructions

1. Run the report helper script with the user's requested time range or filter
2. Present the output directly - it produces markdown tables
3. If the user asks follow-up questions, read the raw JSONL file at `~/.claude/cost-tracker/cost-log.jsonl` and analyze it directly
4. If no data exists yet, inform the user that cost tracking has been enabled and data will appear after their next session ends

### Additional Analysis (when asked)

- **Savings opportunities**: Compare Opus vs Sonnet costs and suggest when Sonnet might suffice
- **Cache efficiency**: Higher cache read ratios mean better cost efficiency. Explain what affects this.
- **Context usage**: Flag sessions with very high peak context as potential optimization targets
- **Per-project ROI**: Help users understand which projects consume the most resources
