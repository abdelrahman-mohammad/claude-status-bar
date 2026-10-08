const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { scopedRows, usableToken, fetchRows } = require('../usage-cache.cjs');
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

// Shape of the endpoint's limits array, with values made up.
const LIMITS = [
  { kind: 'session', group: 'session', percent: 98, resets_at: '2099-01-01T15:00:00.000000+00:00', scope: null },
  { kind: 'weekly_all', group: 'weekly', percent: 22, resets_at: '2099-01-07T10:00:00.000000+00:00', scope: null },
  { kind: 'weekly_scoped', group: 'weekly', percent: 37, resets_at: '2099-01-07T10:00:00.000000+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
  { kind: 'weekly_scoped', group: 'weekly', percent: 5, resets_at: null, scope: { model: null, surface: { display_name: 'Cowork' } } },
  { kind: 'weekly_scoped', group: 'weekly', percent: null, resets_at: null, scope: { model: { display_name: 'Opus' } } },
];
const FABLE = { label: 'Fable', percent: 37, resets_at: '2099-01-07T10:00:00.000000+00:00' };

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

function fresh(rows) {
  return { fetched_at: Date.now(), rows };
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

test('scopedRows keeps only weekly rows scoped to a model', () => {
  assert.deepEqual(scopedRows(LIMITS), [FABLE]);
});

test('scopedRows returns null when the reply has no limits array', () => {
  assert.equal(scopedRows(undefined), null);
  assert.equal(scopedRows({}), null);
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

test('fetchRows sends the token to the usage endpoint and returns its rows', async () => {
  const stub = await stubEndpoint((req, res) => res.end(JSON.stringify({ limits: LIMITS })));
  try {
    assert.deepEqual(await fetchRows('sk-test-token', { request: stub.request }), [FABLE]);
    assert.equal(stub.requested[0].host, 'api.anthropic.com');
    assert.deepEqual(stub.seen, [{ path: '/api/oauth/usage', authorization: 'Bearer sk-test-token' }]);
  } finally {
    await stub.close();
  }
});

test('fetchRows gives up on an error status without retrying', async () => {
  const stub = await stubEndpoint((req, res) => {
    res.statusCode = 429;
    res.end('{}');
  });
  try {
    assert.equal(await fetchRows('sk-test-token', { request: stub.request, retryDelayMs: 10 }), null);
    assert.equal(stub.seen.length, 1);
  } finally {
    await stub.close();
  }
});

test('fetchRows returns null for a body that is not JSON', async () => {
  const stub = await stubEndpoint((req, res) => res.end('<html>'));
  try {
    assert.equal(await fetchRows('sk-test-token', { request: stub.request }), null);
  } finally {
    await stub.close();
  }
});

test('fetchRows retries a dropped connection once', async () => {
  let calls = 0;
  const stub = await stubEndpoint((req, res) => {
    calls += 1;
    if (calls === 1) return req.socket.destroy();
    res.end(JSON.stringify({ limits: LIMITS }));
  });
  try {
    assert.deepEqual(await fetchRows('sk-test-token', { request: stub.request, retryDelayMs: 10 }), [FABLE]);
    assert.equal(calls, 2);
  } finally {
    await stub.close();
  }
});

test('fetchRows gives up after a second timeout', async () => {
  const stub = await stubEndpoint(() => {});
  try {
    assert.equal(await fetchRows('sk-test-token', { request: stub.request, retryDelayMs: 10, timeoutMs: 200 }), null);
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
  writeCache(sandbox, { fetched_at: Date.now() - 2 * HOUR, rows: [FABLE] });
  assert.equal(plain(run('statusline.cjs', BASE, { sandbox })), 'my-app  Opus xhigh  34%  5h 22%\n');
}));

test('hides a row whose window has already reset', withSandbox((sandbox) => {
  writeCache(sandbox, fresh([{ ...FABLE, resets_at: '2000-01-07T10:00:00.000000+00:00' }]));
  assert.equal(plain(run('statusline.cjs', BASE, { sandbox })), 'my-app  Opus xhigh  34%  5h 22%\n');
}));

test('ignores malformed cached rows instead of blanking the line', withSandbox((sandbox) => {
  writeCache(sandbox, fresh([null, { label: 7 }, FABLE]));
  assert.equal(plain(run('statusline.cjs', BASE, { sandbox })), 'my-app  Opus xhigh  34%  5h 22% · Fable 37%\n');
}));

test('hides the segment when the account has no Fable row', withSandbox((sandbox) => {
  writeCache(sandbox, fresh([{ label: 'Opus', percent: 50, resets_at: null }]));
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
  assert.equal(cache.rows, undefined);
}));

test('a refresh is not repeated within three minutes of an attempt', withSandbox((sandbox) => {
  writeCache(sandbox, {});
  run('statusline.cjs', BASE, { sandbox });
  assert.equal(fs.existsSync(cacheFile(sandbox) + '.lock'), false);
}));
