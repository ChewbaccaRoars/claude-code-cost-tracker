---
name: cost-tracker
description: Show Claude Code cost tracking reports and visual dashboard. Use when the user asks about costs, spending, token usage, session costs, project costs, model comparison, how much they have spent, or wants a cost dashboard. Triggered by phrases like "show costs", "cost report", "how much", "spending", "cost tracker", "token usage", "dashboard", "cost dashboard".
argument-hint: "[today|week|month|all|compare|dashboard|project:<name>]"
allowed-tools: Bash(node *), Bash(start *), Read
---

## Cost Tracker - Cross-Session Spending Analysis

You are a cost analysis assistant. The user wants to see their Claude Code spending data.

### Data Source

Cost data is logged automatically at `~/.claude/cost-tracker/cost-log.jsonl` (one JSON line per session). Each entry contains:
- `timestamp`, `start_timestamp`, `end_timestamp`, `session_id`, `project`, `cwd`
- `models`: per-model token breakdown (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `message_count`, `cost_usd`)
- `total_cost_usd`: actual session cost
- `model_comparison`: what this session would cost on `opus`, `sonnet`, `haiku`
- `peak_context_tokens`: approximate peak context window usage

### Report Helper (Terminal Output)

Run the report helper script for pre-formatted markdown output:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/cost-tracker/scripts/report.js" $ARGUMENTS
```

Available arguments: `today`, `week`, `month`, `all`, `compare`, `project:<name>`

### Visual Dashboard (HTML)

Generate and open an interactive HTML dashboard with charts and session history:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/cost-tracker/scripts/dashboard.js"
```

The dashboard includes:
- **KPI cards**: Total spend, today, 7-day, 30-day, cache efficiency, avg per session
- **Model comparison**: What the same work would cost on Opus, Sonnet, and Haiku
- **Charts**: Daily spend (color-coded by threshold), cost by day of week, sessions per day, cumulative spend
- **Session table**: Searchable, filterable by cost range, sortable by date or cost, with session summaries
- **Cost amortization**: Sessions spanning multiple days have costs distributed evenly across active days

Optional: specify a custom output path:
```
node "${CLAUDE_PLUGIN_ROOT}/skills/cost-tracker/scripts/dashboard.js" /path/to/output.html
```

To open the dashboard after generating:
```
start "" "$HOME/.claude/cost-tracker/dashboard.html"
```

### Instructions

1. If the user says "dashboard", run the dashboard script, then open the HTML file
2. Otherwise, run the report helper script with the user's requested time range or filter
3. Present the output directly - it produces markdown tables
4. If the user asks follow-up questions, read the raw JSONL file at `~/.claude/cost-tracker/cost-log.jsonl` and analyze it directly
5. If no data exists yet, inform the user that cost tracking has been enabled and data will appear after their next session ends

### Additional Analysis (when asked)

- **Savings opportunities**: Compare Opus vs Sonnet costs and suggest when Sonnet might suffice
- **Cache efficiency**: Higher cache read ratios mean better cost efficiency. Explain what affects this.
- **Context usage**: Flag sessions with very high peak context as potential optimization targets
- **Per-project ROI**: Help users understand which projects consume the most resources
