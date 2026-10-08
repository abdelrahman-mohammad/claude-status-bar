const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run, plain } = require('./helpers.cjs');

const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

function rows(input, env) {
  return run('subagent-statusline.cjs', input, { env })
    .split('\n')
    .filter(Boolean)
    .map((json) => JSON.parse(json));
}

function row(task, columns = 76, env) {
  const out = rows({ columns, tasks: [{ id: 'a', type: 'local_agent', ...task }] }, env);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a');
  return out[0].content;
}

// Shaped like the docs: `label` repeats `description` until Claude Code has a
// progress summary.
const REVIEWER = {
  name: 'reviewer',
  agentType: 'code-reviewer',
  description: 'Review the diff',
  label: 'Review the diff',
  model: 'claude-sonnet-5',
  effort: 'high',
  contextWindowSize: 200000,
  tokenCount: 42000,
};

test('shows name, label, model, effort and context', () => {
  assert.equal(plain(row(REVIEWER)), 'reviewer  Review the diff  Sonnet high  21%');
});

test('falls back to the agent type when the agent has no name', () => {
  const { name, ...unnamed } = REVIEWER;
  assert.equal(plain(row({ ...unnamed, agentType: 'Explore' })), 'Explore  Review the diff  Sonnet high  21%');
});

test('shows the progress summary once Claude Code has one', () => {
  assert.equal(plain(row({ ...REVIEWER, label: 'Reading src/app.ts' })), 'reviewer  Reading src/app.ts  Sonnet high  21%');
});

test('falls back to the description without a label', () => {
  const { label, ...noLabel } = REVIEWER;
  assert.equal(plain(row(noLabel)), 'reviewer  Review the diff  Sonnet high  21%');
});

test('renders a token budget effort and colors high context red', () => {
  const content = row({ ...REVIEWER, model: 'claude-opus-5', effort: 32000, tokenCount: 186000 });
  assert.equal(plain(content), 'reviewer  Review the diff  Opus 32k  93%');
  assert.ok(content.includes(RED + '93%'));
});

test('scales the context colors to the auto-compact window', () => {
  // 80% of a 200K window on a 1M model is 16% of the full window.
  const env = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' };
  const at = (tokens) => row({ ...REVIEWER, contextWindowSize: 1000000, tokenCount: tokens }, 76, env);
  assert.ok(at(100000).includes(YELLOW + '10%'));
  assert.ok(at(160000).includes(RED + '16%'));
});

test('shows the raw token count while the window size is unknown', () => {
  const { contextWindowSize, ...unsized } = REVIEWER;
  assert.equal(plain(row({ ...unsized, model: 'claude-haiku-4-5-20251001', effort: 'low', tokenCount: 8500 })), 'reviewer  Review the diff  Haiku low  8.5k');
});

test('rounds token counts just under 10k to 10k', () => {
  const { contextWindowSize, ...unsized } = REVIEWER;
  assert.match(plain(row({ ...unsized, tokenCount: 9990 })), / 10k$/);
});

test('leaves out context without a token count', () => {
  const { tokenCount, ...uncounted } = REVIEWER;
  assert.equal(plain(row(uncounted)), 'reviewer  Review the diff  Sonnet high');
});

test('shows only the token count while the model is unresolved', () => {
  const { model, effort, contextWindowSize, ...unresolved } = REVIEWER;
  assert.equal(plain(row({ ...unresolved, tokenCount: 800 })), 'reviewer  Review the diff  800');
});

test('shrinks the label first to fit the width', () => {
  const content = plain(row(REVIEWER, 40));
  assert.equal(content, 'reviewer  Review the d  Sonnet high  21%');
  assert.equal(content.length, 40);
});

test('drops model and effort before cutting the name, and keeps context last', () => {
  assert.equal(plain(row(REVIEWER, 24)), 'reviewer  Review th  21%');
  assert.equal(plain(row(REVIEWER, 14)), 'reviewer  21%');
});

test('never exceeds the width', () => {
  for (const columns of [8, 12, 17, 20, 24, 30, 40, 60]) {
    const content = plain(row(REVIEWER, columns));
    assert.ok(content.length <= columns, `${columns} columns: "${content}" is ${content.length} wide`);
  }
});

test('keeps the default row for a task without an id', () => {
  assert.deepEqual(rows({ columns: 76, tasks: [{ name: 'orphan', model: 'claude-opus-5', tokenCount: 100 }] }), []);
});

test('prints nothing for malformed input', () => {
  assert.equal(run('subagent-statusline.cjs', 'not json'), '');
});
