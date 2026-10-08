#!/usr/bin/env node
// Per-model weekly limits for the status line. The status line payload does not
// carry them (as of Claude Code 2.1.293 its rate_limits holds only five_hour,
// seven_day and spend_limit), so this reads the usage endpoint that /status
// polls, with the same OAuth token.
//
// readScoped() never waits on the network: it returns the cached rows at once and
// refreshes them in a detached child once the last attempt is older than
// REFRESH_MS. The status line is cancelled when a new update fires, so it must
// stay instant.
//
// The token is read from the credentials file and sent only to api.anthropic.com.
// It is never written to the cache or anywhere else.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

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

function writeCache(patch) {
  const next = { ...(readJson(CACHE_FILE) || {}), ...patch };
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
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
  if (Date.now() - mtime(LOCK_FILE) < LOCK_MS) return false;
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // Another reader removed it first; the retry below settles who gets it.
  }
  return take();
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // Already gone.
  }
}

function scheduleRefresh() {
  if (!acquireLock()) return;
  // Recorded before the child runs, so a child that crashes or hangs still holds
  // the next attempt back for REFRESH_MS.
  try {
    writeCache({ attempted_at: Date.now() });
  } catch {
    // The lock still limits attempts to one per LOCK_MS.
  }
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

/**
 * Cached weekly_scoped rows as [{ label, percent, resets_at }], or null when
 * nothing usable is cached. Schedules a background refresh when due.
 */
function readScoped(now = Date.now()) {
  const cache = readJson(CACHE_FILE) || {};
  const sinceAttempt = typeof cache.attempted_at === 'number' ? now - cache.attempted_at : Infinity;
  const sinceFetch = typeof cache.fetched_at === 'number' ? now - cache.fetched_at : Infinity;
  if (sinceAttempt > REFRESH_MS) scheduleRefresh();
  if (sinceFetch > MAX_AGE_MS || !Array.isArray(cache.rows)) return null;
  // A window that has reset no longer applies, whatever the last fetch said.
  return cache.rows.filter(
    (r) => r && typeof r.label === 'string' && typeof r.percent === 'number' && !(Date.parse(r.resets_at) <= now)
  );
}

/**
 * Weekly rows scoped to a model, as [{ label, percent, resets_at }], from the
 * endpoint's limits array. Null when the reply carried no limits array.
 */
function scopedRows(limits) {
  if (!Array.isArray(limits)) return null;
  return limits
    .filter((r) => r?.kind === 'weekly_scoped' && r.scope?.model?.display_name && typeof r.percent === 'number')
    .map((r) => ({ label: r.scope.model.display_name, percent: r.percent, resets_at: r.resets_at ?? null }));
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
 * Resolves to the scoped rows from the usage endpoint, or null when the call
 * fails. Never rejects. `request` stands in for https.request in tests; the
 * host is fixed here so no caller can send the token elsewhere.
 */
function fetchRows(token, { request = https.request, retryDelayMs = RETRY_DELAY_MS, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      // Only a connection failure earns the retry; a 4xx or 5xx is the server's answer.
      const retry = () => (n < 1 ? setTimeout(() => attempt(n + 1), retryDelayMs) : resolve(null));
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
              if (res.statusCode !== 200) return resolve(null);
              try {
                resolve(scopedRows(JSON.parse(body).limits));
              } catch {
                resolve(null);
              }
            });
            // A connection cut mid-body never emits 'end'.
            res.on('close', () => {
              if (!ended) resolve(null);
            });
          }
        );
      } catch {
        return resolve(null);
      }
      req.on('error', retry);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    };
    attempt(0);
  });
}

async function refresh() {
  const token = usableToken(readJson(CREDENTIALS));
  const rows = token ? await fetchRows(token) : null;
  if (rows) {
    try {
      writeCache({ fetched_at: Date.now(), rows });
    } catch {
      // Keep the previous rows.
    }
  }
  releaseLock();
  process.exit(0);
}

if (require.main === module && process.argv.includes('--refresh')) {
  // The request timeout only measures idle time, so a server that trickles
  // bytes would keep the child alive without this.
  setTimeout(() => {
    releaseLock();
    process.exit(0);
  }, DEADLINE_MS);
  refresh();
}

module.exports = { readScoped, scopedRows, usableToken, fetchRows, CACHE_FILE };
