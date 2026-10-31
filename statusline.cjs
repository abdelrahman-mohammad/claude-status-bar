#!/usr/bin/env node
// Status line: project, model, effort, context, rate limits. Nothing on the
// render path waits on the network or on a subprocess - the status line is
// cancelled if it is still running when the next update fires.

const fs = require('fs');
const path = require('path');
const { contextThresholds } = require('./thresholds.cjs');

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

// Notifications and the verbose token counter share this row and truncate it
// from the right, so a long project name would push out the numbers.
const MAX_PROJECT = 20;

const RATE_WARN_PCT = 75;
const RATE_HIGH_PCT = 90;

// The weekly window is slack for most of the week and only becomes the binding
// limit late in it, so it stays hidden until it is worth reading.
const WEEK_SHOW_PCT = 50;

// The Fable weekly limit is not in the payload; see usage-cache.cjs. A missing
// module must cost the segment, not the line. The variable is the opt-out that
// survives a git pull, which would restore a deleted module.
let usage = null;
if (process.env.CLAUDE_STATUS_BAR_USAGE !== 'off') {
  try {
    usage = require('./usage-cache.cjs');
  } catch {
    // Segment stays hidden.
  }
}

/** Last path segment of a Windows or POSIX path, without a trailing separator. */
function basename(p) {
  return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

/**
 * Folder name of the main checkout when `dir` is the root of a linked worktree,
 * or null. A linked worktree's .git is a file such as
 * `gitdir: /src/my-app/.git/worktrees/fix-auth`; the path may be relative, and
 * for a bare repository it ends in `my-app.git/worktrees/fix-auth`.
 */
function mainCheckoutName(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, '.git'), 'utf8');
  } catch {
    // Absent, or a directory: not a linked worktree root.
    return null;
  }
  const found = /^gitdir:\s*(.+?)[\\/]+worktrees[\\/]+[^\\/]+[\\/]*\s*$/m.exec(text);
  if (!found) return null;
  const common = basename(path.resolve(dir, found[1]));
  if (common === '.git') return basename(path.dirname(path.resolve(dir, found[1])));
  return common.replace(/\.git$/, '') || null;
}

/** True when two names differ only in case and in `-`, `_`, `.` or spaces. */
function sameName(a, b) {
  const squash = (s) => String(s).toLowerCase().replace(/[-_.\s]/g, '');
  return squash(a) === squash(b);
}

/**
 * Project label: `folder`, `folder:worktree`, `folder (repo)` or
 * `folder (repo:worktree)`. The repo name from `origin` shows only when it
 * differs from the folder, and a name equal to the one before it is never
 * repeated. Claude Code reports a worktree's own folder as project_dir, whose
 * name is the worktree name, so inside a linked worktree the main checkout
 * supplies the folder and the label matches the main checkout's.
 */
function projectLabel(workspace, cwd) {
  const dir = workspace?.project_dir || workspace?.current_dir || cwd;
  const folder = (workspace?.git_worktree && dir && mainCheckoutName(dir)) || basename(dir) || '~';
  const repo = workspace?.repo?.name && !sameName(workspace.repo.name, folder) ? workspace.repo.name : '';
  const worktree = workspace?.git_worktree && !sameName(workspace.git_worktree, folder) ? workspace.git_worktree : '';

  const head = `${BOLD}${CYAN}${clamp(folder, MAX_PROJECT)}${RESET}`;
  const tree = worktree ? `:${clamp(worktree, MAX_PROJECT)}` : '';
  if (repo) return `${head} ${DIM}(${clamp(repo, MAX_PROJECT)}${tree})${RESET}`;
  return tree ? `${head}${DIM}${tree}${RESET}` : head;
}

function clamp(text, max) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** Context percentage, colored by how close it is to auto-compaction. */
function contextSegment(pct, contextWindowSize) {
  if (pct === null) {
    return `${DIM}--%${RESET}`;
  }
  const { warn, red } = contextThresholds(contextWindowSize);
  const color = pct >= red ? RED : pct >= warn ? YELLOW : GREEN;
  return `${color}${Math.round(pct)}%${RESET}`;
}

function limitPct(pct) {
  const color = pct >= RATE_HIGH_PCT ? RED : pct >= RATE_WARN_PCT ? YELLOW : DIM;
  return `${color}${Math.round(pct)}%${RESET}`;
}

/** Fable weekly percentage from the cached usage endpoint rows, or null when unknown. */
function fablePct() {
  const row = (usage?.readScoped() || []).find((r) => /fable/i.test(r.label));
  return row ? row.percent : null;
}

/** Subscription usage. Absent on API billing and before the first API response. */
function rateSegment(limits) {
  if (!limits) return null;
  const parts = [];
  const fiveHour = limits.five_hour?.used_percentage;
  const week = limits.seven_day?.used_percentage;
  const fable = fablePct();
  if (typeof fiveHour === 'number') parts.push(`${DIM}5h${RESET} ${limitPct(fiveHour)}`);
  if (typeof week === 'number' && week >= WEEK_SHOW_PCT) parts.push(`${DIM}7d${RESET} ${limitPct(week)}`);
  if (fable !== null) parts.push(`${DIM}Fable${RESET} ${limitPct(fable)}`);
  return parts.length ? parts.join(` ${DIM}·${RESET} `) : null;
}

function render(data) {
  const segments = [];

  segments.push(projectLabel(data.workspace, data.cwd));

  const model = data.model?.display_name;
  const effort = data.effort?.level;
  if (model) {
    segments.push(model + (effort ? ` ${DIM}${effort}${RESET}` : ''));
  }

  const used = data.context_window?.used_percentage;
  segments.push(contextSegment(typeof used === 'number' ? used : null, data.context_window?.context_window_size));

  const rate = rateSegment(data.rate_limits);
  if (rate) segments.push(rate);

  return segments.join('  ');
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    process.stdout.write(render(JSON.parse(input)) + '\n');
  } catch {
    // A blank status line beats a broken one, and nothing printed here would be actionable.
  }
});
