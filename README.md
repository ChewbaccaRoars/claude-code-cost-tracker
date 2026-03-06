# Claude Code Cost Tracker

A Claude Code plugin that automatically tracks your spending across sessions, projects, and days. Compare what your work would cost on different Claude models and identify optimization opportunities.

## What It Does

- **Automatic logging** - A `SessionEnd` hook silently records cost data every time you exit a Claude Code session
- **Cross-session tracking** - Persistent JSONL log accumulates data across all your terminals and projects
- **Project detection** - Auto-identifies projects from git remote URLs (falls back to directory name)
- **Model comparison** - Shows what your work would cost on Opus, Sonnet, and Haiku
- **Subagent tracking** - Includes token usage from all subagents spawned during a session
- **Cache efficiency** - Tracks cache hit ratios to help you understand cost drivers

## Installation

Add this repository as a marketplace and install:

```
/plugin marketplace add ChewbaccaRoars/claude-code-cost-tracker
/plugin install cost-tracker@claude-code-cost-tracker
```

Or install from a local clone:

```bash
git clone https://github.com/ChewbaccaRoars/claude-code-cost-tracker.git
# Then in Claude Code:
/plugin install --path ./claude-code-cost-tracker
```

## Usage

Use the `/cost-tracker` skill to view reports:

| Command | Description |
|---------|-------------|
| `/cost-tracker` | Today's cost summary |
| `/cost-tracker today` | Today's cost summary |
| `/cost-tracker week` | Last 7 days |
| `/cost-tracker month` | Last 30 days |
| `/cost-tracker all` | Full history |
| `/cost-tracker compare` | Model cost comparison |
| `/cost-tracker project:<name>` | Filter by project name |

You can also ask naturally: *"how much have I spent this week?"* or *"show me cost breakdown by project"*

## Example Output

```
## Today's Cost Summary

Sessions: 3 | Total Cost: $2.4521

### Token Breakdown
| Type | Count |
|------|-------|
| Input | 1,250 |
| Output | 15,430 |
| Cache Write | 98,000 |
| Cache Read | 450,000 |
| Cache Efficiency | 81.9% |

### Per-Project Costs
| Project | Sessions | Cost |
|---------|----------|------|
| my-app | 2 | $1.8934 |
| dotfiles | 1 | $0.5587 |

### Model Comparison
What this work would cost on each model:
| Model | Cost | vs Actual |
|-------|------|-----------|
| Opus | $12.3400 | +403% |
| Sonnet | $2.4521 | +0% |
| Haiku | $0.6540 | -73% |
```

## How It Works

```
Session ends → SessionEnd hook fires → session-logger.js parses transcript
→ Aggregates tokens per model → Calculates costs → Appends to cost-log.jsonl
→ /cost-tracker skill reads log → Generates formatted reports
```

1. **SessionEnd hook** (`hooks/session-logger.js`): Reads the session transcript JSONL, extracts token usage from all assistant messages (including subagents), calculates costs using the pricing table, and appends a single JSON line to the persistent log.

2. **Cost log** (`~/.claude/cost-tracker/cost-log.jsonl`): One line per session with timestamp, project name, per-model token counts, total cost, model comparison, and peak context usage.

3. **Reporting skill** (`skills/cost-tracker/SKILL.md`): Instructs Claude to read the log and generate formatted reports with tables, trends, and analysis.

## Supported Models & Pricing

Prices per million tokens (as of March 2026):

| Model | Input | Output | Cache Write | Cache Read |
|-------|-------|--------|-------------|------------|
| Claude Opus 4.6 | $15.00 | $75.00 | $18.75 | $1.50 |
| Claude Sonnet 4.6 | $3.00 | $15.00 | $3.75 | $0.30 |
| Claude Haiku 4.5 | $0.80 | $4.00 | $1.00 | $0.08 |

Unknown models default to Sonnet pricing with a `pricing_estimated` flag.

## Data Storage

Cost data is stored at `~/.claude/cost-tracker/cost-log.jsonl` in your home directory (not inside the plugin). This means:

- Data persists across plugin updates
- Data is never pushed to any remote service
- You can back up, export, or delete the file at any time
- Each line is a self-contained JSON object for easy parsing

## Requirements

- **Claude Code** with plugin support
- **Node.js** (any recent version)
- **git** (optional, for project name detection from remotes)

## Platform Support

Tested on:
- Windows 11 with Git Bash
- Should work on macOS and Linux (standard Node.js path handling)

The logger includes Windows-specific path normalization for Git Bash environments (`/c/Users/...` to `C:\Users\...`).

## Contributing

Issues and pull requests welcome. Key areas for contribution:

- Additional model pricing (OpenAI, Google, etc.)
- Visualization/charting support
- Budget alerts and thresholds
- Export to CSV/Excel

## License

MIT
