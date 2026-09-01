// src/screen.js — the impure half of the terminal: the flicker-free single-write
// painter, the raw-mode picker, the no-raw numbered fallback, the text prompt and
// the confirmation. It owns raw mode and the cursor: the cursor always comes back.

import fs from 'node:fs';
import { createInterface } from 'node:readline';

import { fail } from './ctx.js';
import { detectCaps, interactivity } from './tty.js';
import {
  asciify,
  buildMenu,
  createKeyReader,
  decodeKeys,
  fit,
  makeGlyphs,
  makeStyle,
  padEnd,
  width,
} from './ui.js';

const ESC = String.fromCharCode(27);
const ETX = String.fromCharCode(3);
const EOT = String.fromCharCode(4);
const CSI = `${ESC}[`;
const SHOW_CURSOR = `${CSI}?25h`;
const HIDE_CURSOR = `${CSI}?25l`;

/** Every screen ever built, so the exit handler can restore all of them. */
const LIVE = new Set();

/** Sent by the escape-flush timer; never produced by a terminal. */
const FLUSH = Symbol('cam.flushPendingEscape');

/**
 * How long to hold a partial escape sequence before deciding it was a lone Esc.
 * Long enough to survive a split delivery over ssh, short enough that Esc still
 * feels instant — and far below readline's own 500 ms escape timeout.
 */
const ESC_FLUSH_MS = 40;

/**
 * Pair a stateful key reader with the timer that decides a held escape sequence
 * was a lone Esc after all. Every interactive prompt gets its own.
 * @param {Function} getOnData returns the live data handler to re-enter
 * @returns {{ reader: object, arm(): void, clear(): void }} the pump
 */
function makeEscFlush(getOnData) {
  const reader = createKeyReader();
  let timer = null;

  const clear = () => {
    if (timer === null) return;
    try {
      clearTimeout(timer);
    } catch {
      // already fired
    }
    timer = null;
  };

  const arm = () => {
    clear();
    if (reader.pending() === '') return;
    timer = setTimeout(() => {
      timer = null;
      const fn = getOnData();
      if (typeof fn === 'function') fn(FLUSH);
    }, ESC_FLUSH_MS);
    // Never hold the event loop open for a keystroke that is not coming.
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  return { reader, arm, clear };
}

/**
 * True once this process has actually hidden the cursor on a real terminal.
 * Restoring a cursor we never hid would write a bare `ESC[?25h` into whatever
 * stderr happens to be — a file, a pipe, a CI log — where it shows up as
 * literal `[?25h` text. Only undo what we did.
 */
let cursorHidden = false;

/** screen object -> its private machinery. Keeps the public shape exact. */
const INTERNALS = new WeakMap();

// ── low-level plumbing ──────────────────────────────────────────────────────

/**
 * Write synchronously to a file descriptor, swallowing every failure.
 * Node documents Windows TTY writes as asynchronous, so exit-time restores
 * must go through writeSync or they are simply dropped.
 * @param {number} fd file descriptor to write to
 * @param {string} s bytes to write
 * @returns {void}
 */
function writeSyncSafe(fd, s) {
  try {
    fs.writeSync(fd, s);
  } catch {
    try {
      fs.writeSync(2, s);
    } catch {
      // The terminal is gone; there is nothing left to restore it with.
    }
  }
}

/**
 * Apply one named style, tolerating a style object that lacks it.
 * @param {any} style the object from makeStyle
 * @param {string} name style name ('faint', 'red', 'accent', …)
 * @param {string} s text to paint
 * @returns {string} painted text, or the text unchanged
 */
function sty(style, name, s) {
  try {
    if (style && typeof style[name] === 'function') return String(style[name](s));
    if (style && typeof style.paint === 'function') return String(style.paint(s, name));
  } catch {
    // A styling failure must never take the frame down with it.
  }
  return s;
}

/**
 * Whether this capability set wants pure 7-bit output.
 * @param {any} caps capability record from detectCaps
 * @returns {boolean} true when unicode must be folded away
 */
function wantsAscii(caps) {
  if (!caps) return true;
  if (caps.ascii === true) return true;
  return caps.unicode !== true;
}

/**
 * Fold a composed line to ascii when the terminal cannot draw unicode.
 * @param {any} caps capability record from detectCaps
 * @param {string} s text to fold
 * @returns {string} the original or asciified text
 */
function flat(caps, s) {
  if (!wantsAscii(caps)) return s;
  try {
    return asciify(s);
  } catch {
    return s;
  }
}

/**
 * Box-drawing characters this module owns (ui.js owns the menu and table frames).
 * @param {any} caps capability record from detectCaps
 * @returns {{tl:string,tr:string,bl:string,br:string,h:string,v:string,arrow:string,caret:string,cross:string,enter:string,cursor:string,active:string,idle:string}} the kit
 */
function boxKit(caps) {
  if (wantsAscii(caps)) {
    return {
      tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|',
      arrow: '>', caret: '_', cross: 'x', enter: 'Enter',
      cursor: '>', active: '*', idle: 'o',
    };
  }
  return {
    tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│',
    arrow: '›', caret: '▏', cross: '✗', enter: '↵',
    cursor: '▸', active: '●', idle: '○',
  };
}

/**
 * Display width of a plain string, falling back to code-unit length.
 * @param {string} s text to measure
 * @returns {number} number of terminal columns
 */
function cols(s) {
  try {
    const n = width(s);
    return Number.isFinite(n) ? n : String(s).length;
  } catch {
    return String(s).length;
  }
}

/**
 * Pad a plain string to an exact column count.
 * @param {string} s text to pad
 * @param {number} n target columns
 * @returns {string} the padded text
 */
function pad(s, n) {
  try {
    const r = padEnd(s, n);
    if (typeof r === 'string') return r;
  } catch {
    // fall through to the local implementation
  }
  const short = n - cols(s);
  return short > 0 ? s + ' '.repeat(short) : s;
}

/**
 * Truncate a plain string to an exact column count.
 * @param {string} s text to clip
 * @param {number} n maximum columns
 * @param {string} ell ellipsis to append when clipped
 * @returns {string} the clipped text
 */
function clip(s, n, ell) {
  try {
    const r = fit(s, n, ell);
    if (typeof r === 'string') return r;
  } catch {
    // fall through to the local implementation
  }
  const str = String(s);
  return cols(str) <= n ? str : str.slice(0, Math.max(0, n - ell.length)) + ell;
}

// ── key decoding ────────────────────────────────────────────────────────────

/**
 * Minimal decoder used only when ui.decodeKeys cannot read this chunk.
 * @param {string} chunk raw bytes from a raw-mode stdin, as utf8
 * @returns {Array<{name:string,ctrl:boolean,sequence:string}>} decoded keys
 */
function fallbackDecode(chunk) {
  const s = typeof chunk === 'string' ? chunk : String(chunk);
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ESC && s[i + 1] === '[') {
      const rest = s.slice(i + 2);
      const m = /^(\d*)(?:;\d+)?([A-Za-z~])/.exec(rest);
      if (m) {
        const num = m[1];
        const fin = m[2];
        let name = '';
        if (fin === 'A') name = 'up';
        else if (fin === 'B') name = 'down';
        else if (fin === 'C') name = 'right';
        else if (fin === 'D') name = 'left';
        else if (fin === 'H') name = 'home';
        else if (fin === 'F') name = 'end';
        else if (fin === '~' && (num === '1' || num === '7')) name = 'home';
        else if (fin === '~' && (num === '4' || num === '8')) name = 'end';
        else if (fin === '~' && num === '3') name = 'delete';
        out.push({ name, ctrl: false, sequence: ESC + '[' + m[0] });
        i += 2 + m[0].length;
        continue;
      }
    }
    if (c === ESC && s[i + 1] === 'O' && s[i + 2]) {
      const fin = s[i + 2];
      const name = fin === 'A' ? 'up' : fin === 'B' ? 'down' : fin === 'C' ? 'right'
        : fin === 'D' ? 'left' : fin === 'H' ? 'home' : fin === 'F' ? 'end' : '';
      out.push({ name, ctrl: false, sequence: s.slice(i, i + 3) });
      i += 3;
      continue;
    }
    if (c === ESC) {
      out.push({ name: 'escape', ctrl: false, sequence: ESC });
      i += 1;
      continue;
    }
    const code = s.charCodeAt(i);
    if (c === '\r' || c === '\n') out.push({ name: 'return', ctrl: false, sequence: c });
    else if (c === '\t') out.push({ name: 'tab', ctrl: false, sequence: c });
    else if (code === 127 || code === 8) out.push({ name: 'backspace', ctrl: false, sequence: c });
    else if (code > 0 && code < 27) {
      out.push({ name: String.fromCharCode(code + 96), ctrl: true, sequence: c });
    } else {
      out.push({ name: c, ctrl: false, sequence: c });
    }
    i += 1;
  }
  return out;
}

/**
 * Normalise one decoded key into the shape this module matches on.
 * @param {any} k a key from ui.decodeKeys or fallbackDecode
 * @returns {{name:string,ctrl:boolean,ch:string,seq:string}|null} normalised key
 */
function normKey(k) {
  if (k === null || k === undefined) return null;
  if (typeof k === 'string') {
    return { name: k.length === 1 ? '' : k, ctrl: false, ch: k.length === 1 ? k : '', seq: k };
  }
  const name = typeof k.name === 'string' ? k.name : '';
  let seq = '';
  if (typeof k.sequence === 'string') seq = k.sequence;
  else if (typeof k.ch === 'string') seq = k.ch;
  else if (typeof k.char === 'string') seq = k.char;
  else if (typeof k.str === 'string') seq = k.str;
  const ctrl = k.ctrl === true;
  let ch = '';
  if (seq.length === 1 && seq.charCodeAt(0) >= 32 && seq.charCodeAt(0) !== 127) ch = seq;
  else if (!ctrl && name.length === 1 && name !== ESC) ch = name;
  return { name, ctrl, ch, seq };
}

/**
 * Decode a raw stdin chunk into normalised keys.
 * @param {string|Buffer} chunk bytes read from stdin in raw mode
 * @returns {Array<{name:string,ctrl:boolean,ch:string,seq:string}>} normalised keys
 */
function readKeys(chunk, reader) {
  // The flush sentinel: a timer sends it when a partial escape sequence has
  // been held long enough that it is almost certainly a lone Esc keypress.
  if (chunk === FLUSH) {
    const out = [];
    for (const k of (reader ? reader.flush() : [])) {
      const n = normKey(k);
      if (n) out.push(n);
    }
    return out;
  }

  const text = typeof chunk === 'string' ? chunk : String(chunk);
  let raw = null;
  try {
    raw = reader ? reader.push(text) : decodeKeys(text);
  } catch {
    raw = null;
  }
  // A stateful reader legitimately returns [] while it holds an incomplete
  // sequence, so only the stateless path may fall back to the byte decoder.
  if (!Array.isArray(raw)) raw = fallbackDecode(text);
  else if (!reader && raw.length === 0 && text.length > 0) raw = fallbackDecode(text);
  const out = [];
  for (const k of raw) {
    const n = normKey(k);
    if (n) out.push(n);
  }
  return out;
}

/**
 * True when this key means "abort the whole program" (ctrl+c / ctrl+d).
 * @param {{name:string,ctrl:boolean,ch:string,seq:string}} k normalised key
 * @returns {boolean} whether to abort with exit 130
 */
function isAbort(k) {
  if (k.ctrl && (k.name === 'c' || k.name === 'd')) return true;
  return k.seq === ETX || k.seq === EOT;
}

/**
 * True when this key means Enter (CR or LF).
 * @param {{name:string,ctrl:boolean,ch:string,seq:string}} k normalised key
 * @returns {boolean} whether the key accepts
 */
function isEnter(k) {
  if (k.name === 'return' || k.name === 'enter' || k.name === 'linefeed') return true;
  return k.name === '' && (k.seq === '\r' || k.seq === '\n');
}

/**
 * True when this key means Escape.
 * @param {{name:string,ctrl:boolean,ch:string,seq:string}} k normalised key
 * @returns {boolean} whether the key cancels
 */
function isEscape(k) {
  if (k.name === 'escape' || k.name === 'esc') return true;
  return k.seq === ESC && k.name === '';
}

// ── item helpers (the row shape the commands hand us) ───────────────────────

/**
 * Whether a row can hold the cursor.
 * @param {any} item a row handed to select()
 * @returns {boolean} true for normal, non-separator, non-disabled rows
 */
function isSelectable(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.disabled === true) return false;
  if (item.separator === true) return false;
  return item.kind !== 'separator' && item.kind !== 'spacer' && item.kind !== 'rule';
}

/**
 * Whether a row is the "add an account" action row.
 * @param {any} item a row handed to select()
 * @returns {boolean} true for the add row
 */
function isAdd(item) {
  if (!item || typeof item !== 'object') return false;
  return item.kind === 'add' || item.action === 'add' || item.name === '+add';
}

/**
 * The stable identifier of a row.
 * @param {any} item a row handed to select()
 * @returns {string} the row name, or an empty string
 */
function itemName(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.name === 'string') return item.name;
  if (item.profile && typeof item.profile.name === 'string') return item.profile.name;
  return '';
}

/**
 * The primary text of a row.
 * @param {any} item a row handed to select()
 * @param {(key: string, vars?: Record<string, unknown>) => string} t translator
 * @returns {string} the label
 */
function itemLabel(item, t) {
  if (!item || typeof item !== 'object') return '';
  if (isAdd(item)) return typeof item.label === 'string' ? item.label : t('menu.add');
  for (const key of ['label', 'title', 'text']) {
    if (typeof item[key] === 'string' && item[key]) return item[key];
  }
  return itemName(item);
}

/**
 * The secondary text of a row (email · plan · org).
 * @param {any} item a row handed to select()
 * @returns {string} the metadata, or an empty string
 */
function itemMeta(item) {
  if (!item || typeof item !== 'object') return '';
  for (const key of ['meta', 'detail', 'subtitle', 'description']) {
    if (typeof item[key] === 'string' && item[key]) return item[key];
  }
  return '';
}

/**
 * The right-hand tag of a row (last used, health warning).
 * @param {any} item a row handed to select()
 * @param {(key: string, vars?: Record<string, unknown>) => string} t translator
 * @returns {string} the tag, or an empty string
 */
function itemTag(item, t) {
  if (!item || typeof item !== 'object') return '';
  for (const key of ['tag', 'note', 'right']) {
    if (typeof item[key] === 'string' && item[key]) return item[key];
  }
  if (item.lastUsed === true) return t('pick.lastUsedTag');
  return '';
}

// ── the screen ──────────────────────────────────────────────────────────────

/**
 * Build the painter for one output stream (stderr by default, always).
 * Everything cam draws goes to stderr so `claude -p x > out` stays byte-clean.
 * @param {any} ctx the injected context
 * @param {{ stream?: any }} [opts] the stream to paint on
 * @returns {{caps:any,style:any,glyphs:any,paint:(lines:string[])=>void,erase:()=>void,note:(text:string)=>void,out:(text:string)=>void,refresh:()=>void,teardown:()=>void}} the screen
 */
export function createScreen(ctx, { stream = ctx.io.err } = {}) {
  const target = stream || ctx.io.err;
  const fd = target && typeof target.fd === 'number' ? target.fd : 2;
  let caps = detectCaps(ctx, target);
  const style = makeStyle(caps);
  const glyphs = makeGlyphs(!wantsAscii(caps));

  let painted = 0;
  let lastLines = [];
  const disposers = new Set();

  /**
   * Write to the stream, swallowing EPIPE and friends.
   * @param {string} s bytes to write
   * @returns {void}
   */
  const raw = (s) => {
    try {
      target.write(s);
    } catch {
      // A closed pipe is not an error the user can act on.
    }
  };

  /**
   * Whether escape sequences are safe on this stream.
   * @returns {boolean} true when the stream is a real terminal
   */
  const ansi = () => screen.caps && screen.caps.isTTY === true;

  /**
   * Paint one frame with a single write: no tearing, no flicker.
   * @param {string[]|string} lines the complete frame
   * @returns {void}
   */
  const paint = (lines) => {
    const arr = (Array.isArray(lines) ? lines : [lines]).map((l) => (l === null || l === undefined ? '' : String(l)));
    lastLines = arr;
    if (!ansi()) {
      if (arr.length) raw(`${arr.join('\n')}\n`);
      painted = 0;
      return;
    }
    let buf = painted > 0 ? `${CSI}${painted}A` : '';
    buf += `${CSI}G`;
    for (const line of arr) buf += `${line}${CSI}K\n`;
    buf += `${CSI}J`;
    painted = arr.length;
    raw(buf);
  };

  /**
   * Remove the painted region and leave the cursor where the frame started.
   * @returns {void}
   */
  const erase = () => {
    if (painted > 0 && ansi()) raw(`${CSI}${painted}A${CSI}G${CSI}J`);
    painted = 0;
    lastLines = [];
  };

  /**
   * Print one persistent line, dropping any live frame first.
   * @param {string} text the line, already translated
   * @returns {void}
   */
  const note = (text) => {
    erase();
    raw(`${text === null || text === undefined ? '' : String(text)}\n`);
  };

  /**
   * Print text verbatim, dropping any live frame first.
   * @param {string} text the text, already translated
   * @returns {void}
   */
  const out = (text) => {
    erase();
    raw(text === null || text === undefined ? '' : String(text));
  };

  /**
   * Re-measure the terminal, forget the painted region and repaint.
   * Called on resize: after a reflow our row accounting is not trustworthy.
   * @returns {void}
   */
  const refresh = () => {
    let fresh = null;
    try {
      fresh = detectCaps(ctx, target);
    } catch {
      fresh = null;
    }
    if (fresh && fresh !== caps) {
      if (Object.isFrozen(caps)) {
        caps = fresh;
        screen.caps = fresh;
      } else {
        for (const k of Object.keys(fresh)) {
          try {
            caps[k] = fresh[k];
          } catch {
            // exotic accessor; keep the old value
          }
        }
      }
    }
    const keep = lastLines;
    painted = 0;
    if (keep.length) paint(keep);
  };

  /**
   * Release the terminal: listeners off, raw mode off, stdin paused, cursor back.
   * Safe to call any number of times, from anywhere, including an exit handler.
   * @returns {void}
   */
  const teardown = () => {
    for (const d of [...disposers]) {
      try {
        d();
      } catch {
        // a disposer must never block the restore that follows
      }
    }
    disposers.clear();
    const input = ctx.io.in;
    try {
      if (input && typeof input.setRawMode === 'function' && input.isRaw) input.setRawMode(false);
    } catch {
      // stdin may already be gone
    }
    try {
      if (input && typeof input.pause === 'function') input.pause();
    } catch {
      // stdin may already be gone
    }
    if (cursorHidden) {
      writeSyncSafe(fd, SHOW_CURSOR);
      cursorHidden = false;
    }
  };

  const screen = { caps, style, glyphs, paint, erase, note, out, refresh, teardown };

  INTERNALS.set(screen, {
    stream: target,
    fd,
    raw,
    addDisposer: (fn) => disposers.add(fn),
    removeDisposer: (fn) => disposers.delete(fn),
  });
  LIVE.add(teardown);

  return screen;
}

/**
 * Restore every terminal cam touched, synchronously.
 * Registered on process.on('exit') by the CLI: only synchronous work runs there,
 * and Windows TTY writes are asynchronous, hence writeSync.
 * @returns {void}
 */
export function restoreCursorSync() {
  for (const fn of [...LIVE]) {
    try {
      fn();
    } catch {
      // keep restoring the other screens
    }
  }
  if (cursorHidden) {
    writeSyncSafe(2, SHOW_CURSOR);
    cursorHidden = false;
  }
}

// ── the raw-mode picker ─────────────────────────────────────────────────────

/**
 * Choose the starting cursor row.
 * @param {number[]} order selectable row indexes
 * @param {number} index the preferred row index
 * @returns {number} a selectable row index
 */
function startCursor(order, index) {
  const want = Number.isInteger(index) ? index : 0;
  if (order.indexOf(want) !== -1) return want;
  for (const i of order) if (i >= want) return i;
  return order[0];
}

/**
 * Last-resort menu frame, used only if ui.buildMenu cannot render this state.
 * @param {any} ctx the injected context
 * @param {any[]} items the rows
 * @param {number} index the cursor row index
 * @param {any} caps capability record
 * @returns {string[]} the frame
 */
function plainMenuLines(ctx, items, index, caps) {
  const kit = boxKit(caps);
  const lines = [flat(caps, ctx.t('menu.title'))];
  let nameCols = 0;
  for (const item of items) nameCols = Math.max(nameCols, cols(itemLabel(item, ctx.t)));
  nameCols = Math.min(nameCols, 24);
  let hotkey = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!isSelectable(item)) {
      lines.push('');
      continue;
    }
    const add = isAdd(item);
    if (!add) hotkey += 1;
    const cursor = i === index ? kit.cursor : ' ';
    const mark = add ? '+' : (item.active === true ? kit.active : kit.idle);
    const label = pad(clip(itemLabel(item, ctx.t), nameCols, '...'), nameCols);
    const meta = itemMeta(item);
    const tag = itemTag(item, ctx.t);
    const key = add ? 'a' : String(hotkey);
    const parts = [`${cursor} ${mark} ${label}`, meta, tag, key].filter((p) => p !== '');
    lines.push(flat(caps, parts.join('  ')));
  }
  lines.push(flat(caps, ctx.t('menu.footer', {
    updown: ctx.t('key.updown', { up: wantsAscii(caps) ? '^' : '↑', down: wantsAscii(caps) ? 'v' : '↓' }),
    enter: wantsAscii(caps) ? ctx.t('key.enter') : '↵',
  })));
  return lines;
}

/**
 * The raw-mode account picker: arrows, digits, a and q. Painted on stderr.
 * Cancels with null on q/Esc; ctx-level CANCELLED (exit 130) on ctrl+c/ctrl+d.
 * @param {any} ctx the injected context
 * @param {any} screen a screen from createScreen
 * @param {{ items?: any[], index?: number }} opts the rows and the preselected row
 * @returns {Promise<any|null>} the chosen row, or null when the user quit
 */
export function select(ctx, screen, opts = {}) {
  const items = Array.isArray(opts.items) ? opts.items : [];
  const order = [];
  for (let i = 0; i < items.length; i += 1) if (isSelectable(items[i])) order.push(i);
  if (order.length === 0) return Promise.resolve(null);

  const internals = INTERNALS.get(screen) || {};
  const stream = internals.stream || ctx.io.err;
  const rawWrite = typeof internals.raw === 'function' ? internals.raw : () => {};
  const input = ctx.io.in;
  const hot = order.filter((i) => !isAdd(items[i]));
  const addRow = items.find((it) => isAdd(it) && isSelectable(it)) || null;

  let cursor = startCursor(order, opts.index);

  return new Promise((resolve, reject) => {
    let settled = false;
    let onData = null;
    const esc = makeEscFlush(() => onData);
    let onResize = null;

    const detach = () => {
      if (onData && input && typeof input.removeListener === 'function') {
        try {
          input.removeListener('data', onData);
        } catch {
          // the stream may already be destroyed
        }
      }
      if (onResize && stream && typeof stream.removeListener === 'function') {
        try {
          stream.removeListener('resize', onResize);
        } catch {
          // the stream may already be destroyed
        }
      }
      esc.clear();
      onData = null;
      onResize = null;
    };

    const cleanup = () => {
      detach();
      if (typeof internals.removeDisposer === 'function') internals.removeDisposer(detach);
      try {
        screen.erase();
      } catch {
        // nothing left to erase
      }
      try {
        screen.teardown();
      } catch {
        // the restore is best effort by design
      }
    };

    const done = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const abort = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const render = () => {
      let lines = null;
      try {
        lines = buildMenu({ ...opts, items, index: cursor, cursor, caps: screen.caps }, screen.caps);
      } catch {
        lines = null;
      }
      if (!Array.isArray(lines) || lines.length === 0) {
        lines = plainMenuLines(ctx, items, cursor, screen.caps);
      }
      screen.paint(lines);
    };

    const move = (delta) => {
      const at = order.indexOf(cursor);
      const next = (at + delta + order.length) % order.length;
      cursor = order[next];
      render();
    };

    onData = (chunk) => {
      let keys = [];
      try {
        keys = readKeys(chunk, esc.reader);
      } catch {
        keys = [];
      }
      esc.arm();
      for (const k of keys) {
        if (settled) return;
        if (isAbort(k)) {
          abort(cancelledError(ctx));
          return;
        }
        if (isEscape(k) || (k.ch === 'q' && !k.ctrl)) {
          done(null);
          return;
        }
        if (isEnter(k)) {
          done(items[cursor]);
          return;
        }
        if (k.name === 'up' || (k.ch === 'k' && !k.ctrl) || (k.ctrl && k.name === 'p')) {
          move(-1);
          continue;
        }
        if (k.name === 'down' || k.name === 'tab' || (k.ch === 'j' && !k.ctrl) || (k.ctrl && k.name === 'n')) {
          move(1);
          continue;
        }
        if (k.name === 'home') {
          cursor = order[0];
          render();
          continue;
        }
        if (k.name === 'end') {
          cursor = order[order.length - 1];
          render();
          continue;
        }
        if (!k.ctrl && /^[1-9]$/.test(k.ch)) {
          const tagged = items.findIndex((it) => isSelectable(it) && String(it.hotkey || '') === k.ch);
          const target = tagged !== -1 ? tagged : hot[Number(k.ch) - 1];
          if (target !== undefined) {
            cursor = target;
            done(items[target]);
            return;
          }
          continue;
        }
        if (!k.ctrl && k.ch === 'a' && addRow) {
          done(addRow);
          return;
        }
      }
    };

    onResize = () => {
      if (settled) return;
      try {
        screen.refresh();
      } catch {
        // a resize we cannot measure is not fatal
      }
      render();
    };

    try {
      if (!input || typeof input.on !== 'function') {
        // interactivity() promised a raw terminal and stdin cannot deliver one:
        // say so loudly rather than waiting for a keypress that can never arrive.
        abort(cannotAskError(ctx, ctx.t('pick.reason.notATty')));
        return;
      }
      if (typeof internals.addDisposer === 'function') internals.addDisposer(detach);
      if (input && typeof input.setRawMode === 'function') input.setRawMode(true);
      if (input && typeof input.setEncoding === 'function') input.setEncoding('utf8');
      if (input && typeof input.resume === 'function') input.resume();
      if (input && typeof input.on === 'function') input.on('data', onData);
      if (stream && typeof stream.on === 'function') stream.on('resize', onResize);
      // Only a real terminal gets escape bytes: with stderr redirected to a file
      // the menu still works, and the file stays free of control sequences.
      if (screen.caps && screen.caps.isTTY === true) {
        rawWrite(HIDE_CURSOR);
        cursorHidden = true;
      }
      render();
    } catch (e) {
      abort(e);
    }
  });
}

/**
 * Build the CANCELLED error every ctrl+c path throws.
 * @param {any} ctx the injected context
 * @returns {Error} the CamError, ready to throw
 */
function cancelledError(ctx) {
  try {
    fail('CANCELLED', ctx.t('err.cancelled'), { hint: ctx.t('err.cancelledHint') });
  } catch (e) {
    return e;
  }
  return new Error('CANCELLED');
}

/**
 * Build the USAGE error a prompt raises instead of hanging without a terminal.
 * @param {any} ctx the injected context
 * @param {string} reason the already-translated reason asking is impossible
 * @returns {Error} the CamError, ready to throw
 */
function cannotAskError(ctx, reason) {
  try {
    fail('USAGE', ctx.t('launch.cannotAsk', { reason }), { hint: ctx.t('prompt.needsYes') });
  } catch (e) {
    return e;
  }
  return new Error('USAGE');
}

// ── the numbered fallback (git-bash / mintty) ───────────────────────────────

/**
 * One shared readline interface for a whole retry loop, resolving to null on EOF
 * instead of hanging. A second interface would swallow buffered input.
 * @param {any} ctx the injected context
 * @param {any} stream the stream the prompt is written to
 * @returns {{ask: (prompt: string) => Promise<string|null>, close: () => void}} the reader
 */
function lineReader(ctx, stream) {
  const rl = createInterface({ input: ctx.io.in, output: stream, terminal: false });
  const queue = [];
  const waiting = [];
  let closed = false;

  // Every line is queued rather than requested one at a time: readline consumes
  // whatever is already buffered on stdin and emits it whether or not a question
  // is pending, so anything typed ahead would otherwise be silently dropped and
  // the next question would wait forever for a line that was already read.
  rl.on('line', (l) => {
    if (waiting.length) waiting.shift()(String(l));
    else queue.push(String(l));
  });
  rl.once('close', () => {
    closed = true;
    while (waiting.length) waiting.shift()(null);
  });

  return {
    /**
     * Ask one question on the shared interface.
     * @param {string} prompt the already-translated prompt text
     * @returns {Promise<string|null>} the line, or null at end of input
     */
    ask(prompt) {
      try {
        stream.write(prompt);
      } catch {
        // a closed pipe is not an error the user can act on
      }
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
    /**
     * Release the interface and pause stdin again.
     * @returns {void}
     */
    close() {
      try {
        rl.close();
      } catch {
        // already closed
      }
      try {
        if (ctx.io.in && typeof ctx.io.in.pause === 'function') ctx.io.in.pause();
      } catch {
        // stdin may already be gone
      }
    },
  };
}

/**
 * The zero-ANSI numbered picker: the only menu MSYS/mintty terminals can show.
 * @param {any} ctx the injected context
 * @param {any} screen a screen from createScreen
 * @param {{ items?: any[], index?: number }} opts the rows and the preselected row
 * @returns {Promise<any|null>} the chosen row, or null when the user quit
 */
export async function selectLine(ctx, screen, opts = {}) {
  const items = Array.isArray(opts.items) ? opts.items : [];
  const order = [];
  for (let i = 0; i < items.length; i += 1) if (isSelectable(items[i])) order.push(i);
  if (order.length === 0) return null;

  const internals = INTERNALS.get(screen) || {};
  const stream = internals.stream || ctx.io.err;
  const caps = screen.caps;
  const t = ctx.t;
  const addRow = items.find((it) => isAdd(it) && isSelectable(it)) || null;
  const hot = order.filter((i) => !isAdd(items[i]));
  const start = startCursor(order, opts.index);
  const defaultHot = Math.max(0, hot.indexOf(start)) + 1;

  screen.erase();
  const head = [];
  if (caps && caps.isTTY === true) {
    head.push(flat(caps, t('pick.header')));
  } else {
    head.push(flat(caps, `${t('launch.prefix')} ${t('pick.notty')}`));
    head.push(flat(caps, `     ${t('pick.nottyHint')}`));
  }

  let nameCols = 0;
  for (const i of hot) nameCols = Math.max(nameCols, cols(itemLabel(items[i], t)));
  nameCols = Math.min(Math.max(nameCols, 6), 20);

  // Tags line up in one column, so "! expires in 4d" is readable down the list.
  const budget = Math.max(20, (Number(caps && caps.cols) > 0 ? caps.cols : 80) - nameCols - 24);
  let metaCols = 0;
  let anyTag = false;
  for (const i of hot) {
    metaCols = Math.max(metaCols, cols(clip(itemMeta(items[i]), budget, '...')));
    if (itemTag(items[i], t) !== '') anyTag = true;
  }

  const body = [];
  for (let n = 0; n < hot.length; n += 1) {
    const item = items[hot[n]];
    const label = pad(clip(itemLabel(item, t), nameCols, '...'), nameCols);
    const tag = itemTag(item, t);
    let meta = clip(itemMeta(item), budget, '...');
    if (anyTag && tag !== '') meta = pad(meta, metaCols);
    const parts = [`  ${n + 1}) ${label}`, meta, tag].filter((p) => p !== '');
    body.push(flat(caps, parts.join('  ')));
  }
  const tail = addRow ? `  ${t('pick.addRow')}     ${t('pick.quitRow')}` : `  ${t('pick.quitRow')}`;
  body.push(flat(caps, tail));

  for (const line of head.concat(body)) screen.note(line);

  // One interface for the whole retry loop: a second one would swallow input
  // already buffered on stdin and then wait forever for a line that never comes.
  const reader = lineReader(ctx, stream);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await reader.ask(flat(caps, t('pick.choice', { def: String(defaultHot) })));
      if (answer === null) return null;
      const value = String(answer).trim();
      if (value === '') return items[start];
      const low = value.toLowerCase();
      if (low === 'q') return null;
      if (low === 'a' && addRow) return addRow;
      if (/^[0-9]+$/.test(value)) {
        const at = Number(value) - 1;
        if (at >= 0 && at < hot.length) return items[hot[at]];
      } else {
        const named = order.find((i) => itemName(items[i]).toLowerCase() === low);
        if (named !== undefined) return items[named];
      }
      screen.note(flat(caps, `${t('launch.prefix')} ${t('pick.invalid')}`));
    }
    return null;
  } finally {
    reader.close();
  }
}

/**
 * Pick an account with whatever the terminal actually supports.
 * The only entry point commands use; returns null when cam may not ask at all.
 * @param {any} ctx the injected context
 * @param {any} screen a screen from createScreen
 * @param {{ items?: any[], index?: number, mode?: {kind:string,reason:string}, forwarded?: string[] }} opts rows, cursor and an optional precomputed interactivity
 * @returns {Promise<any|null>} the chosen row, or null
 */
export async function pick(ctx, screen, opts = {}) {
  let mode = opts.mode;
  if (!mode || typeof mode.kind !== 'string') {
    mode = interactivity(ctx, { forwarded: Array.isArray(opts.forwarded) ? opts.forwarded : [] });
  }
  if (mode.kind === 'raw') return select(ctx, screen, opts);
  if (mode.kind === 'line') return selectLine(ctx, screen, opts);
  return null;
}

// ── the text prompt ─────────────────────────────────────────────────────────

/**
 * Frame one prompt: a title bar, the label, the field and one hint or error.
 * @param {any} ctx the injected context
 * @param {any} caps capability record
 * @param {any} style the object from makeStyle
 * @param {{title?:string,label:string,value:string,cursorAt:number,hint:string,error:string}} model what to draw
 * @returns {string[]} the frame
 */
function promptFrame(ctx, caps, style, model) {
  const kit = boxKit(caps);
  const total = Math.max(40, Math.min(Number(caps && caps.cols) > 0 ? caps.cols : 80, 76));
  const inner = total - 4;
  const value = model.value;
  const at = Math.max(0, Math.min(model.cursorAt, value.length));
  const field = `${value.slice(0, at)}${kit.caret}${value.slice(at)}`;
  const lines = [];

  const title = model.title ? ` ${clip(flat(caps, model.title), inner, '...')} ` : '';
  const titleCols = cols(title);
  const bar = kit.h.repeat(Math.max(0, total - 3 - titleCols));
  lines.push(sty(style, 'faint', `${kit.tl}${kit.h}${title}${bar}${kit.tr}`));

  // Every row is padded as PLAIN text and only then wrapped in one style, so a
  // display-width helper never has to measure an escape sequence.
  const row = (text) => `${sty(style, 'faint', kit.v)} ${pad(clip(text, inner, '...'), inner)} ${sty(style, 'faint', kit.v)}`;

  lines.push(row(flat(caps, model.label)));
  lines.push(row(`  ${kit.arrow}  ${flat(caps, field)}`));
  if (model.error) {
    lines.push(`${sty(style, 'faint', kit.v)} ${sty(style, 'red', pad(clip(`     ${kit.cross} ${flat(caps, model.error)}`, inner, '...'), inner))} ${sty(style, 'faint', kit.v)}`);
  } else if (model.hint) {
    lines.push(`${sty(style, 'faint', kit.v)} ${sty(style, 'faint', pad(clip(`     ${flat(caps, model.hint)}`, inner, '...'), inner))} ${sty(style, 'faint', kit.v)}`);
  }
  lines.push(sty(style, 'faint', `${kit.bl}${kit.h.repeat(Math.max(0, total - 2))}${kit.br}`));
  lines.push(sty(style, 'faint', flat(caps, `  ${ctx.t('prompt.footerText', {
    enter: wantsAscii(caps) ? ctx.t('key.enter') : kit.enter,
    esc: ctx.t('key.esc'),
  })}`)));
  return lines;
}

/**
 * Run a validator, tolerating a validator that throws or returns nothing.
 * @param {((value: string) => {ok: boolean, reason?: string})|null} validate the validator
 * @param {string} value the current value
 * @returns {{ok: boolean, reason: string}} the verdict
 */
function runValidate(validate, value) {
  if (typeof validate !== 'function') return { ok: true, reason: '' };
  let verdict = null;
  try {
    verdict = validate(value);
  } catch {
    verdict = null;
  }
  if (!verdict || typeof verdict !== 'object') return { ok: true, reason: '' };
  return { ok: verdict.ok !== false, reason: typeof verdict.reason === 'string' ? verdict.reason : '' };
}

/**
 * Ask for one line of text, validating on every keystroke.
 * Esc cancels (null); ctrl+c throws CANCELLED; a non-interactive terminal
 * throws USAGE instead of hanging a CI job forever.
 * @param {any} ctx the injected context
 * @param {any} screen a screen from createScreen
 * @param {{ label?: string, initial?: string, hint?: string, title?: string, validate?: (value: string) => {ok: boolean, reason?: string} }} opts the field
 * @returns {Promise<string|null>} the accepted value, or null when cancelled
 */
export async function textPrompt(ctx, screen, opts = {}) {
  const label = typeof opts.label === 'string' ? opts.label : '';
  const hint = typeof opts.hint === 'string' ? opts.hint : '';
  const title = typeof opts.title === 'string' ? opts.title : '';
  const initial = typeof opts.initial === 'string' ? opts.initial : '';
  const validate = typeof opts.validate === 'function' ? opts.validate : null;

  const mode = interactivity(ctx);
  if (mode.kind === 'none') throw cannotAskError(ctx, mode.reason);

  const internals = INTERNALS.get(screen) || {};
  const stream = internals.stream || ctx.io.err;
  const caps = screen.caps;

  if (mode.kind === 'line') {
    screen.erase();
    if (title) screen.note(flat(caps, title));
    if (label) screen.note(flat(caps, label));
    if (hint) screen.note(flat(caps, `  ${hint}`));
    const kit = boxKit(caps);
    const reader = lineReader(ctx, stream);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const answer = await reader.ask(flat(caps, `  ${kit.arrow} `));
        if (answer === null) return null;
        const value = String(answer).trim() === '' ? initial : String(answer).trim();
        const verdict = runValidate(validate, value);
        if (verdict.ok) return value;
        screen.note(flat(caps, `  ${kit.cross} ${verdict.reason}`));
      }
      return null;
    } finally {
      reader.close();
    }
  }

  const input = ctx.io.in;
  let value = initial;
  let at = value.length;

  return new Promise((resolve, reject) => {
    let settled = false;
    let onData = null;
    const esc = makeEscFlush(() => onData);
    let onResize = null;

    const detach = () => {
      if (onData && input && typeof input.removeListener === 'function') {
        try {
          input.removeListener('data', onData);
        } catch {
          // the stream may already be destroyed
        }
      }
      if (onResize && stream && typeof stream.removeListener === 'function') {
        try {
          stream.removeListener('resize', onResize);
        } catch {
          // the stream may already be destroyed
        }
      }
      esc.clear();
      onData = null;
      onResize = null;
    };

    const cleanup = () => {
      detach();
      if (typeof internals.removeDisposer === 'function') internals.removeDisposer(detach);
      try {
        screen.erase();
      } catch {
        // nothing left to erase
      }
      try {
        screen.teardown();
      } catch {
        // the restore is best effort by design
      }
    };

    const done = (v) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };

    const abort = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const render = () => {
      const verdict = runValidate(validate, value);
      screen.paint(promptFrame(ctx, screen.caps, screen.style, {
        title,
        label,
        value,
        cursorAt: at,
        hint,
        error: verdict.ok ? '' : verdict.reason,
      }));
    };

    onData = (chunk) => {
      let keys = [];
      try {
        keys = readKeys(chunk, esc.reader);
      } catch {
        keys = [];
      }
      esc.arm();
      for (const k of keys) {
        if (settled) return;
        if (isAbort(k)) {
          abort(cancelledError(ctx));
          return;
        }
        if (isEscape(k)) {
          done(null);
          return;
        }
        if (isEnter(k)) {
          if (runValidate(validate, value).ok) {
            done(value);
            return;
          }
          render();
          continue;
        }
        if (k.name === 'backspace') {
          if (at > 0) {
            value = value.slice(0, at - 1) + value.slice(at);
            at -= 1;
          }
          render();
          continue;
        }
        if (k.name === 'delete') {
          if (at < value.length) value = value.slice(0, at) + value.slice(at + 1);
          render();
          continue;
        }
        if (k.ctrl && k.name === 'u') {
          value = '';
          at = 0;
          render();
          continue;
        }
        if (k.ctrl && k.name === 'w') {
          // unix-word-rubout: eat the whitespace under the cursor, then the word,
          // and leave the delimiter before it exactly as readline does.
          const head = value.slice(0, at).replace(/\s+$/, '').replace(/[^\s]+$/, '');
          value = head + value.slice(at);
          at = head.length;
          render();
          continue;
        }
        if (k.name === 'left' || (k.ctrl && k.name === 'b')) {
          at = Math.max(0, at - 1);
          render();
          continue;
        }
        if (k.name === 'right' || (k.ctrl && k.name === 'f')) {
          at = Math.min(value.length, at + 1);
          render();
          continue;
        }
        if (k.name === 'home' || (k.ctrl && k.name === 'a')) {
          at = 0;
          render();
          continue;
        }
        if (k.name === 'end' || (k.ctrl && k.name === 'e')) {
          at = value.length;
          render();
          continue;
        }
        if (!k.ctrl && k.ch && k.ch >= ' ') {
          value = value.slice(0, at) + k.ch + value.slice(at);
          at += k.ch.length;
          render();
        }
      }
    };

    onResize = () => {
      if (settled) return;
      try {
        screen.refresh();
      } catch {
        // a resize we cannot measure is not fatal
      }
      render();
    };

    try {
      if (!input || typeof input.on !== 'function') {
        // interactivity() promised a raw terminal and stdin cannot deliver one:
        // say so loudly rather than waiting for a keypress that can never arrive.
        abort(cannotAskError(ctx, ctx.t('pick.reason.notATty')));
        return;
      }
      if (typeof internals.addDisposer === 'function') internals.addDisposer(detach);
      if (input && typeof input.setRawMode === 'function') input.setRawMode(true);
      if (input && typeof input.setEncoding === 'function') input.setEncoding('utf8');
      if (input && typeof input.resume === 'function') input.resume();
      if (input && typeof input.on === 'function') input.on('data', onData);
      if (stream && typeof stream.on === 'function') stream.on('resize', onResize);
      render();
    } catch (e) {
      abort(e);
    }
  });
}

// ── the confirmation ────────────────────────────────────────────────────────

/**
 * Ask a yes/no question, or require a literal phrase to be typed back.
 * Enter takes the capitalised default; Esc means no; ctrl+c throws CANCELLED;
 * a non-interactive terminal throws USAGE instead of hanging.
 * @param {any} ctx the injected context
 * @param {any} screen a screen from createScreen
 * @param {{ question?: string, def?: boolean, typed?: string|null }} opts the question
 * @returns {Promise<boolean|null>} the answer, or null when the typed phrase did not match
 */
export async function confirm(ctx, screen, { question = '', def = true, typed = null } = {}) {
  const mode = interactivity(ctx);
  if (mode.kind === 'none') throw cannotAskError(ctx, mode.reason);

  const caps = screen.caps;

  if (typeof typed === 'string' && typed !== '') {
    const answer = await textPrompt(ctx, screen, {
      title: question || undefined,
      label: ctx.t('prompt.typeToConfirm', { word: typed }),
      initial: '',
      hint: '',
    });
    if (answer === null) {
      screen.note(flat(caps, ctx.t('prompt.cancelled')));
      return null;
    }
    if (answer.trim() === typed) return true;
    screen.note(flat(caps, ctx.t('prompt.mismatch')));
    return null;
  }

  const yesKey = String(ctx.t('prompt.yesKey') || 'y').toLowerCase();
  const noKey = String(ctx.t('prompt.noKey') || 'n').toLowerCase();
  const marker = def ? ctx.t('prompt.yesNo') : ctx.t('prompt.noYes');
  const head = flat(caps, `${question} ${marker}`);

  const internals = INTERNALS.get(screen) || {};
  const stream = internals.stream || ctx.io.err;

  if (mode.kind === 'line') {
    screen.erase();
    const kit = boxKit(caps);
    const reader = lineReader(ctx, stream);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const answer = await reader.ask(`${head} ${kit.arrow} `);
        if (answer === null) return false;
        const value = String(answer).trim().toLowerCase();
        if (value === '') return def;
        if (value === yesKey || value === 'y') return true;
        if (value === noKey || value === 'n') return false;
        screen.note(flat(caps, `${ctx.t('launch.prefix')} ${ctx.t('pick.invalid')}`));
      }
      return def;
    } finally {
      reader.close();
    }
  }

  const input = ctx.io.in;

  return new Promise((resolve, reject) => {
    let settled = false;
    let onData = null;
    const esc = makeEscFlush(() => onData);

    const detach = () => {
      if (onData && input && typeof input.removeListener === 'function') {
        try {
          input.removeListener('data', onData);
        } catch {
          // the stream may already be destroyed
        }
      }
      esc.clear();
      onData = null;
    };

    const cleanup = () => {
      detach();
      if (typeof internals.removeDisposer === 'function') internals.removeDisposer(detach);
      try {
        screen.erase();
      } catch {
        // nothing left to erase
      }
      try {
        screen.teardown();
      } catch {
        // the restore is best effort by design
      }
    };

    const done = (v) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };

    const abort = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const render = () => {
      const kit = boxKit(screen.caps);
      screen.paint([
        head,
        sty(screen.style, 'faint', flat(screen.caps, `  ${ctx.t('prompt.footerConfirm', {
          enter: wantsAscii(screen.caps) ? ctx.t('key.enter') : kit.enter,
          esc: ctx.t('key.esc'),
        })}`)),
      ]);
    };

    onData = (chunk) => {
      let keys = [];
      try {
        keys = readKeys(chunk, esc.reader);
      } catch {
        keys = [];
      }
      esc.arm();
      for (const k of keys) {
        if (settled) return;
        if (isAbort(k)) {
          abort(cancelledError(ctx));
          return;
        }
        if (isEscape(k)) {
          done(false);
          return;
        }
        if (isEnter(k)) {
          done(def);
          return;
        }
        if (!k.ctrl && k.ch) {
          const c = k.ch.toLowerCase();
          if (c === yesKey || c === 'y') {
            done(true);
            return;
          }
          if (c === noKey || c === 'n') {
            done(false);
            return;
          }
        }
      }
    };

    try {
      if (!input || typeof input.on !== 'function') {
        // interactivity() promised a raw terminal and stdin cannot deliver one:
        // say so loudly rather than waiting for a keypress that can never arrive.
        abort(cannotAskError(ctx, ctx.t('pick.reason.notATty')));
        return;
      }
      if (typeof internals.addDisposer === 'function') internals.addDisposer(detach);
      if (input && typeof input.setRawMode === 'function') input.setRawMode(true);
      if (input && typeof input.setEncoding === 'function') input.setEncoding('utf8');
      if (input && typeof input.resume === 'function') input.resume();
      if (input && typeof input.on === 'function') input.on('data', onData);
      render();
    } catch (e) {
      abort(e);
    }
  });
}
