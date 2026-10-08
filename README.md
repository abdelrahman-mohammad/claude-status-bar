# claude-status-bar

A minimal status line for [Claude Code](https://code.claude.com/docs/en/statusline): project, model, effort, context and plan limits, including the Fable weekly limit that the status line payload does not carry.

```
my-app  Opus xhigh  34%  5h 22% · Fable 37%
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
| Fable weekly limit | `Fable 37%` | Usage endpoint, see [below](#the-fable-weekly-limit) | Hidden when unknown. |

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

## Agent panel rows

`subagent-statusline.cjs` replaces the default row for each subagent in the agent panel with the same vocabulary:

```
reviewer  Review the diff  Sonnet high  21%
```

```json
{
  "subagentStatusLine": {
    "type": "command",
    "command": "node \"${USERPROFILE:-$HOME}/.claude/claude-status-bar/subagent-statusline.cjs\""
  }
}
```

- The title is the name the subagent is addressed by, or its agent type, such as `Explore`, when it has no name.
- Next comes Claude Code's progress summary for the task, which is the task description until there is one.
- Until an agent's context window size is known, the row shows its raw token count, such as `8.5k`, instead of a percentage. An effort given as a token budget shows as `32k`.
- The row never exceeds the width Claude Code reports. The summary shrinks first, then the model and effort drop out, then the context, and the title is cut last.

## The Fable weekly limit

Fable has its own weekly limit, separate from the all-models `7d` window. `/status` shows it, but the status line payload does not include it (tracked upstream in [anthropics/claude-code#73770](https://github.com/anthropics/claude-code/issues/73770) and [#92080](https://github.com/anthropics/claude-code/issues/92080)). Without it, `7d 40%` can look relaxed while Fable is at 100%.

`usage-cache.cjs` fills the gap by reading the endpoint `/status` uses:

- It reads your Claude Code OAuth token from `.credentials.json` in your Claude config directory (`CLAUDE_CONFIG_DIR`, or `~/.claude`) and sends it only to `api.anthropic.com`. The token is never written anywhere.
- The status line never waits on the network. It reads a small cache file, `claude-status-bar-usage.json`, kept in the same config directory so that no other account or user can see it. When the last attempt is more than three minutes old, it starts a detached refresh in the background, which exits within 13 seconds whatever the network does.
- Failed and successful attempts alike wait three minutes before the next one, because the endpoint rate-limits fast polling.
- Data older than an hour is hidden rather than shown stale, and so is a window whose reset time has passed.
- A refresh that finishes while Claude Code is idle shows at the next update. To pick it up sooner, add `"refreshInterval": 60` to the `statusLine` setting.

Limitations:

- The endpoint is internal and undocumented. If it changes, the Fable segment disappears until this repository is updated. The rest of the line is unaffected. Once Claude Code puts the limit in the payload, this module goes away ([#7](https://github.com/abdelrahman-mohammad/claude-status-bar/issues/7)).
- On macOS, Claude Code keeps its credentials in the Keychain rather than `.credentials.json`, so the Fable segment stays hidden there for now ([#6](https://github.com/abdelrahman-mohammad/claude-status-bar/issues/6)).
- Behind a TLS-inspecting antivirus or corporate proxy, the refresh runs Node with `--use-system-ca` so your operating system's certificate store is trusted. Node versions that do not know the flag run without it.

To turn the endpoint off, set `CLAUDE_STATUS_BAR_USAGE` to `off` in the `env` block of `settings.json`:

```json
{
  "env": {
    "CLAUDE_STATUS_BAR_USAGE": "off"
  }
}
```

The status line keeps working without the Fable segment. Deleting `usage-cache.cjs` has the same effect, but `git pull` can bring it back.

## Colors and thresholds

The context percentage turns red near auto-compaction, and yellow ahead of that: 20 points below red, or at half of red when red is low. The agent rows use the same thresholds, scaled to each agent's own context window.

- Without `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, Claude Code picks the compaction point per model and a status line command cannot see it, so red starts at 90% as an early warning.
- With `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, red starts at that percentage of the auto-compact window.
- `used_percentage` always measures against the model's full context window. When `CLAUDE_CODE_AUTO_COMPACT_WINDOW` makes the auto-compact window smaller, the red point is scaled down to match: 80% of a 200K window on a 1M model turns red at 16%.
- The `autoCompactWindow` setting and the `/autocompact` command are not visible to a status line command. If you use them, set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` instead, which Claude Code also gives precedence.

The context thresholds live in `thresholds.cjs`. The limit thresholds are constants at the top of `statusline.cjs`.

## Development

```sh
npm test
```

The tests use the built-in `node:test` runner and need no install. They run each script the way Claude Code does, with JSON on stdin, in a temp and config directory of their own, so they never read your credentials, your cache or your auto-compact settings. Network tests run against a local server.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE)

This project is not affiliated with or endorsed by Anthropic.
