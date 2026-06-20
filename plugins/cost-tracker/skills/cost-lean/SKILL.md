---
name: cost-lean
description: >-
  Use when the user wants to manage context profiles, enable/disable MCPs or
  skills for a session, reduce context bloat, or set up lean mode. Triggers on:
  "lean mode", "disable unused skills", "context profile", "session setup",
  "which MCPs to keep", "slim down context".
argument-hint: "[profiles|save <name>|recommend|restore|status]"
allowed-tools:
  - Bash(node *)
  - Read
  - Write
---

# cost-lean

Manage context profiles for lean sessions.

This skill helps you reduce context bloat by creating and managing profiles that
selectively enable/disable MCP servers and skills based on actual usage patterns.

## Usage

The skill runs: `node "${CLAUDE_PLUGIN_ROOT}/skills/cost-lean/scripts/lean.js" $ARGUMENTS`

## Available Commands

- **(no args)** or **status** - Show current context load breakdown with token
  counts and costs for all skills/MCPs, plus what's currently disabled
- **profiles** - List all saved context profiles
- **save <name>** - Save current active configuration as a named profile
- **recommend** - Analyze usage data and generate recommended profiles based on
  actual usage patterns (lean, recent, project-specific)
- **restore** - Restore full configuration (re-enable all skills/MCPs)

## Workflow

1. Run `recommend` to see what you're actually using
2. Choose a recommended profile or save your own
3. Tell the user to run `npx cost-lean --profile <name>` **before their next session**
   to apply the profile
4. Profiles take effect on NEXT session start, not the current session

## Examples

- "Show me my context load" → runs status
- "What profiles do I have?" → runs profiles
- "Save this as my work setup" → runs save work
- "Find what I actually use" → runs recommend
- "Go back to full config" → runs restore
