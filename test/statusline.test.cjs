const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, run, plain } = require('./helpers.cjs');

const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

let sandbox;
before(() => {
  sandbox = createSandbox();
});
after(() => sandbox.cleanup());

const BASE = {
  model: { display_name: 'Opus' },
  workspace: { project_dir: '/home/me/projects/my-app' },
  effort: { level: 'xhigh' },
  context_window: { used_percentage: 34, context_window_size: 200000 },
};

function line(overrides = {}, env) {
  return run('statusline.cjs', { ...BASE, ...overrides }, { sandbox, env });
}

function context(pct, size = 200000) {
  return { context_window: { used_percentage: pct, context_window_size: size } };
}

test('shows project, model, effort and context', () => {
  assert.equal(plain(line()), 'my-app  Opus xhigh  34%\n');
});

test('takes the last segment of a Windows path', () => {
  const out = line({ workspace: { project_dir: 'C:\\Users\\me\\projects\\my-app\\' } });
  assert.match(plain(out), /^my-app {2}/);
});

test('falls back to current_dir, then cwd, then ~', () => {
  assert.match(plain(line({ workspace: { current_dir: '/srv/api-server' } })), /^api-server /);
  assert.match(plain(line({ workspace: undefined, cwd: '/srv/worker' })), /^worker /);
  assert.match(plain(line({ workspace: undefined })), /^~ /);
});

test('cuts a long project name at 20 characters', () => {
  const out = line({ workspace: { project_dir: '/src/a-very-long-repository-name' } });
  assert.match(plain(out), /^a-very-long-reposit… /);
});

test('adds the worktree name inside a linked worktree', () => {
  const out = line({ workspace: { project_dir: '/src/my-app', git_worktree: 'fix-auth' } });
  assert.match(plain(out), /^my-app:fix-auth /);
});

test('leaves out effort when the model has none', () => {
  assert.equal(plain(line({ effort: undefined })), 'my-app  Opus  34%\n');
});

test('leaves out the model when it is missing', () => {
  assert.equal(plain(line({ model: undefined, effort: undefined })), 'my-app  34%\n');
});

test('shows --% before the first response and after /compact', () => {
  assert.match(plain(line({ context_window: { used_percentage: null } })), / --%$/m);
  assert.match(plain(line({ context_window: undefined })), / --%$/m);
});

test('colors context green, then yellow from 70, then red from 90', () => {
  const at = (pct) => line(context(pct));
  assert.ok(at(69).includes(GREEN + '69%'));
  assert.ok(at(70).includes(YELLOW + '70%'));
  assert.ok(at(89).includes(YELLOW + '89%'));
  assert.ok(at(90).includes(RED + '90%'));
});

test('moves the red point to CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', () => {
  const env = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' };
  const at = (pct) => line(context(pct), env);
  assert.ok(at(59).includes(GREEN + '59%'));
  assert.ok(at(60).includes(YELLOW + '60%'));
  assert.ok(at(80).includes(RED + '80%'));
});

test('keeps a yellow band below a low override', () => {
  const env = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' };
  const at = (pct) => line(context(pct), env);
  assert.ok(at(29).includes(GREEN + '29%'));
  assert.ok(at(30).includes(YELLOW + '30%'));
  assert.ok(at(50).includes(RED + '50%'));
});

test('scales the red point to CLAUDE_CODE_AUTO_COMPACT_WINDOW', () => {
  // 80% of a 200K window on a 1M model is 16% of the full window.
  const env = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' };
  const at = (pct) => line(context(pct, 1000000), env);
  assert.ok(at(7).includes(GREEN + '7%'));
  assert.ok(at(8).includes(YELLOW + '8%'));
  assert.ok(at(16).includes(RED + '16%'));
});

test('does not scale when the window is as large as the model', () => {
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' };
  assert.ok(line(context(89), env).includes(YELLOW + '89%'));
});

test('shows the 5-hour window, and the 7-day window only from 50%', () => {
  const limits = (week) => ({ rate_limits: { five_hour: { used_percentage: 22 }, seven_day: { used_percentage: week } } });
  assert.equal(plain(line(limits(49))), 'my-app  Opus xhigh  34%  5h 22%\n');
  assert.equal(plain(line(limits(50))), 'my-app  Opus xhigh  34%  5h 22% · 7d 50%\n');
});

test('colors limits dim, then yellow from 75, then red from 90', () => {
  const at = (pct) => line({ rate_limits: { five_hour: { used_percentage: pct } } });
  assert.ok(at(74).includes(DIM + '74%'));
  assert.ok(at(75).includes(YELLOW + '75%'));
  assert.ok(at(90).includes(RED + '90%'));
});

test('prints nothing for malformed or empty input', () => {
  assert.equal(run('statusline.cjs', 'not json', { sandbox }), '');
  assert.equal(run('statusline.cjs', '', { sandbox }), '');
});
