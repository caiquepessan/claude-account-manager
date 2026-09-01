// src/tty.js — terminal capability detection and the single decision of whether
// cam may ask a question, and how: full raw-mode menu, numbered prompt, or silence.
// Everything is read from ctx; the gate is ALWAYS stderr, never stdout.

import { WriteStream } from 'node:tty';

/** Env values that mean "off" for a boolean-ish variable. */
const FALSY = new Set(['', '0', 'false', 'no', 'off']);

/** Variables whose truthiness means "this is an unattended build machine". */
const CI_VARS = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'TF_BUILD'];

/**
 * Is an environment variable present and not one of the falsy spellings.
 * @param {unknown} value the raw environment value
 * @returns {boolean} true when the variable is set to something meaning "on"
 */
function flagOn(value) {
  if (value === undefined || value === null) return false;
  return !FALSY.has(String(value).trim().toLowerCase());
}

/**
 * Coerce a terminal dimension to a positive integer, absorbing undefined/NaN.
 * `stream.columns` is undefined (not 80) on a pipe, and NaN propagates into
 * String.repeat() as a RangeError, which is how a menu crashes a launch.
 * @param {unknown} value the candidate dimension
 * @returns {number} a positive integer, or 0 when the value is unusable
 */
function posInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Resolve the color depth for a stream: 1 (none), 4 (16), 8 (256) or 24 (truecolor).
 * getColorDepth() ignores isTTY (it answers 24 for a fake object) and does not
 * exist at all on a piped stream, which is a net.Socket rather than a
 * tty.WriteStream — so isTTY is checked first and the prototype method is only
 * borrowed when the stream claims to be a TTY but lacks the method.
 * @param {Record<string, string|undefined>} env the context environment
 * @param {any} stream the stream being measured
 * @param {boolean} isTTY whether the stream reported itself as a TTY
 * @returns {number} 1, 4, 8 or 24
 */
function colorDepth(env, stream, isTTY) {
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    const v = String(force).trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return 1;
    if (v === '2') return 8;
    if (v === '3') return 24;
    return 4;
  }
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && String(noColor) !== '') return 1;
  if (env.TERM === 'dumb') return 1;
  if (!isTTY || !stream) return 1;
  if (typeof stream.getColorDepth === 'function') {
    try {
      return stream.getColorDepth(env);
    } catch {
      return 4;
    }
  }
  try {
    return WriteStream.prototype.getColorDepth.call(stream, env);
  } catch {
    return 4;
  }
}

/**
 * Decide whether this terminal can draw the box-drawing and status glyphs.
 * Deliberately does NOT spawn `chcp`: it costs ~28 ms, its output is localized,
 * it disagrees between shells on one machine, and it is irrelevant because
 * libuv writes to a Windows console through WriteConsoleW, bypassing the code page.
 * @param {object} ctx the cam context
 * @param {Record<string, string|undefined>} env the context environment
 * @returns {boolean} true when unicode glyphs are safe to emit
 */
function detectUnicode(ctx, env) {
  if (flagOn(env.CAM_ASCII)) return false;
  if (ctx.ascii === true) return false;
  if (ctx.ascii === false) return true;
  const term = env.TERM;
  if (term === 'linux' || term === 'dumb') return false;
  if (ctx.platform === 'win32') {
    return !!(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI || env.MSYSTEM);
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (/UTF-?8/i.test(locale)) return true;
  return ctx.platform === 'darwin';
}

/**
 * Measure one output stream: TTY-ness, color depth, glyph repertoire and size.
 * @param {object} ctx the cam context
 * @param {any} [stream] the stream to measure; defaults to ctx.io.err
 * @returns {{isTTY: boolean, depth: number, unicode: boolean, cols: number, rows: number, ascii: boolean}} the capabilities
 */
export function detectCaps(ctx, stream) {
  const env = ctx.env || {};
  const s = stream || (ctx.io ? ctx.io.err : null);
  const isTTY = !!(s && s.isTTY);
  const depth = colorDepth(env, s, isTTY);
  const cols = (isTTY ? posInt(s.columns) : 0) || posInt(env.COLUMNS) || 80;
  const rows = (isTTY ? posInt(s.rows) : 0) || posInt(env.LINES) || 24;
  const unicode = detectUnicode(ctx, env);
  return { isTTY, depth, unicode, cols, rows, ascii: !unicode };
}

/**
 * Actually enter and leave raw mode to find out whether it works.
 * Never trusts `stdin.isTTY`: in git-bash / mintty (MSYS) native Node reports
 * isTTY false on all three streams inside an obviously interactive terminal,
 * and setRawMode can throw ENOTTY. Gating on isTTY alone is how the menu
 * silently disappears on the single most common Windows dev terminal.
 * The reason is a stable diagnostic token, not user-facing prose.
 * @param {object} ctx the cam context
 * @returns {{ok: boolean, reason: string}} whether raw mode is usable and why not
 */
export function probeRawMode(ctx) {
  const input = ctx.io ? ctx.io.in : null;
  if (!input) return { ok: false, reason: 'no-stdin' };
  if (typeof input.setRawMode !== 'function') return { ok: false, reason: 'no-setrawmode' };
  const wasRaw = input.isRaw === true;
  try {
    input.setRawMode(true);
    input.setRawMode(wasRaw);
    return { ok: true, reason: 'raw-mode-available' };
  } catch (e) {
    try {
      input.setRawMode(wasRaw);
    } catch {
      /* the probe already failed; leaving it alone is the safe move */
    }
    return { ok: false, reason: e && e.code ? String(e.code) : 'setrawmode-threw' };
  }
}

/**
 * Is this an unattended build machine.
 * @param {object} ctx the cam context
 * @returns {boolean} true when any known CI variable is set to a truthy value
 */
export function isCI(ctx) {
  const env = ctx.env || {};
  for (const name of CI_VARS) {
    if (flagOn(env[name])) return true;
  }
  return false;
}

/**
 * Decide whether cam may ask which account to use, and how.
 * The reason is a translated sentence: when the answer is `none` and more than
 * one account exists, the caller prints it, because a silent fallback is the
 * exact failure this program was written to prevent.
 * `forwarded` is accepted so callers can hand over their argv split; it does
 * NOT gate interactivity — the ask policy (auto/always/never) owns that,
 * and `ask=always` must still be able to prompt with arguments present.
 * @param {object} ctx the cam context
 * @param {{forwarded?: string[]}} [opts] the arguments being forwarded to claude
 * @returns {{kind: 'raw'|'line'|'none', reason: string}} how cam may ask, and why
 */
export function interactivity(ctx, opts = {}) {
  const { forwarded = [] } = opts || {};
  void forwarded;
  const env = ctx.env || {};

  // Set in EVERY process Claude Code spawns. Prompting inside its own Bash tool
  // is a hard hang on a stdin that will never deliver a byte, not a slow path.
  if (env.CLAUDECODE === '1') return { kind: 'none', reason: ctx.t('pick.reason.claudecode') };
  if (flagOn(env.CAM_NO_PROMPT)) return { kind: 'none', reason: ctx.t('pick.reason.noPrompt') };
  if (isCI(ctx)) return { kind: 'none', reason: ctx.t('pick.reason.ci') };
  // The shell hook says '0' when it tested `[ -t 0 ] && [ -t 2 ]` and lost.
  if (env.CAM_TTY === '0') return { kind: 'none', reason: ctx.t('pick.reason.notATty') };

  const raw = probeRawMode(ctx);
  if (raw.ok) return { kind: 'raw', reason: ctx.t('doctor.terminalRaw') };

  // The shell knows it is a terminal even when Node does not — that is the
  // whole trick, and it is what makes the menu appear in git-bash at all.
  const errIsTTY = !!(ctx.io && ctx.io.err && ctx.io.err.isTTY);
  if (env.CAM_TTY === '1' || errIsTTY) return { kind: 'line', reason: ctx.t('doctor.terminalLine') };

  const stdinIsTTY = !!(ctx.io && ctx.io.in && ctx.io.in.isTTY);
  return {
    kind: 'none',
    reason: stdinIsTTY ? ctx.t('pick.reason.rawUnavailable') : ctx.t('pick.reason.notATty'),
  };
}
