# Claude Code Cost Tracker

A Claude Code and Cursor plugin that tracks spending, audits context bloat, and helps you run leaner sessions. Automatic logging, context analysis, optimization recommendations, budget alerts, and session profiles — all local, zero dependencies.

## What's New in v2.0

- **Context Audit** — Scans installed skills, MCPs, plugins, hooks, and memory files. Shows what's eating your context window and what it costs per month. Recommends what to disable.
- **Session Profiles** — Save and apply "lean" configurations that disable unused MCPs and skills before a session starts. Auto-restores on session end.
- **Cursor Support** — Dual-runtime pricing engine with Cursor's formula: `(provider_price × 93%) + $0.25/1M tokens`
- **Skill/MCP Usage Tracking** — Logs which skills and MCP tools you actually invoke each session
- **Eval Harness** — 5 agent behavior test scenarios for validating skill quality

## Features

- **Automatic logging** — `SessionEnd` hook silently records cost data every time you exit a session
- **Cross-session tracking** — Persistent JSONL log accumulates data across all terminals and projects
- **Session intelligence** — Captures `/rename` names, auto-classifies sessions (debug, build, review, refactor, test, docs, deploy, config)
- **Project detection** — Auto-identifies projects from git remote URLs
- **Model comparison** — Shows what your work would cost on Opus, Sonnet, and Haiku
- **Subagent & cache tracking** — Includes subagent tokens and cache hit ratios
- **Real-time monitoring** — Cost tips when context or spend thresholds are crossed
- **Budget alerts** — Daily/weekly/monthly limits with 80% and 100% warnings
- **Weekly digests** — Automatic week-over-week comparison on session start
- **Context snapshots** — Logs installed skills/MCPs at session start for trending
- **CSV export** — Dump all data for external analysis

## Installation

```
/plugin marketplace add ChewbaccaRoars/claude-code-cost-tracker
/plugin install cost-tracker@claude-code-cost-tracker
/reload-plugins
```

Or from a local clone:

```bash
git clone https://github.com/ChewbaccaRoars/claude-code-cost-tracker.git
# Then in Claude Code:
/plugin install --path ./claude-code-cost-tracker
```

## Skills

### `/cost-tracker` — Spending Reports

| Command | Description |
|---------|-------------|
| `/cost-tracker` | Today's cost summary |
| `/cost-tracker week` | Last 7 days |
| `/cost-tracker month` | Last 30 days |
| `/cost-tracker all` | Full history |
| `/cost-tracker compare` | Model cost comparison only |
| `/cost-tracker export` | Export all data to CSV |
| `/cost-tracker project:<name>` | Filter by project name |
| `/cost-tracker session:<name>` | Filter by session name |

Reports include token breakdowns, per-project costs, model comparisons, cache efficiency, and daily trends.

### `/cost-audit` — Context Bloat Analysis

Scans your entire setup and shows what's inflating your context window:

```
Context Audit — Last 30 days (147 sessions)

TOTAL CONTEXT LOAD: ~145K tokens/session ($0.043/msg on Opus)

TOP WASTE — Skills not earning their context cost:
  #  Skill              Size     Last Used    Usage   $/Month  Action
  1  slide-icons        23KB     64 days ago  0.7%    $2.32    DISABLE
  2  workday            21KB     45 days ago  1.3%    $2.15    DISABLE
  ...

MCP SERVER WASTE:
  #  Server          Tools  Last Used     Usage   $/Month  Action
  1  atlan-mcp        18    31 days ago   0.0%    $1.08    DISABLE
  ...

ESTIMATED MONTHLY SAVINGS IF ALL "DISABLE" APPLIED: $14.20/month
```

Verdicts:
- **KEEP** — Used in >10% of sessions or used in last 7 days
- **REDUCE** — Used occasionally but oversized (>10KB)
- **DISABLE** — Not used in 30+ days, costing money for no value

### `/cost-lean` — Session Context Profiles

Manage context profiles to run lean sessions:

| Command | Description |
|---------|-------------|
| `/cost-lean` | Show current context load with cost per item |
| `/cost-lean recommend` | Generate profiles from your usage patterns |
| `/cost-lean save <name>` | Save current enabled config as a profile |
| `/cost-lean profiles` | List saved profiles |
| `/cost-lean restore` | Re-enable everything |

**CLI wrapper** for applying profiles before a session:

```bash
npx cost-lean                     # show current context load
npx cost-lean --recommend         # generate profile recommendations
npx cost-lean --profile lean      # apply a saved profile
npx cost-lean --list              # list saved profiles
npx cost-lean --restore           # restore full config

# Then start your session
claude
```

Profiles disable unused MCPs (by filtering `.mcp.json`) and skills (by renaming `SKILL.md` → `SKILL.md.disabled`). A SessionEnd hook automatically restores your full config when the session ends.

### `/cost-optimize` — Smart Recommendations

Analyzes spending patterns across 7 dimensions:

| Analyzer | What It Detects |
|----------|----------------|
| **Model Tier** | Opus sessions that could use Sonnet |
| **Cache Efficiency** | Low cache hit rates, short sessions wasting warmup |
| **Context Bloat** | Sessions exceeding 500K tokens |
| **Project Patterns** | Projects using Opus for routine work |
| **Session Name Patterns** | Task types correlated with model cost |
| **Time Patterns** | Expensive time-of-day patterns |
| **Subagent Usage** | Multi-model session overhead |

### `/cost-dashboard` — Interactive Visualization

Generates a self-contained HTML dashboard with Chart.js:

- KPI cards (total, today, 7-day, 30-day, cache efficiency)
- Daily spend trends, model tier doughnut, per-project bars
- Hour-of-day distribution, cumulative spend, sessions per day
- Searchable session table with cost tiers and summaries

### `/cost-budget` — Spending Limits

```
/cost-budget set weekly 500     # Set $500/week limit
/cost-budget status             # Check current spend vs limits
/cost-budget clear              # Remove all limits
```

Alerts at 80% (yellow) and 100% (red) via the Stop hook.

## Cursor Support

The pricing engine supports Cursor's markup formula:

```
Cursor cost = (Model Provider List Price × 93%) + $0.25 per 1M tokens
```

Runtime is auto-detected via Cursor environment variables. All reports show costs for the detected runtime. Use `npx cost-lean` to apply profiles to Cursor's `~/.cursor/mcp.json`.

## Real-Time Cost Monitor

A `Stop` hook surfaces tips as system messages:

| Threshold | Trigger | Tip |
|-----------|---------|-----|
| Context 200K | Peak context > 200K | Suggests `/compact` |
| Context 500K | Peak context > 500K | Warns about per-message cost |
| Cost $50 | Session > $50 | Suggests Sonnet if on Opus |
| Cost $200 | Session > $200 | Recommends new session |
| Opus routine | Every 20 Opus messages | Reminds about Sonnet |
| Low cache | Cache hit rate < 30% | Advises against clearing context |

Each tip shows once per session.

## How It Works

```
Session Start → Weekly digest check → Context snapshot
     ↓
Each turn → Cost monitor + budget check
     ↓
Session End → Session restore (if lean profile active)
           → Parse transcript → Classify → Calculate → Log
     ↓
On demand → /cost-tracker, /cost-audit, /cost-lean,
            /cost-optimize, /cost-dashboard, /cost-budget
```

### Hooks

| Event | Hook | Purpose |
|-------|------|---------|
| `SessionStart` | `weekly-digest.js` | Weekly comparison digest |
| `SessionStart` | `context-snapshot.js` | Log installed skills/MCPs for trending |
| `Stop` | `cost-monitor.js` | Context and cost threshold alerts |
| `Stop` | `budget-check.js` | Budget limit enforcement |
| `SessionEnd` | `session-restore.js` | Restore config if lean profile was active |
| `SessionEnd` | `session-logger.js` | Parse, classify, calculate, and log |

### Data Files

| File | Purpose |
|------|---------|
| `~/.claude/cost-tracker/cost-log.jsonl` | One JSON line per session |
| `~/.claude/cost-tracker/context-snapshots.jsonl` | Context load snapshots per session |
| `~/.claude/cost-tracker/profiles/` | Saved context profiles |
| `~/.claude/cost-tracker/backups/` | Config backups (auto-managed) |
| `~/.claude/cost-tracker/budget.json` | Budget limits |
| `~/.claude/cost-tracker/dashboard.html` | Last generated dashboard |
| `~/.claude/cost-tracker/digests/` | Weekly digest markdown files |

All data stays local.

## Supported Models & Pricing

Per million tokens (April 2026):

| Model | Input | Output | Cache Write | Cache Read |
|-------|-------|--------|-------------|------------|
| Opus 4.7 / 4.6 | $5.00 | $25.00 | $6.25 | $0.50 |
| Sonnet 4.6 / 4.5 | $3.00 | $15.00 | $3.75 | $0.30 |
| Haiku 4.5 | $1.00 | $5.00 | $1.25 | $0.10 |

Pricing is centralized in `lib/pricing-engine.js`. Unknown models default to Sonnet with a `pricing_estimated` flag.

## Architecture

```
plugins/cost-tracker/
  lib/                    # Shared modules
    pricing-engine.js     # Model pricing + Cursor support
    context-auditor.js    # 6 scanners for context bloat
    usage-correlator.js   # Skill/MCP usage tracking
    config-paths.js       # Runtime detection (CC vs Cursor)
    profile-manager.js    # Profile CRUD, backup/restore
  hooks/                  # Lifecycle hooks
  skills/                 # 6 slash commands
  bin/                    # CLI wrapper (cost-lean)
  evals/                  # Agent behavior tests
  __tests__/              # Jest test suites
```

## Testing

```bash
npm install
npm test
```

218 tests across 13 suites covering pricing calculations, context scanning, usage correlation, profile management, transcript parsing, session classification, threshold logic, budget checks, digest generation, and report formatting.

### Evals

Agent behavior tests validate that skills produce correct recommendations:

```bash
node plugins/cost-tracker/evals/run-evals.js
```

5 scenarios: vague cost help, skill bloat detection, Cursor pricing, MCP partial use, root cause analysis.

## Platform Support

- Windows 11 (Git Bash) — includes path normalization
- macOS and Linux
- Cursor (auto-detected via environment variables)

## Contributing

Issues and PRs welcome at [github.com/ChewbaccaRoars/claude-code-cost-tracker](https://github.com/ChewbaccaRoars/claude-code-cost-tracker).

## License

MIT
