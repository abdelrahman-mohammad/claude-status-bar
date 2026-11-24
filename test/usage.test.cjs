const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { parseUsage, usableToken, fetchUsage, outcome } = require('../usage-cache.cjs');
const { createSandbox, run, plain } = require('./helpers.cjs');

const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CACHE = 'claude-status-bar-usage.json';
const HOUR = 60 * 60_000;

const BASE = {
  model: { display_name: 'Opus' },
  workspace: { project_dir: '/home/me/projects/my-app' },
  effort: { level: 'xhigh' },
  context_window: { used_percentage: 34, context_window_size: 200000 },
  rate_limits: { five_hour: { used_percentage: 22 }, seven_day: { used_percentage: 18 } },
};

// Shape of the endpoint's reply, with values made up.
const LIMITS = [
  { kind: 'session', group: 'session', percent: 98, resets_at: '2099-01-01T15:00:00.000000+00:00', scope: null },
  { kind: 'weekly_all', group: 'weekly', percent: 22, resets_at: '2099-01-07T10:00:00.000000+00:00', scope: null },
  { kind: 'weekly_scoped', group: 'weekly', percent: 37, resets_at: '2099-01-07T10:00:00.000000+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
  { kind: 'weekly_scoped', group: 'weekly', percent: 5, resets_at: null, scope: { model: null, surface: { display_name: 'Cowork' } } },
  { kind: 'weekly_scoped', group: 'weekly', percent: null, resets_at: null, scope: { model: { display_name: 'Opus' } } },
];
const REPLY = {
  limits: LIMITS,
  weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 18, allowance_percent_of_weekly: 50 }],
  seven_day_breakdown: {
    rows: [
      { key: 'claude_code', display_name: 'Claude Code', percent: 90, percent_of_limit: 20 },
      { key: 'broken', display_name: 'Broken' },
    ],
  },
  extra_usage: { is_enabled: true, utilization: 12 },
};
// One limit as it is cached.
const FABLE = {
  kind: 'weekly_scoped',
  group: 'weekly',
  model: 'Fable',
  surface: null,
  percent: 37,
  severity: null,
  resets_at: '2099-01-07T10:00:00.000000+00:00',
  headline: false,
  weekly_share: { used_percent: 18, allowance_percent: 50 },
};

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

function cacheFile(sandbox) {
  return path.join(sandbox.config, CACHE);
}

function writeCache(sandbox, cache) {
  fs.writeFileSync(cacheFile(sandbox), JSON.stringify({ attempted_at: Date.now(), ...cache }));
}

function fresh(limits) {
  return { fetched_at: Date.now(), usage: { limits } };
}

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('timed out waiting for the background refresh');
}

/** A local server standing in for the endpoint, and a request function that reaches it. */
async function stubEndpoint(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // A request that never settles then fails its test instead of hanging the run.
  server.unref();
  const { port } = server.address();
  const requested = [];
  const request = (options, callback) => {
    requested.push(options);
    return http.request({ ...options, host: '127.0.0.1', port }, callback);
  };
  const close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return { request, requested, seen, close };
}

test('parseUsage keeps every limit with a percentage, in the server order', () => {
  const { limits } = parseUsage(REPLY);
  assert.deepEqual(
    limits.map((l) => [l.kind, l.model, l.surface, l.percent]),
    [
      ['session', null, null, 98],
      ['weekly_all', null, null, 22],
      ['weekly_scoped', 'Fable', null, 37],
      ['weekly_scoped', null, 'Cowork', 5],
    ]
  );
  assert.deepEqual(limits[2], FABLE);
});

test('parseUsage keeps a limit it does not know', () => {
  const reply = { limits: [{ kind: 'monthly_new', group: 'monthly', percent: 4, severity: 'normal', is_active: true }] };
  const [limit] = parseUsage(reply).limits;
  assert.equal(limit.kind, 'monthly_new');
  assert.equal(limit.severity, 'normal');
  assert.equal(limit.headline, true);
});

test('parseUsage matches a share by the position in the server list, skipped rows included', () => {
  const reply = {
    limits: [{ kind: 'session', percent: null }, LIMITS[2]],
    weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 7, allowance_percent_of_weekly: 50 }],
  };
  const { limits } = parseUsage(reply);
  assert.equal(limits.length, 1);
  assert.deepEqual(limits[0].weekly_share, { used_percent: 7, allowance_percent: 50 });
});

test('parseUsage keeps the products and extra usage', () => {
  const usage = parseUsage(REPLY);
  assert.deepEqual(usage.products, [{ name: 'Claude Code', percent_of_weekly_limit: 20 }]);
  assert.deepEqual(usage.extra_usage, { enabled: true, percent: 12 });
  assert.deepEqual(parseUsage({ limits: [] }), { limits: [], products: [], extra_usage: { enabled: false, percent: null } });
});

test('parseUsage returns null when the reply has no limits array', () => {
  for (const reply of [undefined, null, {}, { limits: {} }, 'text']) assert.equal(parseUsage(reply), null);
});

test('a successful refresh clears the last error, and a failure keeps the previous usage', () => {
  const usage = parseUsage(REPLY);
  assert.deepEqual(outcome({ usage }, 5), { fetched_at: 5, usage, error: null });
  assert.deepEqual(outcome({ error: 'http_429' }, 5), { error: 'http_429' });
});

test('usableToken accepts a live token and rejects missing, malformed and expired ones', () => {
  const now = 1_000_000;
  const creds = (accessToken, expiresAt = now + 1) => ({ claudeAiOauth: { accessToken, expiresAt } });
  assert.equal(usableToken(creds('sk-test-token'), now), 'sk-test-token');
  assert.equal(usableToken({ claudeAiOauth: { accessToken: 'sk-test-token' } }, now), 'sk-test-token');
  assert.equal(usableToken(creds('sk-test-token', now), now), null);
  assert.equal(usableToken(creds('bad token'), now), null);
  assert.equal(usableToken(creds('bad\ntoken'), now), null);
  assert.equal(usableToken(creds({ token: 'x' }), now), null);
  assert.equal(usableToken(null, now), null);
});

test('fetchUsage sends the token to the usage endpoint and returns the parsed reply', async () => {
  const stub = await stubEndpoint((req, res) => res.end(JSON.stringify(REPLY)));
  try {
    assert.deepEqual(await fetchUsage('sk-test-token', { request: stub.request }), { usage: parseUsage(REPLY) });
    assert.equal(stub.requested[0].host, 'api.anthropic.com');
    assert.deepEqual(stub.seen, [{ path: '/api/oauth/usage', authorization: 'Bearer sk-test-token' }]);
  } finally {
    await stub.close();
  }
});

test('fetchUsage reports an error status without retrying', async () => {
  const stub = await stubEndpoint((req, res) => {
    res.statusCode = 429;
    res.end('{}');
  });
  try {
    assert.deepEqual(await fetchUsage('sk-test-token', { request: stub.request, retryDelayMs: 10 }), { error: 'http_429' });
    assert.equal(stub.seen.length, 1);
  } finally {
    await stub.close();
  }
});

test('fetchUsage reports a body that is not a usage reply', async () => {
  for (const body of ['<html>', '{}', 'null']) {
    const stub = await stubEndpoint((req, res) => res.end(body));
    try {
      assert.deepEqual(await fetchUsage('sk-test-token', { request: stub.request }), { error: 'bad_reply' });
    } finally {
      await stub.close();
    }
  }
});

test('fetchUsage reports a reply that is cut short', async () => {
  const stub = await stubEndpoint((req, res) => {
    res.writeHead(200, { 'Content-Length': 1000 });
    res.write('{"limits":');
    setTimeout(() => req.socket.destroy(), 50);
  });
  try {
    assert.deepEqual(await fetchUsage('sk-test-token', { request: stub.request, retryDelayMs: 10 }), { error: 'network' });
  } finally {
    await stub.close();
  }
});

test('fetchUsage retries a dropped connection once', async () => {
  let calls = 0;
  const stub = await stubEndpoint((req, res) => {
    calls += 1;
    if (calls === 1) return req.socket.destroy();
    res.end(JSON.stringify(REPLY));
  });
  try {
    assert.deepEqual(await fetchUsage('sk-test-token', { request: stub.request, retryDelayMs: 10 }), { usage: parseUsage(REPLY) });
    assert.equal(calls, 2);
  } finally {
    await stub.close();
  }
});

test('fetchUsage gives up after a second timeout', async () => {
  const stub = await stubEndpoint(() => {});
  try {
    assert.deepEqual(await fetchUsage('sk-test-token', { request: stub.request, retryDelayMs: 10, timeoutMs: 200 }), { error: 'network' });
    assert.equal(stub.seen.length, 2);
  } finally {
    await stub.close();
  }
});

test('shows the Fable weekly limit from a fresh cache', withSandbox((sandbox) => {
  writeCache(sandbox, fresh([FABLE]));
  assert.equal(plain(run('statusline.cjs', BASE, { sandbox })), 'my-app  Opus xhigh  34%  5h 22% · Fable 37%\n');
}));

test('colors the Fable limit like the other limits', withSandbox((sandbox) => {
  writeCache(sandbox, fresh([{ ...FABLE, percent: 84 }]));
  assert.ok(run('statusline.cjs', BASE, { sandbox }).includes(YELLOW + '84%'));
  writeCache(sandbox, fresh([{ ...FABLE, percent: 100 }]));
  assert.ok(run('statusline.cjs', BASE, { sandbox }).includes(RED + '100%'));
}));

test('hides rows older than an hour', withSandbox((sandbox) => {
  writeCache(sandbox, { fetched_at: Date.now() - 2 * HOUR, usage: { limits: [FABLE] } });
  assert.equal(plain(run('statusline.cjs', BASE, { sandbox })), 'my-app  Opus xhigh  34%  5h 22%\n');
}));

test('hides a row whose window has already reset', withSandbox((sandbox) => {
  writeCache(sandbox, fresh([{ ...FABLE, resets_at: '2000-01-07T10:00:00.000000+00:00' }]));
  assert.equal(plain(run('statusline.cjs', BASE, { sandbox })), 'my-app  Opus xhigh  34%  5h 22%\n');
}));

test('ignores malformed cached rows instead of blanking the line', withSandbox((sandbox) => {
  writeCache(sandbox, fresh([null, { kind: 'weekly_scoped', model: 7 }, FABLE]));
  assert.equal(plain(run('statusline.cjs', BASE, { sandbox })), 'my-app  Opus xhigh  34%  5h 22% · Fable 37%\n');
}));

test('hides the segment when the account has no Fable row', withSandbox((sandbox) => {
  writeCache(sandbox, fresh([{ ...FABLE, model: 'Opus' }, { ...FABLE, kind: 'weekly_all' }]));
  assert.equal(plain(run('statusline.cjs', BASE, { sandbox })), 'my-app  Opus xhigh  34%  5h 22%\n');
}));

test('shows no limits at all without rate_limits', withSandbox((sandbox) => {
  writeCache(sandbox, fresh([FABLE]));
  const { rate_limits, ...input } = BASE;
  assert.equal(plain(run('statusline.cjs', input, { sandbox })), 'my-app  Opus xhigh  34%\n');
}));

test('CLAUDE_STATUS_BAR_USAGE=off skips the cache and never schedules a refresh', withSandbox((sandbox) => {
  fs.writeFileSync(cacheFile(sandbox), JSON.stringify(fresh([FABLE])));
  const out = run('statusline.cjs', BASE, { sandbox, env: { CLAUDE_STATUS_BAR_USAGE: 'off' } });
  assert.equal(plain(out), 'my-app  Opus xhigh  34%  5h 22%\n');
  assert.equal(fs.existsSync(cacheFile(sandbox) + '.lock'), false);
  assert.equal(JSON.parse(fs.readFileSync(cacheFile(sandbox), 'utf8')).attempted_at, undefined);
}));

test('a due refresh without credentials records the attempt and releases the lock', withSandbox(async (sandbox) => {
  run('statusline.cjs', BASE, { sandbox });
  await waitFor(() => fs.existsSync(cacheFile(sandbox)) && !fs.existsSync(cacheFile(sandbox) + '.lock'));
  const cache = JSON.parse(fs.readFileSync(cacheFile(sandbox), 'utf8'));
  assert.equal(typeof cache.attempted_at, 'number');
  assert.equal(cache.usage, undefined);
  assert.equal(cache.error, 'no_token');
}));

test('a refresh drops fields an older version cached', withSandbox(async (sandbox) => {
  fs.writeFileSync(cacheFile(sandbox), JSON.stringify({ rows: [{ label: 'Fable', percent: 37 }], attempted_at: 0 }));
  run('statusline.cjs', BASE, { sandbox });
  await waitFor(() => !fs.existsSync(cacheFile(sandbox) + '.lock'));
  assert.equal(JSON.parse(fs.readFileSync(cacheFile(sandbox), 'utf8')).rows, undefined);
}));

test('a refresh is not repeated within three minutes of an attempt', withSandbox((sandbox) => {
  writeCache(sandbox, {});
  run('statusline.cjs', BASE, { sandbox });
  assert.equal(fs.existsSync(cacheFile(sandbox) + '.lock'), false);
}));
