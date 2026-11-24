#!/usr/bin/env node
// Plan usage for the status line and for usage.cjs. The status line payload does
// not carry the per-model weekly limits (as of Claude Code 2.1.293 its
// rate_limits holds only five_hour, seven_day and spend_limit), so this reads the
// usage endpoint that /status polls, with the same OAuth token.
//
// readScoped() never waits on the network: it returns the cached rows at once and
// refreshes them in a detached child once the last attempt is older than
// REFRESH_MS. The status line is cancelled when a new update fires, so it must
// stay instant. refreshNow() waits, so it is for the command line only. Both share
// one cache, one lock and one record of the last attempt.
//
// The token is read from the credentials file and sent only to api.anthropic.com.
// It is never written to the cache or anywhere else.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
// macOS keeps the credentials in the Keychain, so this file is absent there and
// the segment stays hidden.
const CREDENTIALS = path.join(CONFIG_DIR, '.credentials.json');
// Kept beside the credentials it was fetched with, not in a shared temp
// directory, so another account or another user never sees these numbers.
const CACHE_FILE = path.join(CONFIG_DIR, 'claude-status-bar-usage.json');
const LOCK_FILE = CACHE_FILE + '.lock';

// Throttle on attempts, not successes: the endpoint answers 429 when polled
// faster than this, and a failing fetch must not turn into a tight loop.
const REFRESH_MS = 3 * 60_000;
// The floor for a refresh somebody asked for, which REFRESH_MS does not hold back.
const MIN_INTERVAL_MS = 60_000;
// A refresh that dies holds the lock this long, then the next read retries.
const LOCK_MS = 15_000;
// The child exits by then whatever the network does, so its lock never goes stale.
const DEADLINE_MS = LOCK_MS - 2_000;
// Beyond this age the number is likelier wrong than useful, so it is hidden.
const MAX_AGE_MS = 60 * 60_000;
const TIMEOUT_MS = 4_000;
const RETRY_DELAY_MS = 1_500;
// A time stamp this far ahead is a small clock adjustment; further ahead, the
// clock was set back and the stamp says nothing about age.
const SKEW_MS = 5_000;
const RENAME_TRIES = 20;
const RENAME_WAIT_MS = 50;
const LEFTOVER_MS = 60_000;

// A TLS-inspecting antivirus or proxy re-signs connections with a root that only
// the operating system's store trusts. Older Node versions reject the flag and
// would exit on it, so it is passed only where Node knows it.
const NODE_ARGS = process.allowedNodeEnvironmentFlags.has('--use-system-ca') ? ['--use-system-ca'] : [];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// Beyond this a Date is invalid.
const isTime = (value) => typeof value === 'number' && Math.abs(value) <= 8.64e15;

/** Milliseconds since `time`, or Infinity when it is not a usable time or lies in the future. */
function since(time, now = Date.now()) {
  if (!isTime(time)) return Infinity;
  const ms = now - time;
  return ms < -SKEW_MS ? Infinity : Math.max(0, ms);
}

const text = (value) => (typeof value === 'string' ? value : null);
const number = (value) => (Number.isFinite(value) ? value : null);
const list = (value) => (Array.isArray(value) ? value : []);

/** Usage with every field of a known type, or undefined without a list of limits. */
function cleanUsage(usage) {
  if (!Array.isArray(usage?.limits)) return undefined;
  return {
    limits: usage.limits
      .filter((r) => typeof r?.kind === 'string' && Number.isFinite(r.percent))
      .map((r) => ({
        kind: r.kind,
        group: text(r.group),
        model: text(r.model),
        surface: text(r.surface),
        percent: r.percent,
        severity: text(r.severity),
        resets_at: Number.isNaN(Date.parse(text(r.resets_at))) ? null : r.resets_at,
        headline: r.headline === true,
        weekly_share: r.weekly_share
          ? { used_percent: number(r.weekly_share.used_percent), allowance_percent: number(r.weekly_share.allowance_percent) }
          : null,
      })),
    products: list(usage.products)
      .filter((p) => typeof p?.name === 'string' && Number.isFinite(p.percent_of_weekly_limit))
      .map((p) => ({ name: p.name, percent_of_weekly_limit: p.percent_of_weekly_limit })),
    extra_usage: { enabled: usage.extra_usage?.enabled === true, percent: number(usage.extra_usage?.percent) },
  };
}

/** The cache as { attempted_at, fetched_at, usage, error }, every field optional and of its type. */
function readCache() {
  const cache = readJson(CACHE_FILE) || {};
  const time = (value) => (isTime(value) ? value : undefined);
  return {
    attempted_at: time(cache.attempted_at),
    fetched_at: time(cache.fetched_at),
    usage: cleanUsage(cache.usage),
    error: text(cache.error),
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Merges `patch` into the cache. Windows refuses the rename while a reader or a
 * virus scanner has either file open, so it is tried again, `waitMs` apart; the
 * render path must not wait and passes nothing. Throws when it never succeeds.
 */
function writeCache(patch, waitMs = 0) {
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...readCache(), ...patch }), { mode: 0o600 });
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fs.renameSync(tmp, CACHE_FILE);
    } catch (err) {
      if (attempt === RENAME_TRIES) {
        removeFile(tmp);
        throw err;
      }
      if (waitMs) sleep(waitMs);
    }
  }
}

function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone, or held open; removeLeftovers() gets it later.
  }
}

/** Removes temporary files that a write left behind, once they are too old to be in use. */
function removeLeftovers() {
  const prefix = path.basename(CACHE_FILE) + '.';
  for (const name of fs.readdirSync(CONFIG_DIR)) {
    if (!name.startsWith(prefix) || !/^\d+\.tmp$/.test(name.slice(prefix.length))) continue;
    const file = path.join(CONFIG_DIR, name);
    if (since(mtime(file)) > LEFTOVER_MS) removeFile(file);
  }
}

function lockHeld() {
  return since(mtime(LOCK_FILE)) < LOCK_MS;
}

/** Takes the refresh lock, replacing one older than LOCK_MS. Returns null, or why not: `held` or `unwritable`. */
function acquireLock() {
  const take = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return null;
    } catch (err) {
      return err.code === 'EEXIST' || fs.existsSync(LOCK_FILE) ? 'held' : 'unwritable';
    }
  };
  const refused = take();
  if (refused !== 'held' || lockHeld()) return refused;
  // When another reader removed it first, the next line settles who gets it.
  removeFile(LOCK_FILE);
  return take();
}

/** Removes the lock when `owner` still holds it. */
function releaseLock(owner) {
  try {
    if (fs.readFileSync(LOCK_FILE, 'utf8') === owner) removeFile(LOCK_FILE);
  } catch {
    // Already gone.
  }
}

/**
 * Takes the lock and records the attempt. Returns null, or why not: `held`,
 * `unwritable`, or `throttled` when the last attempt is younger than the interval.
 */
function beginRefresh(intervalMs) {
  const refused = acquireLock();
  if (refused) return refused;
  // Read again under the lock: another process may have finished a refresh since.
  if (since(readCache().attempted_at) < intervalMs) {
    releaseLock(String(process.pid));
    return 'throttled';
  }
  // Recorded before the child runs, so a child that crashes or hangs still holds
  // the next attempt back. The last error belongs to the last attempt.
  try {
    writeCache({ attempted_at: Date.now(), error: null });
  } catch {
    // The lock still limits attempts to one per LOCK_MS.
  }
  return null;
}

// The child releases the lock in the name of the process that took it.
const childArgs = () => [...NODE_ARGS, __filename, '--refresh', String(process.pid)];

function scheduleRefresh() {
  if (beginRefresh(REFRESH_MS)) return;
  try {
    spawn(process.execPath, childArgs(), { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    releaseLock(String(process.pid));
  }
}

/** Waits while a refresh runs, at most LOCK_MS. False when it still runs then. */
function waitForRefresh() {
  // Not the wall clock, which can be set back while this waits.
  const deadline = performance.now() + LOCK_MS;
  do sleep(100);
  while (lockHeld() && performance.now() < deadline);
  return !lockHeld();
}

/**
 * Refreshes the cache and waits for the result, at most about LOCK_MS. Joins a
 * refresh that is already running instead of starting a second one. Returns null
 * when a refresh ran to its end, whose own error is in the cache, or why none did:
 * `throttled`, `unwritable`, `timeout` or `refresh_failed`.
 */
function refreshNow() {
  const refused = beginRefresh(MIN_INTERVAL_MS);
  if (refused === 'held') return waitForRefresh() ? null : 'timeout';
  if (refused) return refused;
  const child = spawnSync(process.execPath, childArgs(), { stdio: 'ignore', windowsHide: true, timeout: LOCK_MS });
  if (child.status === 0) return null;
  // A child that did not end by itself has not released the lock.
  releaseLock(String(process.pid));
  return child.error?.code === 'ETIMEDOUT' ? 'timeout' : 'refresh_failed';
}

/** True for a limit whose window has not reset yet; its percentage still applies. */
function isCurrent(row, now) {
  return !(Date.parse(row.resets_at) <= now);
}

/**
 * Cached weekly limits scoped to a model, as [{ label, percent }], or null when
 * nothing usable is cached. Schedules a background refresh when due.
 */
function readScoped(now = Date.now()) {
  const cache = readCache();
  if (since(cache.attempted_at, now) > REFRESH_MS) scheduleRefresh();
  if (since(cache.fetched_at, now) > MAX_AGE_MS || !cache.usage) return null;
  return cache.usage.limits
    .filter((r) => r.kind === 'weekly_scoped' && r.model && isCurrent(r, now))
    .map((r) => ({ label: r.model, percent: r.percent }));
}

/**
 * The parts of the endpoint's reply that are kept: every limit the server sent, in
 * its order, with the share of the weekly limit that a scoped one may use, the
 * split of the week by product, and extra usage. Null when the reply carried no
 * limits array.
 */
function parseUsage(reply) {
  if (!Array.isArray(reply?.limits)) return null;
  const shares = list(reply.weekly_scoped_shares);
  return cleanUsage({
    // Shares point at a limit by its position in the server's list.
    limits: reply.limits.map((row, index) => {
      const share = shares.find((s) => s?.limit_index === index);
      return {
        ...row,
        model: row?.scope?.model?.display_name,
        surface: row?.scope?.surface?.display_name,
        headline: row?.is_active,
        weekly_share: share && { used_percent: share.used_percent_of_weekly, allowance_percent: share.allowance_percent_of_weekly },
      };
    }),
    products: list(reply.seven_day_breakdown?.rows).map((r) => ({ name: r?.display_name, percent_of_weekly_limit: r?.percent_of_limit })),
    extra_usage: { enabled: reply.extra_usage?.is_enabled, percent: reply.extra_usage?.utilization },
  });
}

/** The OAuth access token from parsed credentials, or null when it is missing, malformed or expired. */
function usableToken(credentials, now = Date.now()) {
  const oauth = credentials?.claudeAiOauth;
  const token = oauth?.accessToken;
  // A header value with spaces or control characters makes https.request throw.
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) return null;
  // An expired token is Claude Code's to renew; it rewrites the file when it does.
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= now) return null;
  return token;
}

/**
 * Resolves to { usage } from the usage endpoint, or to { error } with the reason:
 * `network`, `http_<status>` or `bad_reply`. Never rejects. `request` stands in
 * for https.request in tests; the host is fixed here so no caller can send the
 * token elsewhere.
 */
function fetchUsage(token, { request = https.request, retryDelayMs = RETRY_DELAY_MS, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      // Only a connection failure earns the retry; a 4xx or 5xx is the server's answer.
      const retry = () => (n < 1 ? setTimeout(() => attempt(n + 1), retryDelayMs) : resolve({ error: 'network' }));
      let req;
      try {
        req = request(
          {
            host: 'api.anthropic.com',
            path: '/api/oauth/usage',
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              'anthropic-beta': 'oauth-2025-04-20',
              Accept: 'application/json',
              'User-Agent': 'claude-status-bar',
            },
            timeout: timeoutMs,
          },
          (res) => {
            let body = '';
            let ended = false;
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => {
              ended = true;
              if (res.statusCode !== 200) return resolve({ error: `http_${res.statusCode}` });
              let usage = null;
              try {
                usage = parseUsage(JSON.parse(body));
              } catch {
                // Not JSON.
              }
              resolve(usage ? { usage } : { error: 'bad_reply' });
            });
            // A connection cut mid-body never emits 'end'.
            res.on('close', () => {
              if (!ended) resolve({ error: 'network' });
            });
          }
        );
      } catch {
        return resolve({ error: 'network' });
      }
      req.on('error', retry);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    };
    attempt(0);
  });
}

/** What a refresh changes in the cache: new usage clears the last error, and a failure keeps the previous usage. */
function outcome({ usage, error }, now = Date.now()) {
  return usage ? { fetched_at: now, usage, error: null } : { error };
}

function finishRefresh(result) {
  let code = 0;
  try {
    writeCache(outcome(result), RENAME_WAIT_MS);
    removeLeftovers();
  } catch {
    // The previous cache stays; the exit code says that this result was lost.
    code = 1;
  }
  releaseLock(process.argv[3]);
  process.exit(code);
}

async function refresh() {
  const token = usableToken(readJson(CREDENTIALS));
  finishRefresh(token ? await fetchUsage(token) : { error: 'no_token' });
}

if (require.main === module && process.argv[2] === '--refresh') {
  // The request timeout only measures idle time, so a server that trickles
  // bytes would keep the child alive without this.
  setTimeout(() => finishRefresh({ error: 'timeout' }), DEADLINE_MS);
  refresh();
}

module.exports = { readScoped, readCache, refreshNow, since, parseUsage, usableToken, fetchUsage, outcome, isCurrent, REFRESH_MS, CACHE_FILE };
