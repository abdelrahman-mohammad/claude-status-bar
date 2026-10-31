const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

// A fresh attempt keeps the usage cache from starting a background refresh,
// which is covered in usage.test.cjs.
beforeEach(() => {
  fs.writeFileSync(path.join(sandbox.config, 'claude-status-bar-usage.json'), JSON.stringify({ attempted_at: Date.now() }));
});

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

/** A worktree root whose .git file points at `gitdir`, laid out the way Claude Code creates them. */
function linkedWorktree(root, gitdir) {
  const tree = path.join(root, '.claude', 'worktrees', 'fix-auth');
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${gitdir}\n`);
  return tree;
}

test('names the project after the main checkout inside a linked worktree', () => {
  const main = path.join(sandbox.tmp, 'my-app');
  const tree = linkedWorktree(main, path.join(main, '.git', 'worktrees', 'fix-auth'));
  assert.match(plain(line({ workspace: { project_dir: tree, git_worktree: 'fix-auth' } })), /^my-app:fix-auth /);
});

test('follows a relative gitdir path', () => {
  const main = path.join(sandbox.tmp, 'relative-app');
  const tree = linkedWorktree(main, '../../../.git/worktrees/fix-auth');
  assert.match(plain(line({ workspace: { project_dir: tree, git_worktree: 'fix-auth' } })), /^relative-app:fix-auth /);
});

test('drops .git from the name of a bare repository', () => {
  const tree = linkedWorktree(path.join(sandbox.tmp, 'bare-checkouts'), path.join(sandbox.tmp, 'bare-app.git', 'worktrees', 'fix-auth'));
  assert.match(plain(line({ workspace: { project_dir: tree, git_worktree: 'fix-auth' } })), /^bare-app:fix-auth /);
});

test('shows the worktree name once when the main checkout is unknown', () => {
  const out = plain(line({ workspace: { project_dir: '/src/no-such-dir/fix-auth', git_worktree: 'fix-auth' } }));
  assert.match(out, /^fix-auth {2}Opus /);
});

test('keeps the folder name in a subfolder of a worktree', () => {
  const main = path.join(sandbox.tmp, 'sub-app');
  const web = path.join(linkedWorktree(main, path.join(main, '.git', 'worktrees', 'fix-auth')), 'web');
  fs.mkdirSync(web, { recursive: true });
  assert.match(plain(line({ workspace: { project_dir: web, git_worktree: 'fix-auth' } })), /^web:fix-auth /);
});

test('adds the repo name in parentheses when it differs from the folder', () => {
  const out = line({ workspace: { project_dir: '/src/my-app', repo: { name: 'app-server' } } });
  assert.equal(plain(out), 'my-app (app-server)  Opus xhigh  34%\n');
});

test('leaves out a repo name that matches the folder', () => {
  assert.match(plain(line({ workspace: { project_dir: '/src/my-app', repo: { name: 'my-app' } } })), /^my-app {2}Opus /);
});

test('matches names regardless of case and separators', () => {
  assert.match(plain(line({ workspace: { project_dir: '/src/MyApp', repo: { name: 'my-app' } } })), /^MyApp {2}Opus /);
  assert.match(plain(line({ workspace: { project_dir: '/src/My Vault', repo: { name: 'vault' } } })), /^My Vault \(vault\) {2}Opus /);
});

test('puts the worktree inside the parentheses when the repo name differs', () => {
  const main = path.join(sandbox.tmp, 'repo-app');
  const tree = linkedWorktree(main, path.join(main, '.git', 'worktrees', 'fix-auth'));
  const out = line({ workspace: { project_dir: tree, git_worktree: 'fix-auth', repo: { name: 'app-server' } } });
  assert.match(plain(out), /^repo-app \(app-server:fix-auth\) {2}Opus /);
});

test('keeps folder:worktree when the repo name matches the folder', () => {
  const main = path.join(sandbox.tmp, 'same-app');
  const tree = linkedWorktree(main, path.join(main, '.git', 'worktrees', 'fix-auth'));
  const out = line({ workspace: { project_dir: tree, git_worktree: 'fix-auth', repo: { name: 'same-app' } } });
  assert.match(plain(out), /^same-app:fix-auth {2}Opus /);
});

test('names the repo when Claude Code starts in a subfolder', () => {
  assert.match(plain(line({ workspace: { project_dir: '/src/my-app/web', repo: { name: 'my-app' } } })), /^web \(my-app\) {2}Opus /);
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
