// src/claude.js — the only module that knows the real `claude` binary exists.
// Owns: finding it across six install layouts, spawning it correctly on Node 24 +
// Windows, wrapping `claude auth`, and proving CLAUDE_CONFIG_DIR still isolates.

import { statSync } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';

import { fail, sanitizeChildEnv } from './ctx.js';
import { ensureDir, readJsonSafe, rmrf, writeJsonAtomic } from './fsx.js';
import { storePaths } from './profiles.js';

/**
 * The signal handlers installed around an inherited-stdio child belong to THIS
 * process, not to the child, and `ctx` has no slot for them. `execPath` — the
 * node that must start a `.js` target on Windows — is the same kind of fact
 * about the running interpreter rather than about the user's machine. Both are
 * reached through `globalThis` so this file still names no ambient environment,
 * platform or stdio global of any kind — every one of those comes from `ctx`.
 */
const runtime = globalThis.process;

/** Signals whose default action would kill the parent before the child. */
const HELD_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGBREAK'];

/** Signal name -> number, for the 128+n exit-code convention. */
export const SIGNUM = Object.freeze({
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGTERM: 15,
  SIGBREAK: 21,
});

/**
 * There is deliberately NO authLogout wrapper in cam.
 *
 * `claude auth logout` revokes the refresh token SERVER-SIDE before it wipes the
 * local state, so calling it against a stored profile permanently destroys that
 * profile's sign-in — for every machine, not just this one. Switching accounts
 * and removing a profile must never revoke anything. If a revoke feature is ever
 * added it has to be its own command with its own explicit confirmation.
 */
export const NEVER_LOGOUT = Object.freeze({
  reason: 'claude auth logout revokes the refresh token server-side; cam never calls it.',
  command: 'claude auth logout',
  safeAlternative: 'cam rm <name> (quarantines the directory, leaves the session valid)',
});

/** Cached isolation proof is trusted for 30 days. */
const ISOLATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A `.session_ingress_token` touched within 5 minutes means a live session. */
const SESSION_FRESH_MS = 5 * 60 * 1000;

/** Windows executable extensions, in preference order. `.ps1` is never runnable here. */
const WIN_EXE_EXT = ['.exe', '.com', '.cmd', '.bat'];

/**
 * Whitespace, a quote, or a cmd.exe metacharacter (`^ & | < > ( )`) forces an
 * argument to be quoted on the cmd.exe path. MEASURED on Windows 11 with
 * `cmd /d /s /c` + windowsVerbatimArguments: caret escaping does NOT survive
 * (`shim.cmd a^&b` ran `b` as a second command), while quoting does
 * (`shim.cmd "a&b"` delivered `a&b` intact). See quoteForCmd.
 */
const CMD_NEEDS_QUOTES = /[\s"^&|<>()]/;

/**
 * Read an environment variable case-insensitively.
 * `ctx.env` is a plain COPY of the real environment, so on Windows it has lost
 * the case-insensitive lookup the live environment object provides — the real
 * key is usually `Path`, not `PATH`.
 * @param {object} ctx cam context
 * @param {string} name variable name
 * @returns {string|undefined} the value, or undefined
 */
function envGet(ctx, name) {
  const env = (ctx && ctx.env) || {};
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key];
  }
  return undefined;
}

/**
 * @param {object} ctx cam context
 * @returns {boolean} true on Windows
 */
function isWin(ctx) {
  return ctx.platform === 'win32';
}

/**
 * @param {object} ctx cam context
 * @param {string} p possibly relative path
 * @returns {string} absolute path, resolved against `ctx.cwd` (never the live cwd)
 */
function absolutize(ctx, p) {
  return isAbsolute(p) ? p : join(ctx.cwd || ctx.home, p);
}

/**
 * @param {string} p path
 * @returns {boolean} true when `p` exists and is a regular file
 */
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * cam must never resolve ITSELF as the claude binary: the shell hook defines a
 * `claude` function that calls `cam`, and a cam bin on PATH next to it would
 * make an infinite spawn loop.
 * @param {string} p candidate path
 * @returns {boolean} true when the candidate is a cam artefact
 */
function looksLikeCam(p) {
  const lower = p.toLowerCase();
  if (lower.includes('claude-account-manager')) return true;
  const base = basename(lower);
  return base.startsWith('cam');
}

/**
 * Classify a resolved path so `runInherit` knows how to start it.
 * @param {string} p resolved binary path
 * @param {string} platform ctx.platform
 * @returns {'exe'|'cmd'|'script'|'unknown'} how the file must be started
 */
function classifyKind(p, platform) {
  const ext = extname(p || '').toLowerCase();
  if (ext === '.exe' || ext === '.com') return 'exe';
  if (ext === '.cmd' || ext === '.bat') return 'cmd';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.sh' || ext === '.bash') return 'script';
  if (ext === '') return platform === 'win32' ? 'script' : 'exe';
  return 'unknown';
}

/**
 * Probe one candidate location, recording every concrete path examined.
 * @param {object} ctx cam context
 * @param {string} base candidate path, with or without an extension
 * @param {string[]} tried accumulator of every path examined
 * @param {Set<string>} seen dedupe set
 * @param {{ explicit?: boolean }} [opts] explicit candidates may be extensionless on Windows
 * @returns {string|null} the first existing file, or null
 */
function probeCandidate(ctx, base, tried, seen, opts = {}) {
  if (!base) return null;
  const win = isWin(ctx);
  const hasExt = extname(base) !== '';
  let variants;
  if (hasExt) variants = [base];
  else if (win) variants = opts.explicit ? [...WIN_EXE_EXT.map((e) => base + e), base] : WIN_EXE_EXT.map((e) => base + e);
  else variants = [base];

  for (const variant of variants) {
    const key = win ? variant.toLowerCase() : variant;
    if (seen.has(key)) continue;
    seen.add(key);
    tried.push(variant);
    // NEVER a .ps1: it cannot be started without a PowerShell host and the
    // execution policy makes it unreliable even then.
    if (extname(variant).toLowerCase() === '.ps1') continue;
    if (looksLikeCam(variant)) continue;
    if (isFile(variant)) return variant;
  }
  return null;
}

/**
 * @param {object} ctx cam context
 * @returns {string[]} PATH entries, unquoted and deduped
 */
function pathDirs(ctx) {
  const raw = envGet(ctx, 'PATH') || '';
  const sep = isWin(ctx) ? ';' : ':';
  const out = [];
  const seen = new Set();
  for (const part of String(raw).split(sep)) {
    const dir = part.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    const key = isWin(ctx) ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/**
 * Find the real `claude` binary WITHOUT spawning anything.
 * Order: CAM_CLAUDE_BIN, config.claudeBin, CLAUDE_CODE_EXECPATH (Claude Code sets
 * it in every process it spawns), ~/.local/bin, ~/.claude/local,
 * ~/.claude/local/node_modules/.bin, the platform package-manager locations, then
 * a PATH scan. `npm prefix -g` is deliberately NOT consulted: 299 ms measured, and
 * it needs shell:true on Windows because npm is npm.cmd.
 *
 * CAM_CLAUDE_BIN and config.claudeBin are PINS, not merely the first candidates:
 * a pin that does not resolve stops the search and reports nothing found. Falling
 * through to auto-discovery would silently run a DIFFERENT claude than the one the
 * user pinned — a different version, possibly a different account behaviour — and
 * `cam doctor` would then describe that binary as if it were the configured one.
 * A typo, or an install under a directory named `claude-account-manager` (which
 * `looksLikeCam` rejects), is exactly how that happens. CLAUDE_CODE_EXECPATH is
 * NOT a pin: it is ambient state inherited from a parent Claude Code process, not
 * a choice the user made, so a stale one still falls through.
 * @param {object} ctx cam context
 * @param {{ config?: object|null, claudeBin?: string|null }} [opts] configured override
 * @returns {{ path: string|null, kind: 'exe'|'cmd'|'script'|'unknown', tried: string[], pinned: string[] }} the winner, every location examined, and the pins that failed
 */
export function resolveClaude(ctx, opts = {}) {
  const tried = [];
  const seen = new Set();
  const win = isWin(ctx);
  const home = ctx.home;

  const configured = opts.claudeBin || (opts.config && opts.config.claudeBin) || null;
  const pins = [envGet(ctx, 'CAM_CLAUDE_BIN'), configured]
    .filter((entry) => typeof entry === 'string' && entry !== '')
    .map((entry) => absolutize(ctx, String(entry)));
  for (const entry of pins) {
    const hit = probeCandidate(ctx, entry, tried, seen, { explicit: true });
    if (hit) return { path: hit, kind: classifyKind(hit, ctx.platform), tried, pinned: [] };
  }
  if (pins.length > 0) return { path: null, kind: 'unknown', tried, pinned: pins };

  const inherited = envGet(ctx, 'CLAUDE_CODE_EXECPATH');
  if (inherited) {
    const hit = probeCandidate(ctx, absolutize(ctx, String(inherited)), tried, seen, { explicit: true });
    if (hit) return { path: hit, kind: classifyKind(hit, ctx.platform), tried, pinned: [] };
  }

  const dirs = [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.claude', 'local', 'node_modules', '.bin'),
  ];
  if (win) {
    const appData = envGet(ctx, 'APPDATA');
    if (appData) dirs.push(join(appData, 'npm'));
    const localAppData = envGet(ctx, 'LOCALAPPDATA');
    if (localAppData) dirs.push(join(localAppData, 'Programs', 'claude'));
  } else {
    dirs.push(
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/home/linuxbrew/.linuxbrew/bin',
      join(home, '.bun', 'bin'),
      join(home, '.volta', 'bin'),
      join(home, '.local', 'share', 'mise', 'shims'),
      join(home, '.asdf', 'shims'),
    );
  }
  for (const dir of dirs) {
    const hit = probeCandidate(ctx, join(dir, 'claude'), tried, seen);
    if (hit) return { path: hit, kind: classifyKind(hit, ctx.platform), tried, pinned: [] };
  }

  for (const dir of pathDirs(ctx)) {
    const hit = probeCandidate(ctx, join(dir, 'claude'), tried, seen);
    if (hit) return { path: hit, kind: classifyKind(hit, ctx.platform), tried, pinned: [] };
  }

  return { path: null, kind: 'unknown', tried, pinned: [] };
}

/**
 * Like `resolveClaude`, but the not-found case is a CamError carrying the full
 * list of locations examined — that list IS the diagnosis.
 * @param {object} ctx cam context
 * @param {{ config?: object|null, claudeBin?: string|null }} [opts] configured override
 * @returns {{ path: string, kind: 'exe'|'cmd'|'script'|'unknown' }} the resolved binary
 */
export function requireClaude(ctx, opts = {}) {
  const found = resolveClaude(ctx, opts);
  if (found.path) return { path: found.path, kind: found.kind };

  const shown = found.tried.slice(0, 3);
  const rest = found.tried.length - shown.length;
  let looked = `${ctx.t('launch.noClaudeLooked')} ${shown.join(', ')}`;
  if (rest > 0) looked += ` ${ctx.t('launch.noClaudeMore', { n: rest })}`;
  // A pin that failed is the answer, not a footnote: the user named a path and
  // it could not be used. Leading with it stops them re-reading a list of
  // locations cam searched instead of fixing the one they configured.
  const pins = Array.isArray(found.pinned) ? found.pinned : [];
  const pinNote = pins.length > 0
    ? `${ctx.t('err.claudeBinPinned', { path: pins.join(', ') })} · `
    : '';
  const hint = `${pinNote}${ctx.t('err.noClaudeHint')} · ${looked}`;

  try {
    fail('NO_CLAUDE', ctx.t('err.noClaude'), { hint });
  } catch (err) {
    // `fail` never returns; attach the full list so launch.js can render the
    // "I looked in …" block without resolving a second time.
    err.tried = found.tried;
    throw err;
  }
  /* c8 ignore next */
  return { path: '', kind: 'unknown' };
}

/**
 * Quote one argument so that it survives BOTH cmd.exe's parser and the
 * CommandLineToArgvW parser the target program uses.
 *
 * Rules, all three measured rather than assumed:
 *  - quote whenever the argument is empty, holds whitespace or a quote, or holds
 *    a cmd metacharacter — inside a quoted region cmd treats `& | < > ( ) ^` as
 *    ordinary text;
 *  - represent an embedded quote as `""`, never as `\"`. Both reach the program
 *    intact, but `\"` leaves cmd's own quote counter flipped for the REST of the
 *    line (cmd knows nothing about backslash escapes), so a later `&` falls
 *    outside quotes and splits the command. `""` keeps the count even.
 *  - double the backslashes that immediately precede a quote (including the
 *    closing one), which is what CommandLineToArgvW requires.
 * @param {string} arg raw argument
 * @returns {string} the quoted argument
 */
function argvQuote(arg) {
  const s = String(arg);
  if (s.length > 0 && !CMD_NEEDS_QUOTES.test(s)) return s;
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    let slashes = 0;
    while (i < s.length && s[i] === '\\') {
      slashes += 1;
      i += 1;
    }
    if (i === s.length) {
      out += '\\'.repeat(slashes * 2);
      break;
    }
    if (s[i] === '"') out += `${'\\'.repeat(slashes * 2)}""`;
    else out += '\\'.repeat(slashes) + s[i];
  }
  out += '"';
  return out;
}

/**
 * Build the single command string for `cmd.exe /d /s /c <string>`.
 *
 * The outer pair of quotes is required: with /s, cmd strips the first character
 * and the LAST quote on the line, so an unwrapped line whose program path is
 * quoted would lose that quote and break on any path containing a space.
 *
 * There is deliberately NO caret escaping here. Measured on Windows 11 through
 * `spawn(cmd.exe, ['/d','/s','/c', line], {windowsVerbatimArguments:true})`:
 *   ""…\shim.cmd" a^&b"   -> the shim received `a`, then cmd ran `b` as a
 *                            command and failed. The caret is consumed without
 *                            protecting the metacharacter.
 *   ""…\shim.cmd" "a&b""  -> the shim received `a&b`. Quoting is what works.
 * Do not "restore" the caret pass; it is a regression, not a hardening.
 *
 * KNOWN LIMIT: `%VAR%` inside an argument is still expanded by cmd, and quoting
 * cannot stop it. Only the .cmd/.bat shim path is affected; a native .exe is
 * spawned directly and never goes through cmd at all.
 *
 * Exported for unit testing.
 * @param {string[]} args the program path followed by its arguments
 * @returns {string} the outer-wrapped, fully quoted command line
 */
export function quoteForCmd(args) {
  const line = (Array.isArray(args) ? args : [args]).map(argvQuote).join(' ');
  return `"${line}"`;
}

/**
 * The node that must start a `.js`/`.mjs`/`.cjs` target on Windows. `ctx.execPath`
 * exists so a test can inject one; the running interpreter is the honest default,
 * because a `claude` shipped as a .js file is a script of THIS node's package.
 * @param {object} ctx cam context
 * @returns {string} an absolute node path, or the bare name as a last resort
 */
function nodeExecPath(ctx) {
  if (ctx && typeof ctx.execPath === 'string' && ctx.execPath) return ctx.execPath;
  return (runtime && runtime.execPath) || 'node';
}

/**
 * Find an interpreter by name on PATH (plus, for bash, the Git for Windows
 * layouts, whose bash.exe is usually NOT on PATH — `Git\cmd` is what installers
 * add and it holds no shell).
 * @param {object} ctx cam context
 * @param {string[]} names bare interpreter names, in preference order
 * @param {string[]} [extraDirs] additional directories to search first
 * @returns {string|null} an absolute path, or null when nothing was found
 */
function findInterpreter(ctx, names, extraDirs = []) {
  const tried = [];
  const seen = new Set();
  for (const name of names) {
    for (const dir of [...extraDirs, ...pathDirs(ctx)]) {
      const hit = probeCandidate(ctx, join(dir, name), tried, seen);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Route a Windows `script` target to the interpreter that can actually run it.
 *
 * cmd.exe CANNOT start a script: it resolves the file through PATHEXT and the
 * machine's file association, so `.js` runs under whatever `ftype JSFile` says
 * (WScript.exe by default, which drops every argument, swallows stdout and
 * exits 0) and `.sh` runs under nothing at all — while cam reports success.
 * MEASURED on Windows 11: `cmd /d /s /c ""t.sh" hello"` exited 0 and never ran
 * the script; `""probe.js" hello"` reached Code.exe with `hello` stripped.
 *
 * Only `.cmd`/`.bat` and extensionless PATH lookups belong on the ComSpec path;
 * those are the cases it was measured for. Note that a `.ps1` is still never
 * *resolved* as the claude binary (see probeCandidate) — this only starts one the
 * user named explicitly, e.g. through `cam exec`.
 * @param {object} ctx cam context
 * @param {string} file the target script
 * @param {string[]} list arguments, already stringified
 * @returns {{ file: string, args: string[], extra: object }|null} the spawn triple, or null for "use ComSpec"
 */
function winScriptSpec(ctx, file, list) {
  const ext = extname(String(file || '')).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { file: nodeExecPath(ctx), args: [file, ...list], extra: {} };
  }
  if (ext === '.sh' || ext === '.bash') {
    const gitDirs = [];
    for (const root of [envGet(ctx, 'ProgramFiles'), envGet(ctx, 'ProgramFiles(x86)'), envGet(ctx, 'ProgramW6432')]) {
      if (root) gitDirs.push(join(root, 'Git', 'bin'), join(root, 'Git', 'usr', 'bin'));
    }
    const localAppData = envGet(ctx, 'LOCALAPPDATA');
    if (localAppData) gitDirs.push(join(localAppData, 'Programs', 'Git', 'bin'));
    // Falling back to the bare name is deliberate: an ENOENT from spawn becomes
    // exit 127, which is a diagnosis. A silent exit 0 is not.
    return { file: findInterpreter(ctx, ['bash', 'sh'], gitDirs) || 'bash.exe', args: [file, ...list], extra: {} };
  }
  if (ext === '.ps1') {
    const host = findInterpreter(ctx, ['pwsh', 'powershell']) || 'powershell.exe';
    return { file: host, args: ['-NoProfile', '-File', file, ...list], extra: {} };
  }
  return null;
}

/**
 * Turn (file, args, kind) into what `ctx.spawn` must actually be given.
 * Node 24 throws EINVAL when a `.cmd`/`.bat` is spawned directly (CVE-2024-27980
 * hardening) and every npm-global Claude Code install on Windows IS `claude.cmd`,
 * so those go through cmd.exe with windowsVerbatimArguments. Script targets never
 * do — cmd.exe cannot start them (see winScriptSpec). `shell:true` is never used:
 * it breaks on paths with spaces and emits DEP0190.
 * @param {object} ctx cam context
 * @param {string} file the resolved binary
 * @param {string[]} args arguments
 * @param {'exe'|'cmd'|'script'|'unknown'} kind classification from resolveClaude
 * @returns {{ file: string, args: string[], extra: object }} the spawn triple
 */
function spawnSpec(ctx, file, args, kind) {
  const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
  if (isWin(ctx) && kind !== 'exe') {
    // The extension is the ground truth here, not `kind`: launch.js labels .ps1
    // 'script' while classifyKind calls it 'unknown', and both must be started
    // by a real interpreter rather than by a file association.
    const viaInterpreter = winScriptSpec(ctx, file, list);
    if (viaInterpreter) return viaInterpreter;
    const comspec = envGet(ctx, 'ComSpec') || 'cmd.exe';
    return {
      file: comspec,
      args: ['/d', '/s', '/c', quoteForCmd([file, ...list])],
      extra: { windowsVerbatimArguments: true },
    };
  }
  return { file, args: list, extra: {} };
}

/**
 * Install no-op handlers so the parent never dies before the child and orphans a
 * TUI mid-redraw. Signals are NOT forwarded: with an inherited console the OS
 * already delivers CTRL_C_EVENT to the attached process group on Windows and
 * SIGINT to the foreground process group on POSIX.
 * @returns {() => void} release function that removes exactly what it installed
 */
function holdSignals() {
  if (!runtime || typeof runtime.on !== 'function') return () => {};
  const noop = () => {};
  const held = [];
  for (const sig of HELD_SIGNALS) {
    // Not every signal exists on every platform; each one gets its own guard.
    try {
      runtime.on(sig, noop);
      held.push(sig);
    } catch {
      /* signal unsupported here */
    }
  }
  return () => {
    for (const sig of held) {
      try {
        runtime.removeListener(sig, noop);
      } catch {
        /* already gone */
      }
    }
  };
}

/**
 * Map a child's termination to a shell exit code.
 * @param {{ code?: number|null, signal?: string|null }} result child close result
 * @returns {number} 128+signum for a signal, the code otherwise, 1 for neither
 */
export function exitCodeFor({ code, signal } = {}) {
  if (signal) return 128 + (SIGNUM[signal] ?? 0);
  return code ?? 1;
}

/**
 * Start a child with the terminal fully inherited. This is the ONE place in cam
 * where the session itself is created.
 * @param {object} ctx cam context
 * @param {string} file the resolved binary
 * @param {string[]} args arguments forwarded verbatim
 * @param {{ env?: object, cwd?: string, kind?: 'exe'|'cmd'|'script'|'unknown' }} [opts] child options
 * @returns {Promise<{ code: number|null, signal: string|null, exitCode: number }>} how the child ended
 */
export function runInherit(ctx, file, args, opts = {}) {
  const { env = { ...ctx.env }, cwd = ctx.cwd, kind = 'exe' } = opts;
  const spec = spawnSpec(ctx, file, args, kind);
  if (ctx.verbose) ctx.io.err.write(`${ctx.t('launch.spawning', { bin: file })}\n`);

  return new Promise((settle) => {
    const release = holdSignals();
    let done = false;
    /**
     * @param {{ code: number|null, signal: string|null, exitCode: number }} result outcome
     * @returns {void}
     */
    const finish = (result) => {
      if (done) return;
      done = true;
      release();
      settle(result);
    };

    let child;
    try {
      child = ctx.spawn(spec.file, spec.args, {
        cwd,
        env,
        stdio: 'inherit',
        windowsHide: false,
        ...spec.extra,
      });
    } catch (err) {
      finish({ code: null, signal: null, exitCode: err && err.code === 'ENOENT' ? 127 : 1 });
      return;
    }

    child.on('error', (err) => {
      finish({ code: null, signal: null, exitCode: err && err.code === 'ENOENT' ? 127 : 1 });
    });
    child.on('close', (code, signal) => {
      finish({ code: code ?? null, signal: signal ?? null, exitCode: exitCodeFor({ code, signal }) });
    });
  });
}

/**
 * Run a child and capture its output. NEVER throws on a non-zero exit: that is
 * load-bearing, because `claude auth status --json` EXITS 1 WHEN LOGGED OUT while
 * still printing valid JSON on stdout.
 * @param {object} ctx cam context
 * @param {string} file the resolved binary
 * @param {string[]} args arguments
 * @param {{ env?: object, cwd?: string, kind?: string, timeoutMs?: number, maxBuffer?: number }} [opts] child options
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean }>} the captured result; code -1 means the spawn itself failed
 */
export function runCapture(ctx, file, args, opts = {}) {
  const {
    env = { ...ctx.env },
    cwd = ctx.cwd,
    kind = 'exe',
    timeoutMs = 20000,
    maxBuffer = 1024 * 1024,
  } = opts;
  const spec = spawnSpec(ctx, file, args, kind);

  return new Promise((settle) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    let killTimer = null;
    let hardTimer = null;

    /**
     * @param {{ code: number|null, stdout: string, stderr: string, timedOut: boolean }} result outcome
     * @returns {void}
     */
    const finish = (result) => {
      if (done) return;
      done = true;
      if (killTimer) clearTimeout(killTimer);
      if (hardTimer) clearTimeout(hardTimer);
      settle(result);
    };

    let child;
    try {
      child = ctx.spawn(spec.file, spec.args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...spec.extra,
      });
    } catch (err) {
      finish({ code: -1, stdout: '', stderr: String((err && err.message) || err), timedOut: false });
      return;
    }

    if (child.stdout && typeof child.stdout.setEncoding === 'function') {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (stdout.length < maxBuffer) stdout += chunk;
      });
      child.stdout.on('error', () => {});
    }
    if (child.stderr && typeof child.stderr.setEncoding === 'function') {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        if (stderr.length < maxBuffer) stderr += chunk;
      });
      child.stderr.on('error', () => {});
    }

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        hardTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, 2000);
        if (hardTimer && typeof hardTimer.unref === 'function') hardTimer.unref();
      }, timeoutMs);
      if (killTimer && typeof killTimer.unref === 'function') killTimer.unref();
    }

    child.on('error', (err) => {
      finish({
        code: -1,
        stdout,
        stderr: stderr || String((err && err.message) || err),
        timedOut,
      });
    });
    child.on('close', (code) => {
      finish({ code: code ?? null, stdout, stderr, timedOut });
    });
  });
}

/**
 * Ask the binary for its version.
 * @param {object} ctx cam context
 * @param {string|{ path: string, kind?: string }} bin the resolved binary
 * @returns {Promise<string|null>} e.g. "2.1.252", or null when it could not be read
 */
export async function claudeVersion(ctx, bin) {
  const file = typeof bin === 'string' ? bin : bin && bin.path;
  if (!file) return null;
  const kind = (typeof bin === 'object' && bin && bin.kind) || classifyKind(file, ctx.platform);
  const res = await runCapture(ctx, file, ['--version'], { kind, timeoutMs: 10000 });
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)/.exec(`${res.stdout}\n${res.stderr}`);
  return match ? match[1] : null;
}

/**
 * Build the child environment for a `claude auth` call. A profile directory gets
 * the sanitized environment, so an ambient CLAUDE_CODE_OAUTH_TOKEN can never make
 * an empty directory look signed in. No configDir means the native default
 * account, whose environment is passed through untouched.
 * @param {object} ctx cam context
 * @param {string|null} configDir the CLAUDE_CONFIG_DIR to use, or null
 * @param {string} name profile name for CAM_ACTIVE
 * @returns {object} the child environment
 */
function envForConfigDir(ctx, configDir, name) {
  if (!configDir) return { ...ctx.env };
  const { env } = sanitizeChildEnv(ctx, { profile: { name, dir: configDir } });
  return env;
}

/**
 * Parse the first JSON object out of captured stdout.
 * @param {string} text captured stdout
 * @returns {object|null} the parsed object, or null
 */
function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    /* fall through to substring extraction */
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    const value = JSON.parse(raw.slice(first, last + 1));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * `claude auth status --json` for one config directory. Parses stdout REGARDLESS
 * of the exit code, because the command exits 1 when logged out while still
 * printing valid JSON. Its output is never logged at any verbosity, in case a
 * future version adds token material. Measured cost ~334 ms, so this is a cold
 * path only: cam add, cam doctor, self-heal and verifyIsolation.
 * @param {object} ctx cam context
 * @param {{ configDir?: string|null, bin?: string|{path:string,kind?:string}|null, timeoutMs?: number }} opts where and how to ask
 * @returns {Promise<object>} { loggedIn, authMethod, apiProvider, email, orgId, orgName, subscriptionType, projectsDirectory, raw } or { loggedIn: false }
 */
export async function authStatus(ctx, { configDir = null, bin = null, timeoutMs = 20000 } = {}) {
  const resolved = bin
    ? { path: typeof bin === 'string' ? bin : bin.path, kind: typeof bin === 'string' ? classifyKind(bin, ctx.platform) : bin.kind || classifyKind(bin.path, ctx.platform) }
    : requireClaude(ctx);

  const res = await runCapture(ctx, resolved.path, ['auth', 'status', '--json'], {
    env: envForConfigDir(ctx, configDir, 'cam-auth'),
    kind: resolved.kind,
    timeoutMs,
  });

  const data = parseJsonObject(res.stdout);
  if (!data) return { loggedIn: false };

  return {
    loggedIn: data.loggedIn === true,
    authMethod: data.authMethod ?? null,
    apiProvider: data.apiProvider ?? null,
    email: data.email ?? null,
    orgId: data.orgId ?? null,
    orgName: data.orgName ?? null,
    subscriptionType: data.subscriptionType ?? null,
    projectsDirectory: data.projectsDirectory ?? null,
    raw: data,
  };
}

/**
 * Hand the terminal to Claude Code's own login, running inside one config
 * directory. stdio is inherited COMPLETELY and nothing may be repainting: on
 * headless Linux, WSL and over SSH this flow prints a URL the user must read.
 * cam never sees a password.
 * @param {object} ctx cam context
 * @param {{ configDir?: string|null, bin?: string|{path:string,kind?:string}|null, mode?: 'claudeai'|'console'|'sso'|'email', email?: string }} opts where and how to sign in
 * @returns {Promise<{ exitCode: number }>} claude's own exit code
 */
export async function authLogin(ctx, { configDir = null, bin = null, mode = 'claudeai', email = '' } = {}) {
  const resolved = bin
    ? { path: typeof bin === 'string' ? bin : bin.path, kind: typeof bin === 'string' ? classifyKind(bin, ctx.platform) : bin.kind || classifyKind(bin.path, ctx.platform) }
    : requireClaude(ctx);

  const args = ['auth', 'login'];
  if (mode === 'console') args.push('--console');
  else if (mode === 'sso') args.push('--sso');
  else if (mode === 'email') {
    if (!email) fail('USAGE', ctx.t('err.usage'), { hint: ctx.t('err.usageHint') });
    args.push('--email', email);
  } else args.push('--claudeai');

  const res = await runInherit(ctx, resolved.path, args, {
    env: envForConfigDir(ctx, configDir, 'cam-login'),
    kind: resolved.kind,
  });
  return { exitCode: res.exitCode };
}

/**
 * Prove, on THIS machine, that a fresh CLAUDE_CONFIG_DIR really is a separate
 * credential namespace. `ok === false` means every profile would silently be the
 * same account while the UI reported success — the one failure that is
 * indistinguishable from working, so `cam add` must refuse on it.
 * @param {object} ctx cam context
 * @param {{ bin?: string|{path:string,kind?:string}|null, force?: boolean }} [opts] binary override and cache bypass
 * @returns {Promise<{ ok: boolean, at: number, claudeVersion: string|null, detail: string }>} the proof, cached for 30 days
 */
export async function verifyIsolation(ctx, { bin = null, force = false } = {}) {
  const paths = storePaths(ctx);
  const resolved = bin
    ? { path: typeof bin === 'string' ? bin : bin.path, kind: typeof bin === 'string' ? classifyKind(bin, ctx.platform) : bin.kind || classifyKind(bin.path, ctx.platform) }
    : requireClaude(ctx);

  const version = await claudeVersion(ctx, resolved);
  const cached = await readJsonSafe(ctx, paths.isolationFile, null);
  if (
    !force &&
    cached &&
    cached.ok === true &&
    cached.claudeVersion === version &&
    cached.platform === ctx.platform &&
    typeof cached.at === 'number' &&
    ctx.now() - cached.at < ISOLATION_TTL_MS
  ) {
    return {
      ok: true,
      at: cached.at,
      claudeVersion: cached.claudeVersion ?? null,
      detail: cached.detail || ctx.t('doctor.isolationOk'),
    };
  }

  await ensureDir(ctx, paths.root);
  let probeDir = null;
  let ok = false;
  let detail = ctx.t('doctor.isolationUnreadable');
  try {
    probeDir = await mkdtemp(join(paths.root, 'isolation-'));
    const status = await authStatus(ctx, { configDir: probeDir, bin: resolved, timeoutMs: 30000 });
    if (status.raw != null) {
      ok = status.loggedIn === false;
      detail = ok ? ctx.t('doctor.isolationOk') : ctx.t('doctor.isolationFail');
    }
  } catch {
    ok = false;
  } finally {
    if (probeDir) {
      try {
        await rmrf(ctx, probeDir);
      } catch {
        /* a leftover probe dir is swept by sweepPending */
      }
    }
  }

  const at = ctx.now();
  try {
    await writeJsonAtomic(
      ctx,
      paths.isolationFile,
      { schema: 1, ok, at, claudeVersion: version, platform: ctx.platform, detail },
      { mode: 0o600 },
    );
  } catch {
    /* the proof is a cache; failing to store it must never break the caller */
  }
  return { ok, at, claudeVersion: version, detail };
}

/**
 * Is a claude session currently using this config directory? Used ONLY to refuse
 * destructive moves of a directory a session owns. Deliberately NOT a gate on
 * switching: two accounts in two terminals at once is a supported feature.
 * @param {object} ctx cam context
 * @param {string} configDir the profile directory
 * @returns {Promise<boolean>} true when the session token was touched under 5 minutes ago
 */
export async function sessionIsLive(ctx, configDir) {
  if (!configDir) return false;
  try {
    const info = await stat(join(configDir, '.session_ingress_token'));
    return ctx.now() - info.mtimeMs < SESSION_FRESH_MS;
  } catch {
    return false;
  }
}
