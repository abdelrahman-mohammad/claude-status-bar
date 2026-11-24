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

/** The cache as { attempted_at, fetched_at, usage, error }, every field optional. */
function readCache() {
  const cache = readJson(CACHE_FILE);
  return cache && typeof cache === 'object' ? cache : {};
}

function writeCache(patch) {
  // Named fields only, so a field an older version wrote does not live on.
  const { attempted_at, fetched_at, usage, error } = { ...readCache(), ...patch };
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ attempted_at, fetched_at, usage, error }), { mode: 0o600 });
  fs.renameSync(tmp, CACHE_FILE);
}

/** Takes the refresh lock, replacing one older than LOCK_MS. False when another refresh holds it. */
function acquireLock() {
  const take = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };
  if (take()) return true;
  if (lockHeld()) return false;
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // Another reader removed it first; the retry below settles who gets it.
  }
  return take();
}

function lockHeld() {
  return Date.now() - mtime(LOCK_FILE) < LOCK_MS;
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // Already gone.
  }
}

/** Takes the lock and records the attempt. False when another refresh holds the lock. */
function beginRefresh() {
  if (!acquireLock()) return false;
  // Recorded before the child runs, so a child that crashes or hangs still holds
  // the next attempt back.
  try {
    writeCache({ attempted_at: Date.now() });
  } catch {
    // The lock still limits attempts to one per LOCK_MS.
  }
  return true;
}

function scheduleRefresh() {
  if (!beginRefresh()) return;
  try {
    spawn(process.execPath, [...NODE_ARGS, __filename, '--refresh'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch {
    releaseLock();
  }
}

function waitForRefresh() {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + LOCK_MS;
  while (lockHeld() && Date.now() < deadline) Atomics.wait(cell, 0, 0, 100);
}

/**
 * Refreshes the cache and waits for the result, at most LOCK_MS. Does nothing
 * when the last attempt is younger than MIN_INTERVAL_MS, and joins a refresh that
 * is already running instead of starting a second one.
 */
function refreshNow() {
  if (lockHeld()) return waitForRefresh();
  const last = readCache().attempted_at;
  if (typeof last === 'number' && Date.now() - last < MIN_INTERVAL_MS) return;
  if (!beginRefresh()) return waitForRefresh();
  const child = spawnSync(process.execPath, [...NODE_ARGS, __filename, '--refresh'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: LOCK_MS,
  });
  // The child releases the lock itself; one that never started cannot.
  if (child.error) releaseLock();
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
  const sinceAttempt = typeof cache.attempted_at === 'number' ? now - cache.attempted_at : Infinity;
  const sinceFetch = typeof cache.fetched_at === 'number' ? now - cache.fetched_at : Infinity;
  if (sinceAttempt > REFRESH_MS) scheduleRefresh();
  if (sinceFetch > MAX_AGE_MS || !Array.isArray(cache.usage?.limits)) return null;
  return cache.usage.limits
    .filter(
      (r) => r?.kind === 'weekly_scoped' && typeof r.model === 'string' && typeof r.percent === 'number' && isCurrent(r, now)
    )
    .map((r) => ({ label: r.model, percent: r.percent }));
}

const text = (value) => (typeof value === 'string' ? value : null);
const number = (value) => (typeof value === 'number' ? value : null);

/**
 * The parts of the endpoint's reply that are kept: every limit the server sent, in
 * its order, with the share of the weekly limit that a scoped one may use, the
 * split of the week by product, and extra usage. Null when the reply carried no
 * limits array.
 */
function parseUsage(reply) {
  if (!Array.isArray(reply?.limits)) return null;
  const list = (value) => (Array.isArray(value) ? value : []);
  const shares = list(reply.weekly_scoped_shares);
  const limits = [];
  reply.limits.forEach((row, index) => {
    if (typeof row?.kind !== 'string' || typeof row.percent !== 'number') return;
    // Shares point at a row by its position in the server's list.
    const share = shares.find((s) => s?.limit_index === index);
    limits.push({
      kind: row.kind,
      group: text(row.group),
      model: text(row.scope?.model?.display_name),
      surface: text(row.scope?.surface?.display_name),
      percent: row.percent,
      severity: text(row.severity),
      resets_at: text(row.resets_at),
      headline: row.is_active === true,
      weekly_share: share
        ? { used_percent: number(share.used_percent_of_weekly), allowance_percent: number(share.allowance_percent_of_weekly) }
        : null,
    });
  });
  return {
    limits,
    products: list(reply.seven_day_breakdown?.rows)
      .filter((r) => typeof r?.display_name === 'string' && typeof r.percent_of_limit === 'number')
      .map((r) => ({ name: r.display_name, percent_of_weekly_limit: r.percent_of_limit })),
    extra_usage: { enabled: reply.extra_usage?.is_enabled === true, percent: number(reply.extra_usage?.utilization) },
  };
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
  try {
    writeCache(outcome(result));
  } catch {
    // Keep the previous cache.
  }
  releaseLock();
  process.exit(0);
}

async function refresh() {
  const token = usableToken(readJson(CREDENTIALS));
  finishRefresh(token ? await fetchUsage(token) : { error: 'no_token' });
}

if (require.main === module && process.argv.includes('--refresh')) {
  // The request timeout only measures idle time, so a server that trickles
  // bytes would keep the child alive without this.
  setTimeout(() => finishRefresh({ error: 'network' }), DEADLINE_MS);
  refresh();
}

module.exports = { readScoped, readCache, refreshNow, parseUsage, usableToken, fetchUsage, outcome, isCurrent, REFRESH_MS, CACHE_FILE };
