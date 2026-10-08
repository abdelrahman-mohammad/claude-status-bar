# claude-status-bar

A minimal status line for [Claude Code](https://code.claude.com/docs/en/statusline): project, model, effort, context and plan limits.

```
my-app  Opus xhigh  34%  5h 22%
```

Plain Node.js with no dependencies. Nothing on the render path waits on the network or on a subprocess.

## What it shows

| Segment | Example | Source | Notes |
| --- | --- | --- | --- |
| Project | `my-app` | `workspace.project_dir` | Last folder name, cut at 20 characters. Inside a linked git worktree it adds `:worktree-name`. |
| Model and effort | `Opus xhigh` | `model.display_name`, `effort.level` | Effort is left out when the model does not support it. |
| Context | `34%` | `context_window.used_percentage` | Green, yellow, then red near auto-compaction; see [Colors and thresholds](#colors-and-thresholds). |
| 5-hour limit | `5h 22%` | `rate_limits.five_hour` | Dim, yellow from 75%, red from 90%. |
| 7-day limit | `7d 54%` | `rate_limits.seven_day` | Hidden below 50%, because it only becomes the binding limit late in the week. |

The limits appear only for Claude.ai subscribers, after the first response of a session. A segment with no data drops out. The one placeholder is `--%` for context, before the first response and right after `/compact`.

## Install

Clone the repository into your Claude config directory:

```sh
git clone https://github.com/abdelrahman-mohammad/claude-status-bar.git ~/.claude/claude-status-bar
```

Add this to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"${USERPROFILE:-$HOME}/.claude/claude-status-bar/statusline.cjs\""
  }
}
```

Claude Code reloads the setting and runs the command as soon as you save the file. To update, run `git pull` in the clone.

Requires Node.js 22 or later on your `PATH`.

### Windows

When Git Bash is installed, Claude Code runs status line commands through it. Use forward slashes in the command, because Git Bash reads backslashes as escape characters.

The command uses `${USERPROFILE:-$HOME}` rather than `~` or `$HOME`. Depending on how the shell is started, those can reach `node.exe` as `/c/Users/you`, which it cannot resolve. `${USERPROFILE:-$HOME}` is a Windows path on Windows and falls back to `$HOME` on macOS and Linux, so one command works on all three.

Without Git Bash, Claude Code runs the command through PowerShell, where `${USERPROFILE:-$HOME}` expands to nothing. Write `$env:USERPROFILE` in its place. That setup is untested here; please open an issue if it does not work for you.

## Colors and thresholds

The context percentage turns red near auto-compaction, and yellow ahead of that: 20 points below red, or at half of red when red is low.

- Without `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, Claude Code picks the compaction point per model and a status line command cannot see it, so red starts at 90% as an early warning.
- With `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, red starts at that percentage of the auto-compact window.
- `used_percentage` always measures against the model's full context window. When `CLAUDE_CODE_AUTO_COMPACT_WINDOW` makes the auto-compact window smaller, the red point is scaled down to match: 80% of a 200K window on a 1M model turns red at 16%.
- The `autoCompactWindow` setting and the `/autocompact` command are not visible to a status line command. If you use them, set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` instead, which Claude Code also gives precedence.

The context thresholds live in `thresholds.cjs`. The limit thresholds are constants at the top of `statusline.cjs`.

## Development

```sh
npm test
```

The tests use the built-in `node:test` runner and need no install. They run each script the way Claude Code does, with JSON on stdin, in a temp and config directory of their own, so they never read your auto-compact settings.

## License

[MIT](LICENSE)

This project is not affiliated with or endorsed by Anthropic.
