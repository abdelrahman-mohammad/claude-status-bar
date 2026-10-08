// Where auto-compaction fires, as a percentage of the model's full context
// window, which is what used_percentage and the agent rows measure against.
//
// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is a percentage of the auto-compact window, and
// CLAUDE_CODE_AUTO_COMPACT_WINDOW can make that window smaller than the model's,
// so both scale the red point. The autoCompactWindow setting and /autocompact are
// invisible to a status line command. Without an override Claude Code picks the
// point per model, so 90 is an early warning rather than the real point.

const DEFAULT_PCT = 90;
// Claude Code reads the window as an integer prefix and clamps it to this range.
const MIN_WINDOW = 100_000;
const MAX_WINDOW = 1_000_000;

function overridePct() {
  const pct = parseFloat(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  return pct >= 1 && pct <= 100 ? pct : DEFAULT_PCT;
}

function compactWindow() {
  const tokens = parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 10);
  return Number.isFinite(tokens) ? Math.min(Math.max(tokens, MIN_WINDOW), MAX_WINDOW) : null;
}

/**
 * Yellow and red points for a context percentage. `contextWindowSize` is the
 * model's window in tokens; without it the points are not scaled.
 */
function contextThresholds(contextWindowSize) {
  const window = compactWindow();
  const scale = window && contextWindowSize > 0 ? Math.min(window, contextWindowSize) / contextWindowSize : 1;
  const red = overridePct() * scale;
  return { warn: Math.max(red - 20, red / 2), red };
}

module.exports = { contextThresholds };
