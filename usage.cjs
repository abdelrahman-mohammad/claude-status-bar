#!/usr/bin/env node
// Prints the plan usage as JSON, for Claude and for scripts:
//
//   node usage.cjs [--max-age <seconds>]
//
// Data younger than --max-age (180 by default, the status line's own refresh
// interval) is answered from the cache. Older data is refreshed first, at most
// once a minute. When that is not possible, the cached data is printed with
// `stale: true` and the reason in `error`.
//
// Exits 0 with data and 1 without. The token is never part of the output.

const { readCache, refreshNow, since, isCurrent, REFRESH_MS } = require('./usage-cache.cjs');

const MINUTE = 60_000;
// Length of the window behind each group of limits the server names. A group that
// is not here gets no pace.
const WINDOW_MS = { session: 5 * 60 * MINUTE, weekly: 7 * 24 * 60 * MINUTE };
// Too early in a window, one short burst projects to nonsense.
const MIN_ELAPSED = 0.05;

const round = (value, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits;
const iso = (ms) => new Date(ms).toISOString();

/**
 * How far through its window a limit is, and where it ends up at the rate so far.
 * `measuredAt` is when the percentage was read, not when it is printed.
 */
function pace(limit, measuredAt) {
  const none = { elapsed_percent: null, projected_percent: null, runs_out_at: null };
  const length = Object.hasOwn(WINDOW_MS, limit.group) ? WINDOW_MS[limit.group] : 0;
  const reset = Date.parse(limit.resets_at);
  if (!length || Number.isNaN(reset)) return none;
  const start = reset - length;
  const elapsed = (measuredAt - start) / length;
  if (elapsed < 0 || elapsed > 1) return none;
  const elapsed_percent = round(elapsed * 100, 1);
  if (elapsed < MIN_ELAPSED) return { ...none, elapsed_percent };
  const projected = limit.percent / elapsed;
  const runsOut = limit.percent < 100 && projected > 100;
  return {
    elapsed_percent,
    projected_percent: round(projected),
    runs_out_at: runsOut ? iso(start + ((measuredAt - start) * 100) / limit.percent) : null,
  };
}

/**
 * The printed report. Data is stale when it was older than `maxAgeMs` at
 * `startedAt`; `reason` is why no refresh ran, if one was due.
 */
function buildReport(cache, { now = Date.now(), startedAt = now, maxAgeMs = REFRESH_MS, reason = null } = {}) {
  const { usage, fetched_at: fetchedAt } = cache;
  const error = cache.error || reason;
  const limits = usage?.limits.filter((limit) => isCurrent(limit, now));
  // Limits that have all reset say nothing any more; an account with none is an answer.
  if (!usage || fetchedAt === undefined || (usage.limits.length && !limits.length)) {
    return { ok: false, error: error || 'no_data' };
  }
  const age = since(fetchedAt, now);
  const stale = age > maxAgeMs + (now - startedAt);
  return {
    ok: true,
    stale,
    error: stale ? error || 'refresh_failed' : null,
    fetched_at: iso(fetchedAt),
    // Unknown when the clock was set back after the data was read.
    age_seconds: Number.isFinite(age) ? round(age / 1000) : null,
    limits: limits.map((limit) => {
      const reset = Date.parse(limit.resets_at);
      return {
        kind: limit.kind,
        scope: limit.model || limit.surface || null,
        percent_used: limit.percent,
        percent_left: Math.max(0, round(100 - limit.percent, 1)),
        severity: limit.severity,
        headline: limit.headline,
        resets_at: Number.isNaN(reset) ? null : iso(reset),
        resets_in_minutes: Number.isNaN(reset) ? null : round((reset - now) / MINUTE),
        ...pace(limit, fetchedAt),
        weekly_share: limit.weekly_share,
      };
    }),
    // Shares of the week, which end with it.
    products: limits.some((limit) => limit.group === 'weekly') ? usage.products : [],
    extra_usage: usage.extra_usage,
  };
}

/** Milliseconds from `--max-age <seconds>`, the default without arguments, or null for anything else. */
function parseMaxAge(argv) {
  if (!argv.length) return REFRESH_MS;
  const [flag, seconds, ...rest] = argv;
  return flag === '--max-age' && /^\d{1,9}(\.\d+)?$/.test(seconds) && !rest.length ? Number(seconds) * 1000 : null;
}

function main(argv) {
  const startedAt = Date.now();
  const maxAgeMs = parseMaxAge(argv);
  if (maxAgeMs === null) return { ok: false, error: 'bad_arguments' };
  if (process.env.CLAUDE_STATUS_BAR_USAGE === 'off') return { ok: false, error: 'disabled' };
  const { usage, fetched_at: fetchedAt } = readCache();
  // An older version caches a recent fetched_at with no usage, so age alone is not enough.
  const due = !usage || since(fetchedAt, startedAt) > maxAgeMs;
  const reason = due ? refreshNow() : null;
  return buildReport(readCache(), { startedAt, maxAgeMs, reason });
}

if (require.main === module) {
  const report = main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.ok ? 0 : 1;
}

module.exports = { buildReport, parseMaxAge, pace };
