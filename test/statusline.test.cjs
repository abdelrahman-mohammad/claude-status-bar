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
function linkedWorktree(root, gitdir, name = 'fix-auth') {
  const tree = path.join(root, '.claude', 'worktrees', name);
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

test('names a bare repository in a hidden directory after its parent', () => {
  const root = path.join(sandbox.tmp, 'hidden-app');
  const tree = linkedWorktree(root, path.join(root, '.bare', 'worktrees', 'fix-auth'));
  assert.match(plain(line({ workspace: { project_dir: tree, git_worktree: 'fix-auth' } })), /^hidden-app:fix-auth /);
});

test('keeps a worktree named like its main checkout', () => {
  const main = path.join(sandbox.tmp, 'api');
  const tree = linkedWorktree(main, path.join(main, '.git', 'worktrees', 'api'), 'api');
  assert.match(plain(line({ workspace: { project_dir: tree, git_worktree: 'api' } })), /^api:api /);
});

test('reads nothing from a .git directory', () => {
  const dir = path.join(sandbox.tmp, 'dir-app');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  assert.match(plain(line({ workspace: { project_dir: dir, git_worktree: 'fix-auth' } })), /^dir-app:fix-auth /);
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
  const label = (folder, repo) => plain(line({ workspace: { project_dir: `/src/${folder}`, repo: { name: repo } } }));
  assert.match(label('MyApp', 'my-app'), /^MyApp {2}Opus /);
  assert.match(label('My App', 'my-app'), /^My App {2}Opus /);
  assert.match(label('my_app', 'my.app'), /^my_app {2}Opus /);
});

test('cuts the repo and worktree names at 20 characters', () => {
  const out = line({
    workspace: { project_dir: '/src/my-app', git_worktree: 'a-very-long-worktree-name', repo: { name: 'a-very-long-repository-name' } },
  });
  assert.match(plain(out), /^my-app \(a-very-long-reposit…:a-very-long-worktre…\) {2}Opus /);
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

/** A main checkout whose .git/HEAD holds `head`. */
function checkout(name, head) {
  const root = path.join(sandbox.tmp, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), `${head}\n`);
  return root;
}

/** A linked worktree of a new main checkout, with the worktree's HEAD set to `head`. */
function worktreeOn(name, head, worktree = 'fix-auth') {
  const main = path.join(sandbox.tmp, name);
  const gitdir = path.join(main, '.git', 'worktrees', worktree);
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, 'HEAD'), `${head}\n`);
  return linkedWorktree(main, gitdir, worktree);
}

const MAGENTA = '\x1b[35m';
const SHA = '0123456789abcdef0123456789abcdef01234567';

test('shows the branch after the project, in its own color', () => {
  const out = line({ workspace: { project_dir: checkout('branch-app', 'ref: refs/heads/main') } });
  assert.equal(plain(out), 'branch-app  main  Opus xhigh  34%\n');
  assert.ok(out.includes(MAGENTA + 'main'));
});

test('shows a branch name with slashes', () => {
  const out = line({ workspace: { project_dir: checkout('slash-app', 'ref: refs/heads/feat/login') } });
  assert.match(plain(out), /^slash-app {2}feat\/login {2}Opus /);
});

test('finds the repository from a subfolder', () => {
  const web = path.join(checkout('nested-app', 'ref: refs/heads/main'), 'web');
  fs.mkdirSync(web, { recursive: true });
  assert.match(plain(line({ workspace: { project_dir: web } })), /^web {2}main {2}Opus /);
});

test('stops at the nearest .git, as git does', () => {
  const inner = path.join(checkout('outer-app', 'ref: refs/heads/main'), 'inner');
  fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
  assert.match(plain(line({ workspace: { project_dir: inner } })), /^inner {2}Opus /);
});

test('reads the branch of a linked worktree', () => {
  const tree = worktreeOn('wt-app', 'ref: refs/heads/login-form');
  assert.match(plain(line({ workspace: { project_dir: tree, git_worktree: 'fix-auth' } })), /^wt-app:fix-auth {2}login-form {2}Opus /);
});

test('follows a relative gitdir to the worktree HEAD', () => {
  const main = path.join(sandbox.tmp, 'rel-wt-app');
  const gitdir = path.join(main, '.git', 'worktrees', 'fix-auth');
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/login-form\n');
  const tree = linkedWorktree(main, '../../../.git/worktrees/fix-auth');
  assert.match(plain(line({ workspace: { project_dir: tree, git_worktree: 'fix-auth' } })), /^rel-wt-app:fix-auth {2}login-form {2}Opus /);
});

test('hides a branch that repeats the worktree name', () => {
  const claude = worktreeOn('hide-app', 'ref: refs/heads/worktree-fix-auth');
  assert.match(plain(line({ workspace: { project_dir: claude, git_worktree: 'fix-auth' } })), /^hide-app:fix-auth {2}Opus /);
  const plainName = worktreeOn('hide-app-2', 'ref: refs/heads/fix-auth');
  assert.match(plain(line({ workspace: { project_dir: plainName, git_worktree: 'fix-auth' } })), /^hide-app-2:fix-auth {2}Opus /);
});

test('shows a detached HEAD as the short commit in yellow', () => {
  const out = line({ workspace: { project_dir: checkout('detached-app', SHA) } });
  assert.match(plain(out), /^detached-app {2}0123456 {2}Opus /);
  assert.ok(out.includes(YELLOW + '0123456'));
});

test('cuts a long branch name at 20 characters', () => {
  const out = line({ workspace: { project_dir: checkout('long-branch-app', 'ref: refs/heads/feat/a-very-long-branch-name') } });
  assert.match(plain(out), /^long-branch-app {2}feat\/a-very-long-br… {2}Opus /);
});

test('reads the branch from the current directory', () => {
  const project = checkout('project-app', 'ref: refs/heads/main');
  const current = checkout('current-app', 'ref: refs/heads/feat/login');
  assert.match(plain(line({ workspace: { project_dir: project, current_dir: current } })), /^project-app {2}feat\/login {2}Opus /);
});

test('shows no branch outside a repository or when HEAD is unreadable', () => {
  assert.equal(plain(line()), 'my-app  Opus xhigh  34%\n');
  const broken = path.join(sandbox.tmp, 'no-head-app');
  fs.mkdirSync(path.join(broken, '.git'), { recursive: true });
  assert.equal(plain(line({ workspace: { project_dir: broken } })), 'no-head-app  Opus xhigh  34%\n');
});

test('survives a directory that is not a string', () => {
  assert.equal(plain(line({ workspace: { project_dir: 42, current_dir: { x: 1 } } })), '42  Opus xhigh  34%\n');
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
