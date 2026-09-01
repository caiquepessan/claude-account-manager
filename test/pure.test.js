// test/pure.test.js — every pure function and every architectural invariant.
// Constraints, enforced by review and by construction:
//   * node:test + node:assert/strict only, zero dependencies.
//   * NO filesystem writes, NO subprocess, NO network. Source files are READ
//     for the architecture and i18n scans; nothing is ever written.
//   * No Date.now(), no process.env, no os.homedir(): every clock, environment,
//     platform, home and stream is injected through createCtx.
//   * Must stay green on Node 18.17 / 20 / 22 / 24 and on Linux, macOS, Windows.
//
// The filesystem and subprocess suites (create/trash/purge/shell-install/
// launch-end-to-end) live in the sibling test file by design.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, sep } from 'node:path';

import {
  createCtx,
  sanitizeChildEnv,
  describeAmbient,
  CamError,
  isCamError,
  fail,
  EXIT,
  HOSTILE_ENV,
} from '../src/ctx.js';
import {
  MESSAGES,
  LOCALES,
  createT,
  detectLocale,
  missingKeys,
} from '../src/i18n.js';
import {
  width,
  truncate,
  padEnd,
  fit,
  stripAnsi,
  asciify,
  plain,
  makeGlyphs,
  makeStyle,
  createKeyReader,
  decodeKeys,
  buildMenu,
  buildTable,
  statusLine,
  banner,
  errorBlock,
  relativeTime,
  planLabel,
} from '../src/ui.js';
import {
  health,
  validName,
  suggestName,
  storePaths,
  claudePaths,
  defaultClaudePaths,
  SEED_KEYS,
  PROJECT_SUBKEYS,
  ACCOUNT_SCOPED_KEYS,
  SHARE_DIRS,
  SHARE_FILES,
  RESERVED_NAMES,
} from '../src/profiles.js';
import { splitArgs, COMMANDS, helpText } from '../src/cli.js';
import { resolveTarget } from '../src/commands/launch.js';
import { keychainService, detectBackend } from '../src/credstore.js';
import { quoteForCmd, runInherit, exitCodeFor, SIGNUM } from '../src/claude.js';
import { sha256Hex } from '../src/fsx.js';
import { interactivity, detectCaps, isCI } from '../src/tty.js';

// ── fixtures ────────────────────────────────────────────────────────────────

/** The one frozen clock this whole file runs on. Never Date.now(). */
const NOW = 1788000000000;
const DAY = 86400000;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ESC = String.fromCharCode(0x1b);

/** A stream that collects writes instead of touching a terminal. */
function mkStream(over = {}) {
  return {
    isTTY: false,
    data: '',
    write(s) { this.data += String(s); return true; },
    on() { return this; },
    once() { return this; },
    removeListener() { return this; },
    end() {},
    ...over,
  };
}

/** stdin whose setRawMode throws — the "cannot ask" machine. */
function mkStdinNoRaw() {
  return mkStream({
    setRawMode() {
      const e = new Error('ENOTTY');
      e.code = 'ENOTTY';
      throw e;
    },
  });
}

/** stdin whose setRawMode works — the "full menu" machine. */
function mkStdinRaw() {
  return mkStream({ isTTY: true, isRaw: false, setRawMode() {} });
}

/**
 * A complete fake machine. `env` is REPLACED by createCtx, never merged, so a
 * developer machine with CLAUDECODE or CLAUDE_* set cannot leak in here.
 */
function ctxOf(over = {}) {
  const io = over.io || {
    in: mkStdinNoRaw(),
    out: mkStream(),
    err: mkStream(),
  };
  return createCtx({
    platform: 'linux',
    home: '/home/u',
    cwd: '/w',
    now: NOW,
    env: {},
    argv: ['node', '/x/bin/cam.js'],
    version: '9.9.9',
    spawn: () => { throw new Error('spawn is not allowed in the pure suite'); },
    ...over,
    io,
  });
}

/** An interactive fake machine (raw mode available). */
function interactiveCtx(over = {}) {
  return ctxOf({
    ...over,
    io: { in: mkStdinRaw(), out: mkStream(), err: mkStream() },
  });
}

/** Every .js file under a directory, recursively. Read-only. */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const SRC_FILES = jsFiles(join(ROOT, 'src'));
const BIN_FILES = jsFiles(join(ROOT, 'bin'));
const rel = (p) => p.slice(ROOT.length).split(sep).join('/');

// ════════════════════════════════════════════════════════════════════════════
describe('architecture', () => {
  it('finds the source tree it is meant to police', () => {
    assert.ok(SRC_FILES.length >= 12, `expected the full src/ tree, saw ${SRC_FILES.length}`);
    assert.ok(BIN_FILES.length >= 1);
    for (const name of ['ctx.js', 'i18n.js', 'fsx.js', 'ui.js', 'screen.js', 'tty.js',
      'credstore.js', 'claude.js', 'profiles.js', 'shell.js', 'cli.js']) {
      assert.ok(SRC_FILES.some((f) => rel(f) === `src/${name}`), `src/${name} is missing`);
    }
    for (const name of ['launch.js', 'account.js', 'doctor.js']) {
      assert.ok(SRC_FILES.some((f) => rel(f) === `src/commands/${name}`), `src/commands/${name} is missing`);
    }
  });

  it('only src/ctx.js touches process, os.homedir or the wall clock', () => {
    // Built from parts so this test file can never match its own scanner.
    const FORBIDDEN = [
      ['process' + '.env', /process\s*\.\s*env\b/],
      ['process' + '.platform', /process\s*\.\s*platform\b/],
      ['process' + '.stdout', /process\s*\.\s*stdout\b/],
      ['process' + '.stderr', /process\s*\.\s*stderr\b/],
      ['process' + '.stdin', /process\s*\.\s*stdin\b/],
      ['os' + '.homedir', /\bos\s*\.\s*homedir\b|\bhomedir\s*\(\s*\)/],
      ['Date' + '.now', /\bDate\s*\.\s*now\b/],
      ['node:child_process', /from\s*['"]node:child_process['"]|require\(\s*['"]node:child_process['"]/],
    ];
    const offences = [];
    for (const file of SRC_FILES) {
      const name = rel(file);
      if (name === 'src/ctx.js') continue;
      const text = readFileSync(file, 'utf8');
      for (const [label, re] of FORBIDDEN) {
        const m = re.exec(text);
        if (m) {
          const line = text.slice(0, m.index).split('\n').length;
          offences.push(`${name}:${line} references ${label}`);
        }
      }
    }
    assert.deepEqual(offences, [], offences.join('\n'));
  });

  it('src/ctx.js really is the injection point (it does touch them)', () => {
    const text = readFileSync(join(ROOT, 'src', 'ctx.js'), 'utf8');
    assert.match(text, /homedir/);
    assert.match(text, /node:child_process/);
    // If ctx.js ever stops owning these, the exemption above is a lie.
  });

  it('bin/cam.js begins with the exact shebang bytes followed by LF', () => {
    const buf = readFileSync(join(ROOT, 'bin', 'cam.js'));
    const expected = Buffer.from('#!/usr/bin/env node\n', 'utf8');
    assert.deepEqual(
      buf.subarray(0, expected.length),
      expected,
      'the shebang must be exactly "#!/usr/bin/env node" + LF (no BOM, no CR)',
    );
    assert.notEqual(buf[0], 0xef, 'a UTF-8 BOM would break the shebang');
  });

  it('no source file contains a CR anywhere', () => {
    const testFiles = existsSync(join(ROOT, 'test')) ? jsFiles(join(ROOT, 'test')) : [];
    const offenders = [];
    for (const file of [...SRC_FILES, ...BIN_FILES, ...testFiles]) {
      const buf = readFileSync(file);
      if (buf.includes(0x0d)) offenders.push(rel(file));
    }
    assert.deepEqual(offenders, [], `CRLF found in: ${offenders.join(', ')}`);
  });

  it('package.json declares zero dependencies and a publishable shape', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies, undefined, 'cam must have no dependencies');
    assert.equal(pkg.devDependencies, undefined, 'cam must have no devDependencies');
    assert.equal(pkg.peerDependencies, undefined);
    assert.equal(pkg.optionalDependencies, undefined);
    assert.equal(pkg.type, 'module');
    assert.equal(typeof pkg.repository, 'object');
    assert.equal(typeof pkg.repository.url, 'string');
    assert.ok(pkg.repository.url.length > 0);
    assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'files[] must exist and be non-empty');
    assert.ok(typeof pkg.engines.node === 'string' && pkg.engines.node.includes('18.17'));
  });

  it('every bin target ends in .js and exists on disk', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const targets = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin;
    assert.ok(targets && Object.keys(targets).length > 0, 'package.json declares no bin');
    for (const [name, target] of Object.entries(targets)) {
      assert.match(target, /\.js$/, `bin.${name} must end in .js`);
      const abs = join(ROOT, target);
      assert.ok(existsSync(abs), `bin.${name} -> ${target} does not exist`);
      assert.ok(statSync(abs).isFile());
      // the shebang must survive npm's shim generation
      assert.ok(readFileSync(abs, 'utf8').startsWith('#!/usr/bin/env node\n'));
    }
  });

  it('every file in the bin/ and src/ trees is covered by files[]', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const patterns = pkg.files.map((f) => f.replace(/\/$/, ''));
    for (const file of [...SRC_FILES, ...BIN_FILES]) {
      const name = rel(file);
      assert.ok(
        patterns.some((p) => name === p || name.startsWith(`${p}/`)),
        `${name} is not covered by package.json files[] and would be missing from the tarball`,
      );
    }
  });

  it('the exit-code table is frozen and never renumbered', () => {
    assert.ok(Object.isFrozen(EXIT));
    assert.deepEqual(EXIT, {
      OK: 0, ERROR: 1, USAGE: 2, NOT_FOUND: 4, CONFLICT: 5,
      NO_ACCOUNTS: 6, AUTH_FAILED: 7, UNSAFE: 8, NO_CLAUDE: 127, CANCELLED: 130,
    });
  });

  it('CamError carries a stable code and exit code, and duck-types across realms', () => {
    const e = new CamError('NOT_FOUND', 'nope');
    assert.equal(e.exitCode, 4);
    assert.equal(e.hint, null);
    assert.ok(isCamError(e));
    assert.ok(isCamError({ name: 'CamError', code: 'IO', exitCode: 1 }), 'must duck-type');
    assert.equal(isCamError(new Error('plain')), false);
    assert.equal(new CamError('WHATEVER_UNKNOWN', 'x').exitCode, EXIT.ERROR);
    assert.equal(new CamError('IO', 'x').exitCode, EXIT.ERROR);
    assert.throws(() => fail('USAGE', 'bad', { hint: 'try --help' }), (err) => (
      isCamError(err) && err.exitCode === 2 && err.hint === 'try --help'
    ));
  });

  it('createCtx REPLACES env instead of merging it', () => {
    const ctx = ctxOf({ env: { ONLY: '1' } });
    assert.deepEqual(Object.keys(ctx.env), ['ONLY']);
    assert.equal(ctx.env.PATH, undefined, 'a real PATH must not leak into a test context');
    assert.ok(Object.isFrozen(ctx));
  });

  it('createCtx accepts a frozen clock as a plain number', () => {
    const ctx = ctxOf();
    assert.equal(ctx.now(), NOW);
    assert.equal(ctx.now(), NOW, 'the clock must not advance');
  });

  it('createCtx derives the platform booleans from the injected platform', () => {
    for (const [platform, flags] of [
      ['win32', { isWindows: true, isDarwin: false, isPosix: false }],
      ['darwin', { isWindows: false, isDarwin: true, isPosix: true }],
      ['linux', { isWindows: false, isDarwin: false, isPosix: true }],
    ]) {
      const ctx = ctxOf({ platform });
      assert.equal(ctx.isWindows, flags.isWindows, platform);
      assert.equal(ctx.isDarwin, flags.isDarwin, platform);
      assert.equal(ctx.isPosix, flags.isPosix, platform);
    }
  });

  it('the command registry is frozen and every entry is runnable', () => {
    assert.ok(Object.isFrozen(COMMANDS));
    const seen = new Set();
    for (const [key, cmd] of Object.entries(COMMANDS)) {
      assert.equal(cmd.name, key, `${key} names itself differently`);
      assert.ok(Object.isFrozen(cmd));
      assert.equal(typeof cmd.run, 'function');
      assert.equal(typeof cmd.usage, 'string');
      assert.ok(Object.prototype.hasOwnProperty.call(MESSAGES.en, cmd.summary),
        `${key}.summary "${cmd.summary}" is not an i18n key`);
      for (const alias of [key, ...cmd.aliases]) {
        assert.equal(seen.has(alias), false, `duplicate verb/alias ${alias}`);
        seen.add(alias);
      }
    }
    assert.ok(seen.has('launch'));
  });

  // REGRESSION: src/shell.js reports what it did with `created` / `appended` /
  // `upgraded`, but doctor.js's actionLabel used to switch on invented names
  // ('installed', 'updated') that no code path emits. Every real action fell
  // through to the default and `cam shell install` reported "not installed"
  // after correctly writing the rc file — the tool doing the right thing and
  // telling the user it had not. Two vocabularies in two files, so a source
  // scan is the only thing that keeps them honest.
  it('doctor.actionLabel handles every action src/shell.js can emit', () => {
    const shellSrc = readFileSync(new URL('../src/shell.js', import.meta.url), 'utf8');
    const doctorSrc = readFileSync(new URL('../src/commands/doctor.js', import.meta.url), 'utf8');

    const emitted = new Set(
      [...shellSrc.matchAll(/\baction:\s*'([a-z-]+)'/g)].map((m) => m[1])
    );
    // Ternaries such as `action: cur === null ? 'created' : 'upgraded'` put the
    // names after the colon, so pick those up too.
    for (const m of shellSrc.matchAll(/\baction:[^,\n]*\?[^,\n]*/g)) {
      for (const q of m[0].matchAll(/'([a-z-]+)'/g)) emitted.add(q[1]);
    }
    assert.ok(emitted.size >= 5, `expected shell.js to emit several actions, saw ${[...emitted]}`);

    const handled = new Set(
      [...doctorSrc.matchAll(/case\s+'([a-z-]+)':/g)].map((m) => m[1])
    );
    const unhandled = [...emitted].filter((a) => !handled.has(a)).sort();
    assert.deepEqual(unhandled, [],
      `src/shell.js emits actions doctor.js does not name explicitly: ${unhandled.join(', ')}`);

    // And the inverse: a case for a name nothing emits is dead code that hides
    // the next drift exactly like this one did.
    const invented = [...handled]
      .filter((a) => !emitted.has(a) && a !== 'installed' && a !== 'updated')
      .sort();
    assert.deepEqual(invented, [],
      `doctor.js names actions src/shell.js never emits: ${invented.join(', ')}`);
  });

  it('every action that changed a file is reported as a success, not as absent', () => {
    const doctorSrc = readFileSync(new URL('../src/commands/doctor.js', import.meta.url), 'utf8');
    const m = doctorSrc.match(/const WROTE_ACTIONS = new Set\(\[([^\]]*)\]\)/);
    assert.ok(m, 'WROTE_ACTIONS is gone; the ok/info decision has drifted back to literals');
    const wrote = new Set([...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]));
    for (const a of ['created', 'appended', 'upgraded', 'removed']) {
      assert.ok(wrote.has(a), `${a} writes a file but is not counted as a success`);
    }
    for (const a of ['unchanged', 'absent', 'not-installed']) {
      assert.equal(wrote.has(a), false, `${a} changes nothing and must not read as a success`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('keys', () => {
  const only = (chunk) => {
    const keys = decodeKeys(chunk);
    assert.equal(keys.length, 1, `expected exactly one key from ${JSON.stringify(chunk)}, got ${keys.length}`);
    return keys[0];
  };

  it('decodes CSI arrows', () => {
    assert.equal(only(`${ESC}[A`).name, 'up');
    assert.equal(only(`${ESC}[B`).name, 'down');
    assert.equal(only(`${ESC}[C`).name, 'right');
    assert.equal(only(`${ESC}[D`).name, 'left');
  });

  it('decodes SS3 arrows (application cursor mode: tmux, many terminals)', () => {
    assert.equal(only(`${ESC}OA`).name, 'up');
    assert.equal(only(`${ESC}OB`).name, 'down');
    assert.equal(only(`${ESC}OC`).name, 'right');
    assert.equal(only(`${ESC}OD`).name, 'left');
  });

  it('treats CR and LF alike as return', () => {
    assert.equal(only('\r').name, 'return');
    assert.equal(only('\n').name, 'return');
  });

  it('treats DEL (0x7f) and BS (0x08) alike as backspace', () => {
    assert.equal(only('\x7f').name, 'backspace');
    assert.equal(only('\x08').name, 'backspace');
  });

  it('decodes 0x03 as ctrl+c — raw mode suppresses SIGINT, so this is the only cancel', () => {
    const k = only('\x03');
    assert.equal(k.name, 'c');
    assert.equal(k.ctrl, true);
  });

  it('decodes modified arrows: [1;5A is ctrl+up, [1;2A is shift+up', () => {
    const ctrlUp = only(`${ESC}[1;5A`);
    assert.equal(ctrlUp.name, 'up');
    assert.equal(ctrlUp.ctrl, true);
    assert.equal(ctrlUp.shift, false);

    const shiftUp = only(`${ESC}[1;2A`);
    assert.equal(shiftUp.name, 'up');
    assert.equal(shiftUp.shift, true);
    assert.equal(shiftUp.ctrl, false);
  });

  it('decodes CSI-tilde keys and shift-tab', () => {
    assert.equal(only(`${ESC}[3~`).name, 'delete');
    assert.equal(only(`${ESC}[5~`).name, 'pageup');
    assert.equal(only(`${ESC}[6~`).name, 'pagedown');
    assert.equal(only(`${ESC}[15~`).name, 'f5');
    const shiftTab = only(`${ESC}[Z`);
    assert.equal(shiftTab.name, 'tab');
    assert.equal(shiftTab.shift, true);
  });

  it('a chunk ENDING in a bare ESC yields escape immediately, with no timeout', () => {
    assert.equal(only(ESC).name, 'escape');
    const pair = decodeKeys(`j${ESC}`);
    assert.equal(pair.length, 2);
    assert.equal(pair[0].name, 'j');
    assert.equal(pair[1].name, 'escape');
    assert.equal(pair[1].sequence, ESC);
  });

  it('one chunk carrying four keys returns an array of exactly four, in order', () => {
    const keys = decodeKeys(`${ESC}[A${ESC}[Aj\r`);
    assert.equal(keys.length, 4);
    assert.deepEqual(keys.map((k) => k.name), ['up', 'up', 'j', 'return']);
  });

  it('a paste-sized chunk decodes every character (autorepeat must not drop input)', () => {
    const keys = decodeKeys('abcdefghij');
    assert.equal(keys.length, 10);
    assert.deepEqual(keys.map((k) => k.name).join(''), 'abcdefghij');
  });

  it('decodes shift and meta on plain characters', () => {
    const upper = only('A');
    assert.equal(upper.name, 'a');
    assert.equal(upper.shift, true);
    const alt = only(`${ESC}b`);
    assert.equal(alt.name, 'b');
    assert.equal(alt.meta, true);
  });

  it('survives an astral code point without splitting a surrogate pair', () => {
    const keys = decodeKeys('\u{1F600}');
    assert.equal(keys.length, 1);
    assert.equal(keys[0].sequence, '\u{1F600}');
  });

  it('accepts a Buffer as well as a string, and returns [] for empty input', () => {
    assert.deepEqual(decodeKeys('').length, 0);
    assert.equal(decodeKeys(Buffer.from(`${ESC}[A`, 'utf8'))[0].name, 'up');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FAILING ON PURPOSE — a real defect, not a weak test. See the report.
  //
  // decodeKeys() is stateless per chunk, and there is no buffering layer above
  // it (src/screen.js readKeys() -> ui.decodeKeys() is a straight per-chunk
  // call; nothing carries a partial escape sequence across two 'data' events).
  // A terminal is free to split an escape sequence across two reads — tmux,
  // ssh over a slow link, and mintty all do it. When that happens:
  //     chunk 1 = ESC        -> decodeKeys yields 'escape'
  //     chunk 2 = "[A"       -> decodeKeys yields '[' then 'a'(shift)
  // and src/screen.js select() maps 'escape' to done(null), i.e. it CANCELS the
  // account picker. commands/launch.js then does `if (!picked.profile) return
  // EXIT.OK`, so a single arrow key can make `claude` exit 0 having launched
  // nothing at all. The fix is a small stateful reader that holds a trailing
  // partial ESC sequence until the next chunk (with a short flush deadline),
  // not a change to this test.
  // FIXED by ui.createKeyReader: decodeKeys stays pure and stateless — a bare
  // trailing ESC still decodes as 'escape' there — while the reader holds an
  // incomplete tail across chunks. src/screen.js gives each prompt its own
  // reader plus a 40 ms flush timer, so a lone Esc is still acted on promptly.
  it('a CSI sequence split across two chunks decodes as one arrow', () => {
    const r = createKeyReader();
    assert.deepEqual(r.push(ESC).map((k) => k.name), [], 'a partial sequence must not emit yet');
    assert.equal(r.pending(), ESC, 'the partial sequence must be held');
    assert.deepEqual(r.push('[A').map((k) => k.name), ['up']);
    assert.equal(r.pending(), '', 'nothing may be left held once the sequence completed');
  });

  it('a three-way split still decodes as one arrow', () => {
    const r = createKeyReader();
    assert.deepEqual(r.push(ESC).map((k) => k.name), []);
    assert.deepEqual(r.push('[').map((k) => k.name), []);
    assert.deepEqual(r.push('A').map((k) => k.name), ['up']);
  });

  it('a split modified arrow (ESC [1;5 + A) still decodes as ctrl+up', () => {
    const r = createKeyReader();
    assert.deepEqual(r.push(`${ESC}[1;5`).map((k) => k.name), []);
    const keys = r.push('A');
    assert.deepEqual(keys.map((k) => k.name), ['up']);
    assert.equal(keys[0].ctrl, true);
  });

  it('a lone Esc is held, then flushed as escape', () => {
    const r = createKeyReader();
    assert.deepEqual(r.push(ESC).map((k) => k.name), []);
    assert.deepEqual(r.flush().map((k) => k.name), ['escape']);
    assert.equal(r.pending(), '');
    assert.deepEqual(r.flush(), [], 'flushing twice must not invent a key');
  });

  it('text before a partial sequence is delivered immediately', () => {
    const r = createKeyReader();
    assert.deepEqual(r.push(`ab${ESC}`).map((k) => k.name), ['a', 'b']);
    assert.equal(r.pending(), ESC);
  });

  it('the reader passes a complete burst straight through', () => {
    const r = createKeyReader();
    assert.deepEqual(
      r.push(`${ESC}[A${ESC}[Aj\r`).map((k) => k.name),
      ['up', 'up', 'j', 'return'],
    );
    assert.equal(r.pending(), '');
  });

  it('ctrl+c is never held, however it arrives', () => {
    const r = createKeyReader();
    const keys = r.push(String.fromCharCode(3));
    assert.equal(keys.length, 1);
    assert.equal(keys[0].ctrl, true);
    assert.equal(keys[0].name, 'c');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('width', () => {
  it('counts a wide CJK cell as 2 despite string length 1', () => {
    assert.equal('短'.length, 1);
    assert.equal(width('短'), 2);
    assert.equal(width('短短短'), 6);
  });

  it('counts a combining mark as 0 despite string length 2', () => {
    const decomposed = 'e\u0301';
    assert.equal(decomposed.length, 2);
    assert.equal(width(decomposed), 1);
    assert.equal(width('\u00e9'), 1, 'precomposed and decomposed must measure alike');
  });

  it('counts a wide astral pair as 2 despite string length 2', () => {
    const astral = '\u{20000}';
    assert.equal(astral.length, 2);
    assert.equal(width(astral), 2);
  });

  it('counts zero-width joiners, variation selectors and controls as 0', () => {
    assert.equal(width('\u200b'), 0);
    assert.equal(width('a\u0000b'), 2);
    assert.equal(width('\u0301'), 0);
  });

  it('ignores ANSI escape sequences entirely', () => {
    const painted = `${ESC}[38;2;217;119;87mwork${ESC}[0m`;
    assert.equal(width(painted), 4);
    assert.equal(stripAnsi(painted), 'work');
    assert.equal(stripAnsi(`${ESC}]0;title\u0007x`), 'x', 'OSC sequences too');
    assert.equal(width(undefined), 0);
    assert.equal(width(null), 0);
  });

  it('truncate under-fills rather than splitting a wide cell', () => {
    const cut = truncate('短短短短短', 6);
    assert.equal(width(cut), 5, 'two wide cells + a 1-wide ellipsis = 5, never 6 with a half cell');
    assert.equal(cut, '短短…');
    assert.equal(cut.includes('\ufffd'), false);
  });

  it('truncate never exceeds its budget, for any input at any budget', () => {
    const corpus = [
      '', 'a', 'abc', 'hello world',
      '短', '短短短短短', 'a短b短c',
      'e\u0301e\u0301e\u0301', '\u{20000}\u{20000}\u{20000}',
      'caique\u00b7pessan@acme.example',
      'Acme \u2014 Corporation Ltd',
      `${ESC}[1mbold${ESC}[0m text`,
      '\u{1F600}\u{1F600}',
      'a\u200bb\u200bc',
    ];
    for (const s of corpus) {
      for (let budget = 0; budget <= 12; budget += 1) {
        for (const mark of ['…', '...', '']) {
          const got = truncate(s, budget, mark);
          assert.ok(
            width(got) <= budget,
            `truncate(${JSON.stringify(s)}, ${budget}, ${JSON.stringify(mark)}) = `
            + `${JSON.stringify(got)} is ${width(got)} wide, over budget`,
          );
        }
      }
    }
  });

  it('truncate returns the input untouched when it already fits', () => {
    assert.equal(truncate('abc', 3), 'abc');
    assert.equal(truncate('短短', 4), '短短');
    assert.equal(truncate('anything', 0), '');
    assert.equal(truncate('anything', -5), '');
  });

  it('padEnd pads by display width, not by string length', () => {
    assert.equal(width(padEnd('短', 6)), 6);
    assert.equal(width(padEnd('e\u0301', 4)), 4);
    assert.equal(padEnd('abcdef', 3), 'abcdef', 'padEnd never truncates');
  });

  it('fit produces exactly the requested width for every corpus entry', () => {
    for (const s of ['', 'a', '短短短短', 'e\u0301x', '\u{20000}y', 'a'.repeat(40)]) {
      for (const cols of [1, 2, 3, 7, 12, 20]) {
        assert.equal(width(fit(s, cols)), cols, `fit(${JSON.stringify(s)}, ${cols})`);
      }
    }
    assert.equal(fit('x', 0), '');
  });

  it('asciify reduces EVERY non-ASCII character, not just box glyphs', () => {
    assert.equal(asciify('caique\u00b7pessan'), 'caique.pessan');
    assert.equal(asciify('Acme \u2014 Corp'), 'Acme - Corp');
    assert.equal(asciify('\u2026'), '...');
    assert.equal(asciify('caf\u00e9'), 'cafe', 'NFKD folds the accent away');
    assert.equal(asciify('caf\u0065\u0301'), 'cafe');
    assert.equal(asciify('短'), '?', 'an unmappable character becomes ?, never a raw byte');
    assert.equal(asciify(`org${ESC}[2Jname`), 'org?[2Jname', 'an escape byte inside data is neutralised');
    assert.match(asciify('\u2713 \u2717 \u2192 \u21b5 \u25cf \u25cb'), /^[\x20-\x7e]*$/);
    assert.equal(asciify(null), '');
  });

  it('the ASCII glyph table has the same shape as the Unicode one', () => {
    const u = makeGlyphs(true);
    const a = makeGlyphs(false);
    assert.deepEqual(Object.keys(u).sort(), Object.keys(a).sort());
    for (const [key, value] of Object.entries(a)) {
      assert.match(value, /^[\x20-\x7e]*$/, `ascii glyph ${key} is not 7-bit`);
    }
    for (const key of ['tl', 'tr', 'bl', 'br', 'h', 'v', 'cursor', 'active', 'idle']) {
      assert.equal(width(u[key]), 1, `unicode glyph ${key} must be exactly one cell wide`);
      assert.equal(width(a[key]), 1, `ascii glyph ${key} must be exactly one cell wide`);
    }
  });

  it('makeStyle composes ONE opening SGR and one reset, and is off below depth 4', () => {
    const off = makeStyle({ depth: 1 });
    assert.equal(off.on, false);
    assert.equal(off.accent('x'), 'x');

    const on = makeStyle({ depth: 24 });
    assert.equal(on.on, true);
    const painted = on.paint('x', 'bold', 'accent');
    assert.equal(width(painted), 1);
    assert.equal((painted.match(/\u001b\[0m/g) || []).length, 1, 'exactly one reset');
    assert.equal((painted.match(/\u001b\[[0-9;]+m/g) || []).length, 2, 'one open + one reset');
    assert.equal(on.paint('', 'bold'), '', 'empty text is never wrapped');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('frames', () => {
  const items = () => ([
    {
      kind: 'account', name: 'default', dir: null, isDefault: true,
      meta: { email: 'me@personal.example', plan: 'max' },
    },
    {
      kind: 'account', name: 'work', dir: '/p/work', active: true,
      meta: {
        email: 'caique\u00b7pessan@acme-corporation.example',
        orgName: 'Acme \u2014 Corporation Ltd',
        plan: 'claude_team',
        lastUsedAt: NOW - 3 * 3600000,
        accountUuid: 'u1',
        refreshTokenExpiresAt: NOW + 20 * DAY,
      },
    },
    {
      kind: 'account', name: '短短短短短短短短短短', dir: '/p/cjk',
      meta: { email: 'cjk@\u4f8b\u3048.example', plan: 'pro', accountUuid: 'u2' },
    },
    {
      kind: 'account', name: 'expiring', dir: '/p/e',
      health: { status: 'warn', daysLeft: 3 },
      meta: { email: 'x@y.example', accountUuid: 'u3' },
    },
    { kind: 'account', name: 'gone', dir: '/p/g', health: { status: 'signedout' }, meta: {} },
    { kind: 'add' },
  ]);

  const state = (over = {}) => ({
    items: items(),
    index: 1,
    now: NOW,
    version: '9.9.9',
    claudeVersion: '2.1.252',
    warnings: ['CLAUDE_CODE_OAUTH_TOKEN removida \u2014 sen\u00e3o venceria o perfil'],
    ...over,
  });

  it('every line of every frame has exactly ONE display width, across the full matrix', () => {
    for (const depth of [24, 8, 4, 1]) {
      for (const cols of [80, 56, 46]) {
        for (const unicode of [true, false]) {
          for (const index of [-1, 0, 1, 4, 5]) {
            const caps = { isTTY: true, depth, unicode, cols, rows: 24, ascii: !unicode };
            const lines = buildMenu(state({ index }), caps);
            assert.ok(lines.length > 5, 'the frame is suspiciously short');
            const widths = new Set(lines.map((l) => width(l)));
            const expected = Math.max(46, Math.min(cols, 74));
            assert.equal(
              widths.size, 1,
              `ragged frame at depth=${depth} cols=${cols} unicode=${unicode} index=${index}: `
              + `widths ${[...widths].sort((a, b) => a - b).join(',')}`,
            );
            assert.equal([...widths][0], expected,
              `frame width at cols=${cols} should clamp to [46,74]`);
          }
        }
      }
    }
  });

  it('the frame never contains a newline inside a line', () => {
    const lines = buildMenu(state(), { depth: 24, cols: 80, unicode: true, isTTY: true });
    for (const l of lines) assert.equal(l.includes('\n'), false);
  });

  it('ascii mode produces printable 7-bit output for USER DATA, not just box glyphs', () => {
    // The email carries U+00B7 and the org name an em dash. Asciifying only the
    // borders would leave both in the output and fail this assertion.
    for (const cols of [80, 56, 46]) {
      const plain = buildMenu(state(), { depth: 1, cols, unicode: false, isTTY: true });
      for (const line of plain) {
        assert.match(line, /^[\x20-\x7e]*$/,
          `non-ASCII survived asciify at cols=${cols}: ${JSON.stringify(line)}`);
      }
      const painted = buildMenu(state(), { depth: 24, cols, unicode: false, isTTY: true });
      for (const line of painted) {
        assert.match(stripAnsi(line), /^[\x20-\x7e]*$/,
          `non-ASCII survived asciify (coloured) at cols=${cols}`);
      }
    }
  });

  it('unicode mode does keep the real user data', () => {
    const lines = buildMenu(state(), { depth: 1, cols: 80, unicode: true, isTTY: true }).join('\n');
    assert.ok(lines.includes('\u00b7') || lines.includes('caique'), 'the email should survive');
    assert.ok(lines.includes('\u2502'), 'unicode borders expected');
  });

  it('degrades gracefully on garbage state', () => {
    for (const bad of [undefined, null, {}, { items: null }, { items: [] }, { items: [null, 5, 'x'] }]) {
      const lines = buildMenu(bad, { cols: 80, depth: 0, unicode: true });
      assert.ok(Array.isArray(lines) && lines.length > 0);
      assert.equal(new Set(lines.map((l) => width(l))).size, 1);
    }
  });

  it('statusLine, banner and errorBlock render one line per row and stay ASCII-safe', () => {
    const caps = { depth: 1, unicode: false, cols: 80 };
    assert.equal(statusLine('ok', 'done', caps), 'v done');
    assert.equal(statusLine('fail', 'nope', caps), 'x nope');
    assert.equal(statusLine('plain', 'bare', caps), 'bare');
    assert.equal(statusLine('nonsense-kind', 'x', caps), '- x', 'unknown kinds fall back to info');

    const line = banner(
      { name: 'work', email: 'a\u00b7b@c.example', meta: { plan: 'claude_max' } },
      caps,
    );
    assert.match(line, /^[\x20-\x7e]*$/);
    assert.ok(line.includes('work'));

    const block = errorBlock({
      title: 'it broke',
      lines: [{ label: 'why', value: 'because' }, { label: 'fix', values: ['a', 'b'] }, 'note'],
    }, caps);
    assert.ok(Array.isArray(block));
    assert.ok(block[0].startsWith('x '));
    for (const l of block) assert.equal(l.includes('\n'), false);
    assert.deepEqual(errorBlock({ title: 'solo' }, caps), ['x solo'], 'no rows, no blank line');
  });

  it('buildTable aligns columns, honours the terminal width and never pads the last column', () => {
    const rows = [
      ['work', 'caique\u00b7pessan@acme.example', 'team'],
      ['短短短', 'cjk@example.jp', 'pro'],
    ];
    const out = buildTable(
      { columns: ['NAME', 'EMAIL', 'PLAN'], rows },
      { cols: 80, depth: 1, unicode: true },
    );
    assert.equal(out.length, 3);
    for (const l of out) {
      assert.ok(width(l) <= 80, 'a table line must fit the terminal');
      assert.equal(/\s$/.test(l), false, 'piped output must have no trailing whitespace');
    }
    const narrow = buildTable({ columns: ['NAME', 'EMAIL', 'PLAN'], rows }, { cols: 24, depth: 1 });
    for (const l of narrow) assert.ok(width(l) <= 24, `narrow table overflowed: ${width(l)}`);
    assert.deepEqual(buildTable({}, { cols: 80 }), []);
  });

  it('relativeTime and planLabel are pure functions of the injected clock', () => {
    const t = createT('en');
    assert.equal(relativeTime(0, NOW, t), t('time.never'));
    assert.equal(relativeTime(NOW - 30000, NOW, t), t('time.now'));
    assert.equal(relativeTime(NOW - 5 * 60000, NOW, t), t('time.minutes', { n: 5 }));
    assert.equal(relativeTime(NOW - 3 * 3600000, NOW, t), t('time.hours', { n: 3 }));
    assert.equal(relativeTime(NOW - DAY, NOW, t), t('time.yesterday'));
    assert.equal(relativeTime(NOW - 3 * DAY, NOW, t), t('time.days', { n: 3 }));
    assert.equal(relativeTime(NOW + 2 * 3600000, NOW, t), t('time.inHours', { n: 2 }));

    assert.equal(planLabel('max', t), t('plan.max'));
    assert.equal(planLabel('claude_max', t), t('plan.max'), 'organizationType spelling');
    assert.equal(planLabel('claude-team', t), t('plan.team'));
    assert.equal(planLabel('enterprise', t), t('plan.enterprise'));
    assert.equal(planLabel('', t), t('plan.unknown'));
    assert.equal(planLabel(null, t), t('plan.unknown'));
    assert.equal(planLabel('something_else', t), t('plan.unknown'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('env', () => {
  const HOSTILE = HOSTILE_ENV.map((h) => h.name);

  const dirty = () => ({
    PATH: '/usr/bin',
    HOME: '/home/u',
    CLAUDE_CONFIG_DIR: '/user/set/this',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/elsewhere',
    SELF_HOSTED_RUNNER_HOST_CONFIG_DIR: '/runner',
    CLAUDE_CODE_ACCOUNT_UUID: 'aaaa-bbbb',
    CLAUDE_CODE_ORGANIZATION_UUID: 'cccc-dddd',
    CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1',
    CAM_PROFILE: 'stale',
    CAM_ACCOUNT: 'stale',
    CAM_TTY: '1',
  });

  it('the hostile list is exactly the five variables that outrank CLAUDE_CONFIG_DIR', () => {
    assert.deepEqual(HOSTILE, [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      'SELF_HOSTED_RUNNER_HOST_CONFIG_DIR',
      'CLAUDE_CODE_ACCOUNT_UUID',
      'CLAUDE_CODE_ORGANIZATION_UUID',
    ]);
    assert.equal(
      HOSTILE.includes('CLAUDE_CODE_FORCE_WINDOWS_CREDMAN'), false,
      'CREDMAN changes the backend, not the account: reported, never stripped',
    );
    for (const item of HOSTILE_ENV) {
      assert.ok(Object.prototype.hasOwnProperty.call(MESSAGES.en, item.impact),
        `${item.name}.impact "${item.impact}" is not an i18n key`);
    }
  });

  it('a real profile gets CLAUDE_CONFIG_DIR, loses every hostile override, and reports each one', () => {
    const ctx = ctxOf({ env: dirty() });
    const { env, stripped, notes } = sanitizeChildEnv(ctx, {
      profile: { name: 'work', dir: '/store/profiles/work' },
    });

    assert.equal(env.CLAUDE_CONFIG_DIR, '/store/profiles/work');
    assert.equal(env.CAM_ACTIVE, 'work');
    for (const name of HOSTILE) {
      assert.equal(env[name], undefined, `${name} survived the strip — silent defeat`);
    }
    assert.deepEqual(stripped.map((s) => s.name).sort(), [...HOSTILE].sort(),
      'every removal must be reported to the user');
    for (const s of stripped) {
      assert.equal(typeof s.impact, 'string');
      assert.ok(s.impact.length > 0, `${s.name} has no translated impact line`);
      assert.notEqual(s.impact, s.key, `${s.name} impact key ${s.key} is missing from the catalogue`);
    }
    // cam's own pins never reach a nested claude
    assert.equal(env.CAM_PROFILE, undefined);
    assert.equal(env.CAM_ACCOUNT, undefined);
    assert.equal(env.CAM_TTY, undefined);
    // reported-only variables are left alone
    assert.equal(env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN, '1');
    assert.equal(env.PATH, '/usr/bin', 'the rest of the environment is untouched');
    assert.deepEqual(notes, []);
    assert.deepEqual(ctx.env, dirty(), 'ctx.env must never be mutated');
  });

  it('the default account (dir === null) is passed through byte-for-byte', () => {
    const ctx = ctxOf({ env: dirty() });
    const { env, stripped, notes } = sanitizeChildEnv(ctx, {
      profile: { name: 'default', dir: null },
    });
    assert.deepEqual(env, dirty(), 'default must be byte-for-byte the pre-existing behaviour');
    assert.equal(env.CLAUDE_CONFIG_DIR, '/user/set/this', "the user's own CLAUDE_CONFIG_DIR is respected");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, dirty().CLAUDE_CODE_OAUTH_TOKEN);
    assert.deepEqual(stripped, []);
    assert.equal(notes.length, 1, 'the respected CLAUDE_CONFIG_DIR is still mentioned');

    // and with no profile at all
    const none = sanitizeChildEnv(ctx, {});
    assert.deepEqual(none.env, dirty());
    assert.deepEqual(none.stripped, []);
  });

  it('the default account with a clean environment produces no note', () => {
    const ctx = ctxOf({ env: { PATH: '/usr/bin' } });
    const { env, notes } = sanitizeChildEnv(ctx, { profile: { name: 'default', dir: null } });
    assert.deepEqual(env, { PATH: '/usr/bin' });
    assert.deepEqual(notes, []);
  });

  it('--keep-env strips nothing and says so', () => {
    const ctx = ctxOf({ env: dirty() });
    const { env, stripped, notes } = sanitizeChildEnv(ctx, {
      profile: { name: 'work', dir: '/store/profiles/work' },
      keepEnv: true,
    });
    assert.deepEqual(stripped, [], 'keepEnv must strip nothing');
    assert.equal(notes.length, 1, 'and must say so out loud');
    for (const name of HOSTILE) {
      assert.equal(env[name], dirty()[name], `${name} must survive --keep-env`);
    }
    assert.equal(env.CLAUDE_CONFIG_DIR, '/store/profiles/work');
    // NOTE: cam's own pins are dropped even under --keep-env, on purpose: a
    // nested claude must never inherit a stale CAM_PROFILE.
    assert.equal(env.CAM_PROFILE, undefined);
  });

  it('on Windows a differently-cased hostile variable is still removed', () => {
    const ctx = ctxOf({
      platform: 'win32',
      env: {
        Path: 'C:\\Windows',
        claude_code_oauth_token: 'sk-ant-oat01-lowercase-spelling',
        CLAUDE_Code_Account_Uuid: 'aaaa',
        claude_config_dir: 'C:\\user\\set',
        cam_profile: 'stale',
      },
    });
    const { env, stripped } = sanitizeChildEnv(ctx, { profile: { name: 'w', dir: 'C:\\p\\w' } });
    const keys = Object.keys(env);
    assert.equal(keys.some((k) => k.toLowerCase() === 'claude_code_oauth_token'), false,
      'Windows resolves env names case-blind: a lower-case spelling would still win');
    assert.equal(keys.some((k) => k.toLowerCase() === 'claude_code_account_uuid'), false);
    assert.equal(keys.some((k) => k.toLowerCase() === 'cam_profile'), false);
    assert.equal(keys.filter((k) => k.toLowerCase() === 'claude_config_dir').length, 1,
      'exactly one spelling of CLAUDE_CONFIG_DIR must remain');
    assert.equal(env.CLAUDE_CONFIG_DIR, 'C:\\p\\w');
    assert.equal(env.Path, 'C:\\Windows');
    assert.deepEqual(stripped.map((s) => s.name).sort(),
      ['CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('POSIX is case-SENSITIVE: a lower-case spelling is neither honoured nor stripped', () => {
    const ctx = ctxOf({ env: { claude_code_oauth_token: 'x' } });
    const { env, stripped } = sanitizeChildEnv(ctx, { profile: { name: 'w', dir: '/p/w' } });
    assert.equal(env.claude_code_oauth_token, 'x');
    assert.deepEqual(stripped, []);
  });

  it('describeAmbient redacts token-shaped values and never prints a secret', () => {
    const secret = 'sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij';
    const ctx = ctxOf({ env: { ...dirty(), CLAUDE_CODE_OAUTH_TOKEN: secret } });
    const rows = describeAmbient(ctx);
    const token = rows.find((r) => r.name === 'CLAUDE_CODE_OAUTH_TOKEN');
    assert.equal(token.present, true);
    assert.equal(token.hostile, true);
    assert.notEqual(token.value, secret, 'the raw token must never leave describeAmbient');
    assert.ok(token.value.length <= 20, `redacted value is too long: ${token.value}`);
    assert.equal(token.value.includes('ghij'), true, 'the last 4 characters are kept for matching');
    for (const row of rows) {
      if (typeof row.value === 'string') {
        assert.ok(row.value.length <= 64, `${row.name} leaked a long value`);
      }
      assert.equal(typeof row.impact, 'string');
      assert.ok(row.impact.length > 0);
    }
    assert.ok(rows.filter((r) => r.hostile).length === HOSTILE.length);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('names', () => {
  // validName takes no ctx: it is platform-independent BY CONSTRUCTION, which is
  // the property being asserted — a name rejected on Linux must also be rejected
  // when the same store is opened from WSL or from Windows.
  const PLATFORMS = ['win32', 'darwin', 'linux', 'freebsd'];

  const rejects = (name, why) => {
    for (const platform of PLATFORMS) {
      const ctx = ctxOf({ platform });
      assert.equal(ctx.platform, platform);
      const got = validName(name);
      assert.equal(got.ok, false, `${JSON.stringify(name)} must be rejected on ${platform} (${why})`);
      assert.equal(typeof got.reason, 'string');
      assert.ok(Object.prototype.hasOwnProperty.call(MESSAGES.en, got.reason),
        `rejection reason "${got.reason}" is not an i18n key`);
      assert.ok(Object.prototype.hasOwnProperty.call(MESSAGES['pt-BR'], got.reason));
    }
  };

  it('rejects path traversal on every platform', () => {
    rejects('.', 'current directory');
    rejects('..', 'parent directory');
    rejects('/', 'separator');
    rejects('\\', 'windows separator');
    rejects('../etc', 'traversal');
    rejects('..\\..\\windows', 'traversal');
    rejects('a/b', 'nested');
    rejects('a\\b', 'nested');
    rejects('C:', 'drive letter');
    rejects('a\u0000b', 'NUL byte');
  });

  it('rejects Windows device names on EVERY platform, extension included', () => {
    for (const name of ['con', 'CON', 'nul', 'NUL', 'prn', 'aux',
      'COM1', 'com9', 'lpt1', 'lpt9.txt', 'CON.json', 'Nul.txt']) {
      rejects(name, 'windows device name');
    }
    assert.equal(validName('com0').ok, true, 'com0 is not a device name');
    assert.equal(validName('com10').ok, true, 'com10 is not a device name');
    assert.equal(validName('console').ok, true, 'console is a fine account name');
  });

  it('rejects the reserved account name in any casing', () => {
    rejects('default', 'reserved');
    rejects('DEFAULT', 'reserved');
    rejects('Default', 'reserved');
    assert.deepEqual([...RESERVED_NAMES], ['default']);
    assert.equal(validName('defaults').ok, true);
  });

  it('rejects empty, over-long, dangerously-shaped and non-ASCII names', () => {
    rejects('', 'empty');
    rejects('   ', 'whitespace only');
    rejects(null, 'not a string');
    rejects(undefined, 'not a string');
    rejects(42, 'not a string');
    rejects('a'.repeat(33), '33 characters');
    rejects('work.', 'trailing dot');
    rejects('.hidden', 'leading dot');
    rejects('-lead', 'leading dash');
    rejects('a b', 'inner space');
    rejects('a\tb', 'inner tab');
    rejects('a*b', 'glob');
    rejects('a?b', 'glob');
    rejects('a"b', 'quote');
    rejects('a|b', 'pipe');
    rejects('a<b', 'redirect');
    rejects('caf\u00e9', 'non-ASCII');
    rejects('\u4f8b', 'non-ASCII');
  });

  it('accepts the names it should, and lower-cases them', () => {
    for (const [input, expected] of [
      ['work', 'work'],
      ['Work', 'work'],
      ['WORK-2', 'work-2'],
      ['a', 'a'],
      ['a.b_c-d', 'a.b_c-d'],
      ['9lives', '9lives'],
      ['a'.repeat(32), 'a'.repeat(32)],
    ]) {
      const got = validName(input);
      assert.equal(got.ok, true, `${input} should be accepted`);
      assert.equal(got.name, expected);
    }
  });

  it('NORMALISES surrounding whitespace instead of rejecting it', () => {
    // PLAN DEVIATION, deliberate: the agreed plan said "rejects ... a trailing
    // space". The implementation trims first, so 'work ' becomes 'work'. The
    // security property that actually matters — no path component may ever end
    // in a space or a dot — still holds, and is asserted here.
    const got = validName('work ');
    assert.equal(got.ok, true);
    assert.equal(got.name, 'work');
    assert.equal(validName(' work').name, 'work');
    assert.equal(validName('\twork\n').name, 'work');
    for (const candidate of ['work ', ' work', 'Work\t']) {
      const v = validName(candidate);
      if (v.ok) {
        assert.equal(/[. ]$/.test(v.name), false, 'a normalised name may not end in a dot or space');
        assert.equal(/^[.\-]/.test(v.name), false);
      }
    }
  });

  it('an accepted name can never escape the profiles directory', () => {
    const ctx = ctxOf({ env: { CAM_HOME: '/store' } });
    const { profilesDir } = storePaths(ctx);
    for (const candidate of ['work', 'a.b', 'x-1', '9', 'a'.repeat(32)]) {
      const v = validName(candidate);
      assert.equal(v.ok, true);
      const p = join(profilesDir, v.name);
      assert.ok(p.startsWith(profilesDir + sep), `${p} escaped ${profilesDir}`);
      assert.equal(p.includes('..'), false);
    }
  });

  it('suggestName proposes a free name that always passes validName', () => {
    assert.equal(suggestName('me@acme.io'), 'acme');
    assert.equal(suggestName('me@gmail.com'), 'me', 'a generic mail host is not an org');
    assert.equal(suggestName('caique+tag@acme-corp.example'), 'acme-corp');
    assert.equal(suggestName('a@gmail.com', ['a']), 'a-2');
    assert.equal(suggestName('a@gmail.com', ['a', 'a-2']), 'a-3');
    assert.equal(suggestName('default@gmail.com'), 'default-2', 'never proposes the reserved name');
    assert.equal(suggestName('con@gmail.com'), 'con-2', 'never proposes a device name');
    assert.equal(suggestName(''), 'account');
    assert.equal(suggestName(null), 'account');

    for (const email of ['', null, 'x', 'me@acme.io', '..@..', '\u4f8b@\u4f8b.jp',
      'UPPER@ACME.IO', 'a'.repeat(80) + '@acme.io', 'default@x.io', 'nul@x.io']) {
      const name = suggestName(email, ['acme', 'x']);
      assert.equal(validName(name).ok, true, `suggestName(${JSON.stringify(email)}) = ${name} is invalid`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('health', () => {
  const meta = (over = {}) => ({ accountUuid: 'u-1', refreshTokenExpiresAt: NOW + 30 * DAY, ...over });

  it('an expiry in the past is expired', () => {
    const h = health(meta({ refreshTokenExpiresAt: NOW - 1 }), NOW);
    assert.equal(h.status, 'expired');
    assert.equal(h.label, 'health.expired');
    assert.equal(h.daysLeft, 0);
  });

  it('an expiry exactly now is expired (the boundary is inclusive)', () => {
    assert.equal(health(meta({ refreshTokenExpiresAt: NOW }), NOW).status, 'expired');
  });

  it('six days left warns and reports the day count', () => {
    const h = health(meta({ refreshTokenExpiresAt: NOW + 6 * DAY }), NOW);
    assert.equal(h.status, 'warn');
    assert.equal(h.label, 'health.warnMenu');
    assert.equal(h.daysLeft, 6);
    assert.deepEqual(h.labelVars, { days: 6 });
  });

  it('exactly seven days still warns; one millisecond more is ok', () => {
    assert.equal(health(meta({ refreshTokenExpiresAt: NOW + 7 * DAY }), NOW).status, 'warn');
    assert.equal(health(meta({ refreshTokenExpiresAt: NOW + 7 * DAY + 1 }), NOW).status, 'ok');
  });

  it('eight days left is ok', () => {
    const h = health(meta({ refreshTokenExpiresAt: NOW + 8 * DAY }), NOW);
    assert.equal(h.status, 'ok');
    assert.equal(h.label, 'health.ok');
    assert.equal(h.daysLeft, 8);
  });

  it('a missing expiry is unknown, never ok and never expired', () => {
    for (const value of [undefined, null, 0, -1, 'soon', NaN, {}]) {
      const h = health(meta({ refreshTokenExpiresAt: value }), NOW);
      assert.equal(h.status, 'unknown', `expiry ${JSON.stringify(value)} should be unknown`);
      assert.equal(h.daysLeft, null);
    }
  });

  it('an opaque backend is unknown — the menu must never read a Keychain', () => {
    for (const backend of ['keychain', 'credman']) {
      const h = health(meta({ backend }), NOW);
      assert.equal(h.status, 'unknown', backend);
      assert.equal(h.label, 'health.unknown');
    }
    assert.equal(health(meta({ backend: 'file' }), NOW).status, 'ok');
  });

  it('no accountUuid is signed out, whatever else the meta says', () => {
    for (const bad of [null, undefined, {}, { accountUuid: '' }, { accountUuid: '   ' },
      { accountUuid: null, refreshTokenExpiresAt: NOW + 30 * DAY }]) {
      const h = health(bad, NOW);
      assert.equal(h.status, 'signedout', JSON.stringify(bad));
      assert.equal(h.label, 'health.signedout');
      assert.equal(h.daysLeft, null);
    }
  });

  it('every health label is a real i18n key in both locales', () => {
    const cases = [
      null,
      meta({ refreshTokenExpiresAt: NOW - 1 }),
      meta({ refreshTokenExpiresAt: NOW + 3 * DAY }),
      meta({ refreshTokenExpiresAt: NOW + 30 * DAY }),
      meta({ backend: 'keychain' }),
    ];
    const seen = new Set();
    for (const m of cases) {
      const h = health(m, NOW);
      seen.add(h.status);
      for (const locale of LOCALES) {
        assert.ok(Object.prototype.hasOwnProperty.call(MESSAGES[locale], h.label),
          `${h.label} missing from ${locale}`);
        assert.notEqual(createT(locale)(h.label, h.labelVars), h.label);
      }
    }
    assert.deepEqual([...seen].sort(), ['expired', 'ok', 'signedout', 'unknown', 'warn']);
  });

  it('tolerates a nonsense clock without throwing', () => {
    for (const now of [undefined, null, NaN, 'x', -1]) {
      const h = health(meta(), now);
      assert.ok(['ok', 'warn', 'expired', 'unknown', 'signedout'].includes(h.status));
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('argv', () => {
  // ── splitArgs ───────────────────────────────────────────────────────────
  it('lifts --cam <name> out of cam\'s own arguments', () => {
    const s = splitArgs(['--cam', 'work', '-p', 'hi']);
    assert.equal(s.cmd, 'launch');
    assert.equal(s.camName, 'work');
    assert.deepEqual(s.forwarded, ['-p', 'hi']);
    assert.equal(s.forwarded.includes('--cam'), false, 'claude must never see --cam');
  });

  it('lifts --cam=<name>', () => {
    const s = splitArgs(['--cam=work', '-c']);
    assert.equal(s.camName, 'work');
    assert.deepEqual(s.forwarded, ['-c']);
  });

  it('a bare --cam is the ask sentinel, not a name', () => {
    const bare = splitArgs(['--cam']);
    assert.equal(bare.camName, ' ask');
    assert.deepEqual(bare.forwarded, []);

    const beforeFlag = splitArgs(['--cam', '-p', 'hi']);
    assert.equal(beforeFlag.camName, ' ask', 'a following flag is not a name');
    assert.deepEqual(beforeFlag.forwarded, ['-p', 'hi']);

    assert.equal(splitArgs(['--cam=']).camName, ' ask');
  });

  it('lifts --cam out of the FORWARDED half too', () => {
    const s = splitArgs(['--', '--cam', 'work', '-p', 'hi']);
    assert.equal(s.camName, 'work');
    assert.deepEqual(s.forwarded, ['-p', 'hi']);
  });

  it('forwards everything after a bare -- verbatim, spaces and quotes included', () => {
    const forwarded = [
      '--resume', 'explain this codebase to me',
      '-p', 'a "quoted" prompt with  double  spaces',
      '--model', 'claude-haiku-4-5-20251001',
      '--', 'a literal second dash-dash',
      '-p',
    ];
    const s = splitArgs(['launch', '--', ...forwarded]);
    assert.equal(s.cmd, 'launch');
    assert.deepEqual(s.forwarded, forwarded, 'the forwarded half must be byte-identical');
    assert.deepEqual(s.camArgs, []);
  });

  it('the shim shape `cam launch -- <argv>` forwards a bare prompt', () => {
    const s = splitArgs(['launch', '--', 'summarise this repo']);
    assert.equal(s.cmd, 'launch');
    assert.deepEqual(s.forwarded, ['summarise this repo']);
    assert.equal(s.camName, undefined);
  });

  it('recognises verbs, aliases and late verbs after global flags', () => {
    assert.equal(splitArgs(['ls']).cmd, 'ls');
    assert.equal(splitArgs(['list']).cmd, 'ls', 'alias');
    assert.equal(splitArgs(['doctor', '--deep']).cmd, 'doctor');
    assert.deepEqual(splitArgs(['doctor', '--deep']).camArgs, ['--deep']);
    const late = splitArgs(['-v', 'doctor']);
    assert.equal(late.cmd, 'doctor', 'a global flag before the verb must not hide it');
    assert.deepEqual(late.camArgs, ['-v']);
    assert.equal(splitArgs(['--lang', 'pt-BR', 'ls']).cmd, 'ls');
  });

  it('a bare leading word that is not a verb is the `cam <name>` shorthand', () => {
    const s = splitArgs(['work', '-c']);
    assert.equal(s.cmd, 'launch');
    assert.equal(s.camName, 'work');
    assert.deepEqual(s.forwarded, ['-c'], 'everything after the name belongs to claude');
  });

  it('parses cam\'s own flags without ever consuming a forwarded one', () => {
    const s = splitArgs(['ls', '--json', '--all']);
    assert.equal(s.flags.json, true);
    assert.equal(s.flags.all, true);
    assert.equal(s.flags.seed, undefined, 'seed/share stay tri-state');
    assert.equal(s.flags.share, undefined);
    assert.equal(splitArgs(['add', '--no-share']).flags.noShare, true);
    assert.equal(splitArgs(['add', '--keep']).flags.keep, true);
    assert.equal(splitArgs([]).cmd, 'launch');
    assert.equal(splitArgs(null).cmd, 'launch');
    assert.deepEqual(splitArgs(undefined).forwarded, []);
  });

  it('helpText names only commands the registry actually has', () => {
    const text = helpText(null, { all: true, version: '9.9.9' });
    assert.ok(text.length > 0);
    for (const name of Object.keys(COMMANDS)) {
      if (COMMANDS[name].advanced && !text.includes(name)) continue;
      assert.ok(text.includes(name), `help omits the ${name} command`);
    }
    assert.ok(helpText('add').includes('cam add'));
  });

  // ── resolveTarget: the pass-through rule ────────────────────────────────
  const defaultAcct = {
    name: 'default', dir: null, isDefault: true, createdAt: 1,
    meta: { email: 'me@personal.example', accountUuid: 'u-def' },
  };
  const work = {
    name: 'work', dir: '/store/profiles/work', createdAt: 2,
    meta: { email: 'me@acme.example', accountUuid: 'u-work' },
  };
  const side = {
    name: 'side', dir: '/store/profiles/side', createdAt: 3,
    meta: { email: 'me@side.example', accountUuid: 'u-side' },
  };

  const resolve = (over = {}, ctxOver = {}) => {
    const ctx = interactiveCtx(ctxOver);
    const mode = over.mode || interactivity(ctx, { forwarded: over.forwarded || [] });
    return resolveTarget(ctx, {
      accounts: [defaultAcct, work, side],
      forwarded: [],
      camName: null,
      flags: {},
      config: {},
      last: null,
      ...over,
      mode,
    });
  };

  it('zero forwarded arguments + several accounts + interactive => the MENU', () => {
    const r = resolve({ forwarded: [] });
    assert.equal(r.kind, 'pick');
    assert.ok(r.profile, 'the menu still preselects an account');
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 0);
  });

  it('ANY forwarded argument => straight through, no menu', () => {
    for (const forwarded of [
      ['-p'],
      ['-p', 'hello'],
      ['-c'],
      ['--resume'],
      ['--resume', 'abc123'],
      ['explain this codebase to me'],
      ['--model', 'claude-haiku-4-5-20251001'],
      ['-'],
    ]) {
      const r = resolve({ forwarded });
      assert.equal(r.kind, 'launch',
        `${JSON.stringify(forwarded)} must pass through, not open a menu`);
      assert.ok(r.profile);
      assert.ok(r.reason.length > 0, 'a pass-through still explains itself');
    }
  });

  it('CAM_ASK=always opens the menu even with arguments', () => {
    const r = resolve({ forwarded: ['-p', 'hi'] }, { env: { CAM_ASK: 'always' } });
    assert.equal(r.kind, 'pick');
    assert.equal(resolve({ forwarded: [] }, { env: { CAM_ASK: 'ALWAYS' } }).kind, 'pick');
  });

  it('CAM_ASK=never passes through even with no arguments', () => {
    const r = resolve({ forwarded: [] }, { env: { CAM_ASK: 'never' } });
    assert.equal(r.kind, 'launch');
    assert.ok(r.detail.length > 0);
  });

  it('--ask beats CAM_ASK, and CAM_ASK beats config.ask', () => {
    assert.equal(resolve({ flags: { ask: 'never' } }, { env: { CAM_ASK: 'always' } }).kind, 'launch');
    assert.equal(resolve({ config: { ask: 'never' } }, { env: { CAM_ASK: 'always' } }).kind, 'pick');
    assert.equal(resolve({ config: { ask: 'never' } }).kind, 'launch');
    assert.equal(resolve({}, { env: { CAM_ASK: 'nonsense' } }).kind, 'pick', 'garbage falls back to auto');
  });

  it('CLAUDECODE=1 passes through and says why — prompting there is a hard hang', () => {
    const ctx = interactiveCtx({ env: { CLAUDECODE: '1' } });
    const mode = interactivity(ctx, { forwarded: [] });
    assert.equal(mode.kind, 'none');
    assert.ok(mode.reason.length > 0);
    const r = resolveTarget(ctx, {
      accounts: [defaultAcct, work, side], forwarded: [], flags: {}, config: {}, mode,
    });
    assert.equal(r.kind, 'launch');
    assert.ok(r.detail.length > 0, 'a silenced menu must still explain itself');
    assert.ok(r.reason.includes(r.short));
  });

  it('CI and CAM_NO_PROMPT and CAM_TTY=0 all silence the menu, each with a reason', () => {
    for (const env of [{ CI: '1' }, { GITHUB_ACTIONS: 'true' }, { CAM_NO_PROMPT: '1' }, { CAM_TTY: '0' }]) {
      const ctx = interactiveCtx({ env });
      const mode = interactivity(ctx, { forwarded: [] });
      assert.equal(mode.kind, 'none', JSON.stringify(env));
      assert.ok(mode.reason.length > 0);
      const r = resolveTarget(ctx, {
        accounts: [defaultAcct, work, side], forwarded: [], flags: {}, config: {}, mode,
      });
      assert.equal(r.kind, 'launch');
    }
    assert.equal(isCI(interactiveCtx({ env: { CI: '0' } })), false, 'CI=0 means not CI');
    assert.equal(isCI(interactiveCtx({ env: { CI: 'false' } })), false);
  });

  it('CAM_TTY=1 restores a line-mode menu when node cannot see the tty (git-bash)', () => {
    const ctx = ctxOf({ env: { CAM_TTY: '1' } }); // setRawMode throws here
    const mode = interactivity(ctx, { forwarded: [] });
    assert.equal(mode.kind, 'line');
    const r = resolveTarget(ctx, {
      accounts: [defaultAcct, work, side], forwarded: [], flags: {}, config: {}, mode,
    });
    assert.equal(r.kind, 'pick', 'the numbered fallback picker must still appear');
  });

  it('a single account passes through with no menu', () => {
    const ctx = interactiveCtx();
    const mode = interactivity(ctx, { forwarded: [] });
    for (const accounts of [[work], [defaultAcct]]) {
      const r = resolveTarget(ctx, { accounts, forwarded: [], flags: {}, config: {}, mode });
      assert.equal(r.kind, 'launch', `one account should never open a menu`);
      assert.equal(r.profile.name, accounts[0].name);
    }
  });

  it('--cam beats everything, including CAM_PROFILE and ask=always', () => {
    const r = resolve(
      { camName: 'side', forwarded: [] },
      { env: { CAM_PROFILE: 'work', CAM_ASK: 'always' } },
    );
    assert.equal(r.kind, 'launch');
    assert.equal(r.profile.name, 'side');
  });

  it('CAM_PROFILE / CAM_ACCOUNT pin the account', () => {
    assert.equal(resolve({}, { env: { CAM_PROFILE: 'side' } }).profile.name, 'side');
    assert.equal(resolve({}, { env: { CAM_ACCOUNT: 'work' } }).profile.name, 'work');
    assert.equal(resolve({}, { env: { CAM_PROFILE: '  side  ' } }).profile.name, 'side');
    // a bare --cam overrides the pin and asks
    assert.equal(resolve({ camName: ' ask' }, { env: { CAM_PROFILE: 'side' } }).kind, 'pick');
  });

  it('an unknown --cam name is NOT_FOUND / exit 4 and never falls back', () => {
    assert.throws(
      () => resolve({ camName: 'typo' }),
      (err) => {
        assert.ok(isCamError(err), 'must be a CamError');
        assert.equal(err.code, 'NOT_FOUND');
        assert.equal(err.exitCode, EXIT.NOT_FOUND);
        assert.equal(err.exitCode, 4);
        assert.ok(err.hint && err.hint.includes('work'), 'the hint should list the real accounts');
        assert.equal(err.message.includes('typo'), true);
        return true;
      },
    );
  });

  it('an unknown CAM_PROFILE is NOT_FOUND too — never a silent wrong org', () => {
    assert.throws(
      () => resolve({}, { env: { CAM_PROFILE: 'ghost' } }),
      (err) => isCamError(err) && err.code === 'NOT_FOUND' && err.exitCode === 4,
    );
  });

  it('an empty account list is firstrun, not a crash', () => {
    const ctx = interactiveCtx();
    const mode = interactivity(ctx, { forwarded: [] });
    const r = resolveTarget(ctx, { accounts: [], forwarded: [], flags: {}, config: {}, mode });
    assert.equal(r.kind, 'firstrun');
    assert.equal(r.profile, null);
    const signedOutDefault = { name: 'default', dir: null, isDefault: true, meta: {} };
    const r2 = resolveTarget(ctx, {
      accounts: [signedOutDefault], forwarded: [], flags: {}, config: {}, mode,
    });
    assert.equal(r2.kind, 'firstrun', 'a signed-out default alone is still first run');
  });

  it('the last-used account is preselected, and a stale one degrades quietly', () => {
    assert.equal(resolve({ last: 'side' }).profile.name, 'side');
    assert.equal(resolve({ config: { last: 'work' } }).profile.name, 'work');
    const ctx = interactiveCtx();
    const mode = interactivity(ctx, { forwarded: [] });
    const r = resolveTarget(ctx, {
      accounts: [defaultAcct, work, side], forwarded: [], flags: {}, config: {},
      last: 'deleted-account', mode,
    });
    assert.equal(r.kind, 'pick', 'a removed "last" must not throw');
    assert.ok(ctx.io.err.data.includes('deleted-account'), 'and must be mentioned on stderr');
  });

  it('detectCaps never returns NaN dimensions, whatever the stream claims', () => {
    for (const stream of [null, {}, { isTTY: true }, { isTTY: true, columns: NaN, rows: undefined },
      { isTTY: true, columns: 0 }, { isTTY: false, columns: 120 }]) {
      const caps = detectCaps(ctxOf(), stream);
      assert.ok(Number.isInteger(caps.cols) && caps.cols > 0, JSON.stringify(stream));
      assert.ok(Number.isInteger(caps.rows) && caps.rows > 0);
      assert.equal(typeof caps.unicode, 'boolean');
      assert.equal(caps.ascii, !caps.unicode);
    }
    assert.equal(detectCaps(ctxOf({ env: { NO_COLOR: '1' } }), { isTTY: true }).depth, 1);
    assert.equal(detectCaps(ctxOf({ env: { TERM: 'dumb' } }), { isTTY: true }).unicode, false);
    assert.equal(detectCaps(ctxOf({ env: { COLUMNS: '132' } }), null).cols, 132);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('keychain', () => {
  const macCtx = (env = {}) => ctxOf({ platform: 'darwin', home: '/Users/u', env });

  it('with no CLAUDE_CONFIG_DIR the service is exactly the unsuffixed name', () => {
    assert.equal(keychainService(macCtx(), null), 'Claude Code-credentials');
    assert.equal(keychainService(macCtx(), undefined), 'Claude Code-credentials');
    assert.equal(keychainService(macCtx(), ''), 'Claude Code-credentials');
    assert.equal(keychainService(macCtx(), '/Users/u/.claude'), 'Claude Code-credentials',
      'naming the ambient directory explicitly must not change the answer');
  });

  it('a profile directory appends the first 8 hex of sha256(NFC(dir))', () => {
    const dir = '/Users/u/.claude-account-manager/profiles/work';
    assert.equal(
      keychainService(macCtx(), dir),
      `Claude Code-credentials-${sha256Hex(dir).slice(0, 8)}`,
    );
    assert.equal(sha256Hex(dir).length, 64);
    assert.match(keychainService(macCtx(), dir), /^Claude Code-credentials-[0-9a-f]{8}$/);
  });

  it('TWO DIRECTORIES PRODUCE TWO SERVICES — the whole macOS story depends on it', () => {
    const a = keychainService(macCtx(), '/Users/u/.cam/profiles/a');
    const b = keychainService(macCtx(), '/Users/u/.cam/profiles/b');
    assert.notEqual(a, b);
    assert.notEqual(a, 'Claude Code-credentials');
    assert.notEqual(b, 'Claude Code-credentials');
    const many = new Set();
    for (let i = 0; i < 50; i += 1) many.add(keychainService(macCtx(), `/Users/u/.cam/profiles/p${i}`));
    assert.equal(many.size, 50, 'no collisions across 50 profiles');
  });

  it('the hash is over the NFC form, with trailing separators removed', () => {
    const composed = '/Users/u/.cam/profiles/caf\u00e9';
    const decomposed = '/Users/u/.cam/profiles/cafe\u0301';
    assert.notEqual(composed, decomposed, 'the two spellings differ as JS strings');
    assert.equal(keychainService(macCtx(), composed), keychainService(macCtx(), decomposed),
      'a macOS filesystem hands back the decomposed spelling; the service must not change');
    assert.equal(keychainService(macCtx(), '/p/a/'), keychainService(macCtx(), '/p/a'));
    assert.equal(keychainService(macCtx(), 'C:\\p\\a\\'), keychainService(macCtx(), 'C:\\p\\a'));
  });

  it('CLAUDE_CODE_CUSTOM_OAUTH_URL inserts -custom-oauth', () => {
    const ctx = macCtx({ CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://oauth.example' });
    assert.equal(keychainService(ctx, null), 'Claude Code-custom-oauth-credentials');
    const dir = '/Users/u/.cam/profiles/work';
    assert.equal(
      keychainService(ctx, dir),
      `Claude Code-custom-oauth-credentials-${sha256Hex(dir).slice(0, 8)}`,
    );
    assert.ok(keychainService(ctx, dir).includes('-custom-oauth'));
    assert.notEqual(keychainService(ctx, dir), keychainService(macCtx(), dir));
  });

  it('an ambient CLAUDE_CONFIG_DIR is no longer "default" and gets a hash', () => {
    const ctx = macCtx({ CLAUDE_CONFIG_DIR: '/Users/u/elsewhere' });
    assert.equal(keychainService(ctx, null), `Claude Code-credentials-${sha256Hex('/Users/u/elsewhere').slice(0, 8)}`);
    assert.notEqual(keychainService(ctx, null), 'Claude Code-credentials');
  });

  it('the formula is platform-independent (a Linux box can predict the mac name)', () => {
    const dir = '/Users/u/.cam/profiles/work';
    const onLinux = keychainService(ctxOf({ home: '/Users/u', env: {} }), dir);
    assert.equal(onLinux, keychainService(macCtx(), dir));
  });

  it('detectBackend is keychain on darwin, file on linux, and never reads a secret', () => {
    const mac = detectBackend(macCtx(), '/Users/u/.cam/profiles/work');
    assert.equal(mac.kind, 'keychain');
    assert.equal(mac.location, keychainService(macCtx(), '/Users/u/.cam/profiles/work'));

    const linux = detectBackend(ctxOf(), '/store/profiles/work');
    assert.equal(linux.kind, 'file');
    assert.equal(linux.location, join('/store/profiles/work', '.credentials.json'));
    assert.equal(linux.canDelete, true);

    const credman = detectBackend(
      ctxOf({ platform: 'win32', env: { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1' } }),
      'C:\\p\\work',
    );
    assert.equal(credman.kind, 'credman');
    assert.equal(credman.canRead, false, 'cmdkey cannot read a secret blob back');
    assert.equal(credman.canDelete, false);

    const win = detectBackend(ctxOf({ platform: 'win32', env: {} }), 'C:\\p\\work');
    assert.equal(win.kind, 'file', 'Windows defaults to the credentials file');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('quoting', () => {
  /**
   * A faithful CommandLineToArgvW: the parser every Windows program (claude.exe
   * and cmd's own tokeniser for a quoted argument) applies to a command line.
   * quoteForCmd is correct only if this parser recovers the original argv.
   */
  // CommandLineToArgvW, plus the `""`-inside-quotes extension that cmd.exe and
  // the CRT both implement. Every expectation below was cross-checked against a
  // real cmd.exe on Windows 11 driving a real .cmd shim that dumps its argv
  // (16 argument sets, including the backslash-before-quote shapes) — this
  // parser exists so the same assertions can also run on Linux and macOS in CI.
  //
  // The subtle rule, and the one an earlier version of this parser got wrong:
  // when an EVEN number of backslashes precedes a quote, half of them are
  // emitted literally and the quote is still a delimiter — it must be handed to
  // the quote branch, not treated as the end of the argument.
  function parseCommandLine(line) {
    const argv = [];
    const n = line.length;
    let i = 0;
    while (i < n) {
      while (i < n && (line[i] === ' ' || line[i] === '\t')) i += 1;
      if (i >= n) break;

      let arg = '';
      let inQuotes = false;
      while (i < n) {
        const c = line[i];

        if (c === '\\') {
          let slashes = 0;
          while (i < n && line[i] === '\\') { slashes += 1; i += 1; }
          if (i < n && line[i] === '"') {
            arg += '\\'.repeat(slashes >> 1);
            // Odd count: the last backslash escapes the quote, which becomes a
            // literal. Even count: the quote keeps its delimiter meaning and is
            // left in place for the branch below.
            if (slashes & 1) { arg += '"'; i += 1; }
          } else {
            arg += '\\'.repeat(slashes);
          }
          continue;
        }

        if (c === '"') {
          if (inQuotes && line[i + 1] === '"') { arg += '"'; i += 2; continue; }
          inQuotes = !inQuotes;
          i += 1;
          continue;
        }

        if (!inQuotes && (c === ' ' || c === '\t')) break;
        arg += c;
        i += 1;
      }
      argv.push(arg);
    }
    return argv;
  }

  const ROUND_TRIP = [
    ['C:\\Program Files\\claude\\claude.cmd', '-p', 'hello world'],
    ['claude.cmd', 'a"b'],
    ['claude.cmd', 'say "hi" twice'],
    ['claude.cmd', 'a&b'],
    ['claude.cmd', 'a;b'],
    ['claude.cmd', 'a^b'],
    ['claude.cmd', 'a|b', 'c<d', 'e>f', '(g)'],
    ['claude.cmd', 'trailing '],
    ['claude.cmd', ''],
    ['claude.cmd', '', 'after-empty'],
    ['claude.cmd', 'C:\\path\\with\\backslashes'],
    ['claude.cmd', 'ends-with-backslash\\'],
    ['claude.cmd', 'quote-after-slash\\"x'],
    ['claude.cmd', '--model', 'claude-haiku-4-5-20251001'],
    ['claude.cmd', '\ttab\tinside'],
    ['claude.cmd', 'unicode \u00b7 \u4f8b'],
  ];

  it('quoteForCmd wraps the whole line in one outer pair (cmd /s eats it)', () => {
    for (const args of ROUND_TRIP) {
      const line = quoteForCmd(args);
      assert.equal(line[0], '"', `missing leading wrapper for ${JSON.stringify(args)}`);
      assert.equal(line[line.length - 1], '"', `missing trailing wrapper for ${JSON.stringify(args)}`);
    }
  });

  it('quoteForCmd round-trips through CommandLineToArgvW', () => {
    for (const args of ROUND_TRIP) {
      const inner = quoteForCmd(args).slice(1, -1);
      assert.deepEqual(
        parseCommandLine(inner), args,
        `round trip failed for ${JSON.stringify(args)} -> ${JSON.stringify(inner)}`,
      );
    }
  });

  it('quoteForCmd quotes every cmd.exe metacharacter and never emits a caret escape', () => {
    for (const meta of [' ', '"', '^', '&', '|', '<', '>', '(', ')']) {
      const line = quoteForCmd(['x.cmd', `a${meta}b`]);
      const inner = line.slice(1, -1);
      assert.ok(inner.includes('"a'), `${JSON.stringify(meta)} must force quoting: ${inner}`);
    }
    assert.equal(quoteForCmd(['x.cmd', 'a&b']).includes('^&'), false,
      'caret escaping does not survive cmd /d /s /c; do not restore it');
    assert.equal(quoteForCmd(['x.cmd']), '"x.cmd"', 'a plain token needs no inner quotes');
    assert.equal(quoteForCmd(['x.cmd', 'plain']), '"x.cmd plain"');
    assert.equal(quoteForCmd(['x.cmd', '']), '"x.cmd """', 'an empty argument must survive as ""');
  });

  it('exitCodeFor maps signals to 128+n and passes codes through', () => {
    assert.equal(exitCodeFor({ code: 0, signal: null }), 0);
    assert.equal(exitCodeFor({ code: 42, signal: null }), 42);
    assert.equal(exitCodeFor({ code: null, signal: 'SIGINT' }), 130);
    assert.equal(exitCodeFor({ code: null, signal: 'SIGINT' }), 128 + SIGNUM.SIGINT);
    assert.equal(exitCodeFor({ code: null, signal: 'SIGTERM' }), 143);
    assert.equal(exitCodeFor({ code: null, signal: 'SIGHUP' }), 129);
    assert.equal(exitCodeFor({ code: null, signal: 'NOT_A_SIGNAL' }), 128);
    assert.equal(exitCodeFor({ code: null, signal: null }), 1);
    assert.equal(exitCodeFor({}), 1);
    assert.equal(exitCodeFor(), 1);
    assert.equal(EXIT.CANCELLED, 130, 'the cancel code and 128+SIGINT must agree');
  });

  // A fake child: no real process is ever created in this file.
  function fakeSpawn(record, finish) {
    return (file, args, opts) => {
      record.push({ file, args, opts });
      const handlers = new Map();
      const child = {
        on(ev, fn) {
          if (!handlers.has(ev)) handlers.set(ev, []);
          handlers.get(ev).push(fn);
          return child;
        },
      };
      queueMicrotask(() => {
        const list = handlers.get(finish.event) || [];
        for (const fn of list) fn(...finish.args);
      });
      return child;
    };
  }

  it('runInherit uses ComSpec for kind cmd on Windows and never sets shell:true', async () => {
    const calls = [];
    const ctx = ctxOf({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', Path: 'C:\\Windows' },
      spawn: fakeSpawn(calls, { event: 'close', args: [0, null] }),
    });
    const result = await runInherit(ctx, 'C:\\npm\\claude.cmd', ['-p', 'a b'], { kind: 'cmd' });
    assert.equal(result.exitCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(calls[0].args.length, 4);
    assert.equal(calls[0].opts.windowsVerbatimArguments, true);
    assert.equal(calls[0].opts.shell, undefined, 'shell:true breaks paths with spaces and emits DEP0190');
    assert.equal(calls[0].opts.stdio, 'inherit');
    assert.ok(calls[0].args[3].includes('claude.cmd'));
    assert.ok(calls[0].args[3].includes('"a b"'));
  });

  it('runInherit spawns a native .exe directly, with no cmd.exe in the middle', async () => {
    const calls = [];
    const ctx = ctxOf({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      spawn: fakeSpawn(calls, { event: 'close', args: [0, null] }),
    });
    await runInherit(ctx, 'C:\\Users\\u\\.local\\bin\\claude.exe', ['-p', 'a b'], { kind: 'exe' });
    assert.equal(calls[0].file, 'C:\\Users\\u\\.local\\bin\\claude.exe');
    assert.deepEqual(calls[0].args, ['-p', 'a b'], 'arguments reach the exe unquoted and unsplit');
    assert.equal(calls[0].opts.windowsVerbatimArguments, undefined);
    assert.equal(calls[0].opts.shell, undefined);
  });

  it('runInherit never routes through a shell on POSIX, whatever the kind', async () => {
    for (const kind of ['exe', 'cmd', 'script', 'unknown']) {
      const calls = [];
      const ctx = ctxOf({ spawn: fakeSpawn(calls, { event: 'close', args: [0, null] }) });
      await runInherit(ctx, '/usr/local/bin/claude', ['-p'], { kind });
      assert.equal(calls[0].file, '/usr/local/bin/claude', kind);
      assert.deepEqual(calls[0].args, ['-p']);
      assert.equal(calls[0].opts.shell, undefined);
    }
  });

  it('runInherit propagates the child exit code unchanged, and maps SIGINT to 130', async () => {
    const ctx42 = ctxOf({ spawn: fakeSpawn([], { event: 'close', args: [42, null] }) });
    assert.equal((await runInherit(ctx42, '/c', [], {})).exitCode, 42);

    const ctxSig = ctxOf({ spawn: fakeSpawn([], { event: 'close', args: [null, 'SIGINT'] }) });
    const sig = await runInherit(ctxSig, '/c', [], {});
    assert.equal(sig.exitCode, 130);
    assert.equal(sig.signal, 'SIGINT');

    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const ctxErr = ctxOf({ spawn: fakeSpawn([], { event: 'error', args: [enoent] }) });
    assert.equal((await runInherit(ctxErr, '/c', [], {})).exitCode, 127);

    const ctxThrow = ctxOf({ spawn: () => { throw enoent; } });
    assert.equal((await runInherit(ctxThrow, '/c', [], {})).exitCode, 127);
  });

  it('runInherit hands the child exactly the env it was given', async () => {
    const calls = [];
    const ctx = ctxOf({
      env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'leak' },
      spawn: fakeSpawn(calls, { event: 'close', args: [0, null] }),
    });
    const sanitized = sanitizeChildEnv(ctx, { profile: { name: 'w', dir: '/p/w' } });
    await runInherit(ctx, '/c', [], { env: sanitized.env, kind: 'exe' });
    assert.equal(calls[0].opts.env.CLAUDE_CONFIG_DIR, '/p/w');
    assert.equal(calls[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(calls[0].opts.cwd, '/w');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('store-pure', () => {
  it('storePaths puts everything under one root and honours CAM_HOME', () => {
    const plain = storePaths(ctxOf());
    assert.equal(plain.root, join('/home/u', '.claude-account-manager'));
    for (const [key, value] of Object.entries(plain)) {
      if (key === 'root') continue;
      assert.ok(value.startsWith(plain.root + sep), `${key} (${value}) escapes the store root`);
    }
    assert.equal(plain.profilesDir, join(plain.root, 'profiles'));
    assert.equal(plain.trashDir, join(plain.root, 'trash'));
    assert.equal(plain.shellDir, join(plain.root, 'shell'));

    const moved = storePaths(ctxOf({ env: { CAM_HOME: '/srv/cam' } }));
    assert.equal(moved.root, '/srv/cam');
    assert.equal(moved.profilesDir, join('/srv/cam', 'profiles'));
    assert.equal(storePaths(ctxOf({ env: { CAM_HOME: '  ' } })).root,
      join('/home/u', '.claude-account-manager'), 'a blank CAM_HOME is ignored');
  });

  it('claudePaths mirrors the layout Claude Code actually creates', () => {
    const p = claudePaths(ctxOf(), '/p/work');
    assert.equal(p.configDir, '/p/work');
    assert.equal(p.configFile, join('/p/work', '.claude.json'));
    assert.equal(p.credentialsFile, join('/p/work', '.credentials.json'));
    assert.equal(p.backupsDir, join('/p/work', 'backups'));
    assert.equal(p.projectsDir, join('/p/work', 'projects'));
  });

  it('defaultClaudePaths implements the MEASURED resolution rule', () => {
    // Verified on Claude Code 2.1.252: with CLAUDE_CONFIG_DIR unset the live
    // global config is ~/.claude.json (HOME ROOT), not ~/.claude/.claude.json.
    const d = defaultClaudePaths(ctxOf());
    assert.equal(d.configFile, join('/home/u', '.claude.json'));
    assert.equal(d.configDir, join('/home/u', '.claude'));
    assert.equal(d.credentialsFile, join('/home/u', '.claude', '.credentials.json'));
    assert.notEqual(d.configFile, join('/home/u', '.claude', '.claude.json'));

    const over = defaultClaudePaths(ctxOf({ env: { CLAUDE_CONFIG_DIR: '/x' } }));
    assert.equal(over.configDir, '/x');
    assert.equal(over.configFile, join('/x', '.claude.json'));
    assert.equal(over.credentialsFile, join('/x', '.credentials.json'));
  });

  it('cam never names the three files it promises never to write', () => {
    const forbidden = [
      join('/home/u', '.claude.json'),
      join('/home/u', '.claude', '.claude.json'),
      join('/home/u', '.claude', '.credentials.json'),
    ];
    const store = storePaths(ctxOf());
    for (const f of forbidden) {
      assert.equal(f.startsWith(store.root), false,
        `${f} must never be inside the cam store`);
    }
  });

  it('the seed filter is an ALLOWLIST of exactly four keys', () => {
    assert.ok(Object.isFrozen(SEED_KEYS));
    assert.deepEqual([...SEED_KEYS], ['hasCompletedOnboarding', 'theme', 'projects', 'mcpServers']);
    assert.equal(SEED_KEYS.length, 4);
  });

  it('no account-scoped key can ever be in the seed allowlist', () => {
    assert.equal(ACCOUNT_SCOPED_KEYS.length, 29);
    const overlap = ACCOUNT_SCOPED_KEYS.filter((k) => SEED_KEYS.includes(k));
    assert.deepEqual(overlap, [], `these keys would cross an account boundary: ${overlap}`);
    for (const k of ['oauthAccount', 'cachedUsageUtilization', 'passesEligibilityCache',
      'modelAccessCache', 'customApiKeyResponses']) {
      assert.ok(ACCOUNT_SCOPED_KEYS.includes(k), `${k} must be listed as account-scoped`);
      assert.equal(SEED_KEYS.includes(k), false);
    }
    // machine identity is not on the allowlist either, so it can never be copied
    for (const k of ['userID', 'machineID', 'firstStartTime', 'firstStartVersion',
      'migrationVersion', 'seenNotifications', 'oauthAccount']) {
      assert.equal(SEED_KEYS.includes(k), false, `${k} must not be seeded`);
    }
  });

  it('project entries keep only the four trust/onboarding subkeys', () => {
    assert.deepEqual([...PROJECT_SUBKEYS], [
      'hasTrustDialogAccepted',
      'hasCompletedProjectOnboarding',
      'projectOnboardingSeenCount',
      'hasClaudeMdExternalIncludesApproved',
    ]);
    assert.equal(PROJECT_SUBKEYS.includes('allowedTools'), false,
      'tool authorisation must not cross an account boundary');
    assert.equal(PROJECT_SUBKEYS.includes('history'), false,
      'prompt history must not cross an account boundary');
    assert.equal(PROJECT_SUBKEYS.includes('lastCost'), false);
  });

  it('transcript directories are never shared between accounts', () => {
    assert.deepEqual([...SHARE_DIRS], ['plugins', 'commands', 'agents', 'skills']);
    for (const forbidden of ['projects', 'sessions', 'todos', 'file-history', 'shell-snapshots']) {
      assert.equal(SHARE_DIRS.includes(forbidden), false,
        `sharing ${forbidden} would let --resume continue another org's session`);
    }
    assert.deepEqual([...SHARE_FILES], ['settings.json', 'CLAUDE.md']);
    assert.equal(SHARE_FILES.includes('.credentials.json'), false);
    assert.equal(SHARE_FILES.includes('.claude.json'), false);
  });

  it('sha256Hex is stable, lowercase and 64 characters', () => {
    assert.equal(sha256Hex(''),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Hex('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.match(sha256Hex('/p/a'), /^[0-9a-f]{64}$/);
    assert.equal(sha256Hex('/p/a'), sha256Hex('/p/a'));
    assert.notEqual(sha256Hex('/p/a'), sha256Hex('/p/b'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('i18n', () => {
  const EN = MESSAGES.en;
  const PT = MESSAGES['pt-BR'];

  it('the catalogue is frozen and lists exactly the supported locales', () => {
    assert.deepEqual([...LOCALES], ['en', 'pt-BR']);
    assert.ok(Object.isFrozen(MESSAGES));
    assert.ok(Object.isFrozen(EN));
    assert.ok(Object.isFrozen(PT));
    for (const locale of LOCALES) assert.ok(MESSAGES[locale], `${locale} has no catalogue`);
  });

  it('en and pt-BR have an IDENTICAL key set', () => {
    const en = Object.keys(EN).sort();
    const pt = Object.keys(PT).sort();
    const missingInPt = en.filter((k) => !Object.prototype.hasOwnProperty.call(PT, k));
    const extraInPt = pt.filter((k) => !Object.prototype.hasOwnProperty.call(EN, k));
    assert.deepEqual(missingInPt, [], `pt-BR is missing: ${missingInPt.join(', ')}`);
    assert.deepEqual(extraInPt, [], `pt-BR has extra keys: ${extraInPt.join(', ')}`);
    assert.equal(en.length, pt.length);
    assert.ok(en.length > 300, 'the catalogue looks truncated');
  });

  it('no value in any locale is empty or whitespace', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        if (typeof value === 'function') continue;
        assert.equal(typeof value, 'string', `${locale}.${key} is neither a string nor a function`);
        assert.notEqual(value, '', `${locale}.${key} is empty`);
        assert.notEqual(value.trim(), '', `${locale}.${key} is whitespace only`);
      }
    }
  });

  it('a key with placeholders has the SAME placeholders in both locales', () => {
    const placeholders = (v) => (typeof v === 'string'
      ? [...v.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort()
      : null);
    const mismatched = [];
    for (const key of Object.keys(EN)) {
      const a = placeholders(EN[key]);
      const b = placeholders(PT[key]);
      if (a === null || b === null) continue; // one side is a function: shapes differ legitimately
      if (a.join(',') !== b.join(',')) mismatched.push(`${key}: en{${a}} vs pt{${b}}`);
    }
    assert.deepEqual(mismatched, [], mismatched.join('\n'));
  });

  it('detectLocale honours --lang > CAM_LANG > LC_ALL > LC_MESSAGES > LANG', () => {
    assert.equal(detectLocale({ argv: ['--lang', 'pt-BR'], env: { CAM_LANG: 'en' } }), 'pt-BR');
    assert.equal(detectLocale({ argv: ['--lang=pt_BR.UTF-8'], env: { CAM_LANG: 'en' } }), 'pt-BR');
    assert.equal(detectLocale({ env: { CAM_LANG: 'en_US', LC_ALL: 'pt_BR.UTF-8' } }), 'en');
    assert.equal(detectLocale({ env: { LC_ALL: 'en_US.UTF-8', LANG: 'pt_BR.UTF-8' } }), 'en');
    assert.equal(detectLocale({ env: { LC_MESSAGES: 'en_US.UTF-8', LANG: 'pt_BR.UTF-8' } }), 'en');
    assert.equal(detectLocale({ env: { LANG: 'pt_BR.UTF-8' } }), 'pt-BR');
  });

  it('detectLocale parses every pt spelling and every POSIX suffix', () => {
    for (const tag of ['pt', 'pt-BR', 'pt_BR', 'pt_BR.UTF-8', 'pt_PT', 'PT-br',
      'pt_BR.utf8@euro', 'pt-br.ISO-8859-1']) {
      assert.equal(detectLocale({ env: { LANG: tag } }), 'pt-BR', tag);
    }
    for (const tag of ['en', 'en-US', 'en_GB.UTF-8', 'fr_FR.UTF-8', 'de_DE', 'ja_JP.UTF-8']) {
      assert.equal(detectLocale({ env: { LANG: tag } }), 'en', tag);
    }
  });

  it('detectLocale always returns a supported locale, even for garbage', () => {
    for (const input of [
      {}, { env: {} }, { env: { LANG: '' } }, { env: { LANG: 'C' } },
      { env: { LANG: 'POSIX' } }, { env: { LANG: '\u0000' } },
      { argv: ['--lang'] }, { argv: ['--lang', ''] }, { argv: ['--lang=zzz'] },
      { env: { LANG: 42 } }, null, undefined,
    ]) {
      const got = detectLocale(input === null || input === undefined ? undefined : input);
      assert.ok(LOCALES.includes(got), `detectLocale(${JSON.stringify(input)}) = ${got}`);
    }
  });

  it('createCtx wires --lang and CAM_LANG into ctx.locale and ctx.t', () => {
    assert.equal(ctxOf({ argv: ['node', 'cam', '--lang', 'pt-BR'] }).locale, 'pt-BR');
    assert.equal(ctxOf({ argv: ['node', 'cam', '--lang=pt-BR'] }).locale, 'pt-BR');
    assert.equal(ctxOf({ env: { CAM_LANG: 'pt-BR' } }).locale, 'pt-BR');
    assert.equal(ctxOf({ env: { LANG: 'pt_BR.UTF-8' } }).locale, 'pt-BR');
    // a --lang meant for claude, after --, must not change cam's locale
    assert.equal(ctxOf({ argv: ['node', 'cam', '--', '--lang', 'pt-BR'], env: { LANG: 'en_US' } }).locale, 'en');
    const pt = ctxOf({ env: { CAM_LANG: 'pt-BR' } });
    const en = ctxOf({ env: { CAM_LANG: 'en' } });
    assert.notEqual(pt.t('help.usage'), en.t('help.usage'), 'the two catalogues must differ');
  });

  it('createT interpolates, keeps an unknown placeholder visible, and falls back to en', () => {
    const t = createT('en');
    assert.equal(t('launch.spawning', { bin: '/x/claude' }).includes('/x/claude'), true);
    assert.ok(t('health.warnMenu', {}).includes('{'), 'a missing var stays visible, never blank');
    assert.equal(createT('zz-ZZ')('help.usage'), t('help.usage'), 'an unknown locale falls back to en');
    assert.equal(createT(undefined)('help.usage'), t('help.usage'));
    assert.equal(t('this.key.does.not.exist'), 'this.key.does.not.exist',
      'an unknown key returns itself rather than throwing');
    assert.ok(missingKeys().includes('this.key.does.not.exist'),
      'and is recorded so `cam doctor` can report it');
  });

  it('EVERY ctx.t() literal key in src/**/*.js exists in BOTH catalogues', () => {
    // This is the test that stops a missing key ever shipping.
    const re = /(?:^|[^A-Za-z0-9_$.])t\(\s*'([A-Za-z0-9_.]+)'\s*[,)]/g;
    const missing = [];
    let scanned = 0;
    for (const file of SRC_FILES) {
      const text = readFileSync(file, 'utf8');
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        scanned += 1;
        const key = m[1];
        const line = text.slice(0, m.index).split('\n').length;
        for (const locale of LOCALES) {
          if (!Object.prototype.hasOwnProperty.call(MESSAGES[locale], key)) {
            missing.push(`${rel(file)}:${line} t('${key}') missing from ${locale}`);
          }
        }
      }
    }
    assert.ok(scanned > 100, `the scanner found only ${scanned} t() calls; the regex is broken`);
    assert.deepEqual(missing, [], missing.join('\n'));
  });

  it('EVERY i18n key stored in a source constant exists too', () => {
    // Keys that never appear inside a t() call because they are carried as data:
    // HOSTILE_ENV[].impact, validName().reason, health().label, COMMANDS[].summary.
    const carried = new Set();
    for (const item of HOSTILE_ENV) carried.add(item.impact);
    for (const cmd of Object.values(COMMANDS)) carried.add(cmd.summary);
    for (const bad of ['', '.', '..', 'a/b', 'con', 'default', 'a'.repeat(33), '-x', 'x.']) {
      const v = validName(bad);
      if (!v.ok) carried.add(v.reason);
    }
    for (const meta of [null, { accountUuid: 'u', refreshTokenExpiresAt: NOW - 1 },
      { accountUuid: 'u', refreshTokenExpiresAt: NOW + 3 * DAY },
      { accountUuid: 'u', refreshTokenExpiresAt: NOW + 30 * DAY },
      { accountUuid: 'u', backend: 'keychain' }]) {
      carried.add(health(meta, NOW).label);
    }
    assert.ok(carried.size >= 12, `expected a real set of carried keys, saw ${carried.size}`);
    const missing = [];
    for (const key of carried) {
      for (const locale of LOCALES) {
        if (!Object.prototype.hasOwnProperty.call(MESSAGES[locale], key)) {
          missing.push(`${key} missing from ${locale}`);
        }
      }
    }
    assert.deepEqual(missing, [], missing.join('\n'));
  });

  // `--ascii` promises 7-bit output. The frame builders fold their own text,
  // but the one-line summaries of ls/which/doctor are written straight to the
  // stream, so they fold at the point of writing — and that fold has to survive
  // ALREADY-STYLED text, because --ascii and --no-color are separate switches.
  // asciify alone cannot do it: it turns an escape byte into '?' by design.
  it('plain() folds non-ASCII without destroying the ANSI around it', () => {
    const styled = `${ESC}[38;5;245mwork · me@acme.io → ok${ESC}[0m`;

    assert.equal(plain(styled, { ascii: false }), styled, 'nothing folds unless asked');
    assert.equal(plain(styled, null), styled);
    assert.equal(plain(styled, undefined), styled);

    const folded = plain(styled, { ascii: true });
    assert.equal(/[^\x00-\x7f]/.test(folded), false, `still not 7-bit: ${JSON.stringify(folded)}`);
    assert.ok(folded.includes(`${ESC}[38;5;245m`), 'the opening SGR sequence was destroyed');
    assert.ok(folded.includes(`${ESC}[0m`), 'the reset was destroyed');
    assert.ok(folded.includes('work . me@acme.io > ok'), `unexpected fold: ${JSON.stringify(folded)}`);

    assert.equal(plain('', { ascii: true }), '');
    assert.equal(plain(null, { ascii: true }), '');
    assert.equal(plain(undefined, { ascii: true }), '');
  });

  it('every catalogue string folds to 7-bit under --ascii', () => {
    // pt-BR is full of accented characters and both locales use `·` and `→`.
    // If any of them survives the fold, a terminal that asked for ASCII gets
    // mojibake in exactly the line telling it which account is running.
    const bad = [];
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        if (typeof value !== 'string') continue;
        const folded = plain(value, { ascii: true });
        if (/[^\x00-\x7f]/.test(folded)) bad.push(`${locale}.${key} -> ${JSON.stringify(folded)}`);
      }
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });

  // A readline prompt legitimately ends in a space — that is where the caret
  // sits while the user types. Every other trailing space is an accident that
  // shows up as a misaligned box or a ragged line, so the rule stays strict and
  // the exceptions are named here one by one.
  const TRAILING_SPACE_OK = new Set(['pick.choice']);

  it('no catalogue string carries a CR, a tab or an accidental trailing space', () => {
    const bad = [];
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        if (typeof value !== 'string') continue;
        if (value.includes('\r')) bad.push(`${locale}.${key} has a CR`);
        if (value.includes('\t')) bad.push(`${locale}.${key} has a tab`);
        if (/ $/.test(value) && !TRAILING_SPACE_OK.has(key)) {
          bad.push(`${locale}.${key} ends in a space`);
        }
        if (/  $/.test(value)) bad.push(`${locale}.${key} ends in two spaces`);
      }
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });

  it('every key allowed a trailing space actually has one in both locales', () => {
    // Keeps the allowlist honest: an entry that stops needing its exception
    // must be removed rather than left to hide a future regression.
    for (const key of TRAILING_SPACE_OK) {
      for (const locale of LOCALES) {
        assert.match(
          MESSAGES[locale][key],
          / $/,
          `${locale}.${key} no longer ends in a space — drop it from TRAILING_SPACE_OK`
        );
      }
    }
  });

  it('no catalogue string looks like a leaked token', () => {
    const tokenish = /sk-ant-[a-z0-9]{3,6}-[A-Za-z0-9_-]{20,}/;
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        if (typeof value !== 'string') continue;
        assert.equal(tokenish.test(value), false, `${locale}.${key} looks like a token`);
      }
    }
  });

  it('every locale renders every key without throwing', () => {
    const vars = {
      n: 3, name: 'work', names: 'a, b', days: 5, version: '9.9.9', path: '/p',
      bin: '/b', code: 0, reason: 'because', var: 'CAM_PROFILE', ask: 'auto',
      email: 'a@b.c', plan: 'Max', updown: '^v', enter: 'Enter', ago: '2h',
      dir: '/d', file: '/f', shell: 'bash', id: 'x', count: 2, size: '1 kB',
    };
    for (const locale of LOCALES) {
      const t = createT(locale);
      for (const key of Object.keys(MESSAGES[locale])) {
        const out = t(key, vars);
        assert.equal(typeof out, 'string', `${locale}.${key} did not render to a string`);
        assert.equal(out.includes('\r'), false, `${locale}.${key} rendered a CR`);
      }
    }
  });
});
