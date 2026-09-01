// src/ui.js — the pure terminal kernel: styling, glyphs, display-width maths,
// the keypress decoder and every frame the user ever sees, as pure functions
// returning strings. No other module in cam emits layout.

import { createT } from './i18n.js';

/** Control characters, built numerically so no source escape can be mangled. */
const ESC = String.fromCharCode(0x1b);
const CSI8 = String.fromCharCode(0x9b);
const BEL = String.fromCharCode(0x07);

/** Fallback translator, used only when a caller passes no bound translator. */
const DEFAULT_T = createT('en');

/**
 * Resolve the translator to use for one render call.
 * @param {...any} carriers objects that may carry a bound translator (state, caps)
 * @returns {(key: string, vars?: Record<string, unknown>) => string} a translator
 */
function pickT(...carriers) {
  for (const c of carriers) {
    if (c && typeof c.t === 'function') return c.t;
  }
  return DEFAULT_T;
}

// ── capabilities ───────────────────────────────────────────────────────────

/** Terminal capabilities assumed when a caller passes none. */
const DEFAULT_CAPS = Object.freeze({
  isTTY: false, depth: 0, unicode: true, cols: 80, rows: 24, ascii: false,
});

/**
 * Normalise a partial caps object from tty.detectCaps into a complete one.
 * @param {object} [caps] partial capabilities
 * @returns {{isTTY:boolean, depth:number, unicode:boolean, cols:number, rows:number, ascii:boolean}} complete caps
 */
function normCaps(caps) {
  const c = caps && typeof caps === 'object' ? caps : {};
  const ascii = c.ascii === true || c.unicode === false;
  return {
    isTTY: c.isTTY === true,
    depth: Number.isFinite(c.depth) && c.depth > 0 ? Math.floor(c.depth) : 0,
    unicode: !ascii,
    cols: Number.isFinite(c.cols) && c.cols > 0 ? Math.floor(c.cols) : DEFAULT_CAPS.cols,
    rows: Number.isFinite(c.rows) && c.rows > 0 ? Math.floor(c.rows) : DEFAULT_CAPS.rows,
    ascii,
  };
}

// ── style ──────────────────────────────────────────────────────────────────

/** SGR parameters per colour depth. Accent is the brand orange #d97757. */
const PALETTE = Object.freeze({
  24: Object.freeze({
    accent: '38;2;217;119;87',
    muted: '38;5;245',
    faint: '38;5;240',
    green: '38;5;114',
    yellow: '38;5;179',
    red: '38;5;167',
  }),
  8: Object.freeze({
    accent: '38;5;173',
    muted: '38;5;245',
    faint: '38;5;240',
    green: '38;5;114',
    yellow: '38;5;179',
    red: '38;5;167',
  }),
  4: Object.freeze({
    accent: '33',
    muted: '37',
    faint: '90',
    green: '32',
    yellow: '33',
    red: '31',
  }),
});

/** Attributes that exist at every colour depth. */
const ATTRS = Object.freeze({ bold: '1', dim: '2', underline: '4', reverse: '7' });

/** The colour names every style object exposes as a function. */
const COLOR_NAMES = Object.freeze(['accent', 'muted', 'faint', 'green', 'yellow', 'red']);

/**
 * Build the styling functions for one terminal.
 * paint composes every requested attribute into ONE opening SGR and ONE reset,
 * because nesting style calls emits an inner reset that cancels the outer style
 * for everything appended afterwards.
 * @param {object} [caps] capabilities from tty.detectCaps ({ depth, ascii, … })
 * @returns {{on:boolean, paint:(s:string, ...names:string[])=>string, accent:Function, muted:Function, faint:Function, green:Function, yellow:Function, red:Function, bold:Function, dim:Function}} style helpers
 */
export function makeStyle(caps) {
  const c = normCaps(caps);
  const table = c.depth >= 24 ? PALETTE[24] : c.depth >= 8 ? PALETTE[8] : c.depth >= 4 ? PALETTE[4] : null;
  const on = table !== null;

  /**
   * Wrap text in a single composed SGR sequence.
   * @param {string} s the raw text
   * @param {...string} names attribute names ('bold', 'accent', 'faint', …)
   * @returns {string} the styled text, or the input untouched when colour is off
   */
  function paint(s, ...names) {
    const text = s === undefined || s === null ? '' : String(s);
    if (!on || text === '') return text;
    const params = [];
    for (const name of names) {
      if (!name) continue;
      if (Object.prototype.hasOwnProperty.call(ATTRS, name)) params.push(ATTRS[name]);
      else if (Object.prototype.hasOwnProperty.call(table, name)) params.push(table[name]);
    }
    if (params.length === 0) return text;
    return ESC + '[' + params.join(';') + 'm' + text + ESC + '[0m';
  }

  const style = { on, paint };
  for (const name of COLOR_NAMES) style[name] = (s) => paint(s, name);
  style.bold = (s) => paint(s, 'bold');
  style.dim = (s) => paint(s, 'dim');
  return style;
}

// ── glyphs ─────────────────────────────────────────────────────────────────

/**
 * Unicode glyphs, every one verified single-width. Never emoji: U+26A1 has
 * length 1 but draws two cells, which misaligns every row after it, and U+2714
 * has the same problem in emoji fonts where U+2713 does not.
 */
const GLYPHS_UNICODE = Object.freeze({
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│',
  active: '●', idle: '○', cursor: '▸', add: '+',
  ok: '✓', fail: '✗', warn: '!', info: '·',
  dot: '·', bullet: '·', ellipsis: '…', dash: '—',
  up: '↑', down: '↓', left: '←', right: '→',
  arrow: '→', enter: '↵', space: ' ',
});

/** The 7-bit fallback set: same shape, so every frame renders identically. */
const GLYPHS_ASCII = Object.freeze({
  tl: '+', tr: '+', bl: '+', br: '+',
  h: '-', v: '|',
  active: '*', idle: 'o', cursor: '>', add: '+',
  ok: 'v', fail: 'x', warn: '!', info: '-',
  dot: '-', bullet: '-', ellipsis: '...', dash: '-',
  up: '^', down: 'v', left: '<', right: '>',
  arrow: '->', enter: 'Enter', space: ' ',
});

/**
 * Pick the glyph table for a terminal.
 * @param {boolean} unicode true when the terminal can draw box and geometry glyphs
 * @returns {Readonly<Record<string,string>>} the frozen glyph table
 */
export function makeGlyphs(unicode) {
  return unicode === false ? GLYPHS_ASCII : GLYPHS_UNICODE;
}

// ── asciify ────────────────────────────────────────────────────────────────

/**
 * Non-ASCII characters that have a faithful 7-bit spelling. Exotic spaces are
 * absent on purpose: NFKD already folds every one of them to U+0020.
 */
const ASCII_MAP = new Map([
  ['‐', '-'], ['‑', '-'], ['‒', '-'], ['–', '-'], ['—', '-'],
  ['―', '-'], ['−', '-'], ['─', '-'], ['━', '-'], ['═', '-'],
  ['│', '|'], ['┃', '|'], ['║', '|'],
  ['┌', '+'], ['┐', '+'], ['└', '+'], ['┘', '+'],
  ['├', '+'], ['┤', '+'], ['┬', '+'], ['┴', '+'], ['┼', '+'],
  ['╭', '+'], ['╮', '+'], ['╯', '+'], ['╰', '+'],
  ['╔', '+'], ['╗', '+'], ['╚', '+'], ['╝', '+'],
  ['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"], ['′', "'"],
  ['“', '"'], ['”', '"'], ['„', '"'], ['‟', '"'], ['″', '"'],
  ['·', '.'], ['•', '*'], ['‣', '*'], ['∙', '*'],
  ['▪', '*'], ['▫', '*'], ['●', '*'], ['✻', '*'],
  ['○', 'o'], ['◦', 'o'],
  ['▸', '>'], ['▹', '>'], ['▶', '>'], ['◂', '<'], ['◀', '<'],
  ['←', '<'], ['↑', '^'], ['→', '>'], ['↓', 'v'],
  ['↵', 'Enter'], ['⏎', 'Enter'], ['↩', 'Enter'],
  ['✓', 'v'], ['✔', 'v'], ['☑', 'v'],
  ['✗', 'x'], ['✘', 'x'], ['✕', 'x'], ['✖', 'x'], ['☒', 'x'],
  ['×', 'x'], ['÷', '/'], ['±', '+/-'], ['°', 'deg'],
  ['©', '(c)'], ['®', '(R)'], ['§', 'S'],
  ['«', '<<'], ['»', '>>'], ['‹', '<'], ['›', '>'],
  ['…', '...'],
]);

/**
 * Zero-width scaffolding: combining marks, joiners, variation selectors and
 * format controls all occupy no cell of their own.
 */
const ZERO_WIDTH_RE = /[\p{Mn}\p{Me}\p{Cf}]/u;

/**
 * Reduce any string to PRINTABLE 7-bit ASCII.
 * Applied to ALL user data — emails, org names, profile names — not just to box
 * glyphs, because a frame that swaps only its borders still leaks the middle
 * dot, the ellipsis and the em dash out of account metadata. Control characters
 * become '?' too: an escape byte inside an org name would otherwise move the
 * cursor and shred the frame around it.
 * Take raw text, not styled text — this is deliberately hostile to ANSI.
 * @param {string} s any raw text
 * @returns {string} printable 7-bit ASCII, with everything else replaced by '?'
 */
/**
 * Fold a line that may ALREADY be styled down to 7-bit, when the terminal asked
 * for it. `asciify` is deliberately hostile to escape bytes — it turns them into
 * '?' — so it can only be given raw text. This applies it per non-ASCII
 * character instead, which leaves any SGR sequence (all of it ASCII) intact.
 *
 * It exists because `--ascii` promises 7-bit output and the one-line summaries
 * of `cam ls`, `cam which` and `cam doctor` are written straight to the stream
 * rather than through the frame builders, so `·` and `→` used to survive.
 * @param {string} text a line, styled or not
 * @param {object} [caps] terminal capabilities; folding happens only when caps.ascii
 * @returns {string} the line, 7-bit when asked for, unchanged otherwise
 */
export function plain(text, caps) {
  const s = text === undefined || text === null ? '' : String(text);
  if (!caps || caps.ascii !== true) return s;
  return s.replace(/[^\x00-\x7f]/gu, (ch) => asciify(ch));
}

export function asciify(s) {
  if (s === undefined || s === null) return '';
  const text = String(s);
  if (text === '') return '';
  let decomposed = text;
  try {
    decomposed = text.normalize('NFKD');
  } catch {
    decomposed = text;
  }
  let out = '';
  for (const ch of decomposed) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && cp < 0x7f) { out += ch; continue; }
    if (cp < 0x80) { out += '?'; continue; }
    if (ZERO_WIDTH_RE.test(ch)) continue;
    const mapped = ASCII_MAP.get(ch);
    out += mapped === undefined ? '?' : mapped;
  }
  return out;
}

/**
 * Apply asciify only when the terminal cannot render Unicode.
 * @param {string} s any text
 * @param {boolean} ascii true when 7-bit output is required
 * @returns {string} the text, asciified when required
 */
function safe(s, ascii) {
  const text = s === undefined || s === null ? '' : String(s);
  return ascii ? asciify(text) : text;
}

// ── width maths ────────────────────────────────────────────────────────────

/** OSC, CSI (7-bit and 8-bit), SS3 and single-byte escape sequences. */
const ANSI_RE = new RegExp(
  ESC + '\\][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)'
  + '|[' + ESC + CSI8 + '][[\\]()#;?!<>=]*[0-9;]*[ -/]*[@-~]'
  + '|' + ESC + '[@-Z\\\\-_]',
  'g',
);

/**
 * Remove every ANSI escape sequence so text can be measured or re-wrapped.
 * @param {string} s possibly styled text
 * @returns {string} the same text with no escape sequences
 */
export function stripAnsi(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(ANSI_RE, '');
}

let SEGMENTER = null;
let SEGMENTER_READY = false;

/**
 * Lazily build the grapheme segmenter (built in, zero dependencies).
 * @returns {object|null} an Intl.Segmenter, or null on a small-icu build
 */
function segmenter() {
  if (!SEGMENTER_READY) {
    SEGMENTER_READY = true;
    try {
      SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      SEGMENTER = null;
    }
  }
  return SEGMENTER;
}

/**
 * Split plain text into user-perceived characters.
 * @param {string} s plain (ANSI-free) text
 * @returns {string[]} grapheme clusters, or code points on a small-icu build
 */
function graphemes(s) {
  const seg = segmenter();
  if (!seg) return Array.from(s);
  const out = [];
  for (const piece of seg.segment(s)) out.push(piece.segment);
  return out;
}

/** East-Asian Wide and Fullwidth ranges — each of these draws two cells. */
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x17000, 0x187f7], [0x18800, 0x18cd5], [0x1b000, 0x1b16f],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

/**
 * Is this code point drawn two cells wide?
 * @param {number} cp a Unicode code point
 * @returns {boolean} true when the character is East-Asian Wide or Fullwidth
 */
function isWide(cp) {
  for (let i = 0; i < WIDE_RANGES.length; i += 1) {
    const range = WIDE_RANGES[i];
    if (cp < range[0]) return false;
    if (cp <= range[1]) return true;
  }
  return false;
}

/**
 * Is this code point a C0/C1 control that occupies no cell?
 * @param {number} cp a Unicode code point
 * @returns {boolean} true for control characters
 */
function isControl(cp) {
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
}

/**
 * Column count of one grapheme cluster.
 * @param {string} cluster one user-perceived character
 * @returns {number} 0, 1 or 2 columns
 */
function clusterWidth(cluster) {
  let visible = false;
  let wide = false;
  for (const ch of cluster) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f) { visible = true; wide = true; continue; }
    if (isControl(cp)) continue;
    if (ZERO_WIDTH_RE.test(ch)) continue;
    visible = true;
    if (isWide(cp)) wide = true;
  }
  if (!visible) return 0;
  return wide ? 2 : 1;
}

/**
 * Display width in terminal columns: ANSI-stripped and grapheme-aware.
 * String length is wrong on three independent axes — combining marks
 * ('e' plus U+0301 is length 2, width 1), astral surrogate pairs (length 2,
 * width 2) and wide CJK (length 1, width 2).
 * @param {string} s any text, styled or not
 * @returns {number} the number of terminal columns the text occupies
 */
export function width(s) {
  if (s === undefined || s === null) return 0;
  const plain = stripAnsi(String(s));
  if (plain === '') return 0;
  let total = 0;
  for (const cluster of graphemes(plain)) total += clusterWidth(cluster);
  return total;
}

/**
 * Shorten text to a column budget without ever splitting a wide cell — it
 * under-fills instead, so five wide CJK characters cut to 6 columns yield
 * width 5. Truncate RAW text, then colour it.
 * @param {string} s the raw text
 * @param {number} maxCols the column budget
 * @param {string} [ellipsis] the marker appended when text was cut
 * @returns {string} text whose display width is at most maxCols
 */
export function truncate(s, maxCols, ellipsis = '…') {
  const text = s === undefined || s === null ? '' : String(s);
  const budget = Number.isFinite(maxCols) ? Math.floor(maxCols) : 0;
  if (budget <= 0) return '';
  if (width(text) <= budget) return text;

  const mark = ellipsis === undefined || ellipsis === null ? '' : String(ellipsis);
  const markW = width(mark);
  const useMark = markW > 0 && markW < budget;
  const room = useMark ? budget - markW : budget;

  let out = '';
  let used = 0;
  for (const cluster of graphemes(stripAnsi(text))) {
    const w = clusterWidth(cluster);
    if (used + w > room) break;
    out += cluster;
    used += w;
  }
  return useMark ? out + mark : out;
}

/**
 * Pad text on the right to a column count. Never truncates.
 * @param {string} s the text
 * @param {number} cols the target column count
 * @returns {string} the text padded with spaces to at least cols columns
 */
export function padEnd(s, cols) {
  const text = s === undefined || s === null ? '' : String(s);
  const target = Number.isFinite(cols) ? Math.floor(cols) : 0;
  const w = width(text);
  if (w >= target) return text;
  return text + ' '.repeat(target - w);
}

/**
 * Force text to occupy exactly a column count: truncate, then pad.
 * @param {string} s the raw text
 * @param {number} cols the exact column count
 * @param {string} [ellipsis] the truncation marker
 * @returns {string} text exactly cols columns wide
 */
export function fit(s, cols, ellipsis = '…') {
  const target = Number.isFinite(cols) ? Math.floor(cols) : 0;
  if (target <= 0) return '';
  return padEnd(truncate(s, target, ellipsis), target);
}

/**
 * Pad on the left (right-align) to a column count. Never truncates.
 * @param {string} s the text
 * @param {number} cols the target column count
 * @returns {string} the right-aligned text
 */
function padStart(s, cols) {
  const text = s === undefined || s === null ? '' : String(s);
  const target = Number.isFinite(cols) ? Math.floor(cols) : 0;
  const w = width(text);
  if (w >= target) return text;
  return ' '.repeat(target - w) + text;
}

/**
 * Force an already-styled string to exactly cols columns. Padding a styled
 * string is safe; truncating one is not, so an over-long line is stripped of
 * its escapes first rather than being cut mid-sequence.
 * @param {string} s possibly styled text
 * @param {number} cols the exact column count
 * @param {string} ellipsis the truncation marker
 * @returns {string} a line exactly cols columns wide
 */
function clampStyled(s, cols, ellipsis) {
  const text = s === undefined || s === null ? '' : String(s);
  const w = width(text);
  if (w === cols) return text;
  if (w < cols) return text + ' '.repeat(cols - w);
  return fit(stripAnsi(text), cols, ellipsis);
}

// ── key decoding ───────────────────────────────────────────────────────────

/**
 * Build a key record with every modifier explicitly present.
 * @param {string} name the key name ('up', 'return', 'c', …)
 * @param {object} [extra] overrides (ctrl, meta, shift, sequence)
 * @returns {{name:string, ctrl:boolean, meta:boolean, shift:boolean, sequence:string}} the key
 */
function mkKey(name, extra = {}) {
  return { name, ctrl: false, meta: false, shift: false, sequence: '', ...extra };
}

/**
 * CSI (ESC [ …) and SS3 (ESC O …). SS3 is not optional: many terminals and
 * tmux configurations put the keypad in application cursor mode, and without it
 * the arrow keys randomly stop working.
 */
const CSI_RE = new RegExp('^' + ESC + '(\\[|O)([?><!]?)([0-9;]*)([@-~])');

/** CSI final bytes that name a key directly. */
const CSI_FINALS = Object.freeze({
  A: 'up', B: 'down', C: 'right', D: 'left', E: 'clear', F: 'end', H: 'home',
  P: 'f1', Q: 'f2', R: 'f3', S: 'f4',
});

/** CSI-tilde parameter values (ESC [ 5 ~). */
const CSI_TILDE = Object.freeze({
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown',
  7: 'home', 8: 'end', 11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5',
  17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12',
  200: 'pastestart', 201: 'pasteend',
});

/**
 * Decode one non-escape character into a key.
 * Both CR and LF are 'return': Node's readline names them differently and Enter
 * silently fails on some terminals when only one of the two is handled.
 * @param {string} ch a single character (one full code point, surrogates included)
 * @returns {{name:string, ctrl:boolean, meta:boolean, shift:boolean, sequence:string}} the key
 */
function decodeChar(ch) {
  const cp = ch.codePointAt(0);
  if (cp === 0x0d || cp === 0x0a) return mkKey('return', { sequence: ch });
  if (cp === 0x09) return mkKey('tab', { sequence: ch });
  if (cp === 0x7f || cp === 0x08) return mkKey('backspace', { sequence: ch });
  if (cp === 0x20) return mkKey('space', { sequence: ch });
  if (cp === 0x00) return mkKey('space', { ctrl: true, sequence: ch });
  if (cp < 0x20) return mkKey(String.fromCharCode(cp + 0x60), { ctrl: true, sequence: ch });
  const lower = ch.toLowerCase();
  return mkKey(lower, { shift: ch !== lower && ch === ch.toUpperCase(), sequence: ch });
}

/**
 * Decode one raw stdin chunk into EVERY keypress it carries.
 * A single read can hold several keys during autorepeat or a paste, and a
 * handler that looks only at the first decoded key silently drops input.
 * A chunk ENDING in a bare ESC decodes as 'escape' immediately, instead of
 * waiting out readline's 500 ms escape timeout, which is what makes Esc feel
 * broken. 0x03 decodes as ctrl+c, because raw mode suppresses SIGINT and the
 * byte is the only cancel signal the picker will ever see.
 * @param {Buffer|string} chunk one raw read from a terminal in raw mode
 * @returns {Array<{name:string, ctrl:boolean, meta:boolean, shift:boolean, sequence:string}>} the keys, in order
 */
export function decodeKeys(chunk) {
  let s = '';
  if (typeof chunk === 'string') s = chunk;
  else if (chunk && typeof chunk.toString === 'function') s = chunk.toString('utf8');
  const keys = [];
  let i = 0;

  while (i < s.length) {
    const ch = String.fromCodePoint(s.codePointAt(i));

    if (ch === ESC) {
      const next = s[i + 1];

      if (next === undefined || next === ESC) {
        keys.push(mkKey('escape', { sequence: ESC }));
        i += 1;
        continue;
      }

      if (next === '[' || next === 'O') {
        const m = CSI_RE.exec(s.slice(i));
        if (m) {
          const seq = m[0];
          const params = m[3].split(';');
          const p1 = Number.parseInt(params[0], 10);
          const p2 = Number.parseInt(params[1], 10);
          const bits = Number.isFinite(p2) && p2 > 0 ? p2 - 1 : 0;
          const mods = {
            shift: (bits & 1) !== 0,
            meta: (bits & 2) !== 0,
            ctrl: (bits & 4) !== 0,
            sequence: seq,
          };
          const final = m[4];
          let name = null;
          if (final === '~') name = CSI_TILDE[Number.isFinite(p1) ? p1 : 0] || null;
          else if (final === 'Z') { name = 'tab'; mods.shift = true; }
          else name = CSI_FINALS[final] || null;
          if (name) keys.push(mkKey(name, mods));
          i += seq.length;
          continue;
        }
        keys.push(mkKey('escape', { sequence: ESC }));
        i += 1;
        continue;
      }

      const after = String.fromCodePoint(s.codePointAt(i + 1));
      keys.push({ ...decodeChar(after), meta: true, sequence: ESC + after });
      i += 1 + after.length;
      continue;
    }

    keys.push(decodeChar(ch));
    i += ch.length;
  }

  return keys;
}

/**
 * How much of `s` is a trailing escape sequence that is still arriving.
 *
 * A terminal is a byte stream, not a message queue: over ssh, inside mintty, or
 * on a busy pty, one arrow key can be delivered as ESC in one 'data' event and
 * '[A' in the next. Decoded independently those become escape + '[' + 'a', and
 * since the picker maps escape to cancel, a single arrow key made `claude` exit
 * 0 having launched nothing.
 * @param {string} s the text decoded so far
 * @returns {number} the index where an incomplete sequence starts, or -1
 */
function incompleteTailAt(s) {
  const at = s.lastIndexOf(ESC);
  if (at < 0) return -1;
  const tail = s.slice(at);
  if (tail === ESC) return at;                       // ESC alone: '[' may follow
  const intro = tail[1];
  if (intro !== '[' && intro !== 'O') return -1;     // ESC + letter is complete
  if (CSI_RE.test(tail)) return -1;                  // a final byte already arrived
  // Only parameter/intermediate bytes so far, so more is still coming.
  return /^[?><!]?[0-9;]*$/.test(tail.slice(2)) ? at : -1;
}

/**
 * A stateful wrapper around `decodeKeys` that holds a partial escape sequence
 * until the rest of it arrives.
 *
 * `push` returns the keys that are unambiguously complete. `flush` decodes
 * whatever is still held — the caller arms a short timer after any push that
 * leaves `pending` non-empty, so a lone Esc keypress still registers promptly
 * instead of waiting for a keystroke that never comes.
 * @returns {{ push(chunk: string|Buffer): object[], flush(): object[], pending(): string }} the reader
 */
export function createKeyReader() {
  let carry = '';

  const asText = (chunk) => {
    if (typeof chunk === 'string') return chunk;
    if (chunk && typeof chunk.toString === 'function') return chunk.toString('utf8');
    return '';
  };

  return {
    push(chunk) {
      const s = carry + asText(chunk);
      carry = '';
      if (s === '') return [];
      const at = incompleteTailAt(s);
      if (at < 0) return decodeKeys(s);
      carry = s.slice(at);
      return at === 0 ? [] : decodeKeys(s.slice(0, at));
    },
    flush() {
      if (carry === '') return [];
      const held = carry;
      carry = '';
      return decodeKeys(held);
    },
    pending() {
      return carry;
    },
  };
}

// ── time and plan labels ───────────────────────────────────────────────────

const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/**
 * Human-readable age of a timestamp. The clock is injected: this module never
 * reads one of its own.
 *
 * ALWAYS PASS `ctx.t`. The default exists only for callers that have no context
 * at all (a unit test, a crash path); every string it produces is English, so an
 * omitted translator silently prints 'just now' inside a pt-BR session.
 * @param {number} ms the timestamp being described, in epoch milliseconds
 * @param {number} now the current time, from ctx.now()
 * @param {Function} [t] a bound translator; the English catalogue by default
 * @returns {string} a translated relative time such as '2h ago' or 'yesterday'
 */
export function relativeTime(ms, now, t = DEFAULT_T) {
  const at = Number.isFinite(ms) ? ms : 0;
  const ref = Number.isFinite(now) ? now : 0;
  if (at <= 0) return t('time.never');

  const diff = ref - at;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < DAY_MS) return t('time.inHours', { n: Math.max(1, Math.round(ahead / HOUR_MS)) });
    return t('time.inDays', { n: Math.max(1, Math.round(ahead / DAY_MS)) });
  }
  if (diff < MINUTE_MS) return t('time.now');
  if (diff < HOUR_MS) return t('time.minutes', { n: Math.floor(diff / MINUTE_MS) });
  if (diff < DAY_MS) return t('time.hours', { n: Math.floor(diff / HOUR_MS) });

  const days = Math.floor(diff / DAY_MS);
  if (days === 1) return t('time.yesterday');
  if (days < 7) return t('time.days', { n: days });
  if (days < 60) return t('time.weeks', { n: Math.floor(days / 7) });
  return t('time.months', { n: Math.max(1, Math.floor(days / 30)) });
}

/** Subscription types the catalogue names, longest prefix first. */
const PLAN_KEYS = Object.freeze(['enterprise', 'team', 'free', 'max', 'pro']);

/**
 * Translate a raw subscriptionType into a display label.
 * @param {string} subscriptionType the value from the credentials or oauthAccount blob
 * @param {Function} [t] a bound translator; the English catalogue by default
 * @returns {string} the translated plan name, or the unknown marker
 */
export function planLabel(subscriptionType, t = DEFAULT_T) {
  let raw = typeof subscriptionType === 'string' ? subscriptionType.trim().toLowerCase() : '';
  // `oauthAccount.organizationType` spells the same plans as `claude_max`,
  // `claude_team`, … — one vocabulary, two prefixes.
  if (raw.startsWith('claude_') || raw.startsWith('claude-')) raw = raw.slice(7);
  if (raw === '') return t('plan.unknown');
  for (const key of PLAN_KEYS) {
    if (raw === key || raw.startsWith(key + '_') || raw.startsWith(key + '-')) return t('plan.' + key);
  }
  return t('plan.unknown');
}

// ── one-line frames ────────────────────────────────────────────────────────

/** Status kinds mapped to their glyph and colour. */
const STATUS_KINDS = Object.freeze({
  ok: { glyph: 'ok', color: 'green' },
  warn: { glyph: 'warn', color: 'yellow' },
  fail: { glyph: 'fail', color: 'red' },
  error: { glyph: 'fail', color: 'red' },
  info: { glyph: 'info', color: 'faint' },
  note: { glyph: 'info', color: 'faint' },
  plain: { glyph: null, color: null },
});

/**
 * One status line: a coloured glyph, a space, then the already translated text.
 * @param {string} kind 'ok' | 'warn' | 'fail' | 'info' | 'note' | 'plain'
 * @param {string} text the translated text to show
 * @param {object} [caps] terminal capabilities
 * @returns {string} the rendered line
 */
export function statusLine(kind, text, caps) {
  const c = normCaps(caps);
  const g = makeGlyphs(c.unicode);
  const style = makeStyle(c);
  const spec = Object.prototype.hasOwnProperty.call(STATUS_KINDS, kind)
    ? STATUS_KINDS[kind]
    : STATUS_KINDS.info;
  const body = safe(text, c.ascii);
  if (!spec.glyph) return body;
  return style.paint(g[spec.glyph], spec.color) + ' ' + body;
}

/**
 * The single line that survives into scrollback after a launch.
 * @param {object} profile the chosen account ({ name, email, plan, meta… })
 * @param {object} [caps] terminal capabilities, optionally carrying a bound t
 * @returns {string} a line such as 'v work - me@acme.io - team'
 */
export function banner(profile, caps) {
  const t = pickT(caps, profile);
  const p = profile && typeof profile === 'object' ? profile : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};

  const name = p.name === undefined || p.name === null ? '' : String(p.name);
  const email = p.email || meta.email || '';
  const planRaw = p.plan || meta.plan || p.subscriptionType || meta.subscriptionType || '';
  const plan = planLabel(planRaw, t);

  let text;
  if (email && planRaw) text = t('launch.banner', { name, email, plan });
  else if (planRaw) text = t('launch.bannerNoEmail', { name, plan });
  else text = t('launch.bannerPlain', { name });

  return statusLine('ok', text, caps);
}

/**
 * The mandatory shape for every user-visible failure: a red headline followed by
 * aligned label/remedy pairs, so a failure is always actionable and never a
 * stack trace.
 * @param {{title: string, lines?: Array<string|{label?:string, value?:string, values?:string[], kind?:string}>}} spec the already translated headline and remedy rows
 * @param {object} [caps] terminal capabilities
 * @returns {string[]} the rendered block, one string per line
 */
export function errorBlock({ title, lines } = {}, caps) {
  const c = normCaps(caps);
  const style = makeStyle(c);
  const out = [statusLine('fail', title === undefined || title === null ? '' : title, caps)];

  const entries = (Array.isArray(lines) ? lines : []).map((entry) => {
    if (entry === null || entry === undefined) return { label: '', values: [], kind: null };
    if (typeof entry === 'string') return { label: '', values: [entry], kind: 'note' };
    const values = Array.isArray(entry.values)
      ? entry.values.slice()
      : (entry.value === undefined || entry.value === null ? [] : [entry.value]);
    return { label: entry.label ? String(entry.label) : '', values, kind: entry.kind || null };
  }).filter((e) => e.label !== '' || e.values.length > 0);

  if (entries.length === 0) return out;
  out.push('');

  let labelW = 0;
  for (const e of entries) labelW = Math.max(labelW, width(safe(e.label, c.ascii)));

  for (const e of entries) {
    const label = safe(e.label, c.ascii);
    const painted = e.kind === 'warn' ? style.yellow(padEnd(label, labelW)) : padEnd(label, labelW);
    if (e.values.length === 0) {
      out.push('  ' + painted);
      continue;
    }
    e.values.forEach((raw, i) => {
      const value = style.muted(safe(raw, c.ascii));
      const head = i === 0 ? painted : ' '.repeat(labelW);
      out.push(labelW > 0 ? '  ' + head + '   ' + value : '  ' + value);
    });
  }

  return out;
}

// ── the account menu ───────────────────────────────────────────────────────

/** Box width floor and ceiling, in columns, borders included. */
const BOX_MIN = 46;
const BOX_MAX = 74;
/** Content columns below which the last-used column is dropped. */
const TAG_COLUMN_MIN = 66;
/** Content columns below which the email is squeezed hardest. */
const EMAIL_TIGHT = 52;
/** Width of the last-used / health column. */
const TAG_W = 12;
/** Digits are only safe as hotkeys because the row order never reshuffles. */
const HOTKEYS = '123456789';

/**
 * Read one caller-supplied menu item into the fields the renderer needs.
 * Accepts a Profile straight from profiles.all, with or without a nested meta.
 * @param {object} item the raw item
 * @param {Function} t the bound translator
 * @param {number} now the clock reading from ctx.now(), or NaN when unavailable
 * @returns {object} the normalised row
 */
function normalizeItem(item, t, now) {
  const it = item && typeof item === 'object' ? item : {};
  const meta = it.meta && typeof it.meta === 'object' ? it.meta : {};
  const kind = it.kind === 'add' || it.kind === 'separator' || it.kind === 'blank'
    ? it.kind
    : 'account';

  const health = it.health && typeof it.health === 'object'
    ? it.health
    : (meta.health && typeof meta.health === 'object' ? meta.health : null);
  const status = health ? health.status : (typeof it.status === 'string' ? it.status : null);
  const daysLeft = health && Number.isFinite(health.daysLeft) ? health.daysLeft : 0;
  const isDefault = it.isDefault === true || it.dir === null;
  const lastUsedAt = Number.isFinite(it.lastUsedAt)
    ? it.lastUsedAt
    : (Number.isFinite(meta.lastUsedAt) ? meta.lastUsedAt : 0);

  let tag = '';
  let tagWarn = false;
  if (status === 'warn') { tag = t('health.warnMenu', { days: daysLeft }); tagWarn = true; }
  else if (status === 'expired') { tag = t('health.expired'); tagWarn = true; }
  else if (status === 'signedout') { tag = t('menu.signedOut'); tagWarn = true; }
  else if (typeof it.tag === 'string' && it.tag !== '') tag = it.tag;
  else if (isDefault) tag = t('menu.yourLogin');
  else if (lastUsedAt > 0 && Number.isFinite(now)) tag = relativeTime(lastUsedAt, now, t);
  else if (it.active === true) tag = t('menu.active');

  return {
    kind,
    name: it.name === undefined || it.name === null ? '' : String(it.name),
    email: it.email || meta.email || '',
    org: it.org || it.orgName || meta.orgName || '',
    plan: it.plan || meta.plan || it.subscriptionType || meta.subscriptionType || '',
    active: it.active === true,
    isDefault,
    hotkey: typeof it.hotkey === 'string' ? it.hotkey : '',
    tag,
    tagWarn,
  };
}

/**
 * Compose the metadata cell: email, plan and org, shedding detail as the
 * terminal narrows — the org goes first, then the email is truncated.
 * @param {object} row a normalised row
 * @param {number} metaW the column budget
 * @param {Record<string,string>} g the glyph table
 * @param {Function} t the bound translator
 * @param {boolean} ascii true when 7-bit output is required
 * @returns {string} the raw (unstyled) metadata text
 */
function metaCell(row, metaW, g, t, ascii) {
  const sep = ' ' + g.dot + ' ';
  const head = row.email ? safe(row.email, ascii) : safe(t('menu.signedOut'), ascii);
  const tail = [];
  if (row.plan) tail.push(safe(planLabel(row.plan, t), ascii));
  if (row.org) tail.push(safe(row.org, ascii));

  let joined = [head].concat(tail).join(sep);
  if (width(joined) <= metaW) return joined;

  while (tail.length > 1) {
    tail.pop();
    joined = [head].concat(tail).join(sep);
    if (width(joined) <= metaW) return joined;
  }

  const tailW = tail.length > 0 ? width(sep + tail[0]) : 0;
  const budget = metaW - tailW;
  if (budget >= 8) {
    const cut = truncate(head, budget, g.ellipsis);
    return tail.length > 0 ? cut + sep + tail[0] : cut;
  }
  return truncate(joined, metaW, g.ellipsis);
}

/**
 * Render the account picker, the only frame with a box around it.
 * The accent hue touches exactly three things — the cursor, the selected label
 * and the plus of the add row. There is no full-width reverse-video selection
 * bar: it fights the user's theme and reads as 1990s DOS.
 * @param {{items: object[], index?: number, version?: string, claudeVersion?: string, warnings?: string[], now?: number, mode?: string, showAdd?: boolean, t?: Function}} state the menu state
 * @param {object} [caps] terminal capabilities
 * @returns {string[]} the frame, one string per line, every line the same width
 */
export function buildMenu(state, caps) {
  const c = normCaps(caps);
  const st = state && typeof state === 'object' ? state : {};
  const t = pickT(st, caps);
  const g = makeGlyphs(c.unicode);
  const style = makeStyle(c);

  const box = Math.max(BOX_MIN, Math.min(c.cols, BOX_MAX));
  const W = box - 4;
  const tagW = W >= TAG_COLUMN_MIN ? TAG_W : 0;
  const now = Number.isFinite(st.now) ? st.now : NaN;

  const raw = Array.isArray(st.items) ? st.items : [];
  const index = Number.isFinite(st.index) ? st.index : -1;
  const accounts = [];
  let addRow = null;
  raw.forEach((item, i) => {
    const row = normalizeItem(item, t, now);
    const entry = { row, selected: i === index };
    if (row.kind === 'add') { if (!addRow) addRow = entry; return; }
    if (row.kind === 'account') accounts.push(entry);
  });
  if (!addRow && st.showAdd === true) {
    addRow = { row: normalizeItem({ kind: 'add' }, t, now), selected: false };
  }

  let nameW = 9;
  for (const entry of accounts) nameW = Math.max(nameW, width(safe(entry.row.name, c.ascii)) + 2);
  nameW = Math.min(nameW, 20);
  const minMeta = W < EMAIL_TIGHT ? 14 : 20;
  nameW = Math.max(7, Math.min(nameW, W - 8 - tagW - minMeta));
  const metaW = Math.max(1, W - 8 - nameW - tagW);

  const lines = [];
  const border = (l, r) => style.faint(l + g.h.repeat(box - 2) + r);
  const line = (content) => style.faint(g.v) + ' ' + clampStyled(content, W, g.ellipsis) + ' ' + style.faint(g.v);

  lines.push(border(g.tl, g.tr));

  // header: the product and its version on the left, the claude build on the right
  const headLeft = safe(t('app.header', { name: t('app.name'), version: st.version || '' }), c.ascii);
  const headRight = st.claudeVersion
    ? safe(t('app.claudeVersion', { version: st.claudeVersion }), c.ascii)
    : '';
  if (headRight && width(headLeft) + width(headRight) + 2 <= W) {
    lines.push(line(padEnd(headLeft, W - width(headRight)) + style.faint(headRight)));
  } else {
    lines.push(line(fit(headLeft, W, g.ellipsis)));
  }
  lines.push(line(style.faint(g.h.repeat(W))));

  // accounts, in the stable order the caller gave us
  if (accounts.length === 0) {
    lines.push(line(style.muted(fit(safe(t('menu.empty'), c.ascii), W, g.ellipsis))));
  } else {
    let digit = 0;
    for (const entry of accounts) {
      const row = entry.row;
      const hotkey = row.hotkey || (digit < HOTKEYS.length ? HOTKEYS[digit] : ' ');
      digit += 1;

      const cursor = entry.selected ? style.accent(g.cursor) : ' ';
      const badge = row.active ? style.green(g.active) : style.faint(g.idle);
      const nameCell = fit(safe(row.name, c.ascii), nameW, g.ellipsis);
      const name = entry.selected ? style.paint(nameCell, 'bold', 'accent') : nameCell;
      const meta = style.muted(fit(metaCell(row, metaW, g, t, c.ascii), metaW, g.ellipsis));
      let tag = '';
      if (tagW > 0) {
        const cell = fit(safe(row.tag, c.ascii), tagW, g.ellipsis);
        tag = row.tagWarn ? style.yellow(cell) : style.muted(cell);
      }
      lines.push(line(cursor + ' ' + badge + ' ' + name + meta + tag + '  ' + style.faint(hotkey) + ' '));
    }
  }

  // the add row, always separated from the accounts by one blank line
  if (addRow) {
    lines.push(line(' '.repeat(W)));
    const label = safe(t('menu.add'), c.ascii);
    const via = W >= TAG_COLUMN_MIN ? safe(t('menu.addVia'), c.ascii) : '';
    const cursor = addRow.selected ? style.accent(g.cursor) : ' ';
    const head = cursor + ' ' + style.accent(g.add) + ' '
      + (addRow.selected ? style.paint(label, 'bold', 'accent') : label);
    const headW = 4 + width(label);
    const room = Math.max(0, W - 4 - width(via));
    const pad = headW < room ? ' '.repeat(room - headW) : '';
    const key = addRow.row.hotkey || 'a';
    lines.push(line(head + pad + style.muted(via) + '  ' + style.faint(key) + ' '));
  }

  // warnings sit above the footer rule, never below it
  const warnings = Array.isArray(st.warnings) ? st.warnings : [];
  for (const warning of warnings) {
    const text = safe(g.warn + ' ' + String(warning), c.ascii);
    lines.push(line(style.yellow(fit(text, W, g.ellipsis))));
  }

  lines.push(line(style.faint(g.h.repeat(W))));
  const footerKey = st.mode === 'select' ? 'menu.footerSelect' : 'menu.footer';
  const footer = safe(t(footerKey, { updown: g.up + g.down, enter: g.enter }), c.ascii);
  lines.push(line(style.faint(fit(footer, W, g.ellipsis))));
  lines.push(border(g.bl, g.br));

  return lines;
}

// ── plain tables ───────────────────────────────────────────────────────────

/** Columns are separated by exactly two spaces. */
const TABLE_GAP = 2;

/**
 * Read one cell out of a row, which may be an array or an object.
 * @param {object|Array} row the row
 * @param {object} col the normalised column
 * @param {number} i the column index
 * @returns {string|object} the raw cell value
 */
function cellOf(row, col, i) {
  if (Array.isArray(row)) return row[i];
  if (row && typeof row === 'object') {
    if (Object.prototype.hasOwnProperty.call(row, col.key)) return row[col.key];
    if (Array.isArray(row.cells)) return row.cells[i];
  }
  return '';
}

/**
 * Render an aligned plain-text table: the shape every non-boxed screen uses.
 * Columns shrink from the widest first when the terminal is too narrow, and the
 * last left-aligned column is never padded, so piped output has no trailing
 * whitespace.
 * @param {{columns: Array<string|object>, rows: Array<object|Array>}} spec columns and rows; cells may be strings or { text, style }
 * @param {object} [caps] terminal capabilities
 * @returns {string[]} the header line (when any column is labelled) and one line per row
 */
export function buildTable({ columns, rows } = {}, caps) {
  const c = normCaps(caps);
  const style = makeStyle(c);
  const g = makeGlyphs(c.unicode);

  const cols = (Array.isArray(columns) ? columns : []).map((col, i) => (
    typeof col === 'string'
      ? { key: String(i), label: col, align: 'left', min: 0, max: Infinity, style: null }
      : {
        key: col && col.key !== undefined ? String(col.key) : String(i),
        label: col && col.label ? String(col.label) : '',
        align: col && col.align === 'right' ? 'right' : 'left',
        min: col && Number.isFinite(col.min) ? col.min : 0,
        max: col && Number.isFinite(col.max) ? col.max : Infinity,
        style: col && col.style ? String(col.style) : null,
      }
  ));
  if (cols.length === 0) return [];

  const body = (Array.isArray(rows) ? rows : []).map((row) => cols.map((col, i) => {
    const cell = cellOf(row, col, i);
    if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
      return {
        text: safe(cell.text === undefined || cell.text === null ? '' : cell.text, c.ascii),
        style: cell.style ? String(cell.style) : col.style,
      };
    }
    return {
      text: safe(cell === undefined || cell === null ? '' : cell, c.ascii),
      style: col.style,
    };
  }));

  const labels = cols.map((col) => safe(col.label, c.ascii));
  const widths = cols.map((col, i) => {
    let w = width(labels[i]);
    for (const cells of body) w = Math.max(w, width(cells[i].text));
    w = Math.max(w, col.min);
    return Math.max(1, Math.min(w, col.max));
  });

  // shrink the widest flexible column until the table fits the terminal
  const budget = Math.max(20, c.cols);
  const total = () => widths.reduce((a, b) => a + b, 0) + TABLE_GAP * (cols.length - 1);
  let guard = 0;
  while (total() > budget && guard < 4096) {
    guard += 1;
    let widest = -1;
    for (let i = 0; i < widths.length; i += 1) {
      if (widths[i] <= Math.max(3, cols[i].min)) continue;
      if (widest === -1 || widths[i] > widths[widest]) widest = i;
    }
    if (widest === -1) break;
    widths[widest] -= 1;
  }

  /**
   * Lay one row of cells out on a single line.
   * @param {Array<{text:string, style:string|null}>} cells the row's cells
   * @returns {string} the rendered line
   */
  const render = (cells) => cells.map((cell, i) => {
    const cut = truncate(cell.text, widths[i], g.ellipsis);
    let placed;
    if (cols[i].align === 'right') placed = padStart(cut, widths[i]);
    else if (i === cols.length - 1) placed = cut;
    else placed = padEnd(cut, widths[i]);
    return cell.style ? style.paint(placed, cell.style) : placed;
  }).join(' '.repeat(TABLE_GAP));

  const out = [];
  if (labels.some((l) => l !== '')) {
    out.push(render(labels.map((label) => ({ text: label, style: 'muted' }))));
  }
  for (const cells of body) out.push(render(cells));
  return out;
}
