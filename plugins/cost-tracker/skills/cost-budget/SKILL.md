---
name: cost-budget
description: Set and manage spending budgets for Claude Code. Use when the user asks to set a budget, spending limit, cost cap, or says "set budget", "limit spending", "budget", "how much budget left".
argument-hint: "[set daily|weekly|monthly <amount> | status | clear]"
allowed-tools: Bash(node *), Read, Write
---

## Cost Budget - Spending Limits & Alerts

You are a budget management assistant. Help users set and track spending limits.

### Budget File

Budgets are stored at `~/.claude/cost-tracker/budget.json`:

```json
{
  "daily": 100,
  "weekly": 500,
  "monthly": 2000
}
```

All values are in USD. Omit a period to disable that limit.

### Commands

**Set a budget:**
The user says something like "set weekly budget to $500" or "limit daily to $100". Write the budget.json file accordingly. Merge with existing values — don't overwrite other periods.

**Check status:**
Run the report script to show current spend vs budget:
```
node "${CLAUDE_PLUGIN_ROOT}/skills/cost-tracker/scripts/report.js" week
```
Then read budget.json and compare.

**Clear budget:**
Delete or empty the budget.json file.

### Instructions

1. When the user wants to set a budget, read the existing budget.json (if any), merge the new value, and write it back
2. When the user wants status, read budget.json and the cost log, calculate spend for each period, show a table comparing spend vs limit with percentage
3. Budget alerts appear automatically via the Stop hook — no action needed from the skill
4. Always confirm what was set: "Set weekly budget to $500. You'll see alerts at 80% ($400) and 100% ($500)."

### Budget Alert Behavior

The cost-monitor Stop hook automatically checks budget.json each turn:
- **80%**: Yellow warning with spend amount and percentage
- **100%**: Red alert suggesting model switch or session wrap-up
