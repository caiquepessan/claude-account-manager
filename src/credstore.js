// src/credstore.js — the credential-store facade: which backend holds an account's
// OAuth session (file, macOS Keychain, Windows Credential Manager), with honest
// capability flags. Cold paths only; the switch path never calls this module.

import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { readJsonSafe, rmrf, sha256Hex } from './fsx.js';
import { runCapture } from './claude.js';
import { fail } from './ctx.js';

/** The keychain account name Claude Code stores every credential under. */
export const KEYCHAIN_ACCOUNT = 'claude-code-user';

/** Absolute path on purpose: this touches credentials, so PATH is not trusted. */
const SECURITY_BIN = '/usr/bin/security';

/** ctx -> boolean, filled in by securityAvailable() and read by detectBackend(). */
const SECURITY_PROBE = new WeakMap();

/** Env values that mean "off" for a boolean-ish variable. */
const FALSY = new Set(['', '0', 'false', 'no', 'off']);

/**
 * Verified token prefixes. Access and refresh tokens are BOTH exactly 108
 * characters, so length can never tell them apart — only the prefix can, and
 * only the refresh token is ever fingerprinted.
 */
const TOKEN_PREFIX = { access: 'sk-ant-oat01', refresh: 'sk-ant-ort01' };

/** A chunked keychain payload is bounded; this stops a delete loop running away. */
const MAX_CHUNKS = 64;

/** Stand-in path used by describe(), which talks about the class, not one profile. */
const PROFILE_PLACEHOLDER = '<profile>';

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
 * A non-empty string, or null.
 * @param {unknown} value the candidate
 * @returns {string|null} the string, or null
 */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Normalize a directory for comparison and hashing: NFC, no trailing separator.
 * @param {string} dir the directory path
 * @returns {string} the normalized path
 */
function normDir(dir) {
  let d = String(dir).normalize('NFC');
  while (d.length > 1 && (d.endsWith('/') || d.endsWith('\\'))) d = d.slice(0, -1);
  return d;
}

/**
 * The config directory Claude Code would use with the ambient environment.
 * @param {object} ctx the cam context
 * @returns {string} the ambient config directory
 */
function ambientConfigDir(ctx) {
  const env = ctx.env || {};
  const sec = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (sec !== undefined) return String(sec);
  return str(env.CLAUDE_CONFIG_DIR) || join(ctx.home, '.claude');
}

/**
 * Is this directory the machine's untouched, default Claude Code config directory.
 * cam must never delete or rewrite anything under it.
 * @param {object} ctx the cam context
 * @param {string} dir the directory to test
 * @returns {boolean} true when dir is ~/.claude with no override in play
 */
function isDefaultConfigDir(ctx, dir) {
  const env = ctx.env || {};
  if (env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined) return false;
  return samePath(ctx, dir, join(ctx.home, '.claude')) && !str(env.CLAUDE_CONFIG_DIR);
}

/**
 * Compare two directory paths for identity, separator- and (on Windows)
 * case-insensitively. Used by every guard that decides "is this the user's real
 * login directory", so it must not be defeated by a path spelled with the other
 * slash — `join(home, '.claude')` yields backslashes on Windows while a config
 * file or a test may spell the same directory with forward slashes.
 *
 * Comparison only: the Keychain service hash is still computed on the exact NFC
 * path, because that is the byte string Claude Code itself hashes.
 * @param {object} ctx the cam context
 * @param {string|null|undefined} a first path
 * @param {string|null|undefined} b second path
 * @returns {boolean} whether both name the same directory
 */
function samePath(ctx, a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const loose = (p) => {
    const s = normDir(p).split('\\').join('/');
    return ctx.platform === 'win32' ? s.toLowerCase() : s;
  };
  return loose(a) === loose(b);
}

/**
 * Best sync answer for "can we drive /usr/bin/security", used by the sync
 * detectBackend. securityAvailable() upgrades this to a measured answer.
 * @param {object} ctx the cam context
 * @returns {boolean} whether the security(1) tool looks usable
 */
function securityKnown(ctx) {
  if (SECURITY_PROBE.has(ctx)) return SECURITY_PROBE.get(ctx) === true;
  if (ctx.platform !== 'darwin') return false;
  try {
    return existsSync(SECURITY_BIN);
  } catch {
    return false;
  }
}

/**
 * The directory whose `.credentials.json` holds this account's session.
 * @param {object} ctx the cam context
 * @param {string|null|undefined} configDir the profile's config directory, if known
 * @returns {string} the directory holding the credentials file
 */
function fileCredentialsDir(ctx, configDir) {
  const sec = str((ctx.env || {}).CLAUDE_SECURESTORAGE_CONFIG_DIR);
  if (sec) return sec;
  return str(configDir) || ambientConfigDir(ctx);
}

/**
 * The macOS Keychain service name for one config directory — a 1:1 port of the
 * decompiled name derivation. This path-derived namespacing is what makes every
 * profile a separate Keychain item with no Keychain code on the switch path,
 * and it is why a profile directory can never be renamed in place.
 * @param {object} ctx the cam context
 * @param {string|null} [configDir] the profile's config directory; omit for the ambient one
 * @returns {string} the Keychain service name
 */
export function keychainService(ctx, configDir) {
  const env = ctx.env || {};
  const sec = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const explicit = str(configDir);
  const ambient = ambientConfigDir(ctx);

  let isDefaultDir;
  let dir;
  if (explicit === null || samePath(ctx, explicit, ambient)) {
    isDefaultDir = sec !== undefined ? !sec : !str(env.CLAUDE_CONFIG_DIR);
    dir = normDir(ambient);
  } else {
    // cam always launches a profile with CLAUDE_CONFIG_DIR=<dir> and with
    // CLAUDE_SECURESTORAGE_CONFIG_DIR stripped, so the child computes exactly this.
    isDefaultDir = false;
    dir = normDir(explicit);
  }

  const oauthSuffix = env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : '';
  return `Claude Code${oauthSuffix}-credentials` + (isDefaultDir ? '' : `-${sha256Hex(dir).slice(0, 8)}`);
}

/**
 * Which credential backend holds this account's session, and what cam may do with it.
 * @param {object} ctx the cam context
 * @param {string|null} [configDir] the profile's config directory; omit for the ambient one
 * @returns {{kind: 'file'|'keychain'|'credman', label: string, location: string, canRead: boolean, canWrite: boolean, canDelete: boolean, reason?: string}} the backend
 */
export function detectBackend(ctx, configDir) {
  const env = ctx.env || {};
  const secureStorage = str(env.CLAUDE_SECURESTORAGE_CONFIG_DIR);

  if (ctx.platform === 'darwin' && !secureStorage) {
    const usable = securityKnown(ctx);
    const backend = {
      kind: 'keychain',
      label: ctx.t('doctor.credentialsKeychain'),
      location: keychainService(ctx, configDir),
      canRead: usable,
      canWrite: usable,
      canDelete: usable,
    };
    if (!usable) backend.reason = ctx.t('credstore.securityMissing');
    return backend;
  }

  if (ctx.platform === 'win32' && flagOn(env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN)) {
    // Claude Code writes a chunked base64 payload under `claude-code-user#m`
    // (metadata {n,l}) plus `#0..#n-1`; cmdkey cannot read secret blobs back, so
    // cam detects and explains this instead of silently doing nothing. `cam add`
    // still works — Claude Code writes into the profile's own service namespace —
    // only purge of the stored credential is unavailable.
    return {
      kind: 'credman',
      label: ctx.t('doctor.credentialsCredman'),
      // The service namespace, derived the same way; not a verified target path.
      location: keychainService(ctx, configDir),
      canRead: false,
      canWrite: false,
      canDelete: false,
      reason: ctx.t('credstore.credmanNoRead'),
    };
  }

  // Everything else, Linux included: a plain file. The Claude Code binary
  // contains no libsecret / gnome-keyring / Secret-Service strings at all.
  const file = join(fileCredentialsDir(ctx, configDir), '.credentials.json');
  return {
    kind: 'file',
    label: ctx.t('doctor.credentialsFile', { path: file }),
    location: file,
    canRead: true,
    canWrite: true,
    canDelete: true,
  };
}

/**
 * Everything the rest of cam is allowed to know about an account's credentials.
 * On the Keychain and Credential Manager backends it reads NOTHING, which is what
 * guarantees the account picker can never raise a macOS Keychain prompt.
 * No token value is returned, logged or kept: only the four derived numbers,
 * the scope list and a 12-hex fingerprint of the refresh token.
 * @param {object} ctx the cam context
 * @param {string} configDir the profile's config directory
 * @returns {Promise<{backend: string, unknown?: boolean, hasOauth?: boolean, expiresAt?: number|null, refreshTokenExpiresAt?: number|null, subscriptionType?: string|null, scopes?: string[], fingerprint?: string|null, extraKeys?: string[]}>} the summary
 */
export async function summary(ctx, configDir) {
  const backend = detectBackend(ctx, configDir);
  if (backend.kind !== 'file') return { backend: backend.kind, unknown: true };

  const raw = await readJsonSafe(ctx, backend.location, null);
  const root = raw && typeof raw === 'object' ? raw : null;
  const extraKeys = root ? Object.keys(root).filter((k) => k !== 'claudeAiOauth') : [];
  const oauth = root && root.claudeAiOauth && typeof root.claudeAiOauth === 'object'
    ? root.claudeAiOauth
    : null;

  if (!oauth) {
    return {
      backend: 'file',
      hasOauth: false,
      expiresAt: null,
      refreshTokenExpiresAt: null,
      subscriptionType: null,
      scopes: [],
      fingerprint: null,
      extraKeys,
    };
  }

  // Read once, derive, discard. Nothing below this line holds token material.
  const hasOauth = typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0;
  const rotating = typeof oauth.refreshToken === 'string' ? oauth.refreshToken : '';
  const fingerprint = rotating.length > 0 && !rotating.startsWith(TOKEN_PREFIX.access)
    ? sha256Hex(rotating).slice(0, 12)
    : null;

  return {
    backend: 'file',
    hasOauth,
    expiresAt: Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null,
    refreshTokenExpiresAt: Number.isFinite(oauth.refreshTokenExpiresAt) ? oauth.refreshTokenExpiresAt : null,
    subscriptionType: str(oauth.subscriptionType),
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter((s) => typeof s === 'string') : [],
    fingerprint,
    extraKeys,
  };
}

/**
 * Can cam drive macOS security(1). Measured once per context, then cached.
 * `list-keychains` reads the search list only: no secret, no password prompt.
 * @param {object} ctx the cam context
 * @returns {Promise<boolean>} true when security(1) ran successfully
 */
export async function securityAvailable(ctx) {
  if (SECURITY_PROBE.has(ctx)) return SECURITY_PROBE.get(ctx) === true;
  if (ctx.platform !== 'darwin') {
    SECURITY_PROBE.set(ctx, false);
    return false;
  }
  let ok = false;
  try {
    const r = await runCapture(ctx, SECURITY_BIN, ['list-keychains'], { timeoutMs: 5000 });
    ok = r && r.code === 0;
  } catch {
    ok = false;
  }
  SECURITY_PROBE.set(ctx, ok);
  return ok;
}

/**
 * Does a Keychain item exist for this service. Runs WITHOUT `-w`, so it returns
 * metadata only and never raises a password prompt — never add `-w` here.
 * @param {object} ctx the cam context
 * @param {string} service the Keychain service name from keychainService()
 * @returns {Promise<boolean>} true when the item exists
 */
export async function keychainHasItem(ctx, service) {
  if (ctx.platform !== 'darwin') return false;
  if (!str(service)) return false;
  if (!(await securityAvailable(ctx))) return false;
  try {
    const r = await runCapture(
      ctx,
      SECURITY_BIN,
      ['find-generic-password', '-s', service, '-a', KEYCHAIN_ACCOUNT],
      { timeoutMs: 10000 },
    );
    return !!r && r.code === 0;
  } catch {
    return false;
  }
}

/**
 * Delete one generic-password item, reporting only whether it was there.
 * @param {object} ctx the cam context
 * @param {string} service the Keychain service name
 * @param {string} account the Keychain account name
 * @returns {Promise<boolean>} true when an item was deleted
 */
async function keychainDeleteItem(ctx, service, account) {
  try {
    const r = await runCapture(
      ctx,
      SECURITY_BIN,
      ['delete-generic-password', '-s', service, '-a', account],
      { timeoutMs: 15000 },
    );
    return !!r && r.code === 0;
  } catch {
    return false;
  }
}

/**
 * Delete the stored credential for one profile directory. Called only by
 * `cam rm --purge`; the caller must first print that deleting a local credential
 * does NOT revoke the session server-side (rm.notRevoked).
 * Refuses outright for the machine's real ~/.claude login.
 * @param {object} ctx the cam context
 * @param {string} configDir the profile's config directory
 * @returns {Promise<boolean>} true when something was actually deleted
 */
export async function remove(ctx, configDir) {
  const dir = str(configDir);
  if (!dir || isDefaultConfigDir(ctx, dir)) {
    fail('UNSAFE', ctx.t('rm.refuseDefault'), { hint: ctx.t('err.unsafeHint') });
  }

  const backend = detectBackend(ctx, dir);

  if (backend.kind === 'keychain') {
    if (!(await securityAvailable(ctx))) return false;
    const service = backend.location;
    let removed = await keychainDeleteItem(ctx, service, KEYCHAIN_ACCOUNT);
    if (await keychainDeleteItem(ctx, service, `${KEYCHAIN_ACCOUNT}#m`)) removed = true;
    for (let i = 0; i < MAX_CHUNKS; i += 1) {
      if (!(await keychainDeleteItem(ctx, service, `${KEYCHAIN_ACCOUNT}#${i}`))) break;
      removed = true;
    }
    return removed;
  }

  if (backend.kind === 'credman') {
    // cmdkey cannot address the chunked blob Claude Code writes; say nothing was
    // removed rather than pretending. detectBackend().reason carries the why.
    return false;
  }

  // Deliberately NOT backend.location: that follows an ambient
  // CLAUDE_SECURESTORAGE_CONFIG_DIR, and a purge must never reach outside the
  // profile directory it was handed. cam strips that variable for every profile
  // it launches, so the profile's own credential is always right here.
  const file = join(dir, '.credentials.json');
  let existed = false;
  try {
    existed = existsSync(file);
  } catch {
    existed = false;
  }
  if (!existed) return false;
  try {
    await rmrf(ctx, file);
  } catch (cause) {
    fail('ERROR', ctx.t('err.io', { file }), { hint: ctx.t('err.ioHint'), cause });
  }
  return true;
}

/**
 * A doctor-ready description of the credential backend this machine uses for
 * profiles, with no real profile path in it.
 * @param {object} ctx the cam context
 * @returns {{kind: 'file'|'keychain'|'credman', notes: string[]}} the backend kind and its caveats
 */
export function describe(ctx) {
  const backend = detectBackend(ctx, PROFILE_PLACEHOLDER);
  const notes = [backend.label];
  if (backend.kind === 'file' && ctx.platform === 'win32') notes.push(ctx.t('doctor.credmanOff'));
  if (backend.reason) notes.push(backend.reason);
  return { kind: backend.kind, notes };
}
