const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { buildReport, parseMaxAge, pace } = require('../usage.cjs');
const { ROOT, createSandbox, scriptEnv } = require('./helpers.cjs');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SCRIPT = path.join(ROOT, 'usage.cjs');
const CACHE = 'claude-status-bar-usage.json';

const at = (ms) => new Date(ms).toISOString();

/** A weekly limit that resets three and a half days from `now`, so half its window has passed. */
function weekly(now, overrides = {}) {
  return {
    kind: 'weekly_all',
    group: 'weekly',
    model: null,
    surface: null,
    percent: 40,
    severity: 'normal',
    resets_at: at(now + 3.5 * DAY),
    headline: true,
    weekly_share: null,
    ...overrides,
  };
}

function usageOf(...limits) {
  return {
    limits,
    products: [{ name: 'Claude Code', percent_of_weekly_limit: 38 }],
    extra_usage: { enabled: false, percent: null },
  };
}

function withSandbox(fn) {
  return async () => {
    const sandbox = createSandbox();
    try {
      await fn(sandbox);
    } finally {
      sandbox.cleanup();
    }
  };
}

const cacheFile = (sandbox) => path.join(sandbox.config, CACHE);
const lockFile = (sandbox) => cacheFile(sandbox) + '.lock';

function writeCache(sandbox, cache) {
  fs.writeFileSync(cacheFile(sandbox), JSON.stringify(cache));
}

/** The command's exit code and parsed report. */
function command(sandbox, args = [], env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { env: scriptEnv({ sandbox, env }), encoding: 'utf8' });
  assert.equal(result.stderr, '');
  return { status: result.status, report: JSON.parse(result.stdout), stdout: result.stdout };
}

test('prints a fresh cache without a refresh', withSandbox((sandbox) => {
  const now = Date.now();
  const cache = { attempted_at: now - MINUTE, fetched_at: now - MINUTE, usage: usageOf(weekly(now)), error: null };
  writeCache(sandbox, cache);
  const { status, report } = command(sandbox);
  assert.equal(status, 0);
  assert.equal(report.ok, true);
  assert.equal(report.stale, false);
  assert.equal(report.error, null);
  assert.ok(report.age_seconds >= 60 && report.age_seconds < 90, String(report.age_seconds));
  assert.equal(report.limits[0].kind, 'weekly_all');
  assert.deepEqual(report.products, cache.usage.products);
  assert.deepEqual(report.extra_usage, cache.usage.extra_usage);
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile(sandbox), 'utf8')), cache);
}));

test('reports one limit in full', () => {
  const now = Date.UTC(2099, 0, 4, 0, 0);
  const share = { used_percent: 20, allowance_percent: 50 };
  const fable = weekly(now, { kind: 'weekly_scoped', model: 'Fable', headline: false, weekly_share: share });
  const { limits } = buildReport({ fetched_at: now, usage: usageOf(fable) }, { now });
  assert.deepEqual(limits, [
    {
      kind: 'weekly_scoped',
      scope: 'Fable',
      percent_used: 40,
      percent_left: 60,
      severity: 'normal',
      headline: false,
      resets_at: at(now + 3.5 * DAY),
      resets_in_minutes: 3.5 * 24 * 60,
      elapsed_percent: 50,
      projected_percent: 80,
      runs_out_at: null,
      weekly_share: share,
    },
  ]);
});

test('names a surface as the scope, and nothing for an unscoped limit', () => {
  const now = Date.now();
  const { limits } = buildReport({ fetched_at: now, usage: usageOf(weekly(now, { surface: 'Cowork' }), weekly(now)) }, { now });
  assert.deepEqual(limits.map((l) => l.scope), ['Cowork', null]);
});

test('keeps a limit without a reset time, with no pace', () => {
  const now = Date.now();
  const [limit] = buildReport({ fetched_at: now, usage: usageOf(weekly(now, { resets_at: null })) }, { now }).limits;
  assert.equal(limit.percent_used, 40);
  assert.equal(limit.resets_at, null);
  assert.equal(limit.resets_in_minutes, null);
  assert.equal(limit.projected_percent, null);
});

test('drops a limit whose window has reset', () => {
  const now = Date.now();
  const gone = weekly(now, { resets_at: at(now - MINUTE) });
  assert.deepEqual(buildReport({ fetched_at: now, usage: usageOf(gone) }, { now }).limits, []);
});

test('never reports less than nothing left', () => {
  const now = Date.now();
  const [limit] = buildReport({ fetched_at: now, usage: usageOf(weekly(now, { percent: 104 })) }, { now }).limits;
  assert.equal(limit.percent_left, 0);
  assert.equal(limit.runs_out_at, null);
});

test('pace projects when a limit runs out', () => {
  const now = Date.UTC(2099, 0, 4);
  // Half the window used 80%, so the rest of the limit lasts a quarter of that half.
  assert.deepEqual(pace(weekly(now, { percent: 80 }), now), {
    elapsed_percent: 50,
    projected_percent: 160,
    runs_out_at: at(now + (3.5 * DAY) / 4),
  });
});

test('pace uses five hours for a session limit', () => {
  const now = Date.UTC(2099, 0, 4);
  const session = { group: 'session', percent: 10, resets_at: at(now + 4 * HOUR) };
  assert.deepEqual(pace(session, now), { elapsed_percent: 20, projected_percent: 50, runs_out_at: null });
});

test('pace is measured when the percentage was read', () => {
  const now = Date.UTC(2099, 0, 4);
  const limit = weekly(now, { percent: 25 });
  assert.equal(pace(limit, now).projected_percent, 50);
  const { limits } = buildReport({ fetched_at: now, usage: usageOf(limit) }, { now: now + DAY });
  assert.equal(limits[0].projected_percent, 50);
});

test('pace projects nothing early in a window, in an unknown group or outside the window', () => {
  const now = Date.UTC(2099, 0, 4);
  const none = { elapsed_percent: null, projected_percent: null, runs_out_at: null };
  assert.deepEqual(pace(weekly(now, { resets_at: at(now + 7 * DAY - 2 * HOUR) }), now), { ...none, elapsed_percent: 1.2 });
  assert.deepEqual(pace(weekly(now, { group: 'monthly' }), now), none);
  assert.deepEqual(pace(weekly(now, { resets_at: at(now + 8 * DAY) }), now), none);
});

test('parseMaxAge reads seconds and rejects anything else', () => {
  assert.equal(parseMaxAge([]), 180_000);
  assert.equal(parseMaxAge(['--max-age', '60']), 60_000);
  assert.equal(parseMaxAge(['--max-age', '0']), 0);
  for (const bad of [['--max-age'], ['--max-age', ''], ['--max-age', ' '], ['--max-age', '-1'], ['--max-age', 'soon']]) {
    assert.equal(parseMaxAge(bad), null, JSON.stringify(bad));
  }
});

test('refuses a bad --max-age without touching the cache', withSandbox((sandbox) => {
  const { status, report } = command(sandbox, ['--max-age', 'soon']);
  assert.equal(status, 1);
  assert.deepEqual(report, { ok: false, error: 'bad_max_age' });
  assert.deepEqual(fs.readdirSync(sandbox.config), []);
}));

test('CLAUDE_STATUS_BAR_USAGE=off reads nothing', withSandbox((sandbox) => {
  const now = Date.now();
  writeCache(sandbox, { fetched_at: now, usage: usageOf(weekly(now)) });
  const { status, report } = command(sandbox, [], { CLAUDE_STATUS_BAR_USAGE: 'off' });
  assert.equal(status, 1);
  assert.deepEqual(report, { ok: false, error: 'disabled' });
}));

test('without a cache or credentials it reports no token', withSandbox((sandbox) => {
  const { status, report } = command(sandbox);
  assert.equal(status, 1);
  assert.deepEqual(report, { ok: false, error: 'no_token' });
  assert.equal(fs.existsSync(lockFile(sandbox)), false);
}));

test('an expired token is never sent, stored or printed', withSandbox((sandbox) => {
  const token = 'test-token-not-real';
  fs.writeFileSync(
    path.join(sandbox.config, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() - 1000 } })
  );
  const { report, stdout } = command(sandbox);
  assert.equal(report.error, 'no_token');
  assert.ok(!stdout.includes(token));
  assert.ok(!fs.readFileSync(cacheFile(sandbox), 'utf8').includes(token));
}));

test('falls back to older data when a refresh fails, and says why', withSandbox((sandbox) => {
  const now = Date.now();
  writeCache(sandbox, { attempted_at: now - 10 * MINUTE, fetched_at: now - 10 * MINUTE, usage: usageOf(weekly(now)), error: null });
  const { status, report } = command(sandbox);
  assert.equal(status, 0);
  assert.equal(report.ok, true);
  assert.equal(report.stale, true);
  assert.equal(report.error, 'no_token');
  assert.equal(report.limits[0].percent_used, 40);
  assert.equal(fs.existsSync(lockFile(sandbox)), false);
}));

test('refreshes at most once a minute, whatever --max-age asks', withSandbox((sandbox) => {
  const now = Date.now();
  const cache = { attempted_at: now - 30_000, fetched_at: now - 10 * MINUTE, usage: usageOf(weekly(now)), error: 'http_429' };
  writeCache(sandbox, cache);
  const { report } = command(sandbox, ['--max-age', '0']);
  assert.equal(report.stale, true);
  assert.equal(report.error, 'http_429');
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile(sandbox), 'utf8')), cache);
}));

test('refreshes a recent cache that holds no usage, as an older version writes it', withSandbox((sandbox) => {
  const now = Date.now();
  writeCache(sandbox, { attempted_at: now - 2 * MINUTE, fetched_at: now - 2 * MINUTE, rows: [{ label: 'Fable', percent: 3 }] });
  assert.equal(command(sandbox).report.error, 'no_token');
}));

test('--max-age decides whether a refresh is due', withSandbox((sandbox) => {
  const now = Date.now();
  const cache = { attempted_at: now - 2 * MINUTE, fetched_at: now - 2 * MINUTE, usage: usageOf(weekly(now)), error: null };
  writeCache(sandbox, cache);
  assert.equal(command(sandbox).report.stale, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile(sandbox), 'utf8')), cache);
  assert.equal(command(sandbox, ['--max-age', '60']).report.error, 'no_token');
}));

test('joins a refresh that is already running', withSandbox(async (sandbox) => {
  const now = Date.now();
  writeCache(sandbox, { attempted_at: now, fetched_at: now - 10 * MINUTE, usage: usageOf(weekly(now)) });
  fs.writeFileSync(lockFile(sandbox), 'another process');
  const child = spawn(process.execPath, [SCRIPT], { env: scriptEnv({ sandbox }) });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  const closed = new Promise((resolve) => child.on('close', resolve));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(stdout, '');
  writeCache(sandbox, { attempted_at: now, fetched_at: Date.now(), usage: usageOf(weekly(now, { percent: 55 })), error: null });
  fs.unlinkSync(lockFile(sandbox));
  assert.equal(await closed, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.stale, false);
  assert.equal(report.limits[0].percent_used, 55);
}));

test('survives a malformed cache', withSandbox((sandbox) => {
  for (const raw of ['not json', 'null', '[]', '{"fetched_at":"today","usage":{"limits":[]}}', '{"fetched_at":1,"usage":7}']) {
    fs.writeFileSync(cacheFile(sandbox), raw);
    const { status, report } = command(sandbox);
    assert.equal(status, 1, raw);
    // A refresh was tried, and only the missing credentials stopped it.
    assert.deepEqual(report, { ok: false, error: 'no_token' }, raw);
  }
  const now = Date.now();
  writeCache(sandbox, { attempted_at: now, fetched_at: now, usage: { limits: [null, 'x', weekly(now)] } });
  assert.equal(command(sandbox).report.limits.length, 1);
}));
