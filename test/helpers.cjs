// Runs the scripts the way Claude Code does: JSON on stdin, output on stdout.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ANSI = /\x1b\[[0-9;]*m/g;

/** A temp and config directory of its own; remove it with cleanup(). */
function createSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-status-bar-test-'));
  const tmp = path.join(dir, 'tmp');
  const config = path.join(dir, 'config');
  fs.mkdirSync(tmp);
  fs.mkdirSync(config);
  return {
    tmp,
    config,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  };
}

/**
 * Environment for a script under test. The caller's auto-compact settings,
 * opt-out, config directory and temp directory never reach the script, so a
 * developer's own settings cannot change a result.
 */
function scriptEnv({ sandbox, env = {} } = {}) {
  const base = { ...process.env };
  for (const name of ['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_STATUS_BAR_USAGE', 'CLAUDE_CONFIG_DIR']) {
    delete base[name];
  }
  if (sandbox) {
    Object.assign(base, {
      TEMP: sandbox.tmp,
      TMP: sandbox.tmp,
      TMPDIR: sandbox.tmp,
      CLAUDE_CONFIG_DIR: sandbox.config,
    });
  }
  return { ...base, ...env };
}

/** Raw stdout of `script` with `input` on stdin; an object is sent as JSON. */
function run(script, input, options) {
  const result = spawnSync(process.execPath, [path.join(ROOT, script)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: scriptEnv(options),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${script} exited with ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

function plain(text) {
  return text.replace(ANSI, '');
}

module.exports = { ROOT, createSandbox, scriptEnv, run, plain };
