# Contributing

Bug reports and pull requests are welcome. For anything larger than a small fix, open an issue first so the approach is agreed before you write it.

## Ground rules

- No dependencies. Everything runs on the Node.js standard library.
- Nothing on the render path waits on the network or on a subprocess. Claude Code cancels the status line command when the next update arrives, so a slow script shows stale output. The one exception to starting a process at all is the detached refresh in `usage-cache.cjs`, at most once every three minutes.
- A segment with no data drops out. The one placeholder is `--%` for context before the first response.
- Every change to the output comes with a test in `test/`. Tests run the scripts with JSON on stdin, as Claude Code does.
- Never log, print or store the OAuth token. See [SECURITY.md](SECURITY.md).

## Workflow

1. Run `npm test` before you push. CI runs it on Linux, macOS and Windows.
2. Give the pull request a [Conventional Commits](https://www.conventionalcommits.org/) title, such as `feat(statusline): show the session name`. Pull requests are squash-merged under that title.
3. Link the issue in the description with `Closes #123`.

## Labels

| Label | Meaning |
| --- | --- |
| `area: statusline` | `statusline.cjs` and `thresholds.cjs` |
| `area: agent-rows` | `subagent-statusline.cjs` |
| `area: usage` | `usage-cache.cjs` and the per-model weekly limits |
| `area: ci` | GitHub Actions and the test harness |
| `area: repo` | Templates, community files and repository settings |
| `type: bug`, `type: feature`, `type: chore`, `type: docs` | What kind of change |
| `platform: windows`, `platform: macos`, `platform: linux` | Only reproduces on one operating system |
| `status: blocked` | Waiting on a change in Claude Code |
| `good first issue`, `help wanted` | Open for outside contributions |
