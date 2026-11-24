---
name: plan-usage
description: Reports how much of the Claude plan is used, as JSON - each limit with its percentage, reset time, pace and projected run-out time. Use when asked about usage, limits, quota or resets, and before work that uses a lot of them, such as a large fan-out or a long background run.
---

Run:

```
node "$HOME/.claude/claude-status-bar/usage.cjs"
```

- The data is up to three minutes old. Add `--max-age 60` when it must be current.
- `limits` holds only the limits that apply to this account. `scope` is the model or surface that a limit covers, and `null` covers everything. `headline` marks the limit that matters most now.
- `runs_out_at` is a straight-line projection of the window so far. Call it a projection. When it is `null`, the limit lasts until the reset only if `projected_percent` is a number; with `percent_left` 0 it is used up, and with `projected_percent` `null` nothing is known.
- `weekly_share` is how much of the whole weekly limit a scoped limit has used and may use.
- With `stale: true` the data is old for the reason in `error`. Give the age with the numbers.
- Give times in the user's time zone.

For what is using the limit (skills, subagents, plugins, MCP servers), or when `ok` is `false`, run the built-in report in Bash. It costs no tokens and can take two minutes, so allow three:

```
MSYS_NO_PATHCONV=1 claude -p "/usage" --safe-mode --no-session-persistence < /dev/null
```
