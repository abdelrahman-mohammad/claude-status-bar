# Security policy

`usage-cache.cjs` reads your Claude Code OAuth token to fetch your plan limits. Anything that could expose that token is a security issue: writing it to disk, logging it, printing it, or sending it anywhere other than `api.anthropic.com`.

## Reporting a vulnerability

Report it privately through [GitHub's private vulnerability reporting](https://github.com/abdelrahman-mohammad/claude-status-bar/security/advisories/new), not in a public issue.

## Supported versions

Only the latest commit on `main` is supported.
