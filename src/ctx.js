// src/ctx.js — the single injection point for env, platform, home, cwd, io, clock
// and spawn, plus the CamError vocabulary, the exit-code table and the child-process
// environment sanitizer. The ONLY module under src/ allowed to touch process/os.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { createT, detectLocale } from './i18n.js';

/** Used when package.json cannot be read (a checkout without an install, a bundle). */
const FALLBACK_VERSION = '0.1.0';

/** Stable process exit codes. Machine-readable contract: never renumber. */
export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_FOUND: 4,
  CONFLICT: 5,
  NO_ACCOUNTS: 6,
  AUTH_FAILED: 7,
  UNSAFE: 8,
  NO_CLAUDE: 127,
  CANCELLED: 130,
});

// Error codes that are not themselves exit codes still need a home: they are all
// ordinary failures (exit 1) but keep a distinct code so messages stay specific.
const CODE_EXIT = Object.freeze({
  OK: EXIT.OK,
  ERROR: EXIT.ERROR,
  USAGE: EXIT.USAGE,
  NOT_FOUND: EXIT.NOT_FOUND,
  CONFLICT: EXIT.CONFLICT,
  NO_ACCOUNTS: EXIT.NO_ACCOUNTS,
  AUTH_FAILED: EXIT.AUTH_FAILED,
  UNSAFE: EXIT.UNSAFE,
  NO_CLAUDE: EXIT.NO_CLAUDE,
  CANCELLED: EXIT.CANCELLED,
  IO: EXIT.ERROR,
  JSON: EXIT.ERROR,
  PERMISSION: EXIT.ERROR,
  NODE_VERSION: EXIT.ERROR,
  UNEXPECTED: EXIT.ERROR,
});

/**
 * The variables that silently outrank CLAUDE_CONFIG_DIR. Left in place, every
 * profile would resolve to the same account while cam reported success — so the
 * launcher deletes them from the child environment and prints one line each.
 * `impact` is an i18n KEY (this is a module constant; it has no translator).
 * CLAUDE_CODE_FORCE_WINDOWS_CREDMAN is deliberately absent: it changes the
 * credential backend, not the account, so it is reported and never stripped.
 */
export const HOSTILE_ENV = Object.freeze([
  Object.freeze({ name: 'CLAUDE_CODE_OAUTH_TOKEN', impact: 'env.impact.oauthToken' }),
  Object.freeze({ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', impact: 'env.impact.secureStorage' }),
  Object.freeze({ name: 'SELF_HOSTED_RUNNER_HOST_CONFIG_DIR', impact: 'env.impact.selfHosted' }),
  Object.freeze({ name: 'CLAUDE_CODE_ACCOUNT_UUID', impact: 'env.impact.accountUuid' }),
  Object.freeze({ name: 'CLAUDE_CODE_ORGANIZATION_UUID', impact: 'env.impact.orgUuid' }),
]);

/** cam's own pins: always dropped from a child so a nested claude cannot inherit one. */
const PIN_ENV = Object.freeze([
  Object.freeze({ name: 'CAM_PROFILE', impact: 'env.impact.camPin' }),
  Object.freeze({ name: 'CAM_ACCOUNT', impact: 'env.impact.camPin' }),
  Object.freeze({ name: 'CAM_TTY', impact: 'env.impact.camPin' }),
]);

// Reported by `cam doctor` / `cam which -v` but never stripped by cam.
const REPORTED_ONLY = Object.freeze([
  Object.freeze({ name: 'CLAUDE_CONFIG_DIR', impact: 'env.impact.configDir' }),
  Object.freeze({ name: 'CLAUDE_CODE_FORCE_WINDOWS_CREDMAN', impact: 'env.impact.credman' }),
]);

/** An error the user can act on: stable code, deterministic exit code, one-line hint. */
export class CamError extends Error {
  /**
   * @param {string} code stable code from the CODE_EXIT table ('NOT_FOUND', 'IO', …)
   * @param {string} message already-translated one-line message
   * @param {{ hint?: string|null, cause?: unknown, exitCode?: number }} [opts] extras
   */
  constructor(code, message, opts = {}) {
    super(String(message));
    const o = opts && typeof opts === 'object' ? opts : {};
    this.name = 'CamError';
    this.code = String(code);
    this.exitCode = Number.isInteger(o.exitCode)
      ? o.exitCode
      : (Object.prototype.hasOwnProperty.call(CODE_EXIT, this.code) ? CODE_EXIT[this.code] : EXIT.ERROR);
    this.hint = typeof o.hint === 'string' && o.hint ? o.hint : null;
    this.cause = o.cause;
  }
}

/**
 * Throw a CamError. Both `message` and `opts.hint` must already be translated.
 * @param {string} code stable code ('USAGE', 'NOT_FOUND', 'UNSAFE', 'IO', …)
 * @param {string} message translated one-line message
 * @param {{ hint?: string|null, cause?: unknown, exitCode?: number }} [opts] extras
 * @returns {never} always throws
 */
export function fail(code, message, opts = {}) {
  throw new CamError(code, message, opts);
}

/**
 * Is this a CamError? Duck-typed as well as instanceof, so an error crossing a
 * duplicated module instance still renders as a user error and not a stack trace.
 * @param {unknown} e the caught value
 * @returns {boolean} true when it carries the CamError contract
 */
export function isCamError(e) {
  if (e instanceof CamError) return true;
  return Boolean(
    e && typeof e === 'object'
    && e.name === 'CamError'
    && typeof e.code === 'string'
    && Number.isInteger(e.exitCode),
  );
}

let cachedVersion = null;

/**
 * Read `version` out of the package manifest next to src/.
 * readFileSync + import.meta.url, never a JSON import assertion (Node 18 has none).
 * @returns {string} the package version, or the built-in fallback
 */
function readVersion() {
  if (cachedVersion !== null) return cachedVersion;
  let value = FALLBACK_VERSION;
  try {
    const file = fileURLToPath(new URL('../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.version === 'string' && parsed.version) value = parsed.version;
  } catch {
    // No manifest (a bare checkout, a bundled build): the fallback is correct enough.
  }
  cachedVersion = value;
  return value;
}

/**
 * Is this a plain data object (safe to merge recursively)? Streams and class
 * instances are not, and must be replaced wholesale instead of merged into.
 * @param {unknown} v candidate
 * @returns {boolean} true for object literals and null-prototype objects
 */
function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursive merge of plain objects only.
 * @param {Record<string, any>} base defaults
 * @param {Record<string, any>} over overrides
 * @returns {Record<string, any>} a new merged object
 */
function deepMerge(base, over) {
  const out = { ...base };
  for (const key of Object.keys(over)) {
    const value = over[key];
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/**
 * Interpret an environment flag.
 * @param {string|undefined} raw the raw environment value
 * @returns {boolean|null} true/false when the variable is set, null when it is not
 */
function envFlag(raw) {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === '' || v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

/**
 * cam's own arguments: everything before the first bare `--`, so flags meant for
 * claude (`cam launch -- --verbose`) never change cam's own behaviour.
 * @param {string[]} argv the full argv
 * @returns {string[]} the leading slice
 */
function ownArgs(argv) {
  const list = Array.isArray(argv) ? argv.filter((a) => typeof a === 'string') : [];
  const cut = list.indexOf('--');
  return cut === -1 ? list : list.slice(0, cut);
}

/**
 * The name cam was invoked as, for usage lines.
 * @param {string[]} argv the full argv
 * @returns {string} 'cam' unless argv names something else
 */
function defaultArgv0(argv) {
  const entry = Array.isArray(argv) ? argv[1] : null;
  if (typeof entry === 'string' && /\.(m|c)?js$|cam(\.exe|\.cmd)?$/i.test(entry)) {
    const base = basename(entry).replace(/\.(m|c)?js$|\.(exe|cmd|ps1)$/i, '');
    if (base && base !== 'node') return base;
  }
  return 'cam';
}

/**
 * Look a variable up case-insensitively on Windows, where the OS resolves
 * environment names without regard to case but a spread copy does not.
 * @param {Record<string, string|undefined>} env the environment
 * @param {string} name canonical variable name
 * @param {boolean} insensitive true on Windows
 * @returns {string|undefined} the value, or undefined when absent
 */
function envGet(env, name, insensitive) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  if (!insensitive) return undefined;
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) return env[key];
  }
  return undefined;
}

/**
 * Delete a variable, including every differently-cased spelling on Windows.
 * A lower-case `claude_code_oauth_token` would otherwise survive the strip and
 * still be honoured by the child, because Windows resolves names case-blind.
 * @param {Record<string, string|undefined>} env the environment (mutated)
 * @param {string} name canonical variable name
 * @param {boolean} insensitive true on Windows
 * @returns {boolean} true when something was actually removed
 */
function envDelete(env, name, insensitive) {
  let removed = false;
  if (Object.prototype.hasOwnProperty.call(env, name)) {
    delete env[name];
    removed = true;
  }
  if (!insensitive) return removed;
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) {
      delete env[key];
      removed = true;
    }
  }
  return removed;
}

/**
 * Set a variable under its canonical spelling, dropping other casings first.
 * @param {Record<string, string|undefined>} env the environment (mutated)
 * @param {string} name canonical variable name
 * @param {string} value the value
 * @param {boolean} insensitive true on Windows
 * @returns {void}
 */
function envSet(env, name, value, insensitive) {
  envDelete(env, name, insensitive);
  env[name] = value;
}

/**
 * Redact anything token-shaped: first 12 characters and last 4, nothing more.
 * A secret must never reach a log line, a JSON dump or a doctor report.
 * @param {string} name variable name
 * @param {string|undefined} value raw value
 * @returns {string|null} a safe-to-print value, or null when unset
 */
function redactValue(name, value) {
  if (typeof value !== 'string') return null;
  if (value === '') return '';
  const secretName = /(TOKEN|SECRET|PASSWORD|CREDENTIALS?|API_?KEY)/i.test(name);
  const secretShape = value.length >= 32 && /^[A-Za-z0-9_.+=-]+$/.test(value);
  if (!secretName && !secretShape) return value;
  if (value.length <= 16) return '…';
  return `${value.slice(0, 12)}…${value.slice(-4)}`;
}

/**
 * Build the context every other module receives as its first parameter.
 * Overrides are deep-merged over the defaults, so a test can assemble a whole
 * fake machine: a fake HOME, a fake platform, string-collecting streams, a frozen
 * clock and a fake spawn. `env` is the one field REPLACED rather than merged —
 * an injected environment is a complete environment, which is what keeps tests
 * hermetic on a machine that already has CLAUDECODE or CLAUDE_* set.
 * @param {Record<string, any>} [overrides] partial ctx to layer over the defaults
 * @returns {Readonly<Record<string, any>>} the frozen context object
 */
export function createCtx(overrides = {}) {
  const over = overrides && typeof overrides === 'object' ? overrides : {};

  const argv = Array.isArray(over.argv) ? over.argv.slice() : process.argv.slice();
  const camArgv = ownArgs(argv);

  const env = isPlainObject(over.env) ? { ...over.env } : { ...process.env };

  const base = {
    platform: process.platform,
    home: homedir(),
    cwd: process.cwd(),
    io: { in: process.stdin, out: process.stdout, err: process.stderr },
    now: () => Date.now(),
    spawn: nodeSpawn,
    spawnSync: nodeSpawnSync,
    version: readVersion(),
    argv0: defaultArgv0(argv),
  };

  const merged = deepMerge(base, over);
  merged.env = env;

  const platform = typeof merged.platform === 'string' ? merged.platform : 'linux';
  merged.platform = platform;
  merged.isWindows = typeof over.isWindows === 'boolean' ? over.isWindows : platform === 'win32';
  merged.isDarwin = typeof over.isDarwin === 'boolean' ? over.isDarwin : platform === 'darwin';
  merged.isPosix = typeof over.isPosix === 'boolean' ? over.isPosix : platform !== 'win32';

  // A frozen clock may be handed in as a plain number.
  if (typeof merged.now === 'number') {
    const frozen = merged.now;
    merged.now = () => frozen;
  } else if (typeof merged.now !== 'function') {
    merged.now = () => Date.now();
  }

  merged.locale = typeof over.locale === 'string' && over.locale
    ? over.locale
    : detectLocale({ env, argv: camArgv });
  merged.t = typeof over.t === 'function' ? over.t : createT(merged.locale);

  merged.verbose = typeof over.verbose === 'boolean'
    ? over.verbose
    : envFlag(envGet(env, 'CAM_VERBOSE', merged.isWindows)) === true || camArgv.includes('--verbose');

  if (typeof over.ascii === 'boolean' || over.ascii === null) {
    merged.ascii = over.ascii;
  } else if (camArgv.includes('--ascii')) {
    merged.ascii = true;
  } else {
    const flag = envFlag(envGet(env, 'CAM_ASCII', merged.isWindows));
    merged.ascii = flag === null ? null : flag;
  }

  // Exposed as a method as well as an export: the launch algorithm calls it as
  // ctx.sanitizeChildEnv(ctx, { profile }).
  merged.sanitizeChildEnv = sanitizeChildEnv;

  delete merged.argv;
  return Object.freeze(merged);
}

/**
 * Build the environment for a spawned child.
 * The reserved `default` account (profile.dir === null) is passed through
 * UNTOUCHED — it means "byte-for-byte what happens today", so stripping there
 * would be a regression cam introduced. For a real profile, CLAUDE_CONFIG_DIR
 * and CAM_ACTIVE are set, every hostile override is removed, and cam's own pins
 * are dropped. The caller MUST print one line per `stripped` entry: never silent.
 * @param {Readonly<Record<string, any>>} ctx the context
 * @param {{ profile?: { name?: string, dir?: string|null }|null, keepEnv?: boolean }} [opts] target profile and --keep-env
 * @returns {{ env: Record<string, string|undefined>, stripped: Array<{ name: string, impact: string, key: string }>, notes: string[] }} child env, what was removed, what to tell the user
 */
export function sanitizeChildEnv(ctx, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const profile = o.profile && typeof o.profile === 'object' ? o.profile : null;
  const keepEnv = o.keepEnv === true;
  const insensitive = ctx.isWindows === true;
  const env = { ...ctx.env };
  /** @type {Array<{ name: string, impact: string, key: string }>} */
  const stripped = [];
  /** @type {string[]} */
  const notes = [];

  const dir = profile && typeof profile.dir === 'string' && profile.dir ? profile.dir : null;

  if (dir === null) {
    if (envGet(env, 'CLAUDE_CONFIG_DIR', insensitive) !== undefined) {
      notes.push(ctx.t('launch.respectConfigDir'));
    }
    return { env, stripped, notes };
  }

  envSet(env, 'CLAUDE_CONFIG_DIR', dir, insensitive);
  envSet(env, 'CAM_ACTIVE', typeof profile.name === 'string' ? profile.name : '', insensitive);

  for (const pin of PIN_ENV) envDelete(env, pin.name, insensitive);

  if (keepEnv) {
    notes.push(ctx.t('launch.keepEnv'));
    return { env, stripped, notes };
  }

  for (const item of HOSTILE_ENV) {
    if (envGet(env, item.name, insensitive) === undefined) continue;
    envDelete(env, item.name, insensitive);
    stripped.push({ name: item.name, impact: ctx.t(item.impact), key: item.impact });
  }

  return { env, stripped, notes };
}

/**
 * Describe every override variable cam cares about, for `cam doctor` and
 * `cam which -v`. Token-shaped values come back redacted; the real value never
 * leaves this function.
 * @param {Readonly<Record<string, any>>} ctx the context
 * @returns {Array<{ name: string, present: boolean, value: string|null, impact: string, hostile: boolean }>} one row per variable, hostile ones first
 */
export function describeAmbient(ctx) {
  const insensitive = ctx.isWindows === true;
  const env = ctx.env || {};
  const rows = [];

  for (const item of HOSTILE_ENV) rows.push({ item, hostile: true });
  for (const item of REPORTED_ONLY) rows.push({ item, hostile: false });
  for (const item of PIN_ENV) rows.push({ item, hostile: false });

  return rows.map(({ item, hostile }) => {
    const raw = envGet(env, item.name, insensitive);
    return {
      name: item.name,
      present: raw !== undefined,
      value: redactValue(item.name, raw),
      impact: ctx.t(item.impact),
      hostile,
    };
  });
}
