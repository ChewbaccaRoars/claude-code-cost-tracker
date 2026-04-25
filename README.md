# Claude Code Cost Tracker

A Claude Code plugin that automatically tracks your spending across sessions, projects, and days. Compare model pricing, get optimization recommendations, set budgets, and visualize spending trends.

## Features

- **Automatic logging** — `SessionEnd` hook silently records cost data every time you exit a session
- **Cross-session tracking** — Persistent JSONL log accumulates data across all terminals and projects
- **Session names** — Captures `/rename` session names for organized tracking
- **Auto-classification** — Categorizes sessions (debug, build, review, refactor, test, docs, deploy, config) by analyzing user messages
- **Project detection** — Auto-identifies projects from git remote URLs (falls back to directory name)
- **Model comparison** — Shows what your work would cost on Opus, Sonnet, and Haiku
- **Subagent tracking** — Includes token usage from all subagents spawned during a session
- **Cache efficiency** — Tracks cache hit ratios to help understand cost drivers
- **Real-time monitoring** — `Stop` hook surfaces cost tips when context or spend thresholds are crossed (early `/compact` nudge at 150K)
- **Model-router hints** — `UserPromptSubmit` hook detects routine work on Opus and suggests Sonnet *before* the prompt runs
- **Per-project auto-apply** — `/cost-optimize apply` writes Sonnet defaults into project `.claude/settings.json` based on observed usage
- **Statusline meter** — Live cost / context / model display in the Claude Code statusline (opt-in)
- **Budget alerts** — Configurable daily/weekly/monthly limits with 80% and 100% warnings
- **Webhook integration** — Slack-compatible POST when a budget threshold is first crossed each day (opt-in)
- **Cost forecast** — Trailing-average end-of-week and end-of-month projections vs your budget
- **Console reconciliation** — Cross-check local estimates against the Anthropic Console usage CSV
- **Per-tool attribution** — Quantify how many tokens each tool (Read, Bash, Grep, Task, MCP, …) consumes
- **Weekly digests** — Automatic this-week-vs-last comparison on session start
- **CSV export** — Dump all data for external analysis or expense reporting

## Installation

Add this repository as a marketplace and install:

```
/plugin marketplace add ChewbaccaRoars/claude-code-cost-tracker
/plugin install cost-tracker@claude-code-cost-tracker
/reload-plugins
```

Or install from a local clone:

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
| `/cost-tracker today` | Today's cost summary |
| `/cost-tracker week` | Last 7 days |
| `/cost-tracker month` | Last 30 days |
| `/cost-tracker all` | Full history |
| `/cost-tracker compare` | Model cost comparison only |
| `/cost-tracker export` | Export all data to CSV |
| `/cost-tracker project:<name>` | Filter by project name |
| `/cost-tracker session:<name>` | Filter by session name |

Reports include token breakdowns, per-project costs, per-session costs (for named sessions), model comparisons, cache efficiency, and daily trends.

You can also ask naturally: *"how much have I spent this week?"* or *"show me cost breakdown by project"*

### `/cost-optimize` — Smart Recommendations

Analyzes your spending patterns and generates actionable recommendations:

| Analyzer | What It Detects |
|----------|----------------|
| **Model Tier** | Opus sessions that could use Sonnet (light sessions, routine editing) |
| **Cache Efficiency** | Low cache hit rates, many short sessions wasting warmup |
| **Context Bloat** | Sessions exceeding 500K tokens, with session names called out |
| **Project Patterns** | Projects using Opus for low-complexity work |
| **Session Name Patterns** | Task types (debug/docs/review) correlated with model cost |
| **Time Patterns** | Which time of day has the most expensive sessions |
| **Subagent Usage** | Multi-model sessions costing more than average |

```
/cost-optimize          # Analyze all history
/cost-optimize week     # Last 7 days only
/cost-optimize month    # Last 30 days
```

Or ask: *"how can I reduce my spending?"*

#### Apply per-project model defaults

Once the optimizer has identified projects that should default to Sonnet, the `apply` action
writes `{"model":"sonnet"}` into each project's `.claude/settings.json` so future sessions
auto-pick the cheaper tier. Existing model fields are never overwritten.

```
/cost-optimize apply              # list candidates only (dry run)
/cost-optimize apply <project>    # apply to one project
/cost-optimize apply all          # apply to every candidate
```

#### Per-tool token attribution

Find out which tools dominate your input cost:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/cost-optimize/scripts/tool-attribution.js"
```

Lists every tool (Read, Bash, Grep, Task subagents, MCP tools, …) by total result tokens
and average tokens per call, so you know whether to scope `Read` calls, pipe `Bash` output
through `head`/`grep`, or rein in subagent usage.

### `/cost-dashboard` — Interactive Visualization

Generates a self-contained HTML dashboard with Chart.js and opens it in your browser:

- **KPI cards** — Total spend, session count, average per session
- **Daily spend** — Line chart with trends
- **Model tier** — Doughnut chart (Opus/Sonnet/Haiku split)
- **Per-project** — Horizontal bar chart
- **Hour-of-day** — Activity and cost distribution
- **Top sessions** — Table with cost, context size, and project

### `/cost-budget` — Spending Limits

Set daily, weekly, or monthly budgets:

```
/cost-budget set weekly 500     # Set $500/week limit
/cost-budget status             # Check current spend vs limits
/cost-budget forecast           # Project end-of-week and end-of-month spend
/cost-budget clear              # Remove all limits
```

Budget alerts appear automatically:
- **80%** — Yellow warning with spend amount and percentage
- **100%** — Red alert suggesting model switch or session wrap-up

Budgets are stored at `~/.claude/cost-tracker/budget.json`.

#### Forecast

The forecast bracket uses two trailing averages — the 30-day window for the low end
(steady-state) and the 7-day window for the high end (recent burn). Compare the bracket
against your weekly/monthly limit to see whether you're trending into the red.

#### Webhook on budget breach (opt-in)

Add a `webhook_url` field to `budget.json` and a Slack-compatible JSON payload is POSTed
when an 80% or 100% threshold is first crossed each UTC day:

```json
{
  "daily": 100,
  "weekly": 500,
  "webhook_url": "https://hooks.slack.com/services/T0000/B0000/XXXX"
}
```

Each `(period, level)` combination fires at most once per day, so the channel doesn't
spam after the threshold has been crossed.

## Real-Time Cost Monitor

A `Stop` hook runs after every turn and surfaces tips as system messages when thresholds are crossed:

| Threshold | Trigger | Tip |
|-----------|---------|-----|
| Context 150K | Peak context > 150K tokens | Early `/compact` nudge before costs scale |
| Context 200K | Peak context > 200K tokens | Suggests `/compact` |
| Context 500K | Peak context > 500K tokens | Warns about per-message cost, suggests splitting |
| Cost $50 | Session cost > $50 | Suggests Sonnet if on Opus |
| Cost $200 | Session cost > $200 | Strong warning, recommends new session |
| Opus routine | Every 20 Opus messages | Reminds about Sonnet for routine work |
| Low cache | Cache hit rate < 30% | Explains impact, advises against context clearing |

Each tip shows once per session — no spam.

## Model-Router Hint (UserPromptSubmit)

When the active model is **Opus** and the prompt looks like routine docs / refactor / test /
review / exploration work, a one-shot system message suggests `/model sonnet`. The
classifier suppresses the hint when the prompt mentions architecture, design, root cause,
race conditions, or other phrases where Opus is genuinely worth the cost.

Each category fires at most once per session, so a single suggestion lands without
becoming noise.

## Statusline Cost Meter (opt-in)

The plugin ships a statusline script at
`plugins/cost-tracker/statusline/cost-statusline.js` that shows
`Sonnet • $1.23 • 145K │ today $4.50/$10 (45%)` and lights up icons as context grows
(🟡 at 200K, 🔴 at 500K) and as you approach your daily budget (⚠️ at 80%, 🚨 at 100%).

Enable it by adding this to your `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/plugins/cost-tracker/statusline/cost-statusline.js"
  }
}
```

(Adjust the path to wherever the plugin is installed on your machine.)

## Weekly Digest

A `SessionStart` hook checks if it's been 7+ days since the last digest. If so, it generates a comparison report:

- This week vs last week: cost delta, session count, average per session
- Model mix comparison (Opus/Sonnet/Haiku spend)
- Top projects
- Insights (spending trends, optimization hints)

Digests are saved to `~/.claude/cost-tracker/digests/` as markdown files.

## Session Auto-Classification

When a session ends, the logger analyzes the first 10 user messages and classifies the session into one of 8 categories:

| Category | Detected Keywords |
|----------|-------------------|
| debug | fix, bug, error, broken, crash, not working |
| build | create, add, implement, feature, scaffold |
| review | review, audit, check, inspect, scan |
| refactor | refactor, cleanup, reorganize, rename |
| test | test, coverage, jest, pytest, unit test |
| docs | doc, readme, comment, explain, document |
| deploy | deploy, ship, release, publish, merge |
| config | config, setup, install, env, setting |

Categories are stored as `session_category` in the cost log and used by the optimizer for pattern analysis.

## How It Works

```
Session Start → Weekly digest check (if 7+ days)
     ↓
Each turn → Cost monitor checks context/cost thresholds
         → Budget check against daily/weekly/monthly limits
     ↓
Session End → Parse transcript tokens → Look up session name
           → Classify session category → Calculate costs
           → Append to cost-log.jsonl
     ↓
On demand → /cost-tracker, /cost-optimize, /cost-dashboard, /cost-budget
```

### Hooks

| Event | Hook | Purpose |
|-------|------|---------|
| `SessionStart` | `weekly-digest.js` | Generate weekly comparison if 7+ days since last |
| `UserPromptSubmit` | `model-router-hint.js` | Suggest Sonnet for Opus sessions running routine work |
| `Stop` | `cost-monitor.js` | Real-time context and cost threshold alerts |
| `Stop` | `budget-check.js` | Budget limit enforcement (+ optional webhook) |
| `SessionEnd` | `session-logger.js` | Parse transcript, classify, calculate, and log |

### Data Files

| File | Purpose |
|------|---------|
| `~/.claude/cost-tracker/cost-log.jsonl` | One JSON line per session (primary data) |
| `~/.claude/cost-tracker/budget.json` | Budget limits (daily/weekly/monthly) |
| `~/.claude/cost-tracker/dashboard.html` | Last generated dashboard |
| `~/.claude/cost-tracker/cost-export.csv` | Last CSV export |
| `~/.claude/cost-tracker/digests/` | Weekly digest markdown files |
| `~/.claude/cost-tracker/last-digest.json` | Timestamp of last digest generation |

All data stays local — nothing is sent to any remote service.

## Supported Models & Pricing

Prices per million tokens (as of April 2026):

| Model | Model ID | Input | Output | Cache Write | Cache Read |
|-------|----------|-------|--------|-------------|------------|
| Claude Opus 4.7 | `claude-opus-4-7` | $5.00 | $25.00 | $6.25 | $0.50 |
| Claude Opus 4.6 | `claude-opus-4-6` | $5.00 | $25.00 | $6.25 | $0.50 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | $3.00 | $15.00 | $3.75 | $0.30 |
| Claude Sonnet 4.5 | `claude-sonnet-4-5-20250929` | $3.00 | $15.00 | $3.75 | $0.30 |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | $1.00 | $5.00 | $1.25 | $0.10 |

Models are matched by exact ID first, then by substring (e.g., `claude-opus-4-6[1m]` matches Opus pricing). Unknown models default to Sonnet pricing with a `pricing_estimated` flag.

To add or update pricing, edit the `PRICING` object in `plugins/cost-tracker/hooks/session-logger.js`.

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

### Per-Session Costs
| Session | Project | Date | Cost |
|---------|---------|------|------|
| auth refactor | my-app | 2026-04-24 | $1.2300 |
| update readme | dotfiles | 2026-04-24 | $0.5587 |

### Model Comparison
| Model | Cost | vs Actual |
|-------|------|-----------|
| Opus | $12.3400 | +403% |
| Sonnet | $2.4521 | +0% |
| Haiku | $0.6540 | -73% |
```

## Requirements

- **Claude Code** with plugin support
- **Node.js** (any recent version)
- **git** (optional, for project name detection from remotes)

## Platform Support

Tested on:
- Windows 11 with Git Bash
- macOS and Linux (standard Node.js path handling)

The logger includes Windows-specific path normalization for Git Bash environments (`/c/Users/...` to `C:\Users\...`).

## Reconcile vs Anthropic Console

Cross-check local cost estimates against the Anthropic Console's actual billing.
Export the usage CSV from console.anthropic.com (Settings → Usage → Export CSV) and run:

```bash
node plugins/cost-tracker/skills/cost-tracker/scripts/reconcile.js /path/to/usage.csv
```

The report shows per-tier and per-day drift, flags models missing from local PRICING,
and tells you whether local estimates trend high or low so you can update pricing or
investigate missed sessions.

## Testing

```bash
npm install
npm test
```

210 tests across 12 test suites covering cost calculations, pricing lookup, transcript parsing, session classification, threshold logic, budget checks, webhook firing, digest generation, report formatting, model-router hints, per-project apply, statusline rendering, cost forecasting, console reconciliation, and per-tool attribution.

## Contributing

Issues and pull requests welcome at [github.com/ChewbaccaRoars/claude-code-cost-tracker](https://github.com/ChewbaccaRoars/claude-code-cost-tracker).

## License

MIT
