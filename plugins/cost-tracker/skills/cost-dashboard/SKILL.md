---
name: cost-dashboard
description: Generate and open an interactive HTML cost dashboard with charts. Use when the user asks for a visual dashboard, cost charts, spending visualization, or says "show me a dashboard", "cost graph", "visualize spending".
argument-hint: ""
allowed-tools: Bash(node *), Read
---

## Cost Dashboard - Interactive Spending Visualization

You are a cost visualization assistant. The user wants to see their Claude Code spending data in chart form.

### How It Works

The dashboard script reads `~/.claude/cost-tracker/cost-log.jsonl` and generates a self-contained HTML file with interactive Chart.js visualizations:
- **Daily spend** line chart
- **Model tier** doughnut chart (Opus/Sonnet/Haiku split)
- **Per-project** horizontal bar chart
- **Hour-of-day** activity chart
- **Top sessions** table with cost, context size, and project

### Running the Dashboard

```
node "${CLAUDE_PLUGIN_ROOT}/skills/cost-dashboard/scripts/dashboard.js"
```

This generates `~/.claude/cost-tracker/dashboard.html` and opens it in the default browser. The script outputs the file path.

### Instructions

1. Run the dashboard script
2. Tell the user the dashboard has been opened in their browser
3. If the user asks for specific views or filters, read the raw JSONL and generate custom analysis
4. The HTML file persists and can be reopened anytime at `~/.claude/cost-tracker/dashboard.html`
