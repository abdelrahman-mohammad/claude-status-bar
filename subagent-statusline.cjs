#!/usr/bin/env node
// Agent panel rows: name, label, model, effort, context pressure.
// One JSON line per row on stdout: {"id": "<task id>", "content": "<row body>"}.

const { contextThresholds } = require('./thresholds.cjs');

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

const GAP = '  ';
const DEFAULT_COLUMNS = 80;
// Right-hand cells give way before the title is cut below this.
const MIN_TITLE = 12;

/** "claude-sonnet-5" -> "Sonnet". Empty when the model is not resolved yet or is not a known family. */
function shortModel(id) {
  const found = /(opus|sonnet|haiku|fable)/i.exec(String(id || ''));
  return found ? found[1][0].toUpperCase() + found[1].slice(1).toLowerCase() : '';
}

function shortTokens(n) {
  if (n < 1000) return String(n);
  const k = n / 1000;
  // Below 9.95 one decimal survives rounding; above it, toFixed(1) would print "10.0k".
  return (k < 9.95 ? k.toFixed(1) : String(Math.round(k))) + 'k';
}

/** Effort is either a level name or a raw token budget. */
function effortLabel(effort) {
  if (typeof effort === 'number') return shortTokens(effort);
  return typeof effort === 'string' ? effort : '';
}

/** Percentage when the window size is known, otherwise the raw token count. */
function contextCell(task) {
  const tokens = task.tokenCount;
  if (typeof tokens !== 'number') return null;
  const size = task.contextWindowSize;
  if (typeof size !== 'number' || size <= 0) {
    const plain = shortTokens(tokens);
    return { plain, colored: `${DIM}${plain}${RESET}` };
  }
  const pct = Math.round((tokens / size) * 100);
  const { warn, red } = contextThresholds(size);
  const color = pct >= red ? RED : pct >= warn ? YELLOW : GREEN;
  const plain = `${pct}%`;
  return { plain, colored: `${color}${plain}${RESET}` };
}

function buildRow(task, columns) {
  // Model and effort come first so they are the first cell to give way; the
  // context percentage is the last one dropped.
  const cells = [];
  const model = shortModel(task.model);
  const effort = effortLabel(task.effort);
  if (model || effort) {
    cells.push({
      plain: [model, effort].filter(Boolean).join(' '),
      colored: model ? model + (effort ? ` ${DIM}${effort}${RESET}` : '') : `${DIM}${effort}${RESET}`,
    });
  }
  const context = contextCell(task);
  if (context) cells.push(context);

  // `label` is a progress summary, and the same text as `description` until
  // Claude Code has one, so it is the detail and never the title.
  const title = String(task.name || task.agentType || '').trim();
  const detail = String(task.label || task.description || '').trim();
  const first = title || detail;
  const second = title && detail !== title ? detail : '';

  // Width is a hard budget: an overlong row wraps and breaks the panel layout.
  const rightWidth = () => cells.map((c) => c.plain).join(GAP).length;
  const needed = Math.min(MIN_TITLE, first.length);
  while (cells.length && rightWidth() + GAP.length + needed > columns) cells.shift();
  let budget = columns - (cells.length ? rightWidth() + GAP.length : 0);
  const shownFirst = first.slice(0, Math.max(budget, 0));
  budget -= shownFirst.length + GAP.length;
  const shownSecond = budget > 3 ? second.slice(0, budget) : '';

  const left = shownFirst
    ? `${BOLD}${shownFirst}${RESET}` + (shownSecond ? `${GAP}${DIM}${shownSecond}${RESET}` : '')
    : '';

  return [left, cells.map((c) => c.colored).join(GAP)].filter(Boolean).join(GAP);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const columns = typeof data.columns === 'number' && data.columns > 0 ? data.columns : DEFAULT_COLUMNS;
    for (const task of data.tasks || []) {
      const content = buildRow(task, columns);
      // An empty content string hides the row, so leave those to the default rendering.
      if (task.id && content) {
        process.stdout.write(JSON.stringify({ id: task.id, content }) + '\n');
      }
    }
  } catch {
    // No output leaves every row at its default rendering.
  }
});
