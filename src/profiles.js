// src/profiles.js — the account store, implemented as filesystem-as-database.
// Owns: enumerate, create, seed, meta-cache, health, quarantine and restore
// profile directories. There is no registry file that can desynchronise from disk.

import { join, basename, dirname, isAbsolute } from 'node:path';
import { readdir, readFile, stat, lstat, mkdir, rm } from 'node:fs/promises';
import { hostname } from 'node:os';

import { fail } from './ctx.js';
import {
  chmodIfPosix,
  ensureDir,
  writeFileAtomic,
  writeJsonAtomic,
  readJsonSafe,
  copyFileIfExists,
  linkDir,
  moveDir,
  purgeTree,
  rmrf,
} from './fsx.js';
import * as credstore from './credstore.js';

// ── constants ────────────────────────────────────────────────────────────────

/** Milliseconds in a day. */
const DAY = 86400000;

/** Below this many days of refresh-token life left, health() reports `warn`. */
const WARN_DAYS = 7;

/** A pending marker older than this with a dead pid is swept. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** cam's ~400-byte per-profile cache. Contains no token material. */
const META_FILE = '.cam-meta.json';

/** Publish marker: while this exists the directory is invisible to list(). */
const PENDING_FILE = '.cam-pending';

/** Written inside a quarantined directory; records where it came from. */
const TRASH_META_FILE = 'trash-meta.json';

/** Schema version of .cam-meta.json. */
const META_SCHEMA = 1;

/** The literal id AND display label of the reserved account. */
const DEFAULT_NAME = 'default';

/**
 * The seed ALLOWLIST. A denylist over a 78 KB file written by a closed-source
 * binary is fail-open: the first release that adds a new account-scoped key
 * would leak one account's data into every profile created afterwards.
 * @type {readonly string[]}
 */
export const SEED_KEYS = Object.freeze([
  'hasCompletedOnboarding',
  'theme',
  'projects',
  'mcpServers',
]);

/**
 * Inside `projects`, every per-directory entry is reduced to these. `allowedTools`
 * and `history` are dropped: tool authorisation and prompt history are not machine
 * state and must not cross an account boundary.
 * @type {readonly string[]}
 */
export const PROJECT_SUBKEYS = Object.freeze([
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
  'projectOnboardingSeenCount',
  'hasClaudeMdExternalIncludesApproved',
]);

/**
 * Keys that belong to ONE account and must never appear in a seeded config.
 * Exported only so the test suite can assert the seed output contains none of
 * them; it is never used as a filter (the allowlist above is the filter).
 * @type {readonly string[]}
 */
export const ACCOUNT_SCOPED_KEYS = Object.freeze([
  'oauthAccount',
  'additionalModelOptionsCache',
  'additionalModelCostsCache',
  'modelAccessCache',
  'orgModelDefaultCache',
  'lastSeenOrgDefaultUpdatedAt',
  'clientDataCache',
  'clientDataCacheSlots',
  'autoCompactWindowsCache',
  'cachedUsageUtilization',
  'hasAvailableSubscription',
  'subscriptionNoticeCount',
  'customApiKeyResponses',
  'cachedExtraUsageDisabledReason',
  'passesEligibilityCache',
  'passesLastSeenRemaining',
  'claudeCodeFirstTokenDate',
  'fableOverageConsentV2',
  'cachedGrowthBookFeatures',
  'cachedGrowthBookFeaturesAt',
  'cachedExperimentData',
  'cachedExperimentFeatures',
  'penguinModeOrgEnabled',
  'groveConfigCache',
  'metricsStatusCache',
  'claudeAiMcpEverConnected',
  'replBridgePlaceholders',
  'bridgeOauthDeadExpiresAt',
  'bridgeOauthDeadFailCount',
]);

/**
 * Directories shared from the real ~/.claude into every profile.
 * `projects/`, `sessions/`, `todos/`, `file-history/` and `shell-snapshots/` are
 * DELIBERATELY absent: they hold conversation transcripts, and sharing them lets
 * `--resume` under account A continue a session belonging to account B's org.
 * @type {readonly string[]}
 */
export const SHARE_DIRS = Object.freeze(['plugins', 'commands', 'agents', 'skills']);

/**
 * Files copied (not linked) from the real ~/.claude into every profile.
 * @type {readonly string[]}
 */
export const SHARE_FILES = Object.freeze(['settings.json', 'CLAUDE.md']);

/**
 * Names a user profile may not take. `default` is the synthetic account whose
 * dir is null and whose CLAUDE_CONFIG_DIR is omitted.
 * @type {readonly string[]}
 */
export const RESERVED_NAMES = Object.freeze([DEFAULT_NAME]);

/** Windows device names, rejected on EVERY platform so a Linux-made profile still works in WSL. */
const DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Mailbox hosts whose first label is not an organisation worth naming a profile after. */
const GENERIC_MAIL_HOSTS = new Set([
  'gmail', 'googlemail', 'hotmail', 'outlook', 'live', 'msn', 'yahoo', 'ymail',
  'icloud', 'me', 'mac', 'aol', 'proton', 'protonmail', 'pm', 'gmx', 'mail',
  'yandex', 'zoho', 'fastmail', 'qq', '163', '126', 'duck', 'tutanota',
]);

/** Share record used when nothing is shared. */
const NO_SHARE = Object.freeze({ mode: 'skip', dirs: [], files: [] });

// ── small local helpers (never exported) ─────────────────────────────────────

/**
 * Does a path exist at all (a broken symlink counts as existing).
 * @param {string} p absolute path
 * @returns {Promise<boolean>} true when lstat succeeds
 */
async function exists(p) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * stat() that answers null instead of throwing.
 * @param {string} p absolute path
 * @returns {Promise<import('node:fs').Stats|null>} the stats, or null
 */
async function statSafe(p) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

/**
 * A finite positive number, or null.
 * @param {unknown} v candidate
 * @returns {number|null} the number or null
 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A non-empty trimmed string, or null.
 * @param {unknown} v candidate
 * @returns {string|null} the string or null
 */
function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Read an environment variable the way the OS resolves it. `ctx.env` is a plain
 * COPY of the real environment, so on Windows it has lost the case-blind lookup
 * the live environment provides: `$env:claude_config_dir` lands as a lower-case
 * key that a direct property read misses. ctx.js already looks these up
 * case-insensitively there, and this module must not disagree with it about
 * whether an override exists — that disagreement made `cam ls` announce
 * "respecting your CLAUDE_CONFIG_DIR" while reading the untouched ~/.claude.
 * POSIX stays case-SENSITIVE, where a differently-cased name is a different
 * variable that Claude Code does not honour either.
 * @param {object} ctx the injected context
 * @param {string} name canonical variable name
 * @returns {string|undefined} the value, or undefined when absent
 */
function envGet(ctx, name) {
  const env = (ctx && ctx.env) || {};
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const insensitive = ctx && (ctx.isWindows === true || ctx.platform === 'win32');
  if (!insensitive) return undefined;
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) return env[key];
  }
  return undefined;
}

/**
 * Case-insensitive name comparison — macOS and Windows filesystems are.
 * @param {string} a first name
 * @param {string} b second name
 * @returns {boolean} true when the names are the same account
 */
function sameName(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

/**
 * Is a process id still running on THIS host? ESRCH means dead, EPERM means alive.
 * @param {number} pid the process id from a .cam-pending marker
 * @returns {boolean} true when the pid is (probably) still alive
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/**
 * This machine's hostname, or an empty string when it cannot be read.
 * @returns {string} the hostname
 */
function thisHost() {
  try {
    return hostname() || '';
  } catch {
    return '';
  }
}

/**
 * Recursive size of a directory that never follows a symlink or junction —
 * the same rule that keeps purgeTree from walking into the real ~/.claude.
 * @param {string} dir absolute directory
 * @param {number} depth remaining recursion budget
 * @returns {Promise<number>} total bytes of real files
 */
async function dirSize(dir, depth = 16) {
  if (depth <= 0) return 0;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await dirSize(p, depth - 1);
    } else if (entry.isFile()) {
      const st = await statSafe(p);
      if (st) total += st.size;
    }
  }
  return total;
}

/**
 * Build the in-memory Profile view of a directory plus its meta cache.
 * @param {object} ctx the injected context
 * @param {string} name the account name
 * @param {string|null} dir the config directory, or null for `default`
 * @param {object|null} meta the parsed .cam-meta.json, or null
 * @param {{ isDefault?: boolean, missing?: boolean }} [opts] flags
 * @returns {object} a Profile
 */
function toProfile(ctx, name, dir, meta, opts = {}) {
  const isDefault = opts.isDefault === true;
  const accountUuid = meta ? str(meta.accountUuid) : null;
  return {
    name,
    dir: isDefault ? null : dir,
    isDefault,
    email: meta ? str(meta.email) : null,
    org: meta ? str(meta.orgName) : null,
    plan: meta ? str(meta.plan) : null,
    accountUuid,
    createdAt: meta && Number.isFinite(Number(meta.createdAt)) ? Number(meta.createdAt) : 0,
    lastUsedAt: meta ? num(meta.lastUsedAt) : null,
    health: health(meta, ctx.now()),
    share: (meta && meta.share && typeof meta.share === 'object') ? meta.share : NO_SHARE,
    missing: opts.missing === true,
    signedOut: !accountUuid,
    meta: meta || null,
  };
}

/**
 * Derive a meta record from a profile directory that has no (or a corrupt) cache.
 * Best-effort: a failure to rewrite the cache costs one re-derivation next time.
 * @param {object} ctx the injected context
 * @param {string} name the account name
 * @param {string} dir the profile directory
 * @returns {Promise<object>} the rebuilt meta
 */
async function rebuildMeta(ctx, name, dir) {
  const identity = await claudeIdentity(ctx, claudePaths(ctx, dir).configFile);
  const st = await statSafe(dir);
  const createdAt = st ? Math.round(num(st.birthtimeMs) || num(st.mtimeMs) || ctx.now()) : ctx.now();
  const meta = {
    schema: META_SCHEMA,
    name,
    createdAt,
    lastUsedAt: null,
    launchCount: 0,
    accountUuid: identity ? identity.accountUuid : null,
    email: identity ? identity.emailAddress : null,
    orgName: identity ? identity.organizationName : null,
    plan: identity ? identity.subscriptionType : null,
    backend: null,
    expiresAt: null,
    refreshTokenExpiresAt: null,
    tokenFingerprint: null,
    claudeVersionSeen: null,
    share: NO_SHARE,
    checkedAt: ctx.now(),
  };
  try {
    await writeMeta(ctx, dir, meta);
  } catch {
    // A read-only or busy store must never make the menu fail to render.
  }
  return meta;
}

// ── layout ───────────────────────────────────────────────────────────────────

/**
 * Every path cam owns. Nothing outside `root` is ever written by this module.
 * @param {object} ctx the injected context
 * @returns {{ root: string, profilesDir: string, trashDir: string, shellDir: string,
 *   lastFile: string, configFile: string, isolationFile: string, defaultMetaFile: string }} the store layout
 */
export function storePaths(ctx) {
  const override = str(envGet(ctx, 'CAM_HOME'));
  const root = override || join(ctx.home, '.claude-account-manager');
  return {
    root,
    profilesDir: join(root, 'profiles'),
    trashDir: join(root, 'trash'),
    shellDir: join(root, 'shell'),
    lastFile: join(root, 'last'),
    configFile: join(root, 'config.json'),
    isolationFile: join(root, 'isolation.json'),
    defaultMetaFile: join(root, 'default-meta.json'),
  };
}

/**
 * The Claude-Code-owned paths inside one config directory.
 * @param {object} ctx the injected context
 * @param {string} dir an absolute CLAUDE_CONFIG_DIR
 * @returns {{ configDir: string, configFile: string, credentialsFile: string,
 *   backupsDir: string, projectsDir: string }} the layout Claude Code creates
 */
export function claudePaths(ctx, dir) {
  return {
    configDir: dir,
    configFile: join(dir, '.claude.json'),
    credentialsFile: join(dir, '.credentials.json'),
    backupsDir: join(dir, 'backups'),
    projectsDir: join(dir, 'projects'),
  };
}

/**
 * The user's REAL Claude Code files — read-only for cam, written never.
 * Implements the empirically verified resolution rule: with CLAUDE_CONFIG_DIR
 * unset the authoritative global config is the HOME-ROOT file, not
 * ~/.claude/.claude.json (an inert v5-migration leftover with no oauthAccount).
 * @param {object} ctx the injected context
 * @returns {{ configDir: string, configFile: string, credentialsFile: string }} the default account's paths
 */
export function defaultClaudePaths(ctx) {
  const override = str(envGet(ctx, 'CLAUDE_CONFIG_DIR'));
  const configDir = override || join(ctx.home, '.claude');
  const configFile = override ? join(override, '.claude.json') : join(ctx.home, '.claude.json');
  return {
    configDir,
    configFile,
    credentialsFile: join(configDir, '.credentials.json'),
  };
}

// ── names ────────────────────────────────────────────────────────────────────

/**
 * The path-traversal boundary. EVERY name passes through here before it reaches
 * path.join. `reason` is an i18n KEY (with `vars`), never English text, because
 * this function is pure and has no translator.
 * @param {string} name the candidate account name
 * @returns {{ ok: boolean, reason?: string, vars?: object, name?: string }} validity plus the normalised name
 */
export function validName(name) {
  if (typeof name !== 'string') return { ok: false, reason: 'add.nameEmpty', vars: {} };
  const raw = name.trim();
  if (raw === '') return { ok: false, reason: 'add.nameEmpty', vars: {} };
  const lower = raw.toLowerCase();

  if (lower.length > 32) return { ok: false, reason: 'add.nameTooLong', vars: {} };
  if (lower === '.' || lower === '..') return { ok: false, reason: 'add.nameChars', vars: {} };
  if (/[\\/:*?"<>|\s\u0000]/.test(lower)) return { ok: false, reason: 'add.nameChars', vars: {} };
  if (/^[.\-]/.test(lower)) return { ok: false, reason: 'add.nameStart', vars: {} };
  if (/[. ]$/.test(lower)) return { ok: false, reason: 'add.nameChars', vars: {} };
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(lower)) return { ok: false, reason: 'add.nameChars', vars: {} };

  const device = lower.split('.')[0];
  if (DEVICE_NAMES.has(device)) return { ok: false, reason: 'add.nameReserved', vars: { name: raw } };
  if (RESERVED_NAMES.some((r) => sameName(r, lower))) {
    return { ok: false, reason: 'add.nameReserved', vars: { name: raw } };
  }
  return { ok: true, name: lower };
}

/**
 * Propose a free, valid profile name from an email address.
 * @param {string|null} email the address `claude auth status` reported
 * @param {Iterable<string>} [taken] names already in use
 * @returns {string} a name that passes validName and is not taken
 */
export function suggestName(email, taken = []) {
  const used = new Set();
  for (const n of (taken && typeof taken[Symbol.iterator] === 'function' ? taken : [])) {
    used.add(String(n).toLowerCase());
  }

  const raw = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const at = raw.indexOf('@');
  const local = at === -1 ? raw : raw.slice(0, at);
  const domain = at === -1 ? '' : raw.slice(at + 1);
  const host = domain.split('.').filter(Boolean);
  const org = host.length > 0 ? host[0] : '';

  let base = (org && !GENERIC_MAIL_HOSTS.has(org)) ? org : local;
  base = base
    .replace(/\+.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 24);
  if (base === '') base = 'account';

  let candidate = base;
  let n = 2;
  while ((used.has(candidate) || !validName(candidate).ok) && n < 1000) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

// ── metadata ─────────────────────────────────────────────────────────────────

/**
 * Read one profile's cam-owned metadata cache. Never throws.
 * @param {object} ctx the injected context
 * @param {string} dir the profile directory
 * @returns {Promise<object|null>} the meta, or null when absent or corrupt
 */
export async function readMeta(ctx, dir) {
  try {
    const meta = await readJsonSafe(ctx, join(dir, META_FILE), null);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    return meta;
  } catch {
    return null;
  }
}

/**
 * Write one profile's metadata cache atomically. Contains no token material.
 * @param {object} ctx the injected context
 * @param {string} dir the profile directory
 * @param {object} meta the record to persist
 * @returns {Promise<void>} resolves when the rename completed
 */
export async function writeMeta(ctx, dir, meta) {
  const record = { schema: META_SCHEMA, ...meta };
  await writeJsonAtomic(ctx, join(dir, META_FILE), record, { mode: 0o600 });
}

/**
 * Read the account identity out of a Claude-Code-owned .claude.json.
 * @param {object} ctx the injected context
 * @param {string} configFile absolute path to a .claude.json
 * @returns {Promise<{ accountUuid: string|null, emailAddress: string|null,
 *   organizationName: string|null, organizationType: string|null,
 *   subscriptionType: string|null, seatTier: string|null }|null>} the identity, or null when signed out
 */
export async function claudeIdentity(ctx, configFile) {
  const cfg = await readJsonSafe(ctx, configFile, null);
  if (!cfg || typeof cfg !== 'object') return null;
  const acc = cfg.oauthAccount;
  if (!acc || typeof acc !== 'object') return null;
  const accountUuid = str(acc.accountUuid) || str(acc.uuid);
  if (!accountUuid) return null;
  const organizationType = str(acc.organizationType);
  return {
    accountUuid,
    emailAddress: str(acc.emailAddress) || str(acc.email),
    organizationName: str(acc.organizationName),
    organizationType,
    // Measured on Claude Code 2.1.252: `oauthAccount` carries NO
    // `subscriptionType` — the plan lives in `.credentials.json` (which the hot
    // path must not read, so that a macOS Keychain prompt can never be raised
    // by drawing a menu) and, in the same vocabulary under another prefix, in
    // `organizationType` ('claude_max'). ui.planLabel normalises both spellings.
    subscriptionType: str(acc.subscriptionType) || str(cfg.subscriptionType) || organizationType,
    seatTier: str(acc.seatTier) || str(acc.organizationRole),
  };
}

/**
 * Pure, table-tested token health. It WARNS and never blocks a launch: refusing
 * to start on a cached, possibly clock-skewed number would lock a user out of an
 * account that works. `label` is an i18n key to be rendered with `labelVars`.
 * @param {object|null} meta a .cam-meta.json record
 * @param {number} now the injected clock reading
 * @returns {{ status: 'ok'|'warn'|'expired'|'signedout'|'unknown', label: string,
 *   labelVars: object, daysLeft: number|null }} the health verdict
 */
export function health(meta, now) {
  const at = Number.isFinite(Number(now)) ? Number(now) : 0;
  if (!meta || !str(meta.accountUuid)) {
    return { status: 'signedout', label: 'health.signedout', labelVars: {}, daysLeft: null };
  }
  const backend = str(meta.backend);
  const expiry = num(meta.refreshTokenExpiresAt);
  if (backend === 'keychain' || backend === 'credman' || expiry === null) {
    return { status: 'unknown', label: 'health.unknown', labelVars: {}, daysLeft: null };
  }
  const left = expiry - at;
  if (left <= 0) {
    return { status: 'expired', label: 'health.expired', labelVars: {}, daysLeft: 0 };
  }
  const daysLeft = Math.max(1, Math.ceil(left / DAY));
  if (left <= WARN_DAYS * DAY) {
    return { status: 'warn', label: 'health.warnMenu', labelVars: { days: daysLeft }, daysLeft };
  }
  return { status: 'ok', label: 'health.ok', labelVars: { days: daysLeft }, daysLeft };
}

/**
 * The post-session sync-back verifier. `<profile>/` IS the config directory the
 * child was given, so nothing can drift; this function only re-derives the cache
 * and asserts, out loud, that the refresh token actually advanced. It reads only
 * expiry integers and a fingerprint — never a token — and on the keychain/credman
 * backends it reads nothing at all, so the menu can never raise a Keychain prompt.
 * Never throws and never affects the exit code.
 * @param {object} ctx the injected context
 * @param {object} profile the profile that just ran
 * @param {{ sessionMs?: number, claudeVersion?: string|null, share?: object|null }} [opts] session facts
 * @returns {Promise<{ changed: boolean, warning: string|null }>} whether the cache moved, plus a translated warning
 */
export async function refreshMeta(ctx, profile, opts = {}) {
  try {
    if (!profile || !profile.dir) return { changed: false, warning: null };
    const dir = profile.dir;
    const now = ctx.now();
    const reported = Number.isFinite(Number(opts.sessionMs));
    const sessionMs = reported ? Number(opts.sessionMs) : 0;

    const prev = await readMeta(ctx, dir);

    let cred = null;
    try {
      cred = await credstore.summary(ctx, dir);
    } catch {
      cred = null;
    }
    const opaque = !cred || cred.unknown === true;

    const identity = await claudeIdentity(ctx, claudePaths(ctx, dir).configFile);

    const next = {
      schema: META_SCHEMA,
      name: profile.name,
      createdAt: (prev && num(prev.createdAt)) || now,
      lastUsedAt: reported ? now : (prev ? num(prev.lastUsedAt) : null),
      launchCount: ((prev && Number(prev.launchCount)) || 0) + (reported ? 1 : 0),
      accountUuid: (identity && identity.accountUuid) || (prev ? str(prev.accountUuid) : null),
      email: (identity && identity.emailAddress) || (prev ? str(prev.email) : null),
      orgName: (identity && identity.organizationName) || (prev ? str(prev.orgName) : null),
      plan: (identity && identity.subscriptionType)
        || (cred ? str(cred.subscriptionType) : null)
        || (prev ? str(prev.plan) : null),
      backend: (cred ? str(cred.backend) : null) || (prev ? str(prev.backend) : null),
      expiresAt: opaque ? (prev ? num(prev.expiresAt) : null) : num(cred.expiresAt),
      refreshTokenExpiresAt: opaque
        ? (prev ? num(prev.refreshTokenExpiresAt) : null)
        : num(cred.refreshTokenExpiresAt),
      tokenFingerprint: opaque
        ? (prev ? str(prev.tokenFingerprint) : null)
        : str(cred.fingerprint),
      claudeVersionSeen: str(opts.claudeVersion) || (prev ? str(prev.claudeVersionSeen) : null),
      share: (opts.share && typeof opts.share === 'object')
        ? opts.share
        : ((prev && prev.share && typeof prev.share === 'object') ? prev.share : NO_SHARE),
      checkedAt: now,
    };

    const changed = !prev || !sameRecord(prev, next);
    await writeMeta(ctx, dir, next);

    // The staleness assertion: cam must never claim to have renewed anything it
    // did not observe renewing.
    let warning = null;
    if (
      sessionMs > 60000
      && !opaque
      && prev
      && num(prev.refreshTokenExpiresAt) !== null
      && next.refreshTokenExpiresAt === num(prev.refreshTokenExpiresAt)
      && next.refreshTokenExpiresAt !== null
      && next.refreshTokenExpiresAt - now < WARN_DAYS * DAY
    ) {
      const days = Math.max(0, Math.ceil((next.refreshTokenExpiresAt - now) / DAY));
      warning = ctx.t('health.notAdvanced', { name: profile.name, days });
    }

    return { changed, warning };
  } catch {
    return { changed: false, warning: null };
  }
}

/**
 * Compare two meta records ignoring the bookkeeping fields that always move.
 * @param {object} a the previous record
 * @param {object} b the next record
 * @returns {boolean} true when nothing meaningful changed
 */
function sameRecord(a, b) {
  const keys = [
    'accountUuid', 'email', 'orgName', 'plan', 'backend',
    'expiresAt', 'refreshTokenExpiresAt', 'tokenFingerprint', 'claudeVersionSeen',
  ];
  for (const k of keys) {
    if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  }
  return JSON.stringify(a.share ?? null) === JSON.stringify(b.share ?? null);
}

// ── enumeration ──────────────────────────────────────────────────────────────

/**
 * Every real profile directory, in stable creation order. Never throws: a store
 * that cannot be read yields an empty menu, not a crash.
 * @param {object} ctx the injected context
 * @returns {Promise<object[]>} the profiles (excluding `default`)
 */
export async function list(ctx) {
  const { profilesDir } = storePaths(ctx);
  let entries = [];
  try {
    entries = await readdir(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    try {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const dir = join(profilesDir, entry.name);
      if (await exists(join(dir, PENDING_FILE))) continue;

      let meta = await readMeta(ctx, dir);
      if (!meta || !str(meta.name)) meta = await rebuildMeta(ctx, entry.name, dir);
      out.push(toProfile(ctx, entry.name, dir, meta));
    } catch {
      // One unreadable directory must not hide the rest of the accounts.
    }
  }

  out.sort((a, b) => (a.createdAt - b.createdAt)
    || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return out;
}

/**
 * The synthetic `default` account: the login the user already had. `dir` is null,
 * which is the signal to OMIT CLAUDE_CONFIG_DIR from the child environment.
 * The 78 KB parse is memoised on the source file's mtimeMs + size.
 * @param {object} ctx the injected context
 * @returns {Promise<object|null>} the profile, or null when nobody is signed in
 */
export async function defaultProfile(ctx) {
  const { configFile } = defaultClaudePaths(ctx);
  const st = await statSafe(configFile);
  if (!st) return null;

  const { root, defaultMetaFile } = storePaths(ctx);
  const stamp = { source: configFile, mtimeMs: Math.round(st.mtimeMs), size: st.size };

  let identity = null;
  let cached = null;
  try {
    cached = await readJsonSafe(ctx, defaultMetaFile, null);
  } catch {
    cached = null;
  }

  // The schema check matters as much as the mtime check: this cache stores a
  // DERIVED identity, so a cam upgrade that changes the derivation must
  // invalidate it even though the source file never changed.
  const fresh = cached
    && cached.schema === META_SCHEMA
    && cached.source === stamp.source
    && cached.mtimeMs === stamp.mtimeMs
    && cached.size === stamp.size
    && Object.prototype.hasOwnProperty.call(cached, 'identity');

  if (fresh) {
    identity = cached.identity;
  } else {
    identity = await claudeIdentity(ctx, configFile);
    try {
      await ensureDir(ctx, root, 0o700);
      await writeJsonAtomic(ctx, defaultMetaFile, { schema: META_SCHEMA, ...stamp, identity }, { mode: 0o600 });
    } catch {
      // The cache is an optimisation; losing it costs 1.09 ms.
    }
  }

  if (!identity || !str(identity.accountUuid)) return null;

  const meta = {
    schema: META_SCHEMA,
    name: DEFAULT_NAME,
    createdAt: 0,
    lastUsedAt: null,
    launchCount: 0,
    accountUuid: identity.accountUuid,
    email: identity.emailAddress || null,
    orgName: identity.organizationName || null,
    plan: identity.subscriptionType || null,
    backend: null,
    expiresAt: null,
    refreshTokenExpiresAt: null,
    tokenFingerprint: null,
    claudeVersionSeen: null,
    share: NO_SHARE,
    checkedAt: ctx.now(),
  };
  return toProfile(ctx, DEFAULT_NAME, null, meta, { isDefault: true });
}

/**
 * The complete account list in STABLE order: `default` first, then profiles by
 * creation time. It never reorders by recency — digit hotkeys launch immediately,
 * and a list that reshuffles between invocations sends prompts to the wrong org.
 * @param {object} ctx the injected context
 * @returns {Promise<object[]>} every selectable account
 */
export async function all(ctx) {
  const [head, rest] = await Promise.all([defaultProfile(ctx), list(ctx)]);
  return head ? [head, ...rest] : rest;
}

/**
 * Look one account up by name, case-insensitively.
 * @param {object} ctx the injected context
 * @param {string} needle the account name (`default` included)
 * @returns {Promise<object|null>} the profile, or null when there is no such account
 */
export async function get(ctx, needle) {
  const want = str(needle);
  if (!want) return null;
  const accounts = await all(ctx);
  for (const p of accounts) {
    if (sameName(p.name, want)) return p;
  }
  return null;
}

// ── creation: build in place, publish by marker ──────────────────────────────

/**
 * Claim `profiles/<name>` and mark it unpublished. The directory is built IN
 * PLACE and never renamed: the macOS Keychain service name is hashed from the
 * directory path, so a rename would orphan the credential the login just wrote.
 * The claim is EXCLUSIVE: exactly one caller can win a given name.
 * @param {object} ctx the injected context
 * @param {string} name the requested account name
 * @returns {Promise<{ dir: string }>} the profile directory, already created 0700
 */
export async function beginCreate(ctx, name) {
  const v = validName(name);
  if (!v.ok) fail('USAGE', ctx.t(v.reason, v.vars || {}), { hint: ctx.t('add.nameHint') });

  const { root, profilesDir } = storePaths(ctx);
  await ensureDir(ctx, root, 0o700);
  await ensureDir(ctx, profilesDir, 0o700);

  const dir = join(profilesDir, v.name);

  // The claim is a single EXCLUSIVE, non-recursive mkdir, not a check followed
  // by a create: recursive mkdir never reports EEXIST for a directory, so two
  // `cam add work` runs started together could both pass an exists() check and
  // both drive `claude auth login` into one directory — leaving one profile
  // whose cached email belongs to account A and whose credentials belong to B.
  // Here EEXIST *is* the conflict signal, whether the name was taken by another
  // process a microsecond ago or by a profile created last week.
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (cause) {
    if (cause && (cause.code === 'EEXIST' || cause.code === 'EISDIR')) {
      fail('CONFLICT', ctx.t('err.conflict', { name: v.name }), {
        hint: ctx.t('err.conflictHint', { name: v.name }),
      });
    }
    fail('ERROR', ctx.t('err.io', { file: dir }), { hint: ctx.t('err.ioHint'), cause });
  }
  // mkdir's mode is masked by the umask, so the 0700 still has to be asserted.
  await chmodIfPosix(ctx, dir, 0o700);

  await writeJsonAtomic(ctx, join(dir, PENDING_FILE), {
    pid: process.pid,
    startedAt: ctx.now(),
    host: thisHost(),
  }, { mode: 0o600 });

  return { dir };
}

/**
 * Publish a profile: drop the pending marker, then write the metadata cache.
 * @param {object} ctx the injected context
 * @param {string} name the account name claimed by beginCreate
 * @param {object} identity the verified identity, optionally carrying `share` and `claudeVersion`
 * @returns {Promise<object>} the published Profile
 */
export async function finishCreate(ctx, name, identity) {
  const v = validName(name);
  if (!v.ok) fail('USAGE', ctx.t(v.reason, v.vars || {}), { hint: ctx.t('add.nameHint') });

  const { profilesDir } = storePaths(ctx);
  const dir = join(profilesDir, v.name);
  if (!(await exists(dir))) {
    fail('NOT_FOUND', ctx.t('err.notFound', { name: v.name }), {
      hint: ctx.t('err.notFoundHint', { names: v.name }),
    });
  }

  const id = identity && typeof identity === 'object' ? identity : {};
  const prev = await readMeta(ctx, dir);
  const now = ctx.now();

  let cred = null;
  try {
    cred = await credstore.summary(ctx, dir);
  } catch {
    cred = null;
  }
  const opaque = !cred || cred.unknown === true;

  const onDisk = await claudeIdentity(ctx, claudePaths(ctx, dir).configFile);

  const meta = {
    schema: META_SCHEMA,
    name: v.name,
    createdAt: (prev && num(prev.createdAt)) || now,
    lastUsedAt: prev ? num(prev.lastUsedAt) : null,
    launchCount: (prev && Number(prev.launchCount)) || 0,
    accountUuid: str(id.accountUuid) || (onDisk ? onDisk.accountUuid : null),
    email: str(id.emailAddress) || str(id.email) || (onDisk ? onDisk.emailAddress : null),
    orgName: str(id.organizationName) || str(id.orgName) || (onDisk ? onDisk.organizationName : null),
    plan: str(id.subscriptionType) || str(id.plan)
      || (onDisk ? onDisk.subscriptionType : null)
      || (cred ? str(cred.subscriptionType) : null),
    backend: cred ? str(cred.backend) : null,
    expiresAt: opaque ? null : num(cred.expiresAt),
    refreshTokenExpiresAt: opaque ? null : num(cred.refreshTokenExpiresAt),
    tokenFingerprint: opaque ? null : str(cred.fingerprint),
    claudeVersionSeen: str(id.claudeVersion) || (prev ? str(prev.claudeVersionSeen) : null),
    share: (id.share && typeof id.share === 'object')
      ? id.share
      : ((prev && prev.share && typeof prev.share === 'object') ? prev.share : NO_SHARE),
    checkedAt: now,
  };

  await rm(join(dir, PENDING_FILE), { force: true });
  await writeMeta(ctx, dir, meta);
  return toProfile(ctx, v.name, dir, meta);
}

/**
 * Roll a failed creation back. Removes `profiles/<name>` entirely and touches
 * nothing else — `last`, the other profiles and every Claude Code file are
 * unchanged. Links are unlinked before any recursion, so a shared `plugins`
 * junction can never be followed into the real ~/.claude.
 * @param {object} ctx the injected context
 * @param {string} name the account name claimed by beginCreate
 * @param {{ keep?: boolean }} [opts] pass keep to leave the directory for debugging
 * @returns {Promise<void>} resolves when the directory is gone (or kept)
 */
export async function abortCreate(ctx, name, opts = {}) {
  if (opts.keep === true) return;
  const v = validName(name);
  if (!v.ok) return;
  const { profilesDir } = storePaths(ctx);
  const dir = join(profilesDir, v.name);
  if (dirname(dir) !== profilesDir) return;
  if (!(await exists(dir))) return;
  // rmrf alone: it performs the same link-safe walk as purgeTree and is scoped
  // to the whole store, whereas purgeTree is scoped to <store>/trash and would
  // always refuse this path.
  try {
    await rmrf(ctx, dir);
  } catch {
    // Leaving a stub behind is survivable: the pending marker keeps it hidden.
  }
}

/**
 * Remove abandoned half-made profiles: a pending marker whose pid is dead and
 * which is older than 24 h. Never throws.
 * @param {object} ctx the injected context
 * @returns {Promise<string[]>} the names that were swept
 */
export async function sweepPending(ctx) {
  const { profilesDir } = storePaths(ctx);
  let entries = [];
  try {
    entries = await readdir(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const swept = [];
  const host = thisHost();
  for (const entry of entries) {
    try {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(profilesDir, entry.name);
      const marker = await readJsonSafe(ctx, join(dir, PENDING_FILE), null);
      if (!marker || typeof marker !== 'object') continue;

      const startedAt = num(marker.startedAt) || 0;
      if (ctx.now() - startedAt < PENDING_TTL_MS) continue;

      const sameMachine = !str(marker.host) || str(marker.host) === host;
      if (sameMachine && pidAlive(Number(marker.pid))) continue;

      // rmrf, NOT purgeTree: both do the same lstat-first, link-unlinking walk,
      // but purgeTree refuses anything outside <store>/trash and this directory
      // lives under <store>/profiles. Calling it here threw UNSAFE into the
      // catch below, so no stale pending profile was ever swept — and because
      // `list` hides directories carrying .cam-pending, the leftover was
      // invisible in the menu and its name stayed unusable.
      await rmrf(ctx, dir);
      swept.push(entry.name);
    } catch {
      // A directory we cannot sweep is simply left for the next run.
    }
  }
  return swept;
}

// ── seeding ──────────────────────────────────────────────────────────────────

/**
 * Seed `<dir>/.claude.json` from the user's real global config through the
 * SEED_KEYS allowlist, reducing every `projects` entry to PROJECT_SUBKEYS.
 * @param {object} ctx the injected context
 * @param {string} dir the profile directory
 * @param {{ seed?: boolean, source?: string }} [opts] pass seed:false to skip entirely
 * @returns {Promise<{ seeded: string[], dropped: string[] }>} which keys were copied and which were left behind
 */
export async function seedConfig(ctx, dir, opts = {}) {
  if (opts.seed === false) return { seeded: [], dropped: [] };

  const source = str(opts.source) || defaultClaudePaths(ctx).configFile;
  const src = await readJsonSafe(ctx, source, null);
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { seeded: [], dropped: [] };

  const seeded = [];
  const dropped = [];
  const out = {};

  for (const key of Object.keys(src)) {
    if (!SEED_KEYS.includes(key)) dropped.push(key);
  }

  for (const key of SEED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const value = src[key];
    if (value === undefined || value === null) continue;

    if (key === 'projects') {
      const projects = {};
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [projectDir, entry] of Object.entries(value)) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
          const reduced = {};
          for (const sub of PROJECT_SUBKEYS) {
            if (Object.prototype.hasOwnProperty.call(entry, sub)) reduced[sub] = entry[sub];
          }
          for (const sub of Object.keys(entry)) {
            if (!PROJECT_SUBKEYS.includes(sub) && !dropped.includes(`projects.${sub}`)) {
              dropped.push(`projects.${sub}`);
            }
          }
          if (Object.keys(reduced).length > 0) projects[projectDir] = reduced;
        }
      }
      if (Object.keys(projects).length === 0) continue;
      out.projects = projects;
      seeded.push(key);
      continue;
    }

    out[key] = value;
    seeded.push(key);
  }

  if (seeded.length === 0) return { seeded, dropped };

  await writeJsonAtomic(ctx, join(dir, '.claude.json'), out, { mode: 0o600, backupOnce: true });
  return { seeded, dropped };
}

/**
 * Share the account-neutral parts of ~/.claude into a profile: SHARE_DIRS by
 * link (degrading to copy, then skip) and SHARE_FILES by copy. Transcript
 * directories are shared only when opts.projects is explicitly true.
 * @param {object} ctx the injected context
 * @param {string} dir the profile directory
 * @param {{ share?: boolean, projects?: boolean, source?: string }} [opts] sharing switches
 * @returns {Promise<{ linked: string[], copied: string[], skipped: string[], mode: string }>} what actually happened
 */
export async function seedShare(ctx, dir, opts = {}) {
  const linked = [];
  const copied = [];
  const skipped = [];

  if (opts.share === false) {
    return { linked, copied, skipped: [...SHARE_DIRS, ...SHARE_FILES], mode: 'skip' };
  }

  const source = str(opts.source) || defaultClaudePaths(ctx).configDir;
  const dirs = opts.projects === true ? [...SHARE_DIRS, 'projects'] : [...SHARE_DIRS];

  for (const name of dirs) {
    const from = join(source, name);
    if (!(await exists(from))) {
      skipped.push(name);
      continue;
    }
    let mode = 'skip';
    try {
      mode = await linkDir(ctx, from, join(dir, name));
    } catch {
      mode = 'skip';
    }
    if (mode === 'link') linked.push(name);
    else if (mode === 'copy') copied.push(name);
    else skipped.push(name);
  }

  for (const name of SHARE_FILES) {
    let ok = false;
    try {
      ok = await copyFileIfExists(ctx, join(source, name), join(dir, name), 0o600);
    } catch {
      ok = false;
    }
    if (ok) copied.push(name);
    else skipped.push(name);
  }

  const mode = linked.length > 0 ? 'link' : (copied.length > 0 ? 'copy' : 'skip');
  return { linked, copied, skipped, mode };
}

// ── the active-account pointer ───────────────────────────────────────────────

/**
 * The account a bare `claude` would pass through to. One line of UTF-8.
 * @param {object} ctx the injected context
 * @returns {Promise<string|null>} the remembered account name, or null
 */
export async function getLast(ctx) {
  const { lastFile } = storePaths(ctx);
  try {
    const raw = await readFile(lastFile, 'utf8');
    const line = String(raw).split(/\r?\n/, 1)[0].trim();
    if (line === '') return null;
    if (sameName(line, DEFAULT_NAME)) return DEFAULT_NAME;
    return validName(line).ok ? line.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Remember the active account. Written before the spawn so a session ended by
 * Ctrl+C still remembers the choice. Two racing cam processes are a benign
 * last-writer-wins: the only shared mutable state is this single pointer.
 * @param {object} ctx the injected context
 * @param {string} name the account name (`default` included)
 * @returns {Promise<void>} resolves once written, or silently on failure
 */
export async function setLast(ctx, name) {
  const wanted = str(name);
  if (!wanted) return;
  if (!sameName(wanted, DEFAULT_NAME) && !validName(wanted).ok) return;
  const { root, lastFile } = storePaths(ctx);
  try {
    await ensureDir(ctx, root, 0o700);
    await writeFileAtomic(ctx, lastFile, `${wanted.toLowerCase()}\n`, { mode: 0o600 });
  } catch {
    // A stale preselection is the worst case; it must never fail a launch.
  }
}

// ── configuration (exactly three keys) ───────────────────────────────────────

/**
 * cam's three-key configuration, with environment overriding the file.
 * @param {object} ctx the injected context
 * @returns {Promise<{ ask: 'auto'|'always'|'never', claudeBin: string|null, ascii: boolean|null }>} the effective config
 */
export async function loadConfig(ctx) {
  let raw = null;
  try {
    raw = await readJsonSafe(ctx, storePaths(ctx).configFile, {});
  } catch {
    raw = {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};

  const asks = ['auto', 'always', 'never'];
  let ask = asks.includes(String(raw.ask)) ? String(raw.ask) : 'auto';
  const askEnv = str(envGet(ctx, 'CAM_ASK'));
  if (askEnv && asks.includes(askEnv.toLowerCase())) ask = askEnv.toLowerCase();

  let claudeBin = str(raw.claudeBin);
  const binEnv = str(envGet(ctx, 'CAM_CLAUDE_BIN'));
  if (binEnv) claudeBin = binEnv;

  let ascii = typeof raw.ascii === 'boolean' ? raw.ascii : null;
  const asciiEnv = str(envGet(ctx, 'CAM_ASCII'));
  if (asciiEnv !== null) {
    const low = asciiEnv.toLowerCase();
    if (low === '1' || low === 'true' || low === 'yes') ascii = true;
    else if (low === '0' || low === 'false' || low === 'no') ascii = false;
  }

  return { ask, claudeBin, ascii };
}

/**
 * Persist the three-key configuration. Unknown keys are dropped, not stored.
 * @param {object} ctx the injected context
 * @param {{ ask?: string, claudeBin?: string|null, ascii?: boolean|null }} cfg the config to write
 * @returns {Promise<void>} resolves when the rename completed
 */
export async function saveConfig(ctx, cfg) {
  const { root, configFile } = storePaths(ctx);
  const source = cfg && typeof cfg === 'object' ? cfg : {};
  const out = {};

  const asks = ['auto', 'always', 'never'];
  if (asks.includes(String(source.ask))) out.ask = String(source.ask);
  const bin = str(source.claudeBin);
  if (bin) out.claudeBin = bin;
  if (typeof source.ascii === 'boolean') out.ascii = source.ascii;

  await ensureDir(ctx, root, 0o700);
  await writeJsonAtomic(ctx, configFile, out, { mode: 0o600 });
}

// ── quarantine ───────────────────────────────────────────────────────────────

/**
 * Quarantine a profile by RENAME into trash/<name>-<epoch>/. Rename is used
 * because a rename cannot traverse a junction, whereas a recursive delete can
 * follow the shared plugins/skills junction into the real ~/.claude.
 * @param {object} ctx the injected context
 * @param {string} name the account to quarantine
 * @returns {Promise<{ trashPath: string, id: string }>} where it went
 */
export async function trashProfile(ctx, name) {
  const v = validName(name);
  if (!v.ok) {
    fail('NOT_FOUND', ctx.t('err.notFound', { name: String(name) }), {
      hint: ctx.t('err.notFoundHint', { names: DEFAULT_NAME }),
    });
  }

  const { profilesDir, trashDir } = storePaths(ctx);
  const dir = join(profilesDir, v.name);
  if (!(await exists(dir))) {
    const names = (await list(ctx)).map((p) => p.name).join(', ');
    fail('NOT_FOUND', ctx.t('err.notFound', { name: v.name }), {
      hint: ctx.t('err.notFoundHint', { names: names || DEFAULT_NAME }),
    });
  }

  const meta = await readMeta(ctx, dir);
  await ensureDir(ctx, trashDir, 0o700);

  const id = `${v.name}-${ctx.now()}`;
  const trashPath = join(trashDir, id);
  await moveDir(ctx, dir, trashPath);

  try {
    await writeJsonAtomic(ctx, join(trashPath, TRASH_META_FILE), {
      schema: META_SCHEMA,
      id,
      name: v.name,
      originalPath: dir,
      accountUuid: meta ? str(meta.accountUuid) : null,
      email: meta ? str(meta.email) : null,
      plan: meta ? str(meta.plan) : null,
      removedAt: ctx.now(),
    }, { mode: 0o600 });
  } catch {
    // Without this record restore falls back to profiles/<name>, which is the
    // same path in every case except a CAM_HOME that moved between runs.
  }

  return { trashPath, id };
}

/**
 * Everything currently quarantined, newest first. Never throws.
 * @param {object} ctx the injected context
 * @returns {Promise<object[]>} the trash entries with size and age
 */
export async function listTrash(ctx) {
  const { trashDir, profilesDir } = storePaths(ctx);
  let entries = [];
  try {
    entries = await readdir(trashDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const now = ctx.now();
  const out = [];
  for (const entry of entries) {
    try {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(trashDir, entry.name);
      const meta = await readJsonSafe(ctx, join(dir, TRASH_META_FILE), null);
      const guessed = entry.name.replace(/-\d{10,}$/, '');
      const name = (meta && str(meta.name)) || guessed;
      const removedAt = (meta && num(meta.removedAt)) || (await statSafe(dir))?.mtimeMs || now;
      out.push({
        id: entry.name,
        name,
        dir,
        originalPath: (meta && str(meta.originalPath)) || join(profilesDir, name),
        accountUuid: meta ? str(meta.accountUuid) : null,
        email: meta ? str(meta.email) : null,
        plan: meta ? str(meta.plan) : null,
        removedAt: Math.round(removedAt),
        ageMs: Math.max(0, now - Math.round(removedAt)),
        size: await dirSize(dir),
      });
    } catch {
      // An unreadable trash entry simply does not list.
    }
  }

  out.sort((a, b) => b.removedAt - a.removedAt);
  return out;
}

/**
 * Bring a quarantined profile back to its ORIGINAL path — which is precisely
 * what makes its macOS Keychain item (hashed from that path) resolve again.
 * @param {object} ctx the injected context
 * @param {string} name the account name, or a trash entry id
 * @returns {Promise<object>} the restored Profile
 */
export async function restoreProfile(ctx, name) {
  const want = str(name);
  const { profilesDir } = storePaths(ctx);
  const entries = await listTrash(ctx);
  const entry = entries.find((e) => sameName(e.id, want)) || entries.find((e) => sameName(e.name, want));

  if (!entry) {
    fail('NOT_FOUND', ctx.t('restore.notInTrash', { name: String(name) }), {
      hint: ctx.t('err.noAccountsHint'),
    });
  }

  const v = validName(entry.name);
  if (!v.ok) fail('USAGE', ctx.t(v.reason, v.vars || {}), { hint: ctx.t('add.nameHint') });

  let target = entry.originalPath;
  if (!isAbsolute(target) || dirname(target) !== profilesDir || basename(target) !== v.name) {
    target = join(profilesDir, v.name);
  }

  if (await exists(target)) {
    fail('CONFLICT', ctx.t('restore.occupied', { name: v.name }), {
      hint: ctx.t('err.conflictHint', { name: v.name }),
    });
  }

  await ensureDir(ctx, profilesDir, 0o700);
  await moveDir(ctx, entry.dir, target);
  await rm(join(target, TRASH_META_FILE), { force: true });

  let meta = await readMeta(ctx, target);
  if (!meta) meta = await rebuildMeta(ctx, v.name, target);
  return toProfile(ctx, v.name, target, meta);
}

/**
 * Permanently delete one quarantined profile. This is the ONLY code path that
 * deletes: purgeTree unlinks every symlink/junction before recursing, then the
 * credential item is removed using the RECORDED ORIGINAL path (the hash input) —
 * but ONLY while that path is still vacant, because a re-created account of the
 * same name owns both the credentials file and the Keychain item living there.
 * @param {object} ctx the injected context
 * @param {string} id the trash entry id, or an account name
 * @returns {Promise<void>} resolves when the copy is gone
 */
export async function purgeTrash(ctx, id) {
  const want = str(id);
  const entries = await listTrash(ctx);
  const entry = entries.find((e) => sameName(e.id, want)) || entries.find((e) => sameName(e.name, want));
  if (!entry) {
    fail('NOT_FOUND', ctx.t('restore.notInTrash', { name: String(id) }), {
      hint: ctx.t('err.noAccountsHint'),
    });
  }

  const { trashDir } = storePaths(ctx);
  if (dirname(entry.dir) !== trashDir) {
    fail('ERROR', ctx.t('err.error'), { hint: ctx.t('err.errorHint') });
  }

  await purgeTree(ctx, entry.dir);
  await rmrf(ctx, entry.dir);

  // A name sitting in trash is free again — beginCreate only refuses a LIVE
  // directory — so `profiles/<name>` may now hold a different, signed-in
  // account. Both credential backends are addressed by that path (the file
  // backend deletes <path>/.credentials.json; the Keychain service is
  // sha256(<path>)), so purging the quarantined copy's credential when the path
  // is occupied would sign the user out of a working account they never named.
  // The stale item of the purged copy is left behind instead: it is unreachable
  // and inert, which is the strictly safer of the two mistakes.
  if (await exists(entry.originalPath)) return;

  try {
    await credstore.remove(ctx, entry.originalPath);
  } catch {
    // A missing keychain item is the expected case on Linux and Windows.
  }
}
